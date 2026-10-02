/**
 * Note naming helpers.
 *
 * A timeline note has a MIDI number and, optionally, a `spelling` taken from a
 * score ({ step: 'B', alter: -1, octave: 3 }). When a spelling exists it wins,
 * because only the score knows whether a pitch is B♭ or A♯. Otherwise the
 * name is derived from the MIDI number using the flats/sharps preference.
 */

const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const ALTER_SYMBOLS = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };

/** Scientific pitch octave: MIDI 60 = C4. */
function midiOctave(midi) {
  return Math.floor(midi / 12) - 1;
}

function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

/**
 * Split a note into display parts.
 * @returns {{letter: string, accidental: string, octave: number}}
 */
function noteParts(note, { flats = true } = {}) {
  if (note.spelling) {
    const { step, alter = 0, octave } = note.spelling;
    return { letter: step, accidental: ALTER_SYMBOLS[String(alter)] ?? '', octave };
  }
  const name = (flats ? FLAT_NAMES : SHARP_NAMES)[((note.midi % 12) + 12) % 12];
  return { letter: name[0], accidental: name.slice(1), octave: midiOctave(note.midi) };
}

/** Plain-text label, e.g. "B♭" or "B♭3". */
function noteLabel(note, { flats = true, octave = false } = {}) {
  const p = noteParts(note, { flats });
  return p.letter + p.accidental + (octave ? p.octave : '');
}

/** Label for a bare MIDI number (used for range sliders, grid labels). */
function midiLabel(midi, opts = {}) {
  return noteLabel({ midi }, { octave: true, ...opts });
}
