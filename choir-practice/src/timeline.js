/**
 * Timeline: the one data format shared by every note source and the player.
 *
 * ── Note source contract ────────────────────────────────────────────────
 * A "note source" is anything that can produce a Timeline:
 *   - AudioNoteSource    (sources/audioSource.js)    pitch-detects an MP3
 *   - MusicXmlNoteSource (sources/musicxmlSource.js) reads a score (phase 2)
 *
 * It must provide notes as:
 *   { start: seconds, end: seconds, midi: integer,
 *     spelling?: { step: 'B', alter: -1, octave: 3 },   // from a score
 *     name?: string }                                     // convenience label
 *
 * Notes are monophonic (one line, no overlaps) and times are relative to the
 * start of the audio file. The player and display know nothing about where
 * notes came from; they only call at(t) and notesBetween(t0, t1).
 */
class Timeline {
  /**
   * @param {Array} notes
   * @param {object} [o]
   * @param {string} [o.source]  'audio' | 'musicxml'
   * @param {object} [o.contour] optional pitch curve for display/debugging:
   *                             { values: Float32Array (fractional MIDI, NaN = none),
   *                               hopSec, offsetSec }
   * @param {object} [o.meta]    free-form stats shown in the status line
   */
  constructor(notes, { source = 'audio', contour = null, meta = {} } = {}) {
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.source = source;
    this.contour = contour;
    this.meta = meta;
    this._starts = Float64Array.from(this.notes, (nt) => nt.start);

    let lo = Infinity;
    let hi = -Infinity;
    for (const nt of this.notes) {
      if (nt.midi < lo) lo = nt.midi;
      if (nt.midi > hi) hi = nt.midi;
    }
    this.minMidi = Number.isFinite(lo) ? lo : 60;
    this.maxMidi = Number.isFinite(hi) ? hi : 72;
  }

  /** Index of the last note starting at or before t, or -1 (binary search). */
  indexAt(t) {
    const s = this._starts;
    let lo = 0;
    let hi = s.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * What is sounding at time t?
   * @returns {{current: object|null, next: object|null}}
   *          current is null during rests.
   */
  at(t) {
    const i = this.indexAt(t);
    const cand = i >= 0 ? this.notes[i] : null;
    const current = cand && t < cand.end ? cand : null;
    const next = this.notes[i + 1] || null;
    return { current, next };
  }

  /** Notes overlapping [t0, t1], for drawing the piano roll. */
  notesBetween(t0, t1) {
    const out = [];
    for (let i = Math.max(0, this.indexAt(t0)); i < this.notes.length; i++) {
      const nt = this.notes[i];
      if (nt.start > t1) break;
      if (nt.end >= t0) out.push(nt);
    }
    return out;
  }
}
