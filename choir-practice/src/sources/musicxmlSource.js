/**
 * MusicXmlNoteSource — PHASE 2, NOT IMPLEMENTED YET.
 *
 * This file pins down the shape so it slots in next to AudioNoteSource
 * without touching the player or display. main.js treats both sources the
 * same way: get a Timeline, hand it to setTimeline().
 *
 * Planned implementation:
 *   load(file)
 *     - Read .musicxml/.xml text (or unzip .mxl: META-INF/container.xml points
 *       at the root score file) and parse it with DOMParser. Still local-only.
 *   listParts() → [{ id: 'P1', name: 'Soprano' }, ...]
 *     - From <part-list>/<score-part>. Some choir scores put S+A on one staff
 *       with two voices, so also expose (part, staff, voice) combinations.
 *   buildTimeline({ partId, staff, voice })
 *     - Walk <measure>s keeping a position in "divisions" (from <attributes>).
 *       <note> advances by <duration> unless it has <chord/>; <backup>/<forward>
 *       move the cursor; <rest/> produces no note.
 *     - Tempo map: collect <sound tempo="…"> (and <metronome> as a fallback)
 *       with their positions, then convert divisions → quarter notes →
 *       seconds by integrating over the tempo segments.
 *     - Ties (<tie type="start|stop">) merge into one long note.
 *     - Repeats/voltas (<repeat>, <ending>) should be unrolled in playback
 *       order, since the practice track plays them out.
 *     - Each note gets midi = 12*(octave+1) + stepSemitone + alter, and
 *       spelling = { step, alter, octave } so the display shows B♭ vs A♯
 *       exactly as written.
 *     - return new Timeline(notes, { source: 'musicxml' })
 *   Sync: the score's beat 1 rarely sits at 0:00 in the MP3. The player's
 *   existing "sync offset" setting already shifts any timeline; the score UI
 *   would expose it as a wider "start offset" slider.
 */
// import { Timeline } from '../timeline.js';

class MusicXmlNoteSource {
  constructor() {
    this.kind = 'musicxml';
  }

  async load(/* file */) {
    throw new Error('MusicXML support is planned for phase 2.');
  }

  listParts() {
    return [];
  }

  buildTimeline(/* { partId, staff, voice } */) {
    throw new Error('MusicXML support is planned for phase 2.');
  }
}
