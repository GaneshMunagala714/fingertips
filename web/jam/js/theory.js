// Music theory: note names, scales, diatonic chords. Pure functions, no DOM.
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const KEYS = ['C', 'D', 'Eb', 'E', 'F', 'G', 'A', 'Bb'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const midiToName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
export const pcName = (m) => NOTE_NAMES[((m % 12) + 12) % 12];
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const keyPc = (key) => NOTE_NAMES.indexOf(key);

// Interval names for drawing chord structure.
export const INTERVAL_NAMES = { 3: 'm3', 4: 'M3', 5: 'P4', 6: 'tritone', 7: 'P5', 10: 'm7', 11: 'M7', 8: 'm6', 9: 'M6' };

/**
 * Diatonic chord on a degree (1-7) of a major key.
 * Default gesture bank: 1=I, 2=ii, 3=iii, 4=IV, 5=V (so in C: C, Dm, Em, F, G).
 * Keyboard also reaches 6=vi and 7=vii°.
 */
export function diatonicChord(key, degree, { seventh = false, inversion = 0, octave = 4 } = {}) {
  const scale = SCALES.major;
  const root = keyPc(key) + 12 * (octave); // C4 = 60 when key is C and octave 4 -> 12*(4+1)
  const base = 12 + root;                    // midi of tonic in requested octave
  const tones = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  const notes = tones.map((step) => {
    const idx = degree - 1 + step;
    return base + scale[idx % 7] + 12 * Math.floor(idx / 7);
  });
  // keep chords in a comfortable range: drop roots above G4
  while (notes[0] > 67) for (let i = 0; i < notes.length; i++) notes[i] -= 12;
  for (let i = 0; i < inversion % notes.length; i++) notes.push(notes.shift() + 12);
  return { notes, name: chordName(notes, base + scale[degree - 1]), degree };
}

/** Name a chord from its notes and root (handles maj, m, dim, 7, maj7, m7, m7b5). */
export function chordName(notes, rootMidi) {
  const rel = new Set(notes.map((n) => (((n - rootMidi) % 12) + 12) % 12));
  const third = rel.has(4) ? 'M' : rel.has(3) ? 'm' : '';
  const fifth = rel.has(7) ? 'P' : rel.has(6) ? 'd' : '';
  const sev = rel.has(11) ? 'M7' : rel.has(10) ? '7' : '';
  const r = pcName(rootMidi);
  if (third === 'M' && fifth === 'P') return r + (sev === 'M7' ? 'maj7' : sev === '7' ? '7' : '');
  if (third === 'm' && fifth === 'P') return r + 'm' + (sev === '7' ? '7' : sev === 'M7' ? 'maj7' : '');
  if (third === 'm' && fifth === 'd') return r + (sev === '7' ? 'm7b5' : 'dim');
  return r;
}

export function chordQuality(name) {
  if (/m7b5|dim/.test(name)) return 'diminished';
  if (/maj7/.test(name)) return 'major 7th';
  if (/m7/.test(name)) return 'minor 7th';
  if (/7/.test(name)) return 'dominant 7th';
  if (/^[A-G][#b]?m/.test(name)) return 'minor';
  return 'major';
}

const ROMAN = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
export const roman = (degree) => ROMAN[degree - 1] || '';

/** A playable scale ladder (MIDI notes) spanning `octaves` from the key's tonic at `octave`. */
export function scaleLadder(key, scaleName, octaves = 2, octave = 4) {
  const steps = SCALES[scaleName] || SCALES.major;
  const base = 12 * (octave + 1) + keyPc(key);
  const out = [];
  for (let o = 0; o < octaves; o++) for (const s of steps) out.push(base + 12 * o + s);
  out.push(base + 12 * octaves);
  return out;
}
