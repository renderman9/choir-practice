/**
 * Scoring for "Sing along": how closely your voice followed the song's notes.
 *
 * The song is divided into 50 ms slots. Each slot that falls inside a note
 * (minus a short grace period at the start of each note, for reaction time)
 * is a slot you're expected to sing. Every reading of your voice in a slot
 * gets a 0–1 score:
 *
 *   within ±25 cents of the note   → 1.0   ("gold": spot on)
 *   25 → 100 cents off             → slides linearly from 1.0 down to 0
 *   further off, or silent         → 0
 *
 * A slot's score is the average of its readings. Singing a section again
 * replaces the old attempt for those slots, so you can practise a passage.
 * Rests are never scored.
 *
 *   "So far"     = average over the slots you've sung through
 *   "Whole song" = total over ALL expected slots (ones you skipped count as 0)
 */

const SING_SLOT_SEC = 0.05;
/** Ignore the first part of each note: nobody hits it in 0 ms. */
const SING_GRACE_SEC = 0.12;
/** Within this many cents = "gold"; within SING_GREEN_CENTS = "green". */
const SING_GOLD_CENTS = 25;
const SING_GREEN_CENTS = 50;
const SING_ZERO_CENTS = 100;
/** A slot not visited for this long is treated as a new attempt. */
const SING_RETRY_MS = 1000;

/** Reading states, used to colour your pitch line. */
const SING = { REST: 0, MISS: 1, GREEN: 2, GOLD: 3 };

class SingScore {
  /** @param {Timeline} timeline */
  constructor(timeline) {
    this.timeline = timeline;
    const end = timeline.notes.length ? timeline.notes[timeline.notes.length - 1].end : 0;
    const n = Math.ceil(end / SING_SLOT_SEC) + 1;
    this.expected = new Uint8Array(n);
    this.sum = new Float32Array(n);
    this.count = new Uint16Array(n);
    this.stamp = new Float64Array(n);
    for (const nt of timeline.notes) {
      const a = Math.ceil((nt.start + SING_GRACE_SEC) / SING_SLOT_SEC);
      const b = Math.floor(nt.end / SING_SLOT_SEC) - 1;
      for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) this.expected[i] = 1;
    }
    this.totalExpected = this.expected.reduce((s, v) => s + v, 0);
  }

  reset() {
    this.sum.fill(0);
    this.count.fill(0);
    this.stamp.fill(0);
  }

  /**
   * Compare one reading of your voice with the song.
   * @param {number} t           song time the reading belongs to (seconds)
   * @param {number|null} midi   your pitch (fractional MIDI) or null if silent
   * @param {object} o
   * @param {boolean} o.anyOctave  count the right note in any octave as correct
   * @param {boolean} o.record     add to the score (false while paused)
   * @returns {{state: number, cents: number|null}}
   */
  add(t, midi, { anyOctave = false, record = true } = {}) {
    const target = this.timeline.at(t).current;
    if (!target) return { state: SING.REST, cents: null };

    let cents = null;
    let state = SING.MISS;
    if (midi != null) {
      let diff = midi - target.midi;
      if (anyOctave) diff = ((((diff + 6) % 12) + 12) % 12) - 6;
      cents = Math.round(diff * 100);
      const c = Math.abs(cents);
      state = c <= SING_GOLD_CENTS ? SING.GOLD : c <= SING_GREEN_CENTS ? SING.GREEN : SING.MISS;
    }

    const i = Math.floor(t / SING_SLOT_SEC);
    if (record && i >= 0 && i < this.expected.length && this.expected[i]) {
      const now = performance.now();
      if (now - this.stamp[i] > SING_RETRY_MS) { this.sum[i] = 0; this.count[i] = 0; }
      const c = cents == null ? Infinity : Math.abs(cents);
      const value = c <= SING_GOLD_CENTS ? 1
        : c >= SING_ZERO_CENTS ? 0
        : 1 - (c - SING_GOLD_CENTS) / (SING_ZERO_CENTS - SING_GOLD_CENTS);
      this.sum[i] += value;
      this.count[i] = Math.min(65535, this.count[i] + 1);
      this.stamp[i] = now;
    }
    return { state, cents };
  }

  /** @returns {{soFar: number|null, whole: number, covered: number}} percentages */
  summary() {
    let total = 0;
    let visited = 0;
    for (let i = 0; i < this.expected.length; i++) {
      if (!this.expected[i] || !this.count[i]) continue;
      total += this.sum[i] / this.count[i];
      visited++;
    }
    const all = this.totalExpected || 1;
    return {
      soFar: visited ? (100 * total) / visited : null,
      whole: (100 * total) / all,
      covered: (100 * visited) / all,
    };
  }
}
