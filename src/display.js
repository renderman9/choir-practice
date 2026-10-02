/**
 * The big "what do I sing now" display: current note, next note, rest state.
 * DOM is only rewritten when the note actually changes; the per-frame work
 * is a single transform on the note-progress bar.
 */

function noteHtml(note, fmt) {
  const p = noteParts(note, fmt);
  return `<span class="letter">${p.letter}</span>`
    + (p.accidental ? `<span class="acc">${p.accidental}</span>` : '')
    + (fmt.octave ? `<span class="oct">${p.octave}</span>` : '');
}

class NoteDisplay {
  constructor({ current, next, nextIn, life }) {
    this.el = { current, next, nextIn, life };
    this.reset();
  }

  /** Force a full re-render on the next update (e.g. toggles changed). */
  reset() {
    this._cur = undefined;
    this._next = undefined;
    this._fmtKey = '';
    this._nextInText = '';
  }

  /**
   * @param {number} t   display time (seconds)
   * @param {{current, next}} state  from Timeline.at(t)
   * @param {{flats: boolean, octave: boolean}} fmt
   * @param {boolean} hasTimeline
   */
  update(t, { current, next }, fmt, hasTimeline) {
    const fmtKey = `${fmt.flats}|${fmt.octave}|${hasTimeline}`;
    const fmtChanged = fmtKey !== this._fmtKey;
    this._fmtKey = fmtKey;

    if (current !== this._cur || fmtChanged) {
      const el = this.el.current;
      if (current) {
        el.innerHTML = noteHtml(current, fmt);
        el.classList.remove('rest');
        // Re-trigger the onset pulse so repeated notes of the same pitch
        // still visibly "re-attack".
        if (current !== this._cur) {
          el.classList.remove('pulse');
          void el.offsetWidth;
          el.classList.add('pulse');
        }
      } else {
        el.innerHTML = `<span class="rest-word">${hasTimeline ? 'rest' : '—'}</span>`;
        el.classList.add('rest');
      }
      this._cur = current;
    }

    if (next !== this._next || fmtChanged) {
      this.el.next.innerHTML = next ? noteHtml(next, fmt) : '—';
      this._next = next;
    }

    // "in 2.4 s" countdown, only during rests (while singing it's noise).
    const nextIn = !current && next ? `in ${(next.start - t).toFixed(1)} s` : '';
    if (nextIn !== this._nextInText) {
      this.el.nextIn.textContent = nextIn;
      this._nextInText = nextIn;
    }

    // How far through the current note we are.
    const frac = current ? Math.min(1, Math.max(0, (t - current.start) / (current.end - current.start))) : 0;
    this.el.life.style.transform = `scaleX(${frac})`;
  }
}
