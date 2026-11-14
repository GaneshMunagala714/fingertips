// Unit tests for JAM's pure logic (music theory, envelopes, gesture -> event mapping).
// Run: node --test tests/jam/
// These use *simulated* hand states, not a camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diatonicChord, scaleLadder, midiToName, midiToFreq, chordQuality } from '../../web/jam/js/theory.js';
import { envAmp } from '../../web/jam/js/audio.js';
import { bus } from '../../web/jam/js/bus.js';
import { play, fromHands, onHandLost, setMode } from '../../web/jam/js/controls.js';
import { tuning } from '../../web/jam/js/hands.js';

test('default gesture chord bank is C, Dm, Em, F, G with real notes', () => {
  const want = { 1: ['C', [60, 64, 67]], 2: ['Dm', [62, 65, 69]], 3: ['Em', [64, 67, 71]], 4: ['F', [65, 69, 72]], 5: ['G', [67, 71, 74]] };
  for (const [d, [name, notes]] of Object.entries(want)) {
    const c = diatonicChord('C', +d);
    assert.equal(c.name, name); assert.deepEqual(c.notes, notes);
  }
  assert.equal(diatonicChord('C', 7).name, 'Bdim');
  assert.equal(chordQuality('Bdim'), 'diminished');
});

test('sevenths, inversions and other keys', () => {
  assert.equal(diatonicChord('C', 1, { seventh: true }).name, 'Cmaj7');
  assert.equal(diatonicChord('C', 5, { seventh: true }).name, 'G7');
  assert.equal(diatonicChord('C', 2, { seventh: true }).name, 'Dm7');
  assert.equal(diatonicChord('C', 7, { seventh: true }).name, 'Bm7b5');
  assert.deepEqual(diatonicChord('C', 1, { inversion: 1 }).notes, [64, 67, 72]);
  assert.equal(diatonicChord('G', 1).name, 'G');
  assert.equal(diatonicChord('G', 5).name, 'D');
  assert.equal(diatonicChord('A', 2).name, 'Bm');
});

test('pitch mapping', () => {
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToFreq(69), 440);
  const lad = scaleLadder('C', 'major', 2, 4);
  assert.equal(lad.length, 15); assert.equal(lad[0], 60); assert.equal(lad[14], 84);
  assert.deepEqual(scaleLadder('C', 'pentatonic', 1, 4), [60, 62, 64, 67, 69, 72]);
});

test('visual amplitude follows the synth envelope', () => {
  assert.equal(envAmp('pad', 1, 0, null, 0), 0);
  assert.ok(envAmp('pad', 1, 0, null, 0.3) > 0.4);                // rising in the attack
  assert.ok(Math.abs(envAmp('pad', 1, 0, null, 10) - 0.75) < 0.01); // settles at sustain
  const held = envAmp('piano', 1, 0, 1, 1);
  assert.ok(envAmp('piano', 1, 0, 1, 1.3) < held * 0.2);           // decays after release
  assert.ok(envAmp('piano', 0.5, 0, null, 0.1) < envAmp('piano', 1, 0, null, 0.1)); // velocity scales it
});

// ---------------------------------------------------------------- gesture mapping with simulated hands
const events = [];
bus.on((e) => events.push(e));
const hand = (side, o = {}) => ({ side, present: true, x: 0.5, y: 0.5, tilt: 0, openness: 1.5, pinch: false, count: -1, ...o });
const absent = (side) => ({ side, present: false });

test('chord mode: stable left-hand finger count selects chord, fist stops it', () => {
  setMode('chord'); events.length = 0; play.chord = null;
  fromHands({ left: hand('left', { count: 3 }), right: hand('right', { y: 0.2, x: 0.6 }) }, 1000);
  const ch = events.find((e) => e.type === 'chord');
  assert.equal(ch.chord, 'Em'); assert.deepEqual(ch.notes, [64, 67, 71]);
  const ex = events.find((e) => e.type === 'expr');
  assert.ok(ex.volume > 0.8, 'raised right hand = loud');
  events.length = 0;
  fromHands({ left: hand('left', { count: 3 }), right: hand('right', { y: 0.2, x: 0.6 }) }, 1016);
  assert.equal(events.filter((e) => e.type === 'chord').length, 0, 'same gesture does not retrigger');
  fromHands({ left: hand('left', { count: 0 }), right: absent('right') }, 1100);
  assert.ok(events.some((e) => e.type === 'chordOff'));
});

test('chord mode: unconfirmed count (-1) does nothing; losing the hand releases the chord', () => {
  setMode('chord'); play.chord = null; events.length = 0;
  fromHands({ left: hand('left', { count: -1 }), right: absent('right') }, 2000);
  assert.equal(events.filter((e) => e.type === 'chord').length, 0);
  fromHands({ left: hand('left', { count: 5 }), right: absent('right') }, 2100);
  assert.equal(events.at(-1).chord, 'G');
  onHandLost('left');
  assert.equal(events.at(-1).type, 'chordOff');
});

test('melody mode: x picks a scale note, pinch plays, release stops', () => {
  setMode('melody'); events.length = 0; play.melody = null; play.melodyIdx = -1;
  fromHands({ left: absent('left'), right: hand('right', { x: 0.09, pinch: true }) }, 3000);
  const on = events.find((e) => e.type === 'noteOn');
  assert.equal(on.midi, 60, 'far left = tonic C4');
  fromHands({ left: absent('left'), right: hand('right', { x: 0.91, pinch: true }) }, 3050);
  const on2 = events.filter((e) => e.type === 'noteOn').at(-1);
  assert.equal(on2.midi, 84, 'far right = C6');
  assert.ok(events.some((e) => e.type === 'noteOff' && e.midi === 60), 'previous note released');
  fromHands({ left: absent('left'), right: hand('right', { x: 0.91, pinch: false }) }, 3100);
  assert.equal(events.at(-1).type, 'noteOff');
  assert.equal(play.melody, null);
});

test('rhythm mode: pinch onset in each zone = kick / snare / hat, no retrigger while held', () => {
  setMode('rhythm'); events.length = 0;
  const L = hand('left', { x: 0.1, pinch: false }), R = hand('right', { x: 0.9, pinch: false });
  fromHands({ left: L, right: R }, 4000);
  L.pinch = true; fromHands({ left: L, right: R }, 4016);
  fromHands({ left: L, right: R }, 4032); // still pinched: no new hit
  assert.deepEqual(events.filter((e) => e.type === 'drum').map((e) => e.drum), ['kick']);
  R.pinch = true; fromHands({ left: L, right: R }, 4050);
  assert.equal(events.filter((e) => e.type === 'drum').at(-1).drum, 'hat');
});

test('one-hand mode: a single hand chooses chords and volume', () => {
  setMode('chord'); play.oneHand = true; play.chord = null; play._lastExpr = -Infinity; events.length = 0;
  fromHands({ left: absent('left'), right: hand('right', { count: 4, y: 0.8 }) }, 5000);
  assert.equal(events.find((e) => e.type === 'chord').chord, 'F');
  assert.ok(events.find((e) => e.type === 'expr').volume < 0.3);
  play.oneHand = false;
  assert.ok(tuning.stableMs > 0);
});
