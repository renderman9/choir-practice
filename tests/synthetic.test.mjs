/**
 * Offline sanity test for the analysis pipeline (no browser needed):
 *   node tests/synthetic.test.mjs
 *
 * Synthesises a "part track": a vibrato voice with harmonics, sung slightly
 * flat (A = 436 Hz), over a quieter background part and some noise, then
 * checks the detected notes match what was synthesised.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The app uses plain browser scripts (so it opens from file://), so load them
// into one shared context in the same order as index.html.
const ctx = vm.createContext({ console, Math, performance });
for (const f of ['notes', 'analysis/mpm', 'analysis/frameAnalysis', 'analysis/postprocess', 'settings']) {
  vm.runInContext(readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'), ctx, { filename: `${f}.js` });
}
const { analyzeFrames, buildNotes, defaultSettings, PARTS, noteLabel, ANALYSIS_SAMPLE_RATE: SR } =
  vm.runInContext('({ analyzeFrames, buildNotes, defaultSettings, PARTS, noteLabel, ANALYSIS_SAMPLE_RATE })', ctx);

const DETUNE = 12 * Math.log2(436 / 440); // whole track ~15 cents flat

// Melody for an alto: [midi or null (rest), seconds]
const melody = [
  [null, 0.4], [69, 0.5], [70, 0.4], [null, 0.35], [74, 0.6],
  [null, 0.06], [74, 0.3], [72, 0.5], [67, 0.12], [65, 0.8], [null, 0.5],
  [57, 0.6], [60, 0.45], [null, 0.4],
];
// Background part (e.g. tenor bleed), always sounding, 14 dB quieter.
const background = [[57, 1.5], [55, 1.5], [53, 2.0], [52, 1.5]];

function render(seq, gain, vibrato, rng) {
  const total = seq.reduce((s, [, d]) => s + d, 0);
  const out = new Float32Array(Math.ceil(total * SR));
  let pos = 0;
  let phase = 0;
  for (const [midi, dur] of seq) {
    const n = Math.round(dur * SR);
    if (midi != null) {
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const vib = vibrato ? 0.4 * Math.sin(2 * Math.PI * 5.5 * t + rng()) : 0; // ±40 cents
        const f = 440 * Math.pow(2, (midi + DETUNE + vib - 69) / 12);
        phase += (2 * Math.PI * f) / SR;
        const env = Math.min(1, t / 0.03, (dur - t) / 0.03);
        let s = 0;
        for (let h = 1; h <= 6; h++) s += Math.sin(h * phase) / (h * h * 0.6 + 0.4);
        out[pos + i] += gain * env * s;
      }
    }
    pos += n;
  }
  return out;
}

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const voice = render(melody, 0.3, true, () => 0);
const bg = render(background, 0.3 * Math.pow(10, -14 / 20), true, () => 1);
const mix = new Float32Array(voice.length);
for (let i = 0; i < mix.length; i++) mix[i] = voice[i] + (bg[i] || 0) + 0.003 * (rng() * 2 - 1);

const part = PARTS.A;
const t0 = performance.now();
const frames = analyzeFrames(mix, SR, { minMidi: part.low, maxMidi: part.high });
const t1 = performance.now();
const tuning = { ...defaultSettings().tuning, minMidi: part.low, maxMidi: part.high };
const { notes, stats } = buildNotes(frames, tuning);

console.log(`frames: ${frames.freq.length}, analysis ${(t1 - t0).toFixed(0)} ms for ${(mix.length / SR).toFixed(1)} s of audio`);
console.log(`reference: ${stats.referenceHz.toFixed(1)} Hz (${stats.referenceCents}¢)`);
for (const n of notes) console.log(`  ${n.start.toFixed(2)}–${n.end.toFixed(2)}  ${noteLabel(n, { octave: true })}`);

// Expected sung notes. The 120 ms G4 passing note is kept (> 80 ms min).
// The two D5s are separated by only 60 ms, so they're bridged into one note.
const expected = [69, 70, 74, 72, 67, 65, 57, 60];
const got = notes.map((n) => n.midi);
const ok = JSON.stringify(got) === JSON.stringify(expected);
console.log(ok ? 'PASS' : `FAIL\n  expected ${expected}\n  got      ${got}`);

// Timing check: each detected note should start within 60 ms of the truth.
let tcur = 0;
const truthStarts = [];
for (const [midi, d] of melody) { if (midi != null) truthStarts.push([midi, tcur]); tcur += d; }
const truthMerged = truthStarts.filter((x, i, a) => !(i > 0 && a[i - 1][0] === x[0]));
let timingOk = ok;
if (ok) {
  notes.forEach((n, i) => {
    const err = Math.abs(n.start - truthMerged[i][1]);
    if (err > 0.06) { timingOk = false; console.log(`  onset off by ${(err * 1000).toFixed(0)} ms for note ${i}`); }
  });
  console.log(timingOk ? 'PASS timing' : 'FAIL timing');
}
process.exit(ok && timingOk ? 0 : 1);
