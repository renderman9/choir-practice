/**
 * Audio playback via an <audio> element (reliable seeking, low memory, and
 * playbackRate keeps pitch when slowed down).
 *
 * The display reads `time` once per animation frame. Some browsers only
 * update media currentTime every ~30–250 ms, which would make the note change
 * in visible steps, so between updates we extrapolate from the wall clock.
 * The audio clock always wins as soon as it ticks.
 */
class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this._url = null;
    this._lastCt = 0;
    this._lastNow = 0;
    this._wakeLock = null;

    // Keep the screen awake while playing (music stand use).
    this.audio.addEventListener('play', () => this._lockScreen());
    this.audio.addEventListener('pause', () => this._unlockScreen());
    this.audio.addEventListener('ended', () => this._unlockScreen());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.audio.paused) this._lockScreen();
    });
  }

  /** Load a File/Blob. Creates a local object URL; nothing leaves the device. */
  load(file) {
    this.pause();
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = URL.createObjectURL(file);
    this.audio.src = this._url;
    this.audio.load();
  }

  get loaded() { return !!this._url; }
  get paused() { return this.audio.paused; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }

  /** Current playback position in seconds, smoothed between clock updates. */
  get time() {
    const a = this.audio;
    const ct = a.currentTime;
    const now = performance.now();
    if (a.paused || a.seeking || ct !== this._lastCt) {
      this._lastCt = ct;
      this._lastNow = now;
      return ct;
    }
    const extrapolated = ct + ((now - this._lastNow) / 1000) * a.playbackRate;
    return Math.min(extrapolated, ct + 0.3);
  }

  play() { return this.audio.play().catch(() => {}); }
  pause() { this.audio.pause(); }
  toggle() { return this.audio.paused ? this.play() : this.pause(); }

  seek(t) {
    const d = this.duration;
    this.audio.currentTime = Math.max(0, d ? Math.min(t, d) : t);
  }

  set rate(r) { this.audio.playbackRate = r; }

  on(event, fn, options) { this.audio.addEventListener(event, fn, options); }

  async _lockScreen() {
    try {
      if ('wakeLock' in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      }
    } catch { /* not supported or denied: fine */ }
  }

  _unlockScreen() {
    this._wakeLock?.release().catch(() => {});
    this._wakeLock = null;
  }
}
