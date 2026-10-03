# Choir Practice

Load your part track (MP3) and the app shows, big and clear, the note you
should be singing right now, plus the next one. It all runs in your browser.
Nothing is uploaded anywhere.

## Run it

Double-click `index.html`. There's nothing to install and no server needed.

The code uses plain `<script>` tags (not ES modules) and does no Web Worker
work, because browsers block both on pages opened from `file://`. Script
order in `index.html` matters, since each file uses names defined in the
ones above it.

To use it on a phone, either copy the folder to the phone, or serve it on your
Wi-Fi (`python -m http.server 8000`) and open `http://<your-pc-ip>:8000`.

Run the offline pipeline test (synthetic voice over a quieter background part,
needs Node):

```sh
npm test
```

## Using it

1. **Choose part track…** (or drag an MP3 onto the page).
2. Pick your part: **S / A / T / B**. This sets the pitch range the detector
   listens in.
3. Wait for the progress bar (about 1–3 s per 4-minute song).
4. Press play. **Space** = play/pause, **←/→** = skip 5 s, click the strip to seek.

- **♭ / ♯**: spell black keys as flats (default) or sharps.
- **Octave numbers**: B♭ → B♭3 (scientific pitch, C4 = middle C; tenors see
  their *sounding* octave).
- **Speed**: slow down without changing pitch.
- **Listen to a different file**: hear the full mix while the notes still
  come from your part track. The files must be time-aligned.
- The piano-roll strip shows detected notes as bars and the raw detected
  pitch as a thin blue line. When tuning, compare the two.

## Tuning settings

Every setting except the range re-applies instantly. Changing the range re-runs
pitch detection (a few seconds).

**Start with diagnostics.** Tick **Show diagnostics** at the top of the Tuning
panel. The strip then shows coloured dots wherever the detector heard a pitch
but threw it away, and the legend says which setting caused it. Find a spot
where the app wrongly says "rest", look at the colour there, and adjust that
one setting.

| Setting | What it does | Change it when… |
|---|---|---|
| **Pitch confidence** (0.75) | Minimum "clarity" (how periodic the sound is, 0–1) for a moment to count as singing. | Raise it if stray notes appear on breaths, consonants or chords. Lower it if real notes are missing (breathy voices, busy mixes). |
| **Volume gate** (35 dB) | Ignores anything this far below the track's loud level. Removes silence and room noise. | Lower it if quiet noise shows up as notes. |
| **Background rejection** (10 dB) | Ignores sound this far below the loudest moments of the surrounding ±4 s. Your part is the loudest, so this removes the other parts during your rests. 0 = off. | **Lower** it if other parts' notes show up while you rest. **Raise** it if your own soft notes disappear. |
| **Smoothing** (120 ms) | Median filter over the pitch curve. Absorbs vibrato and blips but keeps note changes sharp. | Raise it for heavy vibrato. Lower it if fast runs get smeared. |
| **Note stickiness** (15¢) | The pitch must move this far *past* the halfway point between two semitones before the display changes note. | Raise it if a note flickers between two neighbours. Lower it if semitone steps sung a bit flat are missed. |
| **Min note length** (80 ms) | Shorter detected notes are discarded (scoops, slides, glitches). | Raise it if you see brief wrong notes at transitions. Lower it for fast passages. |
| **Ignore gaps shorter than** (150 ms) | A gap this short isn't shown as a rest; the previous note is held. Repeated same-pitch notes with a short gap merge. | Lower it if you want short rests/staccato shown. |
| **Auto-detect tuning** (on) | Estimates if the whole recording is sharp/flat of A=440 (shown in the status line) and compensates. | Turn off for a cappella recordings that drift a lot. |
| **Lowest / Highest note** | Detection range; resets when you change part. Pitches outside are ignored, which prevents octave errors and jumping to other parts. | Widen it if your part goes outside the default. Narrow it if the detector jumps an octave. |
| **Display sync offset** (0 ms) | Shifts the display against the audio. | Set it to about −150…−250 ms with Bluetooth headphones. |

## How it works

```
MP3 ─► decode + resample to 16 kHz mono (Web Audio, local)
    ─► McLeod Pitch Method per 10 ms frame → pitch, clarity, loudness
       (run in ~25 ms slices so the page stays responsive)
    ─► gates → tuning-reference correction → median filter
    ─► semitone rounding with hysteresis → segments → drop short / bridge gaps
    ─► Timeline [{start, end, midi, name}]
    ─► display + piano roll, driven by audio.currentTime in requestAnimationFrame
```

| File | Role |
|---|---|
| `src/analysis/mpm.js` | Pitch detector (McLeod Pitch Method) |
| `src/analysis/frameAnalysis.js` | Stage 1: per-frame measurements (slow, cached) |
| `src/analysis/postprocess.js` | Stage 2: smoothing + note segmentation (instant) |
| `src/sources/audioSource.js` | Note source: audio file → Timeline |
| `src/sources/musicxmlSource.js` | Note source: score → Timeline (**phase 2 stub**) |
| `src/timeline.js` | Shared Timeline format + lookups |
| `src/player.js`, `display.js`, `pianoRoll.js` | Playback and display (source-agnostic) |
| `src/settings.js` | Part ranges, tuning definitions, saved settings |

### Phase 2 (MusicXML)

`musicxmlSource.js` documents the plan. It will produce the same `Timeline`
with `spelling: {step, alter, octave}` on each note, so the display shows the
score's own B♭/A♯. The player's existing sync offset handles the start offset.
