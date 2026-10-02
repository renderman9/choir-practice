/**
 * McLeod Pitch Method (MPM)
 * -------------------------
 * Reference: P. McLeod & G. Wyvill, "A Smarter Way to Find Pitch" (ICMC 2005).
 *
 * The idea in one paragraph: a periodic signal looks like a shifted copy of
 * itself. For every candidate lag τ (a period length, in samples) we measure
 * how similar the frame is to itself shifted by τ, using the
 * "Normalised Square Difference Function" (NSDF):
 *
 *            2 · Σ x[j]·x[j+τ]
 *   n(τ) = ─────────────────────────      (sums over j = 0 … W-1-τ)
 *           Σ x[j]² + Σ x[j+τ]²
 *
 * n(τ) is in [-1, 1]; it is 1 when the shifted copy matches perfectly. The
 * period is the lag of the first big peak. Picking "the highest peak" tends
 * to choose 2× or 3× the true period (octave-down errors), so MPM picks the
 * FIRST "key maximum" that reaches `cutoff × highest peak`. The height of the
 * chosen peak is the "clarity": ~1.0 for a clean sung vowel, low for noise,
 * consonants or a messy chord.
 *
 * We only consider peaks whose lag corresponds to the part's vocal range
 * (minFreq…maxFreq). That is cheap (fewer lags to compute) and it is the main
 * defence against locking onto a quieter background part in another octave.
 */

/**
 * Create a reusable detector for a fixed window size / frequency band.
 * Buffers are allocated once, so calling detect() per frame does no allocation.
 *
 * @param {object} o
 * @param {number} o.sampleRate  sample rate of the audio passed to detect()
 * @param {number} o.windowSize  frame length in samples
 * @param {number} o.minFreq     lowest pitch to accept (Hz)
 * @param {number} o.maxFreq     highest pitch to accept (Hz)
 * @param {number} [o.cutoff=0.9] the MPM "k" constant (see above)
 * @returns {(samples: Float32Array, offset: number) => {freq: number, clarity: number}}
 *          freq is 0 when no pitch was found. The returned object is reused.
 */
function createMpmDetector({ sampleRate, windowSize, minFreq, maxFreq, cutoff = 0.9 }) {
  const W = windowSize;
  // Lag (period in samples) bounds that correspond to the frequency band.
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(W - 3, Math.ceil(sampleRate / minFreq));
  // Compute one lag past maxLag so a peak at maxLag can be interpolated.
  const lastLag = maxLag + 1;

  const buf = new Float32Array(W);
  const nsdf = new Float32Array(lastLag + 1);
  // Key-maxima found in the current frame (lag positions).
  const peakLags = new Int32Array(lastLag + 1);
  const result = { freq: 0, clarity: 0 };

  return function detect(samples, offset) {
    result.freq = 0;
    result.clarity = 0;

    // 1. Copy the frame and remove its DC offset (mean), which would otherwise
    //    bias the correlation towards long lags.
    let mean = 0;
    for (let i = 0; i < W; i++) mean += samples[offset + i];
    mean /= W;
    let energy = 0;
    for (let i = 0; i < W; i++) {
      const s = samples[offset + i] - mean;
      buf[i] = s;
      energy += s * s;
    }
    if (energy < 1e-10) return result;

    // 2. NSDF for τ = 0 … lastLag.
    //    The denominator m(τ) can be updated incrementally: going from τ-1 to τ
    //    drops one sample from each end of the overlap.
    let m = 2 * energy;
    for (let tau = 0; tau <= lastLag; tau++) {
      if (tau > 0) {
        const a = buf[tau - 1];
        const b = buf[W - tau];
        m -= a * a + b * b;
      }
      let r = 0;
      const n = W - tau;
      for (let j = 0; j < n; j++) r += buf[j] * buf[j + tau];
      nsdf[tau] = m > 1e-12 ? (2 * r) / m : 0;
    }

    // 3. Peak picking. Skip the initial positive lobe around τ = 0 (every
    //    signal matches itself at zero lag), then record the highest point of
    //    each subsequent positive lobe ("key maxima").
    let tau = 1;
    while (tau <= lastLag && nsdf[tau] > 0) tau++;

    let nPeaks = 0;
    let highest = 0;
    while (tau <= lastLag) {
      while (tau <= lastLag && nsdf[tau] <= 0) tau++; // to positive zero crossing
      let pk = -1;
      let pv = -Infinity;
      while (tau <= lastLag && nsdf[tau] > 0) {
        if (nsdf[tau] > pv) { pv = nsdf[tau]; pk = tau; }
        tau++;
      }
      // Ignore lobes cut off by the end of the computed range (pk == lastLag
      // is not a true local maximum) and lags outside the vocal range.
      if (pk >= minLag && pk <= maxLag && pk < lastLag) {
        peakLags[nPeaks++] = pk;
        if (pv > highest) highest = pv;
      }
    }
    if (nPeaks === 0) return result;

    // 4. Choose the first key maximum that is "high enough" relative to the
    //    best one. Preferring the earliest (shortest period = highest pitch)
    //    avoids octave-down errors.
    const threshold = cutoff * highest;
    let chosen = peakLags[0];
    for (let i = 0; i < nPeaks; i++) {
      if (nsdf[peakLags[i]] >= threshold) { chosen = peakLags[i]; break; }
    }

    // 5. Parabolic interpolation through the peak and its neighbours gives a
    //    sub-sample period estimate (needed for accurate pitch at high notes,
    //    where the period is only ~15 samples) and a refined peak height.
    const a = nsdf[chosen - 1];
    const b = nsdf[chosen];
    const c = nsdf[chosen + 1];
    const denom = a - 2 * b + c;
    let shift = 0;
    if (denom !== 0) shift = (0.5 * (a - c)) / denom;
    if (shift > 0.5 || shift < -0.5) shift = 0;
    const period = chosen + shift;
    const peak = b - 0.25 * (a - c) * shift;

    result.freq = sampleRate / period;
    result.clarity = Math.min(1, peak);
    return result;
  };
}
