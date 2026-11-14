// Beat clock + 16-step loop, scheduled on the AudioContext clock with a look-ahead timer
// (setInterval only decides *what* to schedule; the audio clock decides *when* it sounds).
// Beats are derived from a shared start time, so every player in a room lands on the same downbeat.
import { bus } from './bus.js';
import { clock } from './clock.js';

const LOOKAHEAD_MS = 120;
const TICK_MS = 25;

export const transport = {
  tempo: 96,
  playing: false,
  startAt: 0,              // room ms of beat 0
  click: false,
  quantize: false,
  loopArmed: false,
  pattern: { kick: new Array(16).fill(false), snare: new Array(16).fill(false), hat: new Array(16).fill(false) },
  engine: null,
  _nextStep: 0,
  _timer: null,

  stepMs() { return 60000 / this.tempo / 4; },
  beatMs() { return 60000 / this.tempo; },

  set(playing, tempo, startAt) {
    this.tempo = tempo;
    this.playing = playing;
    this.startAt = startAt || clock.now() + 100;
    this._nextStep = Math.max(0, Math.ceil((clock.now() - this.startAt) / this.stepMs()));
    bus.signal('transport', { playing, tempo });
    if (playing && !this._timer) this._timer = setInterval(() => this._tick(), TICK_MS);
    if (!playing && this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /** Where the playhead is now: { step (float, 0..16), beat (int) } */
  position(now = clock.now()) {
    if (!this.playing) return null;
    const s = (now - this.startAt) / this.stepMs();
    return { step: ((s % 16) + 16) % 16, beat: Math.floor(s / 4), raw: s };
  },

  /** Snap a local event time forward to the next 16th note when quantize is on. */
  snap(t) {
    if (!this.playing || !this.quantize) return t;
    const sm = this.stepMs();
    const s = Math.round((t - this.startAt) / sm);
    const snapped = this.startAt + s * sm;
    return snapped < clock.now() - 5 ? snapped + sm : snapped;
  },

  /** While the loop is armed, a drum hit is written into the step it lands on. */
  recordHit(drum, t) {
    if (!this.playing || !this.loopArmed) return false;
    const s = Math.round((t - this.startAt) / this.stepMs());
    const idx = ((s % 16) + 16) % 16;
    this.pattern[drum][idx] = true;
    bus.signal('pattern', this.pattern);
    return true;
  },
  toggleStep(drum, idx) { this.pattern[drum][idx] = !this.pattern[drum][idx]; bus.signal('pattern', this.pattern); },
  clearPattern() { for (const k in this.pattern) this.pattern[k].fill(false); bus.signal('pattern', this.pattern); },

  _tick() {
    const horizon = clock.now() + LOOKAHEAD_MS;
    const sm = this.stepMs();
    let guard = 0;
    while (this.startAt + this._nextStep * sm < horizon && guard++ < 32) {
      const n = this._nextStep++;
      const at = this.startAt + n * sm;
      if (at < clock.now() - 50) continue; // skip steps we fell behind on (e.g. background tab)
      const idx = n % 16;
      if (n % 4 === 0) {
        const beat = n / 4;
        const downbeat = beat % 4 === 0;
        bus.signal('beat', { beat, downbeat, at });
        if (this.click && this.engine) this.engine.click(clock.toAudio(at), downbeat);
      }
      for (const drum of ['kick', 'snare', 'hat']) {
        if (this.pattern[drum][idx]) {
          bus.emit({ type: 'drum', drum, t: at, velocity: drum === 'hat' ? 0.6 : 0.85, instrument: 'drums', fromLoop: true });
        }
      }
    }
  },
};
