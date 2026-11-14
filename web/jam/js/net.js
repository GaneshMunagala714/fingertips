// Room connection. Sends our structured music events (never audio or video), receives the other
// players', keeps a shared clock via ping/pong, and reconnects with backoff if the link drops.
import { bus } from './bus.js';
import { clock } from './clock.js';

const SENDABLE = new Set(['chord', 'chordOff', 'noteOn', 'noteOff', 'drum', 'expr', 'allOff']);
const FIELDS = ['type', 'id', 't', 'instrument', 'velocity', 'notes', 'chord', 'degree', 'midi', 'drum', 'volume', 'filter', 'dur'];

export const net = {
  ws: null, room: null, me: null, state: 'off', players: new Map(), transport: null,
  _retry: 0, _pingTimer: null, _want: false, latency: null,

  connect(room) {
    this.room = room; this._want = true;
    this._open();
  },
  _open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let slot = null;
    try { slot = sessionStorage.getItem(`jam-slot-${this.room}`); } catch (_) {}
    const url = `${proto}://${location.host}/jam/ws/${this.room}${slot ? `?slot=${slot}` : ''}`;
    this._setState('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (m) => this._recv(JSON.parse(m.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this._pingTimer);
      for (const id of this.players.keys()) if (id !== this.me) bus.signal('peer-leave', id);
      this.players.clear();
      if (!this._want) { this._setState('off'); return; }
      this._setState('reconnecting');
      const delay = Math.min(8000, 500 * 2 ** this._retry++);
      setTimeout(() => this._want && this._open(), delay);
    };
  },
  disconnect() {
    this._want = false;
    clearInterval(this._pingTimer);
    try { this.ws?.close(); } catch (_) {}
    this.ws = null; this.room = null; this.players.clear();
    clock.offset = 0;
    this._setState('off');
  },
  _setState(s) { this.state = s; bus.signal('net', { state: s, room: this.room, me: this.me, players: [...this.players.values()] }); },
  _ping() { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping', c: Date.now() })); },
  sendRaw(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); },

  /** Bus handler: forward our own live events to the room. */
  forward(ev) {
    if (ev.origin !== 'local' || !SENDABLE.has(ev.type) || this.ws?.readyState !== 1) return;
    const out = {};
    for (const k of FIELDS) if (ev[k] != null) out[k] = ev[k];
    this.ws.send(JSON.stringify({ type: 'ev', ev: out }));
  },

  _recv(msg) {
    switch (msg.type) {
      case 'welcome':
        this.me = msg.you; this._retry = 0;
        try { sessionStorage.setItem(`jam-slot-${this.room}`, msg.you); } catch (_) {}
        bus.playerId = msg.you;
        clock.setSample(Date.now(), msg.serverTime, Date.now());
        this.players = new Map(msg.players.map((p) => [p.id, p]));
        this._pingTimer = setInterval(() => this._ping(), 2000);
        for (let i = 0; i < 4; i++) setTimeout(() => this._ping(), 150 * i);
        this._setState('connected');
        bus.signal('room-transport', msg.transport);
        break;
      case 'pong':
        clock.setSample(msg.c, msg.s, Date.now());
        this.latency = clock.rtt / 2;
        bus.signal('latency', this.latency);
        break;
      case 'join': this.players.set(msg.player.id, msg.player); this._setState('connected'); bus.signal('peer-join', msg.player); break;
      case 'leave': this.players.delete(msg.id); this._setState('connected'); bus.signal('peer-leave', msg.id); break;
      case 'role': this.players.set(msg.player.id, msg.player); this._setState('connected'); break;
      case 'transport': bus.signal('room-transport', msg.transport); break;
      case 'ev': {
        const ev = msg.ev;
        ev.origin = 'remote';
        ev.netDelay = clock.now() - ev.t;   // sender clock -> our clock, both server-corrected
        bus.emit(ev);
        break;
      }
      case 'error':
        bus.signal('net-error', msg.error);
        if (msg.error === 'room is full' || msg.error === 'bad room code') { this._want = false; }
        break;
    }
  },
};
