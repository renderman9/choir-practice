/**
 * Parts, tuning controls and persisted settings.
 *
 * TUNING_DEFS drives the Tuning panel. `stage` says what a change requires:
 *   'detect'  re-run pitch detection (slow, a few seconds)
 *   'notes'   re-run smoothing/segmentation only (instant)
 *   'display' just redraw
 */

/** Default detection ranges, as MIDI numbers (60 = C4). Sounding pitch, so
 *  tenors are an octave below their treble-8 written notes. */
const PARTS = {
  S: { name: 'Soprano', low: 60, high: 84 }, // C4–C6
  A: { name: 'Alto', low: 53, high: 77 },    // F3–F5
  T: { name: 'Tenor', low: 47, high: 72 },   // B2–C5
  B: { name: 'Bass', low: 40, high: 64 },    // E2–E4
};

const TUNING_DEFS = [
  {
    key: 'diagnostics', label: 'Show diagnostics (why notes are missed)', stage: 'display',
    type: 'checkbox', def: false,
    help: 'Coloured dots in the strip show every pitch the detector heard but threw away, and why. '
      + 'Find a spot where it wrongly says "rest", see which colour is there, and adjust that setting.',
  },
  {
    key: 'clarity', label: 'Pitch confidence', stage: 'notes',
    min: 0.2, max: 0.98, step: 0.01, def: 0.75, fmt: (v) => v.toFixed(2),
    help: 'How clearly pitched a moment must be to count as singing. Raise it if you see '
      + 'stray notes on breaths, consonants or piano chords; lower it if real notes go missing. '
      + 'A whole section singing together, or separated vocals, may need 0.4–0.6.',
  },
  {
    key: 'volumeGateDb', label: 'Volume gate', stage: 'notes',
    min: 10, max: 60, step: 1, def: 35, fmt: (v) => `${v} dB below loud`,
    help: 'Anything quieter than this (relative to the loud parts of the track) is treated as '
      + 'silence. Use a smaller number if quiet background parts are being picked up during your rests.',
  },
  {
    key: 'backgroundDb', label: 'Background rejection', stage: 'notes',
    min: 0, max: 30, step: 1, def: 10, fmt: (v) => (v ? `${v} dB below your part` : 'off'),
    help: 'In a part track your part is the loudest; when it rests the other parts are still '
      + 'audible, just quieter. Sound more than this far below the loudest moments of the last/next '
      + 'few seconds is ignored. Lower it if other parts show up during your rests; raise it if your own '
      + 'quiet notes go missing.',
  },
  {
    key: 'smoothingMs', label: 'Smoothing', stage: 'notes',
    min: 0, max: 300, step: 10, def: 120, fmt: (v) => `${v} ms`,
    help: 'Median-filter window over the pitch curve. Longer absorbs more vibrato and wobble '
      + 'but can swallow very fast notes. 0 = off.',
  },
  {
    key: 'hysteresis', label: 'Note stickiness', stage: 'notes',
    min: 0, max: 0.4, step: 0.05, def: 0.15, fmt: (v) => `${Math.round(v * 100)}¢`,
    help: 'Extra distance (in cents, beyond halfway) the pitch must move before the display '
      + 'changes note. Raise if a note flickers between two neighbours; lower if semitone steps are missed.',
  },
  {
    key: 'minNoteMs', label: 'Min note length', stage: 'notes',
    min: 20, max: 300, step: 10, def: 80, fmt: (v) => `${v} ms`,
    help: 'Notes shorter than this are discarded as scoops, slides or glitches.',
  },
  {
    key: 'gapBridgeMs', label: 'Ignore gaps shorter than', stage: 'notes',
    min: 0, max: 500, step: 10, def: 150, fmt: (v) => `${v} ms`,
    help: 'Gaps shorter than this are not shown as rests (consonants, quick breaths). '
      + 'The previous note is held instead.',
  },
  {
    key: 'autoReference', label: 'Auto-detect tuning (A = 440?)', stage: 'notes',
    type: 'checkbox', def: true,
    help: 'Estimates whether the whole recording is a little sharp or flat and compensates, '
      + 'so notes round to the right name. Turn off for tracks that drift a lot.',
  },
  {
    key: 'rangeLow', label: 'Lowest note', stage: 'detect', type: 'note',
    min: 28, max: 96, step: 1,
    help: 'Detection range. Pitches outside it are ignored, which stops the detector jumping '
      + 'to another part or an octave error. Resets when you change part.',
  },
  {
    key: 'rangeHigh', label: 'Highest note', stage: 'detect', type: 'note',
    min: 28, max: 96, step: 1,
  },
  {
    key: 'offsetMs', label: 'Display sync offset', stage: 'display',
    min: -1000, max: 1000, step: 10, def: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v} ms`,
    help: 'Shifts the note display relative to the audio. Use a negative value with Bluetooth '
      + 'headphones (the sound arrives late) so the note changes when you hear it.',
  },
  {
    key: 'micLatencyMs', label: 'Sing along: mic delay', stage: 'display',
    min: 0, max: 500, step: 10, def: 150, fmt: (v) => `${v} ms`,
    help: 'Your voice reaches the app a little after you sing (mic, processing, and hearing the '
      + 'track late). This shifts your line back to make up for it. If your line always changes '
      + 'note just after the song does, raise it; Bluetooth headphones may need 250–400 ms.',
  },
];

/**
 * "★ My favourite" button: hand-tuned for separated vocals (Ultimate Vocal
 * Remover) on the bass part. Lives in the code, not browser storage, so it
 * survives clearing browser data. Edit the values here to change it.
 */
const FAVORITE_TUNING = {
  clarity: 0.34,
  volumeGateDb: 44,
  backgroundDb: 25,
  smoothingMs: 280,
  hysteresis: 0.35,
  minNoteMs: 80,
  gapBridgeMs: 30,
  autoReference: false,
  rangeLow: 33,  // A1
  rangeHigh: 69, // A4
  offsetMs: 0,
};

const STORAGE_KEY = 'choir-practice-settings-v1';

function defaultSettings() {
  const tuning = {};
  for (const d of TUNING_DEFS) if ('def' in d) tuning[d.key] = d.def;
  tuning.rangeLow = PARTS.S.low;
  tuning.rangeHigh = PARTS.S.high;
  return { part: 'S', flats: true, octave: false, rate: 1, tuning };
}

function loadSettings() {
  const s = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      Object.assign(s, saved, { tuning: { ...s.tuning, ...(saved.tuning || {}) } });
    }
  } catch { /* storage unavailable: use defaults */ }
  if (!PARTS[s.part]) s.part = 'S';
  return s;
}

function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
