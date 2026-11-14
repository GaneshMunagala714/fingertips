// Musical intent mapping: hands, keyboard and pointer all end up calling the same few functions,
// which emit canonical events on the bus. Nothing here makes sound or pixels directly.
import { bus } from './bus.js';
import { diatonicChord, scaleLadder, midiToName } from './theory.js';
import { transport } from './transport.js';
import { clock } from './clock.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export const play = {
  mode: 'chord',           // chord | melody | rhythm
  oneHand: false,
  key: 'C',
  scale: 'major',          // melody scale: major | minor | pentatonic
  chromatic: false,
  sevenths: false,
  instrument: 'pad',
  volume: 0.75,
  filter: 0.7,
  chord: null,             // { name, notes, degree }
  inversion: 0,
  sustain: false,
  melody: null,            // { midi, idx }
  melodyIdx: -1,
  lastDrum: {},
  _lastExpr: -Infinity, _sentVol: -1, _sentFil: -1,
  _fistSince: 0, _invCand: 0, _invSince: 0,
};

export function ladder() {
  return scaleLadder(play.key, play.chromatic ? 'chromatic' : play.scale, play.chromatic ? 1 : 2, 4);
}

// ------------------------------------------------------------------ actions (shared by every input)

export function playChord(degree) {
  const c = diatonicChord(play.key, degree, { seventh: play.sevenths, inversion: play.inversion });
  if (play.chord && play.chord.name === c.name && play.chord.notes.join() === c.notes.join()) return;
  play.chord = c;
  bus.emit({ type: 'chord', notes: c.notes, chord: c.name, degree, velocity: 0.8, instrument: play.instrument });
}
export function stopChord() {
  if (!play.chord) return;
  play.chord = null;
  bus.emit({ type: 'chordOff', instrument: play.instrument });
}
export function noteOn(midi, velocity = 0.8) {
  if (play.melody?.midi === midi) return;
  if (play.melody) bus.emit({ type: 'noteOff', midi: play.melody.midi, instrument: play.instrument });
  play.melody = { midi };
  bus.emit({ type: 'noteOn', midi, velocity: clamp(velocity, 0.15, 1), instrument: play.instrument, t: transport.snap(clock.now()) });
}
export function noteOff() {
  if (!play.melody) return;
  bus.emit({ type: 'noteOff', midi: play.melody.midi, instrument: play.instrument });
  play.melody = null;
}
export function drum(type, velocity = 0.85, src = 'key') {
  const now = performance.now();
  if (now - (play.lastDrum[src] ?? -Infinity) < 110) return; // no machine-gun retriggers
  play.lastDrum[src] = now;
  const t = transport.snap(clock.now());
  transport.recordHit(type, t);
  bus.emit({ type: 'drum', drum: type, velocity: clamp(velocity, 0.2, 1), instrument: 'drums', t });
}
export function setExpr({ volume, filter }, force = false) {
  if (volume != null) play.volume = clamp(volume);
  if (filter != null) play.filter = clamp(filter);
  const now = performance.now();
  const changed = Math.abs(play.volume - play._sentVol) > 0.02 || Math.abs(play.filter - play._sentFil) > 0.02;
  if (!force && (!changed || now - play._lastExpr < 50)) return;
  play._lastExpr = now; play._sentVol = play.volume; play._sentFil = play.filter;
  bus.emit({ type: 'expr', volume: +play.volume.toFixed(3), filter: +play.filter.toFixed(3), instrument: play.instrument });
}
export function allOff() {
  play.chord = null; play.melody = null;
  bus.emit({ type: 'allOff', instrument: play.instrument });
}
export function setMode(m) {
  if (m === play.mode) return;
  noteOff();
  play.mode = m;
  bus.signal('mode', m);
}

// ------------------------------------------------------------------ hands -> intents

const heightToLevel = (y) => clamp(1 - (y - 0.12) / 0.7);
const tiltToFilter = (tilt) => clamp(0.6 + tilt / 1.3);

export function fromHands(hands, t) {
  const L = hands.left, R = hands.right;
  const any = R.present ? R : L.present ? L : null;
  if (play.mode === 'chord') {
    const chordHand = play.oneHand ? any : L;
    const exprHand = play.oneHand ? any : R;
    if (exprHand?.present) {
      setExpr({ volume: heightToLevel(exprHand.y), filter: tiltToFilter(exprHand.tilt) });
      if (!play.oneHand) {
        play.sustain = exprHand.pinch;
        // horizontal zone of the right hand picks the voicing (root / 1st / 2nd inversion), held 250ms
        const inv = exprHand.x < 0.66 ? 0 : exprHand.x < 0.83 ? 1 : 2;
        if (inv !== play._invCand) { play._invCand = inv; play._invSince = t; }
        if (inv !== play.inversion && t - play._invSince > 250) {
          play.inversion = inv;
          if (play.chord) { const d = play.chord.degree; play.chord = null; playChord(d); }
        }
      }
    } else if (!play.oneHand) play.sustain = false;
    if (chordHand?.present) {
      const n = chordHand.count;
      if (n >= 1 && n <= 5) playChord(n);
      else if (n === 0 && !play.sustain) stopChord();
    } else if (!play.sustain) stopChord();
  } else if (play.mode === 'melody') {
    const h = play.oneHand ? any : (R.present ? R : L.present ? L : null);
    if (!h) { noteOff(); return; }
    const lad = ladder();
    // pitch from horizontal position, with hysteresis so a note doesn't flicker at a boundary
    const pos = clamp((h.x - 0.08) / 0.84) * lad.length;
    let idx = play.melodyIdx;
    if (idx < 0 || pos < idx - 0.2 || pos > idx + 1.2) idx = Math.min(lad.length - 1, Math.floor(pos));
    play.melodyIdx = idx;
    const level = heightToLevel(h.y);
    setExpr({ volume: 0.35 + level * 0.65, filter: tiltToFilter(h.tilt) });
    if (h.count === 0 && h.openness < 1.0) {
      if (!play._fistSince) play._fistSince = t;
      if (t - play._fistSince > 600) { noteOff(); return; }
    } else play._fistSince = 0;
    if (h.pinch) noteOn(lad[idx], 0.4 + level * 0.6);
    else noteOff();
  } else if (play.mode === 'rhythm') {
    for (const h of [L, R]) {
      if (!h.present) { h._wasPinch = false; continue; }
      if (h.pinch && !h._wasPinch) {
        const type = h.x < 0.36 ? 'kick' : h.x < 0.64 ? 'snare' : 'hat';
        drum(type, 0.55 + heightToLevel(h.y) * 0.45, h.side);
      }
      h._wasPinch = h.pinch;
    }
  }
}

/** Tracking was lost for a hand: never leave a note hanging. */
export function onHandLost(side) {
  if (play.mode === 'melody') noteOff();
  if (play.mode === 'chord' && !play.sustain && (play.oneHand || side === 'left')) stopChord();
}

// ------------------------------------------------------------------ keyboard

const MELODY_KEYS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"];
const keyDown = new Set();

export function bindKeyboard(isActive) {
  addEventListener('keydown', (e) => {
    if (!isActive() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (keyDown.has(k)) return;
    keyDown.add(k);
    let handled = true;
    if (k >= '1' && k <= '7') playChord(+k);
    else if (k === '0') stopChord();
    else if (MELODY_KEYS.includes(k)) {
      const lad = ladder();
      const i = Math.min(lad.length - 1, MELODY_KEYS.indexOf(k));
      play.melodyIdx = i;
      noteOn(lad[i], 0.8);
    } else if (k === 'z') drum('kick', 0.9);
    else if (k === 'x') drum('snare', 0.85);
    else if (k === 'c') drum('hat', 0.7);
    else if (k === 'arrowup') setExpr({ volume: play.volume + 0.08 }, true);
    else if (k === 'arrowdown') setExpr({ volume: play.volume - 0.08 }, true);
    else if (k === 'arrowright') setExpr({ filter: play.filter + 0.08 }, true);
    else if (k === 'arrowleft') setExpr({ filter: play.filter - 0.08 }, true);
    else if (k === 'q') setMode('chord');
    else if (k === 'w') setMode('melody');
    else if (k === 'e') setMode('rhythm');
    else if (k === 'escape') allOff();
    else { handled = false; keyDown.delete(k); }
    if (handled) e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    keyDown.delete(k);
    if (MELODY_KEYS.includes(k) && play.melody) {
      const lad = ladder();
      if (play.melody.midi === lad[Math.min(lad.length - 1, MELODY_KEYS.indexOf(k))]) noteOff();
    }
  });
  addEventListener('blur', () => { keyDown.clear(); noteOff(); });
}

export const describeNote = (m) => midiToName(m);
