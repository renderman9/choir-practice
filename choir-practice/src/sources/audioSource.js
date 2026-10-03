/**
 * AudioNoteSource: builds a Timeline by pitch-detecting a part track.
 *
 * Two stages, cached separately so tuning feels instant:
 *   detect(range)        slow (1–3 s), time-sliced: per-frame pitch/clarity/volume.
 *                        Only re-run when the decoded audio or vocal range changes.
 *   buildTimeline(opts)  instant: smoothing + note segmentation.
 *
 * Depends on: frameAnalysis.js, postprocess.js, timeline.js
 */

class AudioNoteSource {
  constructor() {
    this.kind = 'audio';
    this.samples = null;
    this.sampleRate = 0;
    this.duration = 0;
    this.frames = null;
    this._job = null;
  }

  get ready() { return !!this.samples; }
  get hasFrames() { return !!this.frames; }

  /** Decode an audio file to mono at the analysis sample rate. Local only. */
  async load(file) {
    this.cancel();
    this.samples = null;
    this.frames = null;
    const data = await file.arrayBuffer();
    // decodeAudioData resamples to the context's rate, so a 1-sample offline
    // context at 16 kHz gives us decoded + resampled audio in one step.
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, ANALYSIS_SAMPLE_RATE);
    const buffer = await ctx.decodeAudioData(data);

    // Mix all channels down to mono.
    const mono = new Float32Array(buffer.length);
    const nch = buffer.numberOfChannels;
    for (let c = 0; c < nch; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / nch;
    }
    this.samples = mono;
    this.sampleRate = buffer.sampleRate;
    this.duration = buffer.duration;
  }

  /** Does the cached detection match this range? */
  isDetectedFor({ minMidi, maxMidi }) {
    return !!this.frames && this.frames.minMidi === minMidi && this.frames.maxMidi === maxMidi;
  }

  /**
   * Run pitch detection. Work is done in ~25 ms slices, yielding to the
   * browser in between, so the page stays responsive and the progress bar
   * updates. (No Web Worker: those are blocked when the page is opened
   * straight from disk via file://.)
   * Starting a new run cancels the old one; its promise rejects with
   * {cancelled: true}.
   */
  detect({ minMidi, maxMidi }, onProgress) {
    this.cancel();
    if (!this.samples) return Promise.reject(new Error('No audio loaded'));
    const analyzer = createFrameAnalyzer(this.samples, this.sampleRate, { minMidi, maxMidi });
    return new Promise((resolve, reject) => {
      const job = { cancelled: false, reject };
      this._job = job;
      let batch = 200; // frames per slice; adapted to hit the time budget
      const run = () => {
        if (job.cancelled) return;
        try {
          const t0 = performance.now();
          const done = analyzer.step(batch);
          const ms = performance.now() - t0;
          batch = Math.max(50, Math.round(batch * (25 / Math.max(1, ms))));
          onProgress?.(analyzer.progress);
          if (done) {
            this._job = null;
            this.frames = analyzer.frames;
            resolve(analyzer.frames);
          } else {
            setTimeout(run, 0);
          }
        } catch (err) {
          this._job = null;
          reject(err);
        }
      };
      setTimeout(run, 0);
    });
  }

  cancel() {
    const job = this._job;
    if (job) {
      job.cancelled = true;
      this._job = null;
      job.reject({ cancelled: true });
    }
  }

  /** Stage 2: tuning options → Timeline. */
  buildTimeline(tuning) {
    const { notes, contour, stats } = buildNotes(this.frames, tuning);
    return new Timeline(notes, { source: 'audio', contour, meta: stats });
  }
}
