/**
 * Stage 2 of audio analysis: turn noisy per-frame pitch into clean notes.
 *
 * Raw pitch detection on a real recording flickers: breaths and consonants
 * produce junk, vibrato wobbles across semitone boundaries, other parts bleed
 * through, and note transitions produce a few frames of in-between pitches.
 * The pipeline below cleans that up in this order:
 *
 *   1. Gate      drop frames that are quiet, not clearly pitched, or much
 *                quieter than your part nearby (= background parts)
 *   2. Reference estimate how far the whole track is from A=440 and correct
 *   3. Median    median-filter the pitch curve (absorbs vibrato and blips,
 *                but keeps note changes sharp, unlike an averaging filter)
 *   4. Quantize  round to semitones, with hysteresis so a singer hovering near
 *                a boundary doesn't flip between two notes
 *   5. Segment   join consecutive frames with the same note into notes
 *   6. Clean     drop very short notes, then bridge tiny gaps
 *
 * Every step is cheap, so this re-runs instantly when a Tuning slider moves.
 */

/** Per-frame diagnostic codes: why a frame did or didn't become part of a note.
 *  Checked in this order, so a frame gets the FIRST reason that applies. */
const DIAG = {
  NONE: 0,            // silence / no pitch found at all
  KEPT: 1,            // part of a note
  QUIET: 2,           // below the volume gate
  BACKGROUND: 3,      // rejected by background rejection
  LOW_CONFIDENCE: 4,  // below pitch confidence
  OUT_OF_RANGE: 5,    // outside lowest/highest note
  SMOOTHED_OUT: 6,    // passed the gates, removed by smoothing (too patchy)
  TOO_SHORT: 7,       // formed a note shorter than min note length
};

/**
 * @param {object} frames   output of analyzeFrames()
 * @param {object} o        tuning options (see settings.js for meanings)
 * @param {number} o.clarity        min MPM clarity (0…1) for a frame to count as sung
 * @param {number} o.volumeGateDb   frames more than this many dB below the
 *                                  track's loud level count as silence
 * @param {number} o.backgroundDb   frames more than this many dB below the
 *                                  LOCAL loud level are background (0 = off)
 * @param {number} o.smoothingMs    median filter window
 * @param {number} o.hysteresis     extra semitones beyond ½ needed to change note
 * @param {number} o.minNoteMs      notes shorter than this are dropped
 * @param {number} o.gapBridgeMs    gaps shorter than this are not shown as rests
 * @param {boolean} o.autoReference correct for tracks not tuned to A=440
 * @param {number} o.minMidi        part range (frames outside are ignored)
 * @param {number} o.maxMidi
 * @returns {{notes: Array, contour: object, stats: object}}
 */
function buildNotes(frames, o) {
  const { freq, clarity, rmsDb, hopSec, frameOffsetSec } = frames;
  const n = freq.length;

  // ── 1. Gate ─────────────────────────────────────────────────────────────
  // Two loudness gates:
  //  a) Volume gate, relative to the whole track's "loud level" (95th
  //     percentile frame loudness): removes silence, breaths, room noise.
  //  b) Background rejection, relative to the LOCAL loud level (the loudest
  //     part of the surrounding few seconds). In a part track your part is
  //     the loudest thing; when it rests, the other parts keep going but
  //     several dB quieter. Without this gate those background parts would
  //     be "detected" during every one of your rests.
  const loudLevel = percentile(rmsDb, 0.95, -70);
  const gateDb = loudLevel - o.volumeGateDb;
  const localLevel = o.backgroundDb > 0 ? localLoudness(rmsDb, hopSec) : null;
  const lo = o.minMidi - 1.5;
  const hi = o.maxMidi + 1.5;

  const raw = new Float32Array(n).fill(NaN); // fractional MIDI, NaN = unvoiced
  // Diagnostics: what the detector heard in every frame (even rejected ones)
  // and why it was rejected. See DIAG in this file.
  const heard = new Float32Array(n).fill(NaN);
  const reason = new Uint8Array(n);
  let voicedRaw = 0;
  for (let i = 0; i < n; i++) {
    if (freq[i] <= 0) { reason[i] = DIAG.NONE; continue; }
    const m = 69 + 12 * Math.log2(freq[i] / 440);
    heard[i] = m;
    if (rmsDb[i] < gateDb) reason[i] = DIAG.QUIET;
    else if (localLevel && rmsDb[i] < localLevel[i] - o.backgroundDb) reason[i] = DIAG.BACKGROUND;
    else if (clarity[i] < o.clarity) reason[i] = DIAG.LOW_CONFIDENCE;
    else if (m < lo || m > hi) reason[i] = DIAG.OUT_OF_RANGE;
    else {
      reason[i] = DIAG.KEPT;
      raw[i] = m;
      voicedRaw++;
    }
  }

  // ── 2. Reference pitch ──────────────────────────────────────────────────
  // If the recording is e.g. at A=435, every note sits ~15–20 cents flat and
  // rounding becomes fragile. Vibrato makes single frames useless for
  // estimating this, so we do a first pass, average the pitch over each
  // detected note (vibrato cancels out), estimate one global offset from
  // those averages, then run the pipeline again with the offset removed.
  let refOffset = 0;
  if (o.autoReference) {
    const first = notesFromPitch(raw, frames, o);
    refOffset = estimateReferenceOffset(noteMeans(first.notes, raw, frames));
    if (refOffset !== 0) {
      for (let i = 0; i < n; i++) {
        if (raw[i] === raw[i]) raw[i] -= refOffset;
        if (heard[i] === heard[i]) heard[i] -= refOffset;
      }
    }
  }

  const { notes, smooth } = notesFromPitch(raw, frames, o);
  for (const nt of notes) nt.name = noteLabel(nt, { flats: true });

  // Frames that passed the gates but still didn't end up in a note: either
  // the median filter removed them (too few sung frames around them) or the
  // note they formed was shorter than the minimum length.
  const inNote = new Uint8Array(n);
  for (const nt of notes) {
    const i0 = Math.max(0, Math.ceil((nt.start - frameOffsetSec) / hopSec));
    const i1 = Math.min(n - 1, Math.floor((nt.end - frameOffsetSec) / hopSec));
    for (let i = i0; i <= i1; i++) inNote[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (reason[i] !== DIAG.KEPT || inNote[i]) continue;
    reason[i] = smooth[i] === smooth[i] ? DIAG.TOO_SHORT : DIAG.SMOOTHED_OUT;
  }

  const voicedSmooth = smooth.reduce((c, v) => c + (v === v ? 1 : 0), 0);
  return {
    notes,
    // Smoothed pitch curve (reference-corrected), drawn in the piano roll so
    // you can see what the detector "heard" while tuning.
    // `heard` + `reason` power the diagnostics view.
    contour: {
      values: smooth, heard, reason, hopSec, offsetSec: frameOffsetSec,
      rangeLow: o.minMidi, rangeHigh: o.maxMidi,
    },
    stats: {
      frames: n,
      voicedRawPct: n ? (100 * voicedRaw) / n : 0,
      voicedPct: n ? (100 * voicedSmooth) / n : 0,
      referenceCents: Math.round(refOffset * 100),
      referenceHz: 440 * Math.pow(2, refOffset / 12),
      loudLevelDb: loudLevel,
    },
  };
}

/** Steps 3–6: gated fractional-MIDI pitch curve → notes. */
function notesFromPitch(raw, { hopSec, frameOffsetSec }, o) {
  const n = raw.length;

  // ── 3. Median filter ────────────────────────────────────────────────────
  let win = Math.round(o.smoothingMs / 1000 / hopSec);
  if (win % 2 === 0) win += 1; // odd window, centred on the frame
  const smooth = medianFilter(raw, Math.max(1, win));

  // ── 4. Quantize with hysteresis ─────────────────────────────────────────
  // Stay on the current semitone until the pitch moves more than
  // (0.5 + hysteresis) semitones away from it.
  const q = new Int16Array(n).fill(-1);
  const switchDist = 0.5 + o.hysteresis;
  let cur = -1;
  for (let i = 0; i < n; i++) {
    const v = smooth[i];
    if (v !== v) { cur = -1; continue; } // NaN → unvoiced; reset
    if (cur < 0 || Math.abs(v - cur) > switchDist) cur = Math.round(v);
    q[i] = cur;
  }

  // ── 5. Segment: runs of identical note numbers become notes ─────────────
  const half = hopSec / 2;
  const timeOf = (i) => frameOffsetSec + i * hopSec;
  let segs = [];
  for (let i = 0; i < n; ) {
    if (q[i] < 0) { i++; continue; }
    let j = i;
    while (j + 1 < n && q[j + 1] === q[i]) j++;
    segs.push({ start: timeOf(i) - half, end: timeOf(j) + half, midi: q[i] });
    i = j + 1;
  }

  // ── 6. Clean up ─────────────────────────────────────────────────────────
  // a) Drop notes too short to be real (scoops, transitions, stray frames).
  const minDur = o.minNoteMs / 1000;
  segs = segs.filter((s) => s.end - s.start >= minDur);

  // b) Bridge small gaps. A gap shorter than gapBridge is a consonant, a
  //    dropped short note or a detection hiccup, not a real rest:
  //    - same note on both sides → merge into one note
  //    - different notes → extend the earlier note up to the next one
  //    Either way the display never flashes "rest" for a split second.
  const bridge = o.gapBridgeMs / 1000;
  const notes = [];
  for (const s of segs) {
    const prev = notes[notes.length - 1];
    if (prev && s.start - prev.end <= bridge) {
      if (prev.midi === s.midi) { prev.end = s.end; continue; }
      prev.end = s.start;
    }
    notes.push({ ...s });
  }
  return { notes, smooth };
}

/**
 * Local loud level per frame: the loudest part of the surrounding ±4 s.
 * Computed on 0.5 s blocks (90th-percentile loudness per block, so a single
 * transient doesn't count) and then a sliding max over neighbouring blocks.
 */
function localLoudness(rmsDb, hopSec) {
  const n = rmsDb.length;
  const blockLen = Math.max(1, Math.round(0.5 / hopSec));
  const nBlocks = Math.ceil(n / blockLen);
  const blockLevel = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    blockLevel[b] = percentile(rmsDb.subarray(b * blockLen, Math.min(n, (b + 1) * blockLen)), 0.9, -70);
  }
  const reach = 8; // blocks either side = ±4 s
  const out = new Float32Array(n);
  for (let b = 0; b < nBlocks; b++) {
    let mx = -Infinity;
    for (let k = Math.max(0, b - reach); k <= Math.min(nBlocks - 1, b + reach); k++) {
      if (blockLevel[k] > mx) mx = blockLevel[k];
    }
    out.fill(mx, b * blockLen, Math.min(n, (b + 1) * blockLen));
  }
  return out;
}

/** Average (fractional MIDI) pitch over each note, with its duration as weight. */
function noteMeans(notes, raw, { hopSec, frameOffsetSec }) {
  const out = [];
  for (const nt of notes) {
    const i0 = Math.max(0, Math.ceil((nt.start - frameOffsetSec) / hopSec));
    const i1 = Math.min(raw.length - 1, Math.floor((nt.end - frameOffsetSec) / hopSec));
    let sum = 0;
    let k = 0;
    for (let i = i0; i <= i1; i++) {
      // Only frames that agree with the note (skip scoops / other-part frames).
      if (raw[i] === raw[i] && Math.abs(raw[i] - nt.midi) < 1) { sum += raw[i]; k++; }
    }
    if (k >= 5) out.push({ value: sum / k, weight: nt.end - nt.start });
  }
  return out;
}

/**
 * Median filter that ignores unvoiced (NaN) frames.
 * Output frame i is voiced only if MORE than half the window is voiced; then
 * it takes the median of the voiced values. This both removes isolated
 * blips (a lone voiced frame in silence) and fills isolated dropouts (a lone
 * unvoiced frame inside a note), while keeping note onsets/offsets in place.
 */
function medianFilter(values, win) {
  const n = values.length;
  const out = new Float32Array(n).fill(NaN);
  const h = (win - 1) >> 1;
  const tmp = new Float64Array(win);
  for (let i = 0; i < n; i++) {
    let k = 0;
    const a = Math.max(0, i - h);
    const b = Math.min(n - 1, i + h);
    for (let j = a; j <= b; j++) {
      const v = values[j];
      if (v === v) tmp[k++] = v;
    }
    if (k * 2 <= win) continue;
    const sorted = tmp.subarray(0, k).sort();
    out[i] = k % 2 ? sorted[k >> 1] : 0.5 * (sorted[k / 2 - 1] + sorted[k / 2]);
  }
  return out;
}

/**
 * Estimate a global tuning offset in semitones (−0.5…0.5) from per-note
 * average pitches. Each note's distance from the nearest semitone is treated
 * as an angle on a circle (so −0.49 and +0.49 are neighbours) and we take the
 * duration-weighted circular mean. If the notes disagree (no consistent
 * offset, or too few notes) we return 0 rather than guess.
 */
function estimateReferenceOffset(means) {
  let s = 0;
  let c = 0;
  let total = 0;
  for (const { value, weight } of means) {
    const ang = 2 * Math.PI * (value - Math.round(value));
    s += weight * Math.sin(ang);
    c += weight * Math.cos(ang);
    total += weight;
  }
  if (means.length < 4 || total <= 0) return 0;
  const resultant = Math.hypot(s, c) / total; // 1 = all notes agree exactly
  if (resultant < 0.6) return 0;
  const offset = Math.atan2(s, c) / (2 * Math.PI);
  return Math.abs(offset) < 0.03 ? 0 : offset; // ignore < 3 cents
}

function percentile(arr, p, floor) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] > floor) vals.push(arr[i]);
  if (!vals.length) return floor;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
}
