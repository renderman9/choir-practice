/**
 * App wiring: file loading, part choice, analysis, tuning panel, playback,
 * and the requestAnimationFrame loop that keeps the display in sync.
 *
 * Data flow:
 *   note source (AudioNoteSource now, MusicXmlNoteSource later)
 *        └─► Timeline ─► setTimeline() ─► NoteDisplay + PianoRoll
 *   Player.time (audio clock) ─► rAF loop ─► Timeline.at(t) ─► display
 */

const $ = (id) => document.getElementById(id);

const settings = loadSettings();
const player = new Player();
const source = new AudioNoteSource();
const display = new NoteDisplay({
  current: $('currentNote'), next: $('nextNote'), nextIn: $('nextIn'), life: $('noteLife'),
});
const roll = new PianoRoll($('roll'), { onSeek: (t) => player.seek(t - settings.tuning.offsetMs / 1000) });

const state = {
  partFile: null,      // the analysed part track
  altFile: null,       // optional different file to listen to
  timeline: null,
  detectMs: 0,
  seeking: false,      // user dragging the seek bar
};

// ── Status / progress ────────────────────────────────────────────────────
function showProgress(text, fraction) {
  const p = $('progress');
  p.hidden = false;
  p.classList.toggle('indeterminate', fraction == null);
  $('progressFill').style.width = fraction == null ? '' : `${Math.round(fraction * 100)}%`;
  $('progressText').textContent = fraction == null ? text : `${text} ${Math.round(fraction * 100)}%`;
}
function hideProgress() { $('progress').hidden = true; }
function setStatus(text, isError = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

// ── Timeline (source-agnostic) ───────────────────────────────────────────
function setTimeline(tl) {
  state.timeline = tl;
  roll.setTimeline(tl);
  display.reset();
  // New notes = new song (or re-analysis): start the sing-along score over.
  sing.score = tl ? new SingScore(tl) : null;
  sing.trail = [];
  renderSingScore(true);
}

function describeTimeline(tl) {
  const m = tl.meta;
  const parts = [`${tl.notes.length} notes`];
  if (tl.notes.length) parts.push(`range ${midiLabel(tl.minMidi, fmt())}–${midiLabel(tl.maxMidi, fmt())}`);
  if (m.voicedPct != null) parts.push(`${Math.round(m.voicedPct)}% of track sung`);
  if (m.referenceCents) parts.push(`tuning A=${m.referenceHz.toFixed(1)} Hz (${m.referenceCents > 0 ? '+' : ''}${m.referenceCents}¢)`);
  if (state.detectMs) parts.push(`analysed in ${(state.detectMs / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

// ── Audio analysis ───────────────────────────────────────────────────────
function currentRange() {
  return { minMidi: settings.tuning.rangeLow, maxMidi: settings.tuning.rangeHigh };
}

async function loadPartFile(file) {
  state.partFile = file;
  $('fileName').textContent = file.name;
  if (!state.altFile) loadPlayback(file);
  setTimeline(null);
  setStatus('');
  showProgress('Decoding audio…', null);
  try {
    await source.load(file);
  } catch (err) {
    hideProgress();
    setStatus(`Couldn't decode "${file.name}". Is it an audio file your browser supports?`, true);
    return;
  }
  await runDetect();
}

async function runDetect() {
  if (!source.ready) return;
  showProgress('Finding notes…', 0);
  const t0 = performance.now();
  try {
    await source.detect(currentRange(), (f) => showProgress('Finding notes…', f));
  } catch (err) {
    if (err && err.cancelled) return; // superseded by a newer run
    hideProgress();
    setStatus(`Analysis failed: ${err.message || err}`, true);
    return;
  }
  state.detectMs = performance.now() - t0;
  hideProgress();
  rebuildTimeline();
}

function rebuildTimeline() {
  if (!source.hasFrames) return;
  const tl = source.buildTimeline({
    ...settings.tuning,
    minMidi: settings.tuning.rangeLow,
    maxMidi: settings.tuning.rangeHigh,
  });
  setTimeline(tl);
  setStatus(tl.notes.length
    ? describeTimeline(tl)
    : 'No notes found. Try lowering "Pitch confidence" or check the part / range in Tuning.');
}

// ── Playback ─────────────────────────────────────────────────────────────
function loadPlayback(file) {
  player.load(file);
  player.rate = settings.rate;
  $('playBtn').disabled = false;
  $('seek').disabled = false;
}

player.on('loadedmetadata', () => {
  $('seek').max = String(player.duration);
  $('timeTotal').textContent = formatTime(player.duration);
});
player.on('play', () => { $('playBtn').classList.add('playing'); $('playBtn').setAttribute('aria-label', 'Pause'); });
player.on('pause', () => { $('playBtn').classList.remove('playing'); $('playBtn').setAttribute('aria-label', 'Play'); });

$('playBtn').addEventListener('click', () => player.toggle());
$('seek').addEventListener('input', (e) => {
  state.seeking = true;
  player.seek(Number(e.target.value));
  $('timeNow').textContent = formatTime(Number(e.target.value));
});
$('seek').addEventListener('change', () => { state.seeking = false; });
$('rate').value = String(settings.rate);
$('rate').addEventListener('change', (e) => {
  settings.rate = Number(e.target.value);
  player.rate = settings.rate;
  saveSettings(settings);
});

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (tag === 'SELECT' || !player.loaded) return;
  if (e.code === 'Space') {
    e.preventDefault();
    player.toggle();
  } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && e.target.type !== 'range') {
    e.preventDefault();
    player.seek(player.time + (e.code === 'ArrowLeft' ? -5 : 5));
  }
});
// Buttons activate on Space *keyup*; swallow it so a focused button doesn't
// toggle playback a second time.
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && e.target.tagName === 'BUTTON') e.preventDefault();
});

// ── The sync loop ────────────────────────────────────────────────────────
// Everything visible is derived from the audio clock each animation frame,
// so the display can't drift from what you hear (no timers involved).
let lastTimeText = '';
function frame() {
  const audioT = player.time;
  const t = audioT + settings.tuning.offsetMs / 1000;
  const f = fmt();
  const tl = state.timeline;
  const now = tl ? tl.at(t) : { current: null, next: null };

  display.update(t, now, f, !!tl);
  if (mic.active) updateSinging(t, f);
  roll.draw(t, f, now.current);

  if (!state.seeking) $('seek').value = String(audioT);
  const tt = formatTime(audioT);
  if (tt !== lastTimeText) { $('timeNow').textContent = tt; lastTimeText = tt; }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Sing along ───────────────────────────────────────────────────────────
// Each frame: read your pitch from the mic, work out which moment of the
// song it belongs to (now minus the mic delay), compare with the song's note
// there, add it to the score (only while playing) and hand the trail to the
// strip for drawing.
const mic = new MicPitch();
const sing = {
  score: null,       // SingScore for the current timeline
  trail: [],         // recent readings: { t, m, state }
  lastT: NaN,
  lastStatsAt: 0,
  youKey: '',
};

function updateSinging(t, f) {
  const m = mic.read();
  const ts = t - settings.tuning.micLatencyMs / 1000;
  const playing = !player.paused;
  if (Math.abs(ts - sing.lastT) > 0.5) sing.trail = []; // seeked: start a fresh line
  sing.lastT = ts;

  const res = sing.score
    ? sing.score.add(ts, m, { anyOctave: !!settings.anyOctave, record: playing })
    : { state: SING.REST, cents: null };
  if (playing) {
    sing.trail.push({ t: ts, m, state: res.state });
    const keepFrom = ts - roll.windowSec;
    while (sing.trail.length && sing.trail[0].t < keepFrom) sing.trail.shift();
  }
  const note = mic.stableNote(); // note name with anti-flicker stickiness
  roll.singer = { trail: sing.trail, head: { t: ts, m, note, state: res.state } };
  roll.invalidate(); // redraw even while paused, so the tip follows your voice

  // "You" readout: the note you're singing, and how far off the song's note.
  const you = note == null ? '—' : noteLabel({ midi: note }, { ...f, octave: true });
  const cents = m == null || res.cents == null ? '' : res.cents === 0 ? 'on the note'
    : `${res.cents > 0 ? '+' : ''}${res.cents}¢ ${res.cents > 0 ? 'sharp' : 'flat'}`;
  const cls = m == null ? '' : ['', 'sing-miss', 'sing-green', 'sing-gold'][res.state];
  const key = `${you}|${cents}|${cls}`;
  if (key !== sing.youKey) {
    sing.youKey = key;
    $('singYou').textContent = you;
    $('singYou').className = `v ${cls}`;
    $('singCents').textContent = cents;
  }
  if (performance.now() - sing.lastStatsAt > 250) renderSingScore();
}

function renderSingScore(force = false) {
  sing.lastStatsAt = performance.now();
  if (!force && !mic.active) return;
  const s = sing.score?.summary();
  $('singSoFar').textContent = s?.soFar == null ? '—' : `${Math.round(s.soFar)}%`;
  $('singWhole').textContent = s ? `${Math.round(s.whole)}%` : '—';
  $('singCovered').textContent = s && s.covered > 0 ? `(sung ${Math.round(s.covered)}% of the song)` : '';
}

async function setSinging(on) {
  if (on) {
    try {
      await mic.start(currentRange());
    } catch (err) {
      $('singHint').textContent = err && err.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow mic access for this page (icon in the address bar) and try again.'
        : `Couldn't start the microphone: ${err.message || err}`;
      return;
    }
    $('singHint').textContent = 'Listening. Wear headphones, so the mic hears only you, not the track.';
  } else {
    mic.stop();
    roll.singer = null;
    roll.invalidate();
    $('singHint').textContent = 'Wear headphones, so the mic hears only you, not the track.';
  }
  $('singBtn').classList.toggle('listening', mic.active);
  $('singBtn').textContent = mic.active ? '■ Stop singing' : '🎤 Sing along';
  $('singStats').hidden = !mic.active;
  $('singReset').hidden = !mic.active;
  renderSingScore(true);
}

$('singBtn').addEventListener('click', () => setSinging(!mic.active));
$('singReset').addEventListener('click', () => {
  sing.score?.reset();
  sing.trail = [];
  renderSingScore(true);
});
$('anyOctave').checked = !!settings.anyOctave;
$('anyOctave').addEventListener('change', (e) => {
  settings.anyOctave = e.target.checked;
  saveSettings(settings);
});
player.on('ended', () => {
  if (!mic.active || !sing.score) return;
  const s = sing.score.summary();
  $('singHint').textContent = `Song finished! Whole-song score: ${Math.round(s.whole)}%.`;
  renderSingScore(true);
});

// ── File inputs & drag-and-drop ──────────────────────────────────────────
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadPartFile(file);
  e.target.value = '';
});
$('altInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  state.altFile = file;
  $('altName').textContent = `Playing: ${file.name}`;
  $('altClear').hidden = false;
  const t = player.time;
  loadPlayback(file);
  player.on('loadedmetadata', () => player.seek(t), { once: true });
});
$('altClear').addEventListener('click', () => {
  state.altFile = null;
  $('altName').textContent = 'Playing the part track';
  $('altClear').hidden = true;
  if (state.partFile) loadPlayback(state.partFile);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name));
  if (file) loadPartFile(file);
});

// ── Part picker ──────────────────────────────────────────────────────────
function renderPart() {
  for (const b of $('partPicker').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.part === settings.part));
  }
  const p = PARTS[settings.part];
  // Staff view uses the clef each part reads: tenors read treble-8.
  roll.clef = settings.part === 'B' ? 'bass' : settings.part === 'T' ? 'treble8' : 'treble';
  // The mic listens in the same range as the part.
  if (mic.active) mic.setRange(currentRange());
  roll.invalidate();
  $('partInfo').textContent = `${p.name} · listening ${midiLabel(settings.tuning.rangeLow, fmt())}–${midiLabel(settings.tuning.rangeHigh, fmt())}`;
}
$('partPicker').addEventListener('click', (e) => {
  const part = e.target.closest('button')?.dataset.part;
  if (!part || part === settings.part) return;
  settings.part = part;
  settings.tuning.rangeLow = PARTS[part].low;
  settings.tuning.rangeHigh = PARTS[part].high;
  saveSettings(settings);
  renderPart();
  syncTuningControls();
  runDetect();
});

// ── Display toggles ──────────────────────────────────────────────────────
function fmt() { return { flats: settings.flats, octave: settings.octave }; }
function renderToggles() {
  $('flatsBtn').setAttribute('aria-checked', String(settings.flats));
  $('sharpsBtn').setAttribute('aria-checked', String(!settings.flats));
  $('octaveToggle').checked = settings.octave;
  $('rollLabelsToggle').checked = !!settings.rollLabels;
  document.body.classList.toggle('roll-labels', !!settings.rollLabels);
  roll.labels = !!settings.rollLabels;
  $('staffToggle').checked = !!settings.staffView;
  document.body.classList.toggle('staff-view', !!settings.staffView);
  roll.staff = !!settings.staffView;
  // "White paper" only applies to (and is only offered in) staff view.
  $('paperToggleWrap').hidden = !settings.staffView;
  $('paperToggle').checked = !!settings.paper;
  roll.paper = !!settings.paper;
  document.body.classList.toggle('paper-staff', !!settings.staffView && !!settings.paper);
  roll.windowSec = settings.rollWindow || 8;
  $('rollWindow').value = String(roll.windowSec);
}
function onFormatChange() {
  saveSettings(settings);
  renderToggles();
  renderPart();
  syncTuningControls();
  roll.invalidate();
  if (state.timeline) setStatus(describeTimeline(state.timeline));
}
$('flatsBtn').addEventListener('click', () => { settings.flats = true; onFormatChange(); });
$('sharpsBtn').addEventListener('click', () => { settings.flats = false; onFormatChange(); });
$('octaveToggle').addEventListener('change', (e) => { settings.octave = e.target.checked; onFormatChange(); });
$('rollLabelsToggle').addEventListener('change', (e) => { settings.rollLabels = e.target.checked; onFormatChange(); });
$('staffToggle').addEventListener('change', (e) => { settings.staffView = e.target.checked; onFormatChange(); });
$('paperToggle').addEventListener('change', (e) => { settings.paper = e.target.checked; onFormatChange(); });
$('rollWindow').addEventListener('change', (e) => { settings.rollWindow = Number(e.target.value); onFormatChange(); });

// ── Tuning panel (generated from TUNING_DEFS) ───────────────────────────
const tuningInputs = new Map();

function formatTuning(def, v) {
  if (def.type === 'note') return midiLabel(v, { flats: settings.flats });
  return def.fmt ? def.fmt(v) : String(v);
}

function buildTuningPanel() {
  const host = $('tuningControls');
  for (const def of TUNING_DEFS) {
    const wrap = document.createElement('div');
    wrap.className = `tune ${def.type === 'checkbox' ? 'checkbox' : ''}`;
    const id = `tune-${def.key}`;
    let input;
    if (def.type === 'checkbox') {
      wrap.innerHTML = `<label class="head"><input type="checkbox" id="${id}"> ${def.label}</label>`;
      input = wrap.querySelector('input');
    } else {
      wrap.innerHTML = `<div class="head"><label for="${id}">${def.label}</label><output></output></div>`
        + `<input type="range" id="${id}" min="${def.min}" max="${def.max}" step="${def.step}">`;
      input = wrap.querySelector('input');
    }
    if (def.help) {
      const p = document.createElement('p');
      p.className = 'help';
      p.textContent = def.help;
      wrap.appendChild(p);
    }
    const out = wrap.querySelector('output');
    input.addEventListener(def.type === 'checkbox' ? 'change' : 'input', () => {
      settings.tuning[def.key] = def.type === 'checkbox' ? input.checked : Number(input.value);
      enforceRange(def.key);
      syncTuningControls();
      onTuningChanged(def);
    });
    tuningInputs.set(def.key, { def, input, out });
    host.appendChild(wrap);
  }
}

/** Keep lowest < highest by at least a fifth. */
function enforceRange(changedKey) {
  const t = settings.tuning;
  if (t.rangeHigh - t.rangeLow < 7) {
    if (changedKey === 'rangeLow') t.rangeHigh = Math.min(96, t.rangeLow + 7);
    else t.rangeLow = Math.max(28, t.rangeHigh - 7);
  }
}

function syncTuningControls() {
  for (const { def, input, out } of tuningInputs.values()) {
    const v = settings.tuning[def.key];
    if (def.type === 'checkbox') input.checked = !!v;
    else {
      input.value = String(v);
      out.textContent = formatTuning(def, v);
    }
  }
}

let notesTimer = 0;
let detectTimer = 0;
function onTuningChanged(def) {
  saveSettings(settings);
  if (def.stage === 'detect') {
    renderPart();
    clearTimeout(detectTimer);
    detectTimer = setTimeout(runDetect, 500);
  } else if (def.stage === 'notes') {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(rebuildTimeline, 80);
  } else {
    applyDiagnostics();
    roll.invalidate();
  }
}

function applyDiagnostics() {
  const on = !!settings.tuning.diagnostics;
  document.body.classList.toggle('diagnostics', on);
  $('diagLegend').hidden = !on;
  roll.diagnostics = on;
  roll.invalidate();
}

$('reanalyze').addEventListener('click', () => runDetect());
$('favoriteTuning').addEventListener('click', () => {
  // Keep non-tuning toggles (e.g. diagnostics) as they are.
  settings.tuning = { ...settings.tuning, ...FAVORITE_TUNING };
  saveSettings(settings);
  syncTuningControls();
  renderPart();
  if (source.isDetectedFor(currentRange())) rebuildTimeline(); else runDetect();
});
$('resetTuning').addEventListener('click', () => {
  const part = PARTS[settings.part];
  settings.tuning = { ...defaultSettings().tuning, rangeLow: part.low, rangeHigh: part.high };
  saveSettings(settings);
  syncTuningControls();
  renderPart();
  applyDiagnostics();
  if (source.isDetectedFor(currentRange())) rebuildTimeline(); else runDetect();
});

// ── Helpers / init ───────────────────────────────────────────────────────
function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

buildTuningPanel();
syncTuningControls();
renderToggles();
renderPart();
applyDiagnostics();
