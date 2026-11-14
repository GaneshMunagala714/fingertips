// Web Audio synth. One AudioContext for the whole app (or an OfflineAudioContext for export).
// Signal path:  voice -> player channel (volume, tone filter) -> channel analyser -> master -> compressor
//               -> master analyser -> output gain (mute / master volume) -> speakers
// Analysers sit *before* the mute, so the visuals keep showing real dynamics when the sound is muted.
import { midiToFreq } from './theory.js';

export const INSTRUMENTS = {
  piano:   { label: 'Piano',     attack: 0.005, decay: 1.4, sustain: 0.12, release: 0.45, peak: 0.30 },
  strings: { label: 'Strings',   attack: 0.22,  decay: 0.4, sustain: 0.80, release: 0.7,  peak: 0.20, onset: 0.6 },
  bells:   { label: 'Bells',     attack: 0.002, decay: 2.6, sustain: 0.0,  release: 1.2,  peak: 0.28 },
  pad:     { label: 'Synth pad', attack: 0.45,  decay: 0.6, sustain: 0.75, release: 1.3,  peak: 0.16, onset: 0.55 },
  drums:   { label: 'Drums',     attack: 0.001, decay: 0.3, sustain: 0.0,  release: 0.1,  peak: 0.9 },
};
// Slow instruments still speak at once: they jump to `onset` x peak in ONSET_S, then swell to the peak.
// Without this a pad took ~0.5 s to be heard, which felt like lag between the hand and the sound.
export const ONSET_S = 0.012;
export const DRUM_ENV = { kick: { decay: 0.35, peak: 1 }, snare: { decay: 0.2, peak: 0.7 }, hat: { decay: 0.06, peak: 0.35 } };

/**
 * Envelope value (0..1, before channel volume) of a voice at time `now`, using the same ADSR the
 * synth schedules. Times in seconds. Used by the visuals so a note's glow follows its real loudness.
 */
export function envAmp(instrument, velocity, tOn, tOff, now) {
  const p = INSTRUMENTS[instrument] || INSTRUMENTS.piano;
  const seg = (t) => {
    if (t < 0) return 0;
    if (p.onset && t < ONSET_S) return (t / ONSET_S) * p.onset;
    if (p.onset && t < p.attack) return p.onset + (1 - p.onset) * (t - ONSET_S) / (p.attack - ONSET_S);
    if (t < p.attack) return t / p.attack;
    const d = t - p.attack;
    // exponential approach to sustain level, same shape as setTargetAtTime(decay/4)
    return p.sustain + (1 - p.sustain) * Math.exp(-d / (p.decay / 4));
  };
  let v;
  if (tOff == null || now < tOff) v = seg(now - tOn);
  else v = seg(tOff - tOn) * Math.exp(-(now - tOff) / (p.release / 4));
  return Math.max(0, v) * velocity;
}

export class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.connect(this.out);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.comp.connect(this.masterAnalyser);
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.comp);
    this.channels = new Map();       // key -> { vol, filter, analyser, volume, filterAmt }
    this.held = new Map();           // `${key}:${midi}` -> voice   (melody notes)
    this.chords = new Map();         // key -> [voice]
    this.noise = this._noiseBuffer();
    this._buf = new Float32Array(512);
    this.muted = false;
  }

  _noiseBuffer() {
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  channel(key) {
    let ch = this.channels.get(key);
    if (ch) return ch;
    const vol = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    vol.gain.value = 0.75;
    filter.frequency.value = cutoff(0.7);
    vol.connect(filter); filter.connect(analyser); analyser.connect(this.master);
    ch = { vol, filter, analyser, volume: 0.75, filterAmt: 0.7, buf: new Float32Array(256) };
    this.channels.set(key, ch);
    return ch;
  }

  setMuted(m) {
    this.muted = m;
    this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.03);
  }
  setMasterVolume(v) { this.master.gain.setTargetAtTime(0.85 * v, this.ctx.currentTime, 0.05); }

  /** Measured RMS level (0..~1) of a player's channel, or of the master if no key. */
  level(key) {
    const ch = key ? this.channels.get(key) : null;
    const an = ch ? ch.analyser : this.masterAnalyser;
    const buf = ch ? ch.buf : this._buf;
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(s / buf.length) * 4);
  }

  /** Apply a music event at AudioContext time `when`. */
  handle(ev, when, key = ev.playerId) {
    const t = Math.max(when, this.ctx.currentTime);
    switch (ev.type) {
      case 'chord': {
        this._releaseChord(key, t);
        const vel = ev.velocity ?? 0.8;
        const voices = ev.notes.map((m) => this._voice(key, ev.instrument, m, vel * 0.8, t));
        this.chords.set(key, voices);
        break;
      }
      case 'chordOff': this._releaseChord(key, t); break;
      case 'noteOn': {
        const k = `${key}:${ev.midi}`;
        if (this.held.has(k)) this._release(this.held.get(k), t);
        this.held.set(k, this._voice(key, ev.instrument, ev.midi, ev.velocity ?? 0.8, t));
        if (ev.dur) this.handle({ type: 'noteOff', midi: ev.midi }, t + ev.dur / 1000, key);
        break;
      }
      case 'noteOff': {
        const k = `${key}:${ev.midi}`;
        const v = this.held.get(k);
        if (v && v.start <= t) { this._release(v, t); this.held.delete(k); }
        break;
      }
      case 'drum': this._drum(key, ev.drum, ev.velocity ?? 0.9, t); break;
      case 'expr': {
        const ch = this.channel(key);
        if (ev.volume != null) { ch.volume = ev.volume; ch.vol.gain.setTargetAtTime(ev.volume, t, 0.02); }
        if (ev.filter != null) { ch.filterAmt = ev.filter; ch.filter.frequency.setTargetAtTime(cutoff(ev.filter), t, 0.025); }
        break;
      }
      case 'allOff': this.allOff(key, t); break;
    }
  }

  allOff(key, when = this.ctx.currentTime) {
    for (const [k, v] of this.held) if (key == null || k.startsWith(key + ':')) { this._release(v, when, 0.08); this.held.delete(k); }
    for (const [k] of this.chords) if (key == null || k === key) this._releaseChord(k, when, 0.08);
  }

  _releaseChord(key, t, rel) {
    const vs = this.chords.get(key);
    if (vs) vs.forEach((v) => this._release(v, t, rel));
    this.chords.delete(key);
  }

  _voice(key, instrument, midi, vel, t) {
    const ctx = this.ctx;
    const p = INSTRUMENTS[instrument] || INSTRUMENTS.piano;
    const ch = this.channel(key);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    if (p.onset) env.gain.linearRampToValueAtTime(p.peak * vel * p.onset, t + ONSET_S);
    env.gain.linearRampToValueAtTime(p.peak * vel, t + p.attack);
    env.gain.setTargetAtTime(p.peak * vel * p.sustain, t + p.attack, p.decay / 4);
    env.connect(ch.vol);
    const f = midiToFreq(midi);
    const oscs = [];
    const osc = (type, freq, gain = 1, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(env);
      o.start(t); oscs.push(o);
      return o;
    };
    if (instrument === 'piano') {
      osc('triangle', f, 0.8); osc('sine', f * 2, 0.18); osc('sine', f * 3, 0.06);
    } else if (instrument === 'strings') {
      const a = osc('sawtooth', f, 0.35, -6); const b = osc('sawtooth', f, 0.35, 6);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
      const depth = ctx.createGain(); depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(5, t + 0.6);
      lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune); lfo.start(t); oscs.push(lfo);
    } else if (instrument === 'bells') {
      // two-operator FM: inharmonic ratio gives the bell shimmer; index decays with time
      const car = osc('sine', f, 0.9);
      const mod = ctx.createOscillator(); mod.frequency.value = f * 3.5;
      const idx = ctx.createGain(); idx.gain.setValueAtTime(f * 2.2, t); idx.gain.setTargetAtTime(f * 0.2, t, 0.4);
      mod.connect(idx); idx.connect(car.frequency); mod.start(t); oscs.push(mod);
      osc('sine', f * 2, 0.12);
    } else { // pad
      osc('sawtooth', f, 0.25, -11); osc('sawtooth', f, 0.25, 0); osc('sawtooth', f, 0.25, 11); osc('sine', f / 2, 0.3);
    }
    // instrument colour filter (in addition to the player's tone control)
    if (instrument === 'strings' || instrument === 'pad') {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = instrument === 'pad' ? 1400 : 2200;
      env.disconnect(); env.connect(lp); lp.connect(ch.vol);
    }
    return { env, oscs, start: t, released: false, peak: p.peak * vel, p };
  }

  _release(v, t, rel) {
    if (!v || v.released) return;
    v.released = true;
    const r = rel ?? v.p.release;
    const g = v.env.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.setTargetAtTime(0, t, r / 4);
    const stopAt = t + r * 1.6 + 0.05;
    v.oscs.forEach((o) => { try { o.stop(stopAt); } catch (_) {} });
    v.oscs[0].onended = () => { try { v.env.disconnect(); } catch (_) {} };
  }

  _drum(key, type, vel, t) {
    const ctx = this.ctx;
    const ch = this.channel(key);
    const g = ctx.createGain();
    g.connect(ch.vol);
    const d = DRUM_ENV[type] || DRUM_ENV.kick;
    g.gain.setValueAtTime(d.peak * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d.decay);
    if (type === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      o.connect(g); o.start(t); o.stop(t + d.decay + 0.05);
    } else {
      const n = ctx.createBufferSource(); n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type === 'hat' ? 'highpass' : 'bandpass';
      f.frequency.value = type === 'hat' ? 7000 : 1800;
      n.connect(f); f.connect(g); n.start(t); n.stop(t + d.decay + 0.05);
      if (type === 'snare') {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
        const og = ctx.createGain(); og.gain.setValueAtTime(0.35 * vel, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.connect(og); og.connect(ch.vol); o.start(t); o.stop(t + 0.15);
      }
    }
  }

  /** Soft metronome tick (not a music event; only when the click is enabled). */
  click(t, accent) {
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(accent ? 0.12 : 0.06, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.06);
  }
}

export const cutoff = (x) => 250 * Math.pow(2, x * 6.2); // 0..1 -> 250 Hz .. ~18 kHz
