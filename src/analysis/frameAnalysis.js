/**
 * Stage 1 of audio analysis: raw per-frame measurements.
 *
 * The whole (mono, resampled) track is cut into short overlapping frames.
 * For each frame we store:
 *   - freq     detected fundamental in Hz (0 = no pitch found)
 *   - clarity  MPM peak height, 0…1 (how "pitched" the frame is)
 *   - rmsDb    loudness in dBFS
 *
 * This is the slow part (1–3 s per song), so its result is cached and it
 * runs in small slices (see createFrameAnalyzer) so the page stays responsive
 * and can show progress. Everything the Tuning panel controls, except the
 * vocal range, is applied afterwards in postprocess.js, which is instant.
 *
 * Depends on: mpm.js (createMpmDetector)
 */

/** Analysis sample rate. 16 kHz keeps every vocal fundamental (≤ ~1.1 kHz)
 *  and its first several harmonics, and makes analysis ~3× cheaper than 44.1k. */
const ANALYSIS_SAMPLE_RATE = 16000;

/** Hop between frame starts. 10 ms gives timing resolution well below what a
 *  singer can perceive as "late". */
const HOP_SEC = 0.01;

/** Frames quieter than this are treated as digital silence and skipped
 *  (saves time; the user-adjustable volume gate is applied later). */
const SILENCE_FLOOR_DB = -70;

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Set up an incremental analysis. Call step(n) repeatedly until it returns
 * true, then read `.frames`.
 *
 * @param {Float32Array} samples  mono audio
 * @param {number} sampleRate
 * @param {{minMidi: number, maxMidi: number}} range  vocal range of the part
 */
function createFrameAnalyzer(samples, sampleRate, { minMidi, maxMidi }) {
  // Allow one semitone of slack either side so a slightly flat lowest note
  // (or sharp top note) is still detected.
  const minFreq = midiToHz(minMidi - 1);
  const maxFreq = midiToHz(maxMidi + 1);

  // The window must hold at least ~2.5 periods of the lowest pitch for the
  // NSDF to be reliable at long lags. Higher parts get shorter windows, which
  // also gives sharper note boundaries.
  const maxPeriod = sampleRate / minFreq;
  const windowSize = Math.max(512, Math.ceil(2.5 * maxPeriod));
  const hop = Math.round(HOP_SEC * sampleRate);

  const detect = createMpmDetector({ sampleRate, windowSize, minFreq, maxFreq });

  const nFrames = samples.length >= windowSize
    ? Math.floor((samples.length - windowSize) / hop) + 1
    : 0;
  const frames = {
    freq: new Float32Array(nFrames),
    clarity: new Float32Array(nFrames),
    rmsDb: new Float32Array(nFrames),
    hopSec: hop / sampleRate,
    // Frame i covers [i*hop, i*hop + windowSize); we timestamp it at its centre.
    frameOffsetSec: windowSize / 2 / sampleRate,
    minMidi,
    maxMidi,
  };
  let i = 0;

  return {
    frames,
    get progress() { return nFrames ? i / nFrames : 1; },
    /** Analyse up to `count` more frames. Returns true when finished. */
    step(count) {
      const stop = Math.min(nFrames, i + count);
      for (; i < stop; i++) {
        const off = i * hop;
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
          const s = samples[off + j];
          sum += s * s;
        }
        const rms = Math.sqrt(sum / windowSize);
        const db = rms > 0 ? 20 * Math.log10(rms) : -120;
        frames.rmsDb[i] = db;

        if (db > SILENCE_FLOOR_DB) {
          const r = detect(samples, off);
          frames.freq[i] = r.freq;
          frames.clarity[i] = r.clarity;
        }
      }
      return i >= nFrames;
    },
  };
}

/** Analyse everything in one go (used by the Node test). */
function analyzeFrames(samples, sampleRate, range) {
  const a = createFrameAnalyzer(samples, sampleRate, range);
  a.step(Infinity);
  return a.frames;
}
