/**
 * Scrolling piano-roll strip: a few seconds of past and future notes around
 * a fixed playhead, plus the detected pitch curve as a faint line so you can
 * see what the detector heard while adjusting the Tuning panel.
 * Click/tap to seek.
 */

/** Default seconds visible in the strip; a quarter is past, the rest ahead. */
const DEFAULT_WINDOW_SEC = 8;

/** Dark strip (default). */
const COLORS = {
  bg: '#12161d',
  blackRow: '#0d1015',
  cLine: '#2a313c',
  label: '#6b7686',
  labelFuture: '#cfe0ff',
  labelBg: 'rgba(18, 22, 29, 0.8)',
  note: '#3b4a5f',
  noteFuture: '#4f6a8c',
  noteNow: '#ffc857',
  textOnNote: '#e9eef5',
  textOnNow: '#1b1406',
  contour: 'rgba(120, 220, 255, 0.75)',
  playhead: '#ff6b6b',
  staffLine: '#5a6575',
  // Sing-along line
  singGold: '#ffd24a',
  singGreen: '#3ddc84',
  singMiss: '#ff5c5c',
  singRest: '#9aa4b2',
  singOutline: 'rgba(8, 10, 14, 0.85)',
};

/** "White paper" staff: black ink on white, like printed sheet music. */
const PAPER_COLORS = {
  ...COLORS,
  bg: '#fbfaf6',
  label: '#3a3f47',
  labelFuture: '#0f1d33',
  labelBg: 'rgba(251, 250, 246, 0.85)',
  note: '#b9c0ca',
  noteFuture: '#2f5d9a',
  noteNow: '#e3a300',
  textOnNote: '#ffffff',
  contour: 'rgba(0, 120, 200, 0.8)',
  playhead: '#d92b2b',
  staffLine: '#1d2127',
  singGold: '#d99a00',
  singGreen: '#16a34a',
  singMiss: '#dc2626',
  singRest: '#6b7280',
  singOutline: 'rgba(255, 255, 255, 0.9)',
};

/** Diagnostics dot colours, indexed by DIAG code (postprocess.js).
 *  Keep in sync with the legend in index.html. */
const DIAG_COLORS = {
  2: '#7d8796', // too quiet
  3: '#b07cff', // background
  4: '#ff9f43', // low confidence
  5: '#ff4d4d', // out of range
  6: '#2ee6c5', // smoothed out
  7: '#ff7eb6', // too short
};

class PianoRoll {
  constructor(canvas, { onSeek } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.timeline = null;
    this.onSeek = onSeek;
    this.diagnostics = false; // show what was heard and why it was rejected
    this.labels = false;      // write each note's name just above its bar
    this.staff = false;       // staff layout instead of piano-roll rows
    this.windowSec = DEFAULT_WINDOW_SEC; // seconds visible (zoom)
    this.paper = false;       // white "sheet music" look (staff layout only)
    this.singer = null;       // sing-along: { trail: [{t, m, state}], head }
    this.clef = 'treble';     // 'treble' | 'treble8' | 'bass' (staff layout)
    this._lastT = NaN;
    this._dirty = true;

    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();

    canvas.addEventListener('click', (e) => {
      if (!this.timeline || !this.onSeek) return;
      const rect = canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const span = this.windowSec;
      this.onSeek(this._lastT - span / 4 + frac * span);
    });
  }

  setTimeline(tl) { this.timeline = tl; this._dirty = true; }
  /** Active colour palette. */
  get pal() { return this.staff && this.paper ? PAPER_COLORS : COLORS; }
  invalidate() { this._dirty = true; }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, width);
    this.h = Math.max(1, height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dirty = true;
  }

  /** Draw for time t. Skips work when nothing changed. */
  draw(t, fmt, currentNote) {
    const P = this.pal;
    if (!this._dirty && t === this._lastT) return;
    this._dirty = false;
    this._lastT = t;

    const { ctx, w, h } = this;
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);

    const tl = this.timeline;
    if (!tl) return;

    const span = this.windowSec;
    const t0 = t - span / 4;
    const xOf = (time) => ((time - t0) / span) * w;

    // Vertical scale: whole-track range (stable, doesn't jump around). In
    // diagnostics mode, also include the detection range plus a margin so
    // out-of-range pitches are visible.
    const c = tl.contour;
    const diag = this.diagnostics && c && c.reason;
    let lo = tl.minMidi - 1;
    let hi = tl.maxMidi + 1;
    if (diag) {
      lo = Math.min(lo, c.rangeLow - 4);
      hi = Math.max(hi, c.rangeHigh + 4);
    }

    // Geometry for the chosen layout: where a (fractional) pitch sits
    // vertically, how tall a note bar is, and the background grid.
    const g = this.staff ? this._staffGeometry(lo, hi, fmt) : this._pianoGeometry(lo, hi);
    g.drawGrid();

    // Notes.
    const nowX = xOf(t);
    const visible = tl.notesBetween(t0, t0 + span);
    const barH = g.barH;
    for (const nt of visible) {
      const x0 = xOf(nt.start);
      const x1 = xOf(nt.end);
      const yc = g.noteY(nt);
      const isNow = nt === currentNote;
      const color = isNow ? P.noteNow : nt.start > t ? P.noteFuture : P.note;
      g.decorateNote?.(nt, x0, x1, color);
      ctx.fillStyle = color;
      roundRect(ctx, x0, yc - barH / 2, Math.max(2, x1 - x0 - 1), barH, Math.min(4, barH / 2));
      ctx.fill();
      if (!this.labels && x1 - x0 > 26 && barH >= 9) {
        ctx.font = `${Math.min(11, barH)}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isNow ? P.textOnNow : P.textOnNote;
        ctx.fillText(noteLabel(nt, fmt), Math.max(x0, 0) + 4, yc);
      }
    }

    // Detected pitch curve.
    if (c) {
      const v = c.values;
      const i0 = Math.max(0, Math.floor((t0 - c.offsetSec) / c.hopSec));
      const i1 = Math.min(v.length - 1, Math.ceil((t0 + span - c.offsetSec) / c.hopSec));

      // Diagnostics: a dot wherever a pitch was heard but didn't make it into
      // a note, coloured by the reason (clamped to the strip's edges).
      if (diag) {
        const r = Math.max(1.5, Math.min(3, barH / 3));
        for (let i = i0; i <= i1; i++) {
          const col = DIAG_COLORS[c.reason[i]];
          const m = c.heard[i];
          if (!col || m !== m) continue;
          const x = xOf(c.offsetSec + i * c.hopSec);
          const y = Math.min(h - r, Math.max(r, g.pitchY(m)));
          ctx.fillStyle = col;
          ctx.fillRect(x - r / 2, y - r / 2, r, r);
        }
      }
      ctx.strokeStyle = P.contour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const m = v[i];
        if (m !== m) { pen = false; continue; }
        const x = xOf(c.offsetSec + i * c.hopSec);
        const y = g.pitchY(m);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }

    if (this.labels) this._drawLabels(visible, g, xOf, t, fmt, currentNote);
    if (this.singer) this._drawSinger(g, xOf, t0, fmt);

    // Playhead.
    ctx.fillStyle = P.playhead;
    ctx.fillRect(Math.round(nowX) - 1, 0, 2, h);
  }

  /**
   * Note names next to the bars, drawn last so nothing covers them. Every
   * name is shown: each tries a few spots (just above its bar, just below,
   * then one row further out) and takes the first that doesn't collide with
   * a name already placed. If all spots are taken it's drawn above anyway.
   * A dark backing keeps names readable over lines and bars.
   */
  _drawLabels(visible, g, xOf, t, fmt, currentNote) {
    const P = this.pal;
    const { ctx, h } = this;
    const size = 14;
    const pad = 2;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    const placed = []; // boxes already used: [x0, y0, x1, y1]
    const hits = (b) => placed.some((p) => b[0] < p[2] + pad && b[2] + pad > p[0] && b[1] < p[3] && b[3] > p[1]);

    for (const nt of visible) {
      const label = noteLabel(nt, fmt);
      const tw = ctx.measureText(label).width;
      const x = Math.max(xOf(nt.start), 0) + 1;
      const yc = g.noteY(nt);
      const above = yc - g.barH / 2 - 2;       // text baselines (bottom edge)
      const below = yc + g.barH / 2 + 2 + size;
      const spots = [above, below, above - size - 2, below + size + 2]
        .map((y) => Math.min(h - 1, Math.max(size + 1, y))); // stay inside the strip
      const boxAt = (y) => [x - 2, y - size, x + tw + 2, y];
      const y = spots.find((s) => !hits(boxAt(s))) ?? spots[0];
      const box = boxAt(y);
      placed.push(box);

      ctx.fillStyle = P.labelBg;
      ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      ctx.fillStyle = nt === currentNote ? P.noteNow : nt.start > t ? P.labelFuture : P.label;
      ctx.fillText(label, x, y);
    }
    ctx.textBaseline = 'middle';
  }

  /**
   * "Sing along": your voice as a thick line, coloured per reading by how
   * well it matches the song (gold = spot on, green = right note, red =
   * wrong note, grey = song is resting), with the note you're singing written
   * in front of the line's tip.
   */
  _drawSinger(g, xOf, t0, fmt) {
    const P = this.pal;
    const { ctx, w, h } = this;
    const { trail, head } = this.singer;
    const colorOf = (s) => [P.singRest, P.singMiss, P.singGreen, P.singGold][s];
    const yOf = (m) => Math.min(h - 2, Math.max(2, g.pitchY(m)));

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      if (b.t < t0 || a.m == null || b.m == null || b.t - a.t > 0.15) continue;
      const x0 = xOf(a.t), y0 = yOf(a.m), x1 = xOf(b.t), y1 = yOf(b.m);
      // Dark outline first so the line stays visible on top of note bars.
      ctx.strokeStyle = P.singOutline;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = colorOf(b.state);
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.lineCap = 'butt';

    if (head && head.m != null) {
      const x = xOf(head.t);
      const y = yOf(head.m);
      const color = colorOf(head.state);
      ctx.fillStyle = P.singOutline;
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI); ctx.fill();

      const label = noteLabel({ midi: Math.round(head.m) }, { ...fmt, octave: true });
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(w - tw - 6, x + 10);
      const ly = Math.min(h - 10, Math.max(10, y));
      ctx.fillStyle = P.labelBg;
      ctx.fillRect(lx - 3, ly - 10, tw + 6, 20);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly);
    }
  }

  /** Piano-roll layout: one row per semitone. */
  _pianoGeometry(lo, hi) {
    const P = this.pal;
    const { ctx, w, h } = this;
    const rowH = h / (hi - lo + 1);
    const pitchY = (m) => h - (m - lo + 0.5) * rowH; // row centre
    return {
      barH: Math.max(2, rowH - 1),
      pitchY,
      noteY: (nt) => pitchY(nt.midi),
      drawGrid() {
        // Darker rows for black keys, a line + label at each C.
        ctx.font = `${Math.max(9, Math.min(11, rowH))}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        for (let m = lo; m <= hi; m++) {
          const y = pitchY(m) - rowH / 2;
          if (isBlackKey(m)) {
            ctx.fillStyle = P.blackRow;
            ctx.fillRect(0, y, w, rowH);
          }
          if (m % 12 === 0) {
            ctx.fillStyle = P.cLine;
            ctx.fillRect(0, y + rowH - 1, w, 1);
            if (rowH >= 6) {
              ctx.fillStyle = P.label;
              ctx.fillText(midiLabel(m), 4, y + rowH / 2);
            }
          }
        }
      },
    };
  }

  /**
   * Staff layout: vertical position = where the note is WRITTEN on a staff.
   * Positions are counted in "staff steps" (each line and each space is one
   * step: C4 → D4 → E4 …), so B♭ and B share the B position. Five lines for
   * the part's clef, plus ledger lines for notes beyond them.
   */
  _staffGeometry(lo, hi, fmt) {
    const P = this.pal;
    const { ctx, w, h } = this;
    const clef = STAFF_CLEFS[this.clef] || STAFF_CLEFS.treble;
    const stepOf = (nt) => {
      const p = noteParts(nt, fmt);
      return p.octave * 7 + LETTER_STEPS.indexOf(p.letter) + clef.shift;
    };
    const stepOfMidi = (m) => stepOf({ midi: m });
    // Fractional pitch (the blue line) → interpolate between semitones.
    const stepOfPitch = (m) => {
      const f = Math.floor(m);
      const s0 = stepOfMidi(f);
      return s0 + (stepOfMidi(f + 1) - s0) * (m - f);
    };

    const bottom = clef.lines[0];
    const top = clef.lines[4];
    const sLo = Math.min(bottom - 2, stepOfMidi(lo));
    const sHi = Math.max(top + 2, stepOfMidi(hi));
    const half = h / (sHi - sLo + 2); // pixels per staff step
    const yOfStep = (s) => h - (s - sLo + 1) * half;
    const barH = Math.max(3, 2 * half * 0.8);

    return {
      barH,
      pitchY: (m) => yOfStep(stepOfPitch(m)),
      noteY: (nt) => yOfStep(stepOf(nt)),
      drawGrid() {
        ctx.fillStyle = P.staffLine;
        for (const s of clef.lines) ctx.fillRect(0, Math.round(yOfStep(s)), w, 1);
        // Clef symbol at the left edge (needs a font with music symbols;
        // Windows, macOS and most phones have one).
        ctx.fillStyle = P.label;
        ctx.textBaseline = 'middle';
        ctx.font = `${Math.round(half * clef.glyphSize)}px "Segoe UI Symbol", "Noto Music", "Apple Symbols", serif`;
        ctx.fillText(clef.glyph, 4, yOfStep(clef.glyphStep));
        if (clef.shift) {
          ctx.font = `${Math.max(9, Math.round(half * 1.6))}px system-ui, sans-serif`;
          ctx.fillText('8', 4 + half * 1.6, yOfStep(bottom - 3));
        }
      },
      decorateNote(nt, x0, x1, color) {
        const s = stepOf(nt);
        // Ledger lines between the staff and a note above/below it.
        ctx.fillStyle = P.staffLine;
        for (let l = bottom - 2; l >= s; l -= 2) ctx.fillRect(x0 - 3, Math.round(yOfStep(l)), x1 - x0 + 6, 1);
        for (let l = top + 2; l <= s; l += 2) ctx.fillRect(x0 - 3, Math.round(yOfStep(l)), x1 - x0 + 6, 1);
      },
    };
  }
}

/** Staff steps: octave*7 + index of the letter (C4 = 28, A4 = 33 …). */
const LETTER_STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** Clefs, with their five line positions in staff steps.
 *  treble8 (tenor) is written an octave above where it sounds. */
const STAFF_CLEFS = {
  treble: { lines: [30, 32, 34, 36, 38], shift: 0, glyph: '𝄞', glyphStep: 32, glyphSize: 7 },   // E4 G4 B4 D5 F5
  treble8: { lines: [30, 32, 34, 36, 38], shift: 7, glyph: '𝄞', glyphStep: 32, glyphSize: 7 },
  // glyphStep is a little below the F line (24) so the clef's curl wraps it.
  bass: { lines: [18, 20, 22, 24, 26], shift: 0, glyph: '𝄢', glyphStep: 23.4, glyphSize: 4.4 },  // G2 B2 D3 F3 A3
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
