/**
 * Live microphone pitch tracking for "Sing along".
 *
 * Uses the same McLeod pitch detector as track analysis (mpm.js), run once
 * per animation frame on the most recent slice of mic audio:
 *
 *   mic → AnalyserNode (ring buffer of recent samples, never played back)
 *       → read(): newest samples, downsampled to ~16 kHz
 *       → loudness gate + MPM + clarity gate
 *       → short median over the last few readings (steadies the line)
 *
 * Nothing is recorded or sent anywhere; samples are only looked at.
 *
 * Depends on: mpm.js (createMpmDetector), frameAnalysis.js (midiToHz)
 */

/** Below this loudness (dBFS) the mic counts as silent. */
const MIC_SILENCE_DB = -50;
/** Minimum MPM clarity for a reading to count as singing. A solo voice
 *  close to the mic is very clean, so this can be stricter than for tracks. */
const MIC_MIN_CLARITY = 0.7;
/** Readings in the median (at ~60 fps, 5 ≈ 80 ms). */
const MIC_MEDIAN = 5;

class MicPitch {
  constructor() {
    this.active = false;
    this._ctx = null;
    this._stream = null;
    this._analyser = null;
    this._recent = [];
  }

  /**
   * Ask for the mic and start listening.
   * @param {{minMidi:number, maxMidi:number}} range  expected singing range
   */
  async start(range) {
    if (this.active) return;
    // Browser voice processing is tuned for speech and fights sustained sung
    // notes, so turn it off, except echo cancellation, which helps a little
    // if you're not wearing headphones.
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    const src = this._ctx.createMediaStreamSource(this._stream);
    this._analyser = this._ctx.createAnalyser();
    src.connect(this._analyser); // not connected to the speakers: no feedback
    this.active = true;
    this.setRange(range);
  }

  stop() {
    this.active = false;
    this._stream?.getTracks().forEach((t) => t.stop());
    this._ctx?.close().catch(() => {});
    this._stream = this._ctx = this._analyser = null;
    this._recent = [];
  }

  /** (Re)build the detector for a singing range. */
  setRange({ minMidi, maxMidi }) {
    if (!this._ctx) return;
    const sr = this._ctx.sampleRate;
    // Downsample to ~16 kHz by averaging groups of samples (also acts as a
    // simple low-pass filter). Plenty for any voice, and much cheaper.
    this._factor = Math.max(1, Math.round(sr / 16000));
    this._rate = sr / this._factor;
    const minFreq = midiToHz(minMidi - 1);
    const maxFreq = midiToHz(maxMidi + 1);
    this._window = Math.max(512, Math.ceil(2.5 * (this._rate / minFreq)));
    // The analyser must hold at least window × factor raw samples.
    let fft = 2048;
    while (fft < this._window * this._factor) fft *= 2;
    this._analyser.fftSize = Math.min(32768, fft);
    this._raw = new Float32Array(this._analyser.fftSize);
    this._down = new Float32Array(this._window);
    this._detect = createMpmDetector({ sampleRate: this._rate, windowSize: this._window, minFreq, maxFreq });
    this._recent = [];
  }

  /**
   * Current sung pitch as fractional MIDI, or null when not singing.
   * Call once per animation frame.
   */
  read() {
    if (!this.active) return null;
    this._analyser.getFloatTimeDomainData(this._raw);
    const f = this._factor;
    const W = this._window;
    const start = this._raw.length - W * f; // newest W×f samples
    let sum = 0;
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += this._raw[start + i * f + k];
      s /= f;
      this._down[i] = s;
      sum += s * s;
    }
    const db = 10 * Math.log10(sum / W + 1e-20);

    let midi = NaN;
    if (db > MIC_SILENCE_DB) {
      const r = this._detect(this._down, 0);
      if (r.freq > 0 && r.clarity >= MIC_MIN_CLARITY) midi = 69 + 12 * Math.log2(r.freq / 440);
    }

    // Median of the last few readings; silent unless most of them are sung.
    this._recent.push(midi);
    if (this._recent.length > MIC_MEDIAN) this._recent.shift();
    const sung = this._recent.filter((v) => v === v).sort((a, b) => a - b);
    if (sung.length * 2 <= this._recent.length) return null;
    return sung[sung.length >> 1];
  }
}
