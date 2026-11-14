// Records the structured event stream (with timing and player identity), replays it through the same
// bus, and exports JSON / PNG / WAV. The WAV is rendered offline by the same synth code, from the events.
import { bus } from './bus.js';
import { clock } from './clock.js';
import { AudioEngine, INSTRUMENTS } from './audio.js';

const KEEP = ['type', 'playerId', 'instrument', 'velocity', 'notes', 'chord', 'degree', 'midi', 'drum', 'volume', 'filter', 'dur'];

export const recorder = {
  recording: false, startedAt: 0, events: [], replaying: false, _timers: [],

  start() { this.events = []; this.startedAt = clock.now(); this.recording = true; bus.signal('rec', this.status()); },
  stop() {
    this.recording = false;
    // look-ahead events (beat loop) can be captured slightly out of order: sort by when they sounded
    this.events.sort((a, b) => a.time - b.time);
    bus.signal('rec', this.status());
  },
  clear() { this.stop(); this.stopReplay(); this.events = []; bus.signal('rec', this.status()); },
  status() {
    return { recording: this.recording, replaying: this.replaying, count: this.events.length,
      seconds: this.events.reduce((m, e) => Math.max(m, e.time), 0) / 1000 };
  },

  capture(ev) {
    if (!this.recording || ev.origin === 'replay') return;
    const e = { time: Math.max(0, Math.round(ev.at - this.startedAt)) };
    for (const k of KEEP) if (ev[k] != null) e[k] = ev[k];
    this.events.push(e);
  },

  replay() {
    if (!this.events.length) return;
    this.stopReplay();
    this.replaying = true;
    const base = clock.now() + 150;
    for (const e of this.events) {
      this._timers.push(setTimeout(() => {
        bus.emit({ ...e, t: base + e.time, origin: 'replay' });
      }, Math.max(0, base + e.time - clock.now() - 100)));
    }
    const last = this.events.reduce((m, e) => Math.max(m, e.time), 0);
    this._timers.push(setTimeout(() => this.stopReplay(), last + 2500));
    bus.signal('rec', this.status());
  },
  stopReplay() {
    this._timers.forEach(clearTimeout); this._timers = [];
    if (this.replaying) {
      const ids = new Set(this.events.map((e) => e.playerId));
      for (const id of ids) bus.emit({ type: 'allOff', playerId: id, origin: 'replay', instrument: 'piano' });
    }
    this.replaying = false;
    bus.signal('rec', this.status());
  },

  toJSON() {
    return { app: 'Sign2Speak JAM', version: 1, createdAt: new Date().toISOString(), unit: 'ms since recording start',
      players: [...new Set(this.events.map((e) => e.playerId))], events: this.events };
  },
  load(obj) {
    if (!obj || !Array.isArray(obj.events)) throw new Error('not a JAM composition');
    this.events = obj.events.filter((e) => typeof e.time === 'number' && typeof e.type === 'string');
    bus.signal('rec', this.status());
  },

  saveLocal(name) {
    try {
      const all = JSON.parse(localStorage.getItem('jam-compositions') || '[]');
      all.unshift({ name, savedAt: Date.now(), data: this.toJSON() });
      localStorage.setItem('jam-compositions', JSON.stringify(all.slice(0, 10)));
      return true;
    } catch (_) { return false; }
  },
  listLocal() { try { return JSON.parse(localStorage.getItem('jam-compositions') || '[]'); } catch (_) { return []; } },

  /** Render the recording to a WAV using an OfflineAudioContext and the same synth. */
  async renderWav() {
    if (!this.events.length) throw new Error('nothing recorded');
    const sr = 44100;
    const len = this.events.reduce((m, e) => Math.max(m, e.time), 0) / 1000 + 3;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * len), sr);
    const eng = new AudioEngine(ctx);
    for (const e of this.events) eng.handle(e, 0.05 + e.time / 1000, e.playerId);
    eng.allOff(null, len - 1.5);
    const buf = await ctx.startRendering();
    return encodeWav(buf);
  },
};

function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([data], { type: 'audio/wav' });
}

export { INSTRUMENTS };
