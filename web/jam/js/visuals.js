// Generative stage. Everything drawn here comes from real music events:
//   pitch      -> vertical position (MIDI, C2 at the bottom .. C7 at the top), optional note labels
//   dynamics   -> ribbon width / glow / size, computed from the same ADSR envelope the synth plays,
//                 scaled by the player's channel volume; background glow follows the *measured* output level
//   harmony    -> chord notes drawn as connected nodes with interval labels and the chord name
//   rhythm     -> time scrolls right-to-left past a "now" line; beat lines, metronome dots, 16-step grid
//   timbre     -> each instrument has its own mark (points+arcs, flowing trails, rings, soft ribbons, pulses)
//   player     -> colour AND node shape (circle / diamond / square / triangle), never colour alone
import { envAmp, INSTRUMENTS } from './audio.js';
import { midiToName, chordQuality, roman, INTERVAL_NAMES } from './theory.js';
import { clock } from './clock.js';
import { transport } from './transport.js';

export const PLAYER_STYLE = {
  p1: { hue: 34, shape: 'circle', name: 'Player 1' },
  p2: { hue: 196, shape: 'diamond', name: 'Player 2' },
  p3: { hue: 352, shape: 'square', name: 'Player 3' },
  p4: { hue: 140, shape: 'triangle', name: 'Player 4' },
};
const styleFor = (key) => PLAYER_STYLE[key.replace(/^r/, '')] || PLAYER_STYLE.p1;

export const view = {
  theme: 'aurora',          // aurora | constellation | garden
  labels: true,
  intensity: 0.8,           // 0..1
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  simplified: false,
  highContrast: false,
  showCursors: true,
};

const MIDI_LO = 45, MIDI_HI = 89; // A2 .. F6 covers every chord and melody note we play

export class Stage {
  constructor(canvas, engineRef) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.engineRef = engineRef;       // () => AudioEngine | null
    this.marks = [];                  // notes + drums
    this.open = new Map();            // `${key}:${midi}` -> mark
    this.chordMarks = new Map();      // key -> [mark]
    this.liveChord = new Map();       // key -> { name, notes, degree, at, nodes:[{midi,y}] }
    this.vol = new Map();             // key -> channel volume
    this.tone = new Map();            // key -> filter 0..1
    this.hits = [];                   // drum hits for the beat grid
    this.beatFlash = { beat: -1, at: 0, downbeat: false };
    this.particles = [];
    this.quality = 1;                 // adaptive 0.4..1
    this.frameMs = 16; this.fps = 60;
    this.glow = 0;
    this.sprites = new Map();
    this.hands = null; this.mode = null; this.ladder = []; this.melodyIdx = -1;
    this.inset = 90;                  // px reserved at the bottom for the toolbar / pads
    this.ripples = [];                // visible haptics: one ring per haptic pulse
    this.thump = null;                // strong pulses nudge the whole stage
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, this.quality < 0.7 ? 1 : 1.5);
    this.W = innerWidth; this.H = innerHeight;
    this.c.width = Math.floor(this.W * dpr); this.c.height = Math.floor(this.H * dpr);
    this.c.style.width = this.W + 'px'; this.c.style.height = this.H + 'px';
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.X0 = this.W * (this.W < 700 ? 0.62 : 0.70);   // the "now" line
    this._layout();
    this.speed = Math.max(60, this.W * 0.065);          // px per second of music
    this._seedParticles();
  }

  _layout() {
    this.top = this.H * 0.12;
    this.gridY = this.H - this.inset - 62;          // 16-step beat grid
    this.ladderY = this.gridY - 36;                 // melody note strip
    this.bottom = Math.max(this.H * 0.35, this.ladderY - 56);
  }
  setInset(px) { if (Math.abs(px - this.inset) > 2) { this.inset = px; this._layout(); } }

  _seedParticles() {
    const n = Math.round((this.W * this.H) / 14000 * this.quality * view.intensity);
    this.particles = Array.from({ length: n }, () => ({ x: Math.random() * this.W, y: Math.random() * this.H,
      r: Math.random() * 1.6 + 0.3, s: Math.random() * 0.25 + 0.05, p: Math.random() * 6.28 }));
  }

  y(midi) { return this.bottom - ((midi - MIDI_LO) / (MIDI_HI - MIDI_LO)) * (this.bottom - this.top); }
  x(t, now) { return this.X0 - ((now - t) / 1000) * this.speed; }
  color(key, l = 62, a = 1, midi = 60) {
    const s = styleFor(key);
    if (view.highContrast) return `hsla(${s.hue},100%,${Math.min(85, l + 15)}%,${a})`;
    return `hsla(${s.hue + (midi - 60) * 0.6},85%,${l}%,${a})`;
  }

  sprite(key) {
    let sp = this.sprites.get(key);
    if (sp) return sp;
    sp = document.createElement('canvas'); sp.width = sp.height = 64;
    const g = sp.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, this.color(key, 80, 0.9)); grd.addColorStop(0.25, this.color(key, 60, 0.45)); grd.addColorStop(1, this.color(key, 50, 0));
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this.sprites.set(key, sp);
    return sp;
  }

  // ---------------------------------------------------------------- events -> marks

  handle(ev) {
    const key = ev.origin === 'replay' ? 'r' + ev.playerId : ev.playerId;
    const at = ev.at;
    const close = (m) => { if (m && m.off == null) m.off = Math.max(at, m.on); };
    switch (ev.type) {
      case 'chord': {
        (this.chordMarks.get(key) || []).forEach(close);
        const ms = ev.notes.map((midi) => this._addNote(key, ev.instrument, midi, ev.velocity ?? 0.8, at, ev.id));
        ms.forEach((m) => { m.chordVel = 0.8; });
        this.chordMarks.set(key, ms);
        const prev = this.liveChord.get(key);
        this.liveChord.set(key, { name: ev.chord, notes: ev.notes, degree: ev.degree, at, inst: ev.instrument, marks: ms,
          nodes: ev.notes.map((m, i) => ({ midi: m, y: prev?.nodes[i]?.y ?? this.y(m) })) });
        break;
      }
      case 'chordOff':
        (this.chordMarks.get(key) || []).forEach(close);
        this.chordMarks.delete(key);
        this.liveChord.delete(key);
        break;
      case 'noteOn': {
        const k = `${key}:${ev.midi}`;
        close(this.open.get(k));
        const m = this._addNote(key, ev.instrument, ev.midi, ev.velocity ?? 0.8, at, null);
        if (ev.dur) m.off = at + ev.dur;
        this.open.set(k, m);
        break;
      }
      case 'noteOff': { const k = `${key}:${ev.midi}`; close(this.open.get(k)); this.open.delete(k); break; }
      case 'drum':
        this.marks.push({ kind: 'drum', key, drum: ev.drum, on: at, vel: ev.velocity ?? 0.85 });
        this.hits.push({ key, drum: ev.drum, at, vel: ev.velocity ?? 0.85 });
        if (this.hits.length > 64) this.hits.shift();
        break;
      case 'expr':
        if (ev.volume != null) this.vol.set(key, ev.volume);
        if (ev.filter != null) this.tone.set(key, ev.filter);
        break;
      case 'allOff':
        for (const [k, m] of this.open) if (k.startsWith(key + ':')) { close(m); this.open.delete(k); }
        (this.chordMarks.get(key) || []).forEach(close);
        this.chordMarks.delete(key); this.liveChord.delete(key);
        break;
    }
  }

  releasePlayer(key) { this.handle({ type: 'allOff', playerId: key, at: clock.now() }); }

  _addNote(key, inst, midi, vel, on, chordId) {
    const m = { kind: 'note', key, inst, midi, vel, on, off: null, chordId, seed: Math.random() * 6.28 };
    this.marks.push(m);
    return m;
  }

  onBeat(b) { this.beatFlash = { ...b }; }

  /** Loudness of a mark at room time t (ms): real envelope x the player's channel volume. */
  amp(m, t) {
    return envAmp(m.inst, m.vel, m.on / 1000, m.off == null ? null : m.off / 1000, t / 1000) * (this.vol.get(m.key) ?? 0.75);
  }
  tail(m) { return m.off == null ? Infinity : m.off + (INSTRUMENTS[m.inst]?.release ?? 0.5) * 1200; }

  // ---------------------------------------------------------------- frame

  frame(dtMs) {
    const t0 = performance.now();
    const now = clock.now();
    const g = this.g, W = this.W, H = this.H;
    const motion = !view.reducedMotion;
    const eng = this.engineRef();
    const level = eng ? eng.level() : 0;
    // smooth the glow (slow attack/release keeps it far below any flash/strobe threshold)
    this.glow += (level - this.glow) * (level > this.glow ? 0.12 : 0.04);

    // background
    g.globalCompositeOperation = 'source-over';
    if (view.highContrast) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    else {
      // flat neutral black that lifts slightly with the measured output level
      g.fillStyle = `hsl(30,4%,${2 + this.glow * 5 * view.intensity}%)`;
      g.fillRect(0, 0, W, H);
    }
    if (!view.simplified && !view.highContrast) this._particles(now, motion);
    if (!this.mode) { this._trackFrame(dtMs, t0); return; } // welcome screen: ambience only
    const shake = this._shake(motion);
    if (shake) { g.save(); g.translate(shake.x, shake.y); }
    this._pitchGuide();
    this._beatLines(now);

    // remove marks that have scrolled off
    const leftEdge = now - ((this.X0 + 80) / this.speed) * 1000;
    this.marks = this.marks.filter((m) => (m.kind === 'drum' ? m.on : this.tail(m)) > leftEdge);

    g.globalCompositeOperation = view.highContrast || view.simplified ? 'source-over' : 'lighter';
    const notes = this.marks.filter((m) => m.kind === 'note' && m.on <= now);
    if (view.theme === 'constellation') this._chordHistory(notes, now);
    for (const m of notes) this._note(m, now, motion);
    for (const m of this.marks) if (m.kind === 'drum' && m.on <= now) this._drumMark(m, now, motion);
    g.globalCompositeOperation = 'source-over';

    this._nowLine();
    this._liveChords(now);
    if (this.mode === 'melody') this._ladder();
    if (this.mode === 'rhythm') this._drumZones();
    this._beatGrid(now);
    if (shake) g.restore();
    this._ripples(motion);
    if (view.showCursors) this._cursors();

    this._trackFrame(dtMs, t0);
  }

  _trackFrame(dtMs, t0) {
    // adaptive quality
    const cost = performance.now() - t0;
    this.frameMs = this.frameMs * 0.95 + dtMs * 0.05;
    this.fps = 1000 / this.frameMs;
    this.drawMs = (this.drawMs || cost) * 0.9 + cost * 0.1;
    if (this.frameMs > 26 && this.quality > 0.4) { this.quality = Math.max(0.4, this.quality - 0.1); this._seedParticles(); if (this.quality < 0.7 && this.dpr > 1) this.resize(); }
    else if (this.frameMs < 18 && this.quality < 1 && Math.random() < 0.01) { this.quality = Math.min(1, this.quality + 0.1); }
  }

  _particles(now, motion) {
    const g = this.g;
    g.fillStyle = `rgba(255,255,255,${0.14 * view.intensity})`;
    for (const p of this.particles) {
      if (motion) { p.y -= p.s * (1 + this.glow * 3); p.x += Math.sin(now / 2000 + p.p) * 0.1; if (p.y < 0) { p.y = this.H; p.x = Math.random() * this.W; } }
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
    }
  }

  _pitchGuide() {
    const g = this.g;
    g.font = '600 11px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
    for (let m = 48; m <= MIDI_HI; m += 12) {
      const y = this.y(m);
      g.strokeStyle = view.highContrast ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(this.W, y); g.stroke();
      if (view.labels) { g.fillStyle = view.highContrast ? '#fff' : 'rgba(255,255,255,0.45)'; g.fillText(midiToName(m), 10, y - 4); }
    }
    g.fillStyle = view.highContrast ? '#fff' : 'rgba(255,255,255,0.4)';
    g.textAlign = 'right'; g.fillText('Higher notes sit higher  ·  time flows left', this.X0 - 8, this.top - 14); g.textAlign = 'left';
  }

  _beatLines(now) {
    if (!transport.playing) return;
    const g = this.g, bm = transport.beatMs();
    const first = Math.floor((now - transport.startAt - (this.X0 / this.speed) * 1000) / bm);
    const last = Math.ceil((now - transport.startAt) / bm);
    for (let b = first; b <= last; b++) {
      const t = transport.startAt + b * bm;
      const x = this.x(t, now);
      const down = ((b % 4) + 4) % 4 === 0;
      g.strokeStyle = view.highContrast ? `rgba(255,255,255,${down ? 0.5 : 0.2})` : `rgba(255,255,255,${down ? 0.16 : 0.06})`;
      g.lineWidth = down ? 2 : 1;
      g.beginPath(); g.moveTo(x, this.top - 10); g.lineTo(x, this.bottom + 10); g.stroke();
    }
  }

  _note(m, now, motion) {
    const g = this.g;
    const end = Math.min(now, this.tail(m));
    const x1 = this.x(m.on, now), x2 = this.x(end, now);
    const y = this.y(m.midi);
    const I = view.intensity;
    const theme = view.theme;
    const sharp = view.simplified || view.highContrast;
    const step = Math.max(3, 7 / this.quality);
    const span = x2 - x1;
    const n = Math.max(1, Math.ceil(span / step));
    const tAt = (x) => now - ((this.X0 - x) / this.speed) * 1000;
    const wave = (x, k) => (motion && !sharp ? Math.sin(x * 0.025 + now / 600 + m.seed) * k : 0);
    const nowAmp = this.amp(m, now);
    const peak = this.amp(m, m.on + (INSTRUMENTS[m.inst]?.attack ?? 0) * 1000 + 1);

    if (theme === 'aurora' || sharp) {
      // ribbon whose thickness at each point = loudness at that moment
      const width = { pad: 70, strings: 46, piano: 34, bells: 26 }[m.inst] || 40;
      const wv = { strings: 5, pad: 3, piano: 0, bells: 1 }[m.inst] ?? 2;
      g.beginPath();
      for (let i = 0; i <= n; i++) { const x = x1 + (span * i) / n; g.lineTo(x, y - 1 - this.amp(m, tAt(x)) * width * I - wave(x, wv)); }
      for (let i = n; i >= 0; i--) { const x = x1 + (span * i) / n; g.lineTo(x, y + 1 + this.amp(m, tAt(x)) * width * I - wave(x, wv)); }
      g.closePath();
      if (sharp) { g.fillStyle = this.color(m.key, 60, 0.85, m.midi); g.fill(); g.strokeStyle = view.highContrast ? '#fff' : 'rgba(0,0,0,0.5)'; g.lineWidth = 1; g.stroke(); }
      else {
        const grd = g.createLinearGradient(0, y - width, 0, y + width);
        const a = m.inst === 'pad' ? 0.28 : 0.5;
        grd.addColorStop(0, this.color(m.key, 60, 0, m.midi)); grd.addColorStop(0.5, this.color(m.key, 66, a, m.midi)); grd.addColorStop(1, this.color(m.key, 60, 0, m.midi));
        g.fillStyle = grd; g.fill();
        g.strokeStyle = this.color(m.key, 80, 0.5 * Math.min(1, nowAmp * 3 + 0.2), m.midi); g.lineWidth = 1.2;
        g.beginPath(); for (let i = 0; i <= n; i++) { const x = x1 + (span * i) / n; g.lineTo(x, y - wave(x, wv)); } g.stroke();
      }
    } else if (theme === 'constellation') {
      g.strokeStyle = this.color(m.key, 70, 0.15 + nowAmp * 0.8, m.midi);
      g.lineWidth = 1 + nowAmp * 3 * I;
      g.beginPath(); g.moveTo(x1, y); g.lineTo(x2, y); g.stroke();
      const tw = motion ? 0.85 + 0.15 * Math.sin(now / 300 + m.seed * 9) : 1;
      this._glow(m.key, x1, y, (10 + peak * 60 * I) * tw);
      if (m.off == null || now < this.tail(m)) this._glow(m.key, x2, y, 6 + nowAmp * 70 * I);
    } else { // garden
      // a vine grows for as long as the note sounds; a flower blooms at the onset
      g.strokeStyle = this.color(m.key, 45, 0.6, m.midi); g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i <= n; i++) { const x = x1 + (span * i) / n; g.lineTo(x, y + Math.sin((x - x1) * 0.06 + m.seed) * (4 + this.amp(m, tAt(x)) * 14)); }
      g.stroke();
      const petals = { piano: 5, strings: 6, bells: 8, pad: 4 }[m.inst] || 5;
      const r = 6 + peak * 34 * I;
      const bloom = Math.min(1, (now - m.on) / 250);
      g.fillStyle = this.color(m.key, 62, 0.35 + nowAmp * 0.6, m.midi);
      for (let p = 0; p < petals; p++) {
        const a = (p / petals) * 6.283 + m.seed + (motion ? now / 4000 : 0);
        g.beginPath(); g.ellipse(x1 + Math.cos(a) * r * 0.55 * bloom, y + Math.sin(a) * r * 0.55 * bloom, r * 0.5 * bloom, r * 0.22 * bloom, a, 0, 6.283); g.fill();
      }
      g.fillStyle = this.color(m.key, 85, 0.9, m.midi); g.beginPath(); g.arc(x1, y, 2.5 + nowAmp * 6, 0, 6.283); g.fill();
    }

    // instrument signatures on top of any theme
    const age = (now - m.on) / 1000;
    if (m.inst === 'piano' && age < 1.6 && !sharp) {           // defined point + decaying arc
      g.strokeStyle = this.color(m.key, 80, 0.6 * (1 - age / 1.6), m.midi); g.lineWidth = 1.5;
      g.beginPath(); g.arc(x1, y, 8 + age * 30, -1.2, 1.2); g.stroke();
    }
    if (m.inst === 'bells' && age < 2.5) {                     // expanding rings
      for (let k = 0; k < 3; k++) {
        const r = motion ? 6 + (age * 40 + k * 14) : 10 + k * 8;
        g.strokeStyle = this.color(m.key, 75, Math.max(0, 0.5 * (1 - age / 2.5) - k * 0.12), m.midi);
        g.lineWidth = 1.2; g.beginPath(); g.arc(x1, y, r, 0, 6.283); g.stroke();
      }
    }
    // player shape marker at the onset so identity never relies on colour
    this._shape(styleFor(m.key).shape, x1, y, 4 + peak * 6, this.color(m.key, 85, 0.9, m.midi), sharp);
    if (view.labels && (x2 - x1 > 18 || now - m.on < 1500)) {
      g.font = '600 11px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
      g.fillStyle = view.highContrast ? '#fff' : 'rgba(240,240,245,0.85)';
      g.fillText(midiToName(m.midi), x1 + 7, y - 9);
    }
  }

  _chordHistory(notes, now) {
    // constellation: draw the chord's notes as a connected figure at its onset
    const groups = new Map();
    for (const m of notes) if (m.chordId) { if (!groups.has(m.chordId)) groups.set(m.chordId, []); groups.get(m.chordId).push(m); }
    const g = this.g;
    for (const ms of groups.values()) {
      ms.sort((a, b) => a.midi - b.midi);
      const x = this.x(ms[0].on, now);
      const a = this.amp(ms[0], now);
      g.strokeStyle = this.color(ms[0].key, 75, 0.25 + a, 60); g.lineWidth = 1;
      g.beginPath();
      ms.forEach((m, i) => { const px = x + (i % 2 ? 14 : -14) * (i ? 1 : 0); i ? g.lineTo(px, this.y(m.midi)) : g.moveTo(x, this.y(m.midi)); });
      g.stroke();
    }
  }

  _glow(key, x, y, r) {
    if (r < 1) return;
    this.g.drawImage(this.sprite(key), x - r, y - r, r * 2, r * 2);
  }

  _shape(shape, x, y, r, fill, outline) {
    const g = this.g;
    g.fillStyle = fill;
    g.beginPath();
    if (shape === 'circle') g.arc(x, y, r, 0, 6.283);
    else if (shape === 'diamond') { g.moveTo(x, y - r * 1.3); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.3); g.lineTo(x - r, y); g.closePath(); }
    else if (shape === 'square') g.rect(x - r, y - r, r * 2, r * 2);
    else { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.1, y + r * 0.8); g.lineTo(x - r * 1.1, y + r * 0.8); g.closePath(); }
    g.fill();
    if (outline) { g.strokeStyle = view.highContrast ? '#fff' : '#000'; g.lineWidth = 1.5; g.stroke(); }
  }

  _drumMark(m, now, motion) {
    const g = this.g;
    const x = this.x(m.on, now);
    const age = (now - m.on) / 1000;
    const y = this.bottom + 18 + { kick: 26, snare: 13, hat: 0 }[m.drum];
    const r = { kick: 13, snare: 9, hat: 6 }[m.drum] * (0.6 + m.vel * 0.6);
    const pulse = motion && age < 0.4 ? 1 + (0.4 - age) * 2.5 : 1;
    const alpha = Math.max(0.25, 1 - age / 3);
    g.strokeStyle = this.color(m.key, 72, alpha, 60); g.lineWidth = 2;
    g.save(); g.translate(x, y); g.rotate(m.drum === 'snare' ? 0.785 : 0);
    g.beginPath();
    const R = r * pulse;
    if (m.drum === 'kick') g.arc(0, 0, R, 0, 6.283);
    else if (m.drum === 'snare') g.rect(-R * 0.75, -R * 0.75, R * 1.5, R * 1.5);
    else { g.moveTo(0, -R); g.lineTo(R * 0.9, R * 0.6); g.lineTo(-R * 0.9, R * 0.6); g.closePath(); }
    g.stroke(); g.restore();
    if (view.theme === 'garden' && !view.simplified) { // rhythm grows little shoots from the ground
      g.strokeStyle = this.color(m.key, 45, alpha * 0.6, 60);
      g.beginPath(); g.moveTo(x, y - r); g.quadraticCurveTo(x + 6, y - r - 18 * m.vel, x, y - r - 30 * m.vel); g.stroke();
    }
  }

  _nowLine() {
    const g = this.g;
    const grd = g.createLinearGradient(0, this.top, 0, this.bottom);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.5, `rgba(255,255,255,${view.highContrast ? 0.8 : 0.25})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(this.X0 - 1, this.top - 20, 2, this.bottom - this.top + 40);
  }

  _liveChords(now) {
    const g = this.g;
    const keys = [...this.liveChord.keys()];
    keys.forEach((key, i) => {
      const c = this.liveChord.get(key);
      if (c.at > now) return;
      const cx = this.X0 + (this.W - this.X0) * (0.42 + i * 0.3);
      // smooth transition: nodes glide to their new pitches
      c.nodes.forEach((n) => { n.y += (this.y(n.midi) - n.y) * 0.18; });
      const amps = c.marks.map((m) => this.amp(m, now));
      const pts = c.nodes.map((n, j) => ({ x: cx + (j % 2 ? 22 : -22) * (j === 0 ? 0 : 1), y: n.y, midi: n.midi, a: amps[j] || 0 }));
      g.lineWidth = view.highContrast ? 3 : 1.6;
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j - 1], q = pts[j];
        g.strokeStyle = this.color(key, 75, 0.7, 60);
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
        if (view.labels) {
          const iv = INTERVAL_NAMES[(q.midi - p.midi) % 12] || '';
          g.font = '500 10px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'; g.fillStyle = 'rgba(240,240,245,0.7)';
          g.textAlign = 'right'; g.fillText(iv, Math.min(p.x, q.x) - 10, (p.y + q.y) / 2 + 3); g.textAlign = 'left';
        }
      }
      if (pts.length > 2) { // close the shape: the chord's geometry
        g.strokeStyle = this.color(key, 75, 0.25, 60); g.setLineDash([3, 5]);
        g.beginPath(); g.moveTo(pts[0].x, pts[0].y); g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); g.stroke(); g.setLineDash([]);
      }
      g.globalCompositeOperation = view.highContrast ? 'source-over' : 'lighter';
      for (const p of pts) if (!view.simplified) this._glow(key, p.x, p.y, 10 + p.a * 90 * view.intensity);
      g.globalCompositeOperation = 'source-over';
      for (const p of pts) {
        this._shape(styleFor(key).shape, p.x, p.y, 6 + p.a * 10, this.color(key, 85, 1, p.midi), true);
        if (view.labels) {
          g.font = '700 13px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'; g.fillStyle = view.highContrast ? '#fff' : '#eef';
          g.fillText(midiToName(p.midi), p.x + 14, p.y + 4);
        }
      }
      const topY = Math.min(...pts.map((p) => p.y)) - 34;
      g.textAlign = 'center';
      g.font = '700 26px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'; g.fillStyle = view.highContrast ? '#ff0' : this.color(key, 82, 1, 60);
      g.fillText(c.name, cx, topY);
      g.font = '500 12px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'; g.fillStyle = view.highContrast ? '#fff' : 'rgba(240,240,245,0.75)';
      g.fillText(`${c.degree ? roman(c.degree) + ' · ' : ''}${chordQuality(c.name)} · ${c.notes.length} notes`, cx, topY + 17);
      g.textAlign = 'left';
    });
  }

  _ladder() {
    // the melody keyboard: horizontal hand position -> scale step. Drawn just above the beat grid.
    const g = this.g, lad = this.ladder, n = lad.length;
    if (!n) return;
    const x0 = this.W * 0.08, w = this.W * 0.84, y = this.ladderY, h = 26;
    for (let i = 0; i < n; i++) {
      const x = x0 + (w * i) / n, on = i === this.melodyIdx;
      g.fillStyle = on ? 'rgba(255,255,255,0.85)' : view.highContrast ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)';
      g.fillRect(x + 1, y, w / n - 2, h);
      g.fillStyle = on ? '#111' : view.highContrast ? '#fff' : 'rgba(240,240,245,0.8)';
      g.font = `${on ? 700 : 500} 11px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif`; g.textAlign = 'center';
      g.fillText(midiToName(lad[i]), x + w / n / 2, y + 17);
    }
    g.textAlign = 'left';
  }

  _drumZones() {
    const g = this.g;
    const names = [['kick', 0, 0.36], ['snare', 0.36, 0.64], ['hat', 0.64, 1]];
    for (const [name, a, b] of names) {
      g.fillStyle = view.highContrast ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.035)';
      g.fillRect(this.W * a + 2, this.top, this.W * (b - a) - 4, this.bottom - this.top);
      g.font = '700 14px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'; g.textAlign = 'center';
      g.fillStyle = view.highContrast ? '#fff' : 'rgba(240,240,245,0.45)';
      g.fillText(`${name.toUpperCase()} — pinch here`, this.W * (a + b) / 2, this.top + 10);
    }
    g.textAlign = 'left';
  }

  _beatGrid(now) {
    const g = this.g;
    const W = this.W;
    const y0 = this.gridY, x0 = Math.max(W * 0.1, 150), w = W * 0.92 - x0;
    const rows = ['kick', 'snare', 'hat'];
    const pos = transport.position(now);
    // metronome: four beat dots + BPM
    const beatIn = pos ? Math.floor(pos.step / 4) : -1;
    g.font = '700 13px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
    g.fillStyle = view.highContrast ? '#fff' : 'rgba(240,240,245,0.85)';
    g.fillText(`${transport.tempo} BPM`, 12, y0 + 12);
    g.font = '500 11px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
    g.fillText(pos ? `beat ${beatIn + 1} / 4` : 'stopped', 12, y0 + 28);
    for (let b = 0; b < 4; b++) {
      const cx = 22 + b * 16, cy = y0 + 46, on = b === beatIn;
      g.beginPath(); g.arc(cx, cy, on ? 6 : 4, 0, 6.283);
      g.fillStyle = on ? (b === 0 ? '#ffb340' : '#fff') : 'rgba(255,255,255,0.18)'; g.fill();
    }
    // 16-step grid (one bar), rows = drums
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 16; s++) {
        const x = x0 + (w * s) / 16, y = y0 + r * 18;
        const filled = transport.pattern[rows[r]][s];
        g.fillStyle = filled ? 'rgba(255,179,64,0.85)' : s % 4 === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
        if (view.highContrast && !filled) g.fillStyle = 'rgba(255,255,255,0.2)';
        g.fillRect(x + 1, y, w / 16 - 2, 14);
      }
      g.fillStyle = 'rgba(240,240,245,0.6)'; g.font = '500 10px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
      g.textAlign = 'right'; g.fillText(rows[r], x0 - 8, y0 + r * 18 + 11); g.textAlign = 'left';
    }
    // live hits appear where they landed in the bar
    if (pos) {
      for (const h of this.hits) {
        const age = (now - h.at) / 1000;
        if (age < 0 || age > 1.2) continue;
        const s = (((h.at - transport.startAt) / transport.stepMs()) % 16 + 16) % 16;
        const r = rows.indexOf(h.drum);
        g.strokeStyle = this.color(h.key, 75, 1 - age / 1.2, 60); g.lineWidth = 2;
        g.strokeRect(x0 + (w * s) / 16 - 2, y0 + r * 18 - 2, w / 16, 18);
      }
      const px = x0 + (w * pos.step) / 16;
      g.fillStyle = view.highContrast ? '#ff0' : 'rgba(255,255,255,0.8)';
      g.fillRect(px - 1, y0 - 4, 2, 3 * 18 + 4);
    }
  }

  /** Visible haptics: rings for every pulse of a haptic pattern, at the hand (or note) that caused it. */
  ripple(x, y, key, pattern, strong = false) {
    const t = performance.now();
    for (const p of pattern) this.ripples.push({ x, y, key, t0: t + p.d, amp: p.amp, ms: p.ms });
    if (this.ripples.length > 90) this.ripples.splice(0, this.ripples.length - 90);
    if (strong) this.thump = { t0: t, amp: pattern[0]?.amp ?? 1, key };
  }

  _shake(motion) {
    if (!this.thump || !motion || view.simplified) return null;
    const k = (performance.now() - this.thump.t0) / 140;
    if (k >= 1) { this.thump = null; return null; }
    const a = 2.5 * this.thump.amp * (1 - k) * (1 - k);
    return { x: Math.sin(k * 31) * a, y: Math.cos(k * 23) * a * 0.6 };
  }

  _ripples(motion) {
    const g = this.g, now = performance.now();
    this.ripples = this.ripples.filter((r) => now - r.t0 < 900);
    for (const r of this.ripples) {
      const age = (now - r.t0) / 1000;
      if (age < 0) continue;
      const dur = 0.5 + r.amp * 0.35, k = Math.min(1, age / dur);
      if (k >= 1) continue;
      const ease = 1 - Math.pow(1 - k, 3);
      const rad = motion ? 16 + ease * (34 + r.amp * 96) : 30;
      const a = Math.pow(1 - k, 2) * (0.35 + 0.65 * r.amp) * view.intensity;
      g.strokeStyle = view.highContrast ? `rgba(255,255,255,${a})` : this.color(r.key, 74, a);
      g.lineWidth = 0.75 + r.amp * 4 * (1 - k);
      g.beginPath(); g.arc(r.x, r.y, rad, 0, 6.283); g.stroke();
      if (r.ms >= 20 && motion) { // long pulses read as heavier: a second, trailing ring
        g.lineWidth = 0.75 + r.amp * 2 * (1 - k);
        g.beginPath(); g.arc(r.x, r.y, rad * 0.62, 0, 6.283); g.stroke();
      }
    }
    if (this.thump && !view.simplified) { // the screen edge takes the hit too
      const k = (now - this.thump.t0) / 260;
      if (k < 1) {
        g.save();
        g.strokeStyle = this.color(this.thump.key, 70, 0.28 * (1 - k) * this.thump.amp * view.intensity);
        g.lineWidth = 3 + 7 * (1 - k);
        g.strokeRect(0, 0, this.W, this.H);
        g.restore();
      }
    }
  }

  _cursors() {
    if (!this.hands) return;
    const g = this.g;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const h of Object.values(this.hands)) {
      if (!h.present) continue;
      const x = h.x * this.W, y = h.y * this.H;
      const r = h.pinch ? 17 : 24;
      // frosted disc with a hairline ring; fills in when pinching
      g.fillStyle = h.pinch ? 'rgba(255,179,64,0.92)' : 'rgba(255,255,255,0.10)';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.strokeStyle = h.pinch ? 'rgba(255,179,64,1)' : 'rgba(255,255,255,0.55)'; g.lineWidth = 1.25;
      g.beginPath(); g.arc(x, y, r + 0.5, 0, 6.283); g.stroke();
      g.fillStyle = h.pinch ? '#111' : '#f5f5f7';
      g.font = '600 15px -apple-system, "SF Pro Text", -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
      g.fillText(h.count < 0 ? '' : String(h.count), x, y + 0.5);
      g.font = '500 10px -apple-system, "SF Pro Text", -apple-system, "SF Pro Text", Inter, system-ui, sans-serif';
      g.fillStyle = 'rgba(245,245,247,0.6)';
      g.fillText(h.side === 'left' ? 'LEFT' : 'RIGHT', x, y + r + 12);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.arc(h.tip.x * this.W, h.tip.y * this.H, 3, 0, 6.283); g.fill();
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  /** Composite PNG of the current artwork. */
  snapshot() { return this.c.toDataURL('image/png'); }
}
