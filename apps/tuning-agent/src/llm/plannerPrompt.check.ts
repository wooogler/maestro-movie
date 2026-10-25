/**
 * Executable check for the quick-card narration directive:
 *
 *   npx tsx apps/tuning-agent/src/llm/plannerPrompt.check.ts
 *
 * One claim to defend, the same one the language check defends. The recorded
 * study ran against a particular system prompt, and teaching the planner to
 * narrate GUI adaptations for a sixty-second booth card must not have changed
 * it. So the flag off has to produce the prompt byte-for-byte, not a prompt
 * that merely reads the same.
 *
 * The second claim is smaller but easy to get wrong: the prompt is memoized in
 * a single module-level slot, so the flag has to be part of the cache key or
 * the first session to build a prompt decides for the next one.
 *
 * Exit code 0 means every case passed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  STUDY_THEATER_FORMAT_NOTE,
  STUDY_TIME_FORMAT_NOTE,
  buildPreferenceSystemPrompt,
  getExtractorSystemPrompt,
} from './llmExtractor';
import { buildLanguageSection, buildSystemPrompt } from './llmPlanner';
import type { PlannerWorkflow } from './llmPlanner';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const STAGE_META = [{ stage: 'movie', goal: 'pick a film', fieldGuide: 'title, genre' }];

function workflow(guiAdaptationEnabled: boolean, cpMemoryEnabled = false): PlannerWorkflow {
  return {
    currentStage: 'movie',
    previousStage: null,
    nextStage: 'theater',
    proceedRule: 'Call next only when selectedId exists (current: null).',
    availableToolNames: ['select', 'respond'],
    guiAdaptationEnabled,
    cpMemoryEnabled,
  } as PlannerWorkflow;
}

/**
 * Every configuration a recorded study session could have run in. `cpMemory`
 * belongs here and used to be hardcoded to false: `cpMemoryWindow` is 10 in
 * `full-tuning-voice-off` and `full-tuning-voice-on`, so the check named "a
 * study session is byte-identical" was exercising only the conditions that
 * DON'T use preference memory.
 */
const STUDY_CONFIGS: Array<{ gui: boolean; cp: boolean; language: string }> = [];
for (const gui of [true, false]) {
  for (const cp of [true, false]) {
    for (const language of ['en', 'ko']) STUDY_CONFIGS.push({ gui, cp, language });
  }
}

function studyPrompt(config: { gui: boolean; cp: boolean; language: string }): string {
  return buildSystemPrompt(workflow(config.gui, config.cp), STAGE_META, config.language);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

const NARRATION_MARKER = 'Narrating the adaptation';
const BREVITY_MARKER = 'Writing for the ear';
const PRELOAD_MARKER = 'Remembered preferences (this session)';
const DEMO_MARKER = 'Booth demo (this session)';
const DECISIVE_MARKER = 'Deciding for the visitor (booth demo)';
const CONFLICT_MARKER = 'Two requirements that rule each other out (booth demo)';
const OPENING_MARKER = 'Opening a stage (booth demo)';
const SEAT_MARKER = 'Seats (booth demo)';
const HIDDEN_ONCE_MARKER = 'Hidden options, said once (booth demo)';

/*
  The prompt the recorded study ran against, pinned by content.

  The checks below all compare one build against another, which catches a demo
  flag leaking into a study session but NOT an edit to the rules themselves —
  both sides move together and the check stays green. These hashes are the part
  that fails when someone edits `CORE_SYSTEM_PROMPT`, the CP-memory rules, the
  GUI adaptation rules, the tool-calling rules or a language section.

  A failure here is not automatically a bug. It means a prompt C1-C4 were
  recorded against has changed, and that is a decision to make deliberately: if
  the change is intended and the study data is being re-collected or the
  affected sessions are demo-only, update the hash in the same commit that
  changes the prompt, and say why.
*/
const PINNED_STUDY_PROMPTS: Record<string, string> = {
  'gui:1 cp:1 en': '073a6359a796d885',
  'gui:1 cp:1 ko': 'a1355633b05ed52a',
  'gui:1 cp:0 en': '704e3e9d4ea14aa2',
  'gui:1 cp:0 ko': 'ded8c8828e127456',
  'gui:0 cp:1 en': '9ccfa79c736a763a',
  'gui:0 cp:1 ko': '648013b0f1fb6582',
  'gui:0 cp:0 en': '88936f0170b1bae1',
  'gui:0 cp:0 ko': '6762fdef500951ff',
};

console.log('\n0. the recorded study prompt, pinned by content');
for (const config of STUDY_CONFIGS) {
  const key = `gui:${config.gui ? 1 : 0} cp:${config.cp ? 1 : 0} ${config.language}`;
  const actual = digest(studyPrompt(config));
  check(`${key} is unchanged`, actual === PINNED_STUDY_PROMPTS[key], `now ${actual}`);
}

console.log('\n1. a study session is byte-identical');
for (const config of STUDY_CONFIGS) {
  const key = `gui:${config.gui ? 1 : 0} cp:${config.cp ? 1 : 0} ${config.language}`;
  const before = studyPrompt(config);
  const wf = workflow(config.gui, config.cp);
  const explicitlyOff = buildSystemPrompt(wf, STAGE_META, config.language, false);
  const undefinedFlag = buildSystemPrompt(wf, STAGE_META, config.language, undefined);
  check(`${key}: omitting the flag equals passing false`, before === explicitlyOff);
  check(`${key}: ...and equals passing undefined`, before === undefinedFlag);
  check(`${key}: no narration section appears`, !before.includes(NARRATION_MARKER));

  const brevityOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false);
  const brevityUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, undefined);
  check(`${key}: the brevity flag off changes nothing`, before === brevityOff);
  check(`${key}: ...and neither does leaving it undefined`, before === brevityUndefined);
  check(`${key}: no brevity section appears`, !before.includes(BREVITY_MARKER));

  const preloadOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false);
  const preloadUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, undefined);
  check(`${key}: the preloaded-memory flag off changes nothing`, before === preloadOff);
  check(`${key}: ...and neither does leaving it undefined`, before === preloadUndefined);
  check(`${key}: no remembered-preferences section appears`, !before.includes(PRELOAD_MARKER));

  const demoOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false);
  const demoUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, undefined);
  check(`${key}: the demo flag off changes nothing`, before === demoOff);
  check(`${key}: ...and neither does leaving it undefined`, before === demoUndefined);
  check(`${key}: no booth-demo section appears`, !before.includes(DEMO_MARKER));

  const decisiveOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false);
  const decisiveUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, undefined);
  // The flag without the demo flag is a caller's mistake, and must still be a no-op.
  const decisiveWithoutDemo = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, true);
  check(`${key}: the decisive flag off changes nothing`, before === decisiveOff);
  check(`${key}: ...and neither does leaving it undefined`, before === decisiveUndefined);
  check(`${key}: ...nor asking for it outside a demo session`, before === decisiveWithoutDemo);
  check(`${key}: no decisive-selection section appears`, !before.includes(DECISIVE_MARKER));

  const conflictsOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false);
  const conflictsUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, undefined);
  const conflictsWithoutDemo = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, true);
  check(`${key}: the requirement-conflict flag off changes nothing`, before === conflictsOff);
  check(`${key}: ...and neither does leaving it undefined`, before === conflictsUndefined);
  check(`${key}: ...nor asking for it outside a demo session`, before === conflictsWithoutDemo);
  check(`${key}: no requirement-conflict section appears`, !before.includes(CONFLICT_MARKER));

  const openingOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false);
  const openingUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, undefined);
  const openingWithoutDemo = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, true);
  check(`${key}: the opening-question flag off changes nothing`, before === openingOff);
  check(`${key}: ...and neither does leaving it undefined`, before === openingUndefined);
  check(`${key}: ...nor asking for it outside a demo session`, before === openingWithoutDemo);
  check(`${key}: no opening-question section appears`, !before.includes(OPENING_MARKER));

  const seatsOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, false);
  const seatsUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, undefined);
  const seatsWithoutDemo = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, true);
  check(`${key}: the seat-choice flag off changes nothing`, before === seatsOff);
  check(`${key}: ...and neither does leaving it undefined`, before === seatsUndefined);
  check(`${key}: ...nor asking for it outside a demo session`, before === seatsWithoutDemo);
  check(`${key}: no seat-choice section appears`, !before.includes(SEAT_MARKER));

  const hiddenOff = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, false, false);
  const hiddenUndefined = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, false, undefined);
  const hiddenWithoutDemo = buildSystemPrompt(wf, STAGE_META, config.language, false, false, false, false, false, false, false, false, true);
  check(`${key}: the hidden-count-once flag off changes nothing`, before === hiddenOff);
  check(`${key}: ...and neither does leaving it undefined`, before === hiddenUndefined);
  check(`${key}: ...nor asking for it outside a demo session`, before === hiddenWithoutDemo);
  check(`${key}: no hidden-count-once section appears`, !before.includes(HIDDEN_ONCE_MARKER));
}
check(
  'the style rule the narration section would override is still there, untouched',
  studyPrompt({ gui: true, cp: false, language: 'en' }).includes(
    'Treat assistantMessage as a brief spoken cue'
  )
);

console.log('\n2. a quick card gets the section, and only adds to the prompt');
{
  const off = buildSystemPrompt(workflow(true), STAGE_META, 'en', false);
  const on = buildSystemPrompt(workflow(true), STAGE_META, 'en', true);
  check('the section is appended', on.includes(NARRATION_MARKER));
  check('the off prompt is a prefix of the on prompt — nothing was removed', on.startsWith(off));
  check(
    'it comes after the rules it overrides',
    on.indexOf(NARRATION_MARKER) > on.indexOf('Treat assistantMessage as a brief spoken cue')
  );
  check('it says which side wins on conflict', /this section wins/i.test(on));
  check(
    'it still forbids reciting the items, which is what the screen is for',
    /never the survivors|item-by-item/i.test(on)
  );
}

console.log('\n3. nothing to narrate without GUI adaptation');
{
  const plain = buildSystemPrompt(workflow(false), STAGE_META, 'en', false);
  const asked = buildSystemPrompt(workflow(false), STAGE_META, 'en', true);
  check('asking for narration with adaptation off changes nothing', plain === asked);
  check('and adds no section', !asked.includes(NARRATION_MARKER));
}

console.log('\n4. the memo cannot leak one session’s prompt into the next');
{
  /*
    The prompt is cached in ONE module-level slot keyed by its inputs. These
    calls alternate so that each one would hit a stale cache if the flag were
    missing from that key — which is exactly the bug that would hand a study
    session a booth prompt, or the reverse.
  */
  const loudFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', true);
  const quietAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false);
  const loudAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', true);
  check('quiet after loud is quiet', !quietAfter.includes(NARRATION_MARKER));
  check('loud after quiet is loud again', loudAgain.includes(NARRATION_MARKER));
  check('and the two loud builds agree', loudFirst === loudAgain);
  check(
    'language still separates too, with the flag on',
    buildSystemPrompt(workflow(true), STAGE_META, 'ko', true) !== loudAgain
  );
}

console.log('\n5. a voice demo session gets the brevity section, and only adds to the prompt');
{
  const off = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false);
  const on = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, true);
  check('the section is appended', on.includes(BREVITY_MARKER));
  check('the off prompt is a prefix of the on prompt — nothing was removed', on.startsWith(off));
  check(
    'it comes after the style rule it overrides',
    on.indexOf(BREVITY_MARKER) > on.indexOf('Treat assistantMessage as a brief spoken cue')
  );
  check('it says which side wins on conflict', /this section wins/i.test(on));
  check(
    'it asks for an empty message rather than a narrated one',
    /empty string/i.test(on.slice(on.indexOf(BREVITY_MARKER)))
  );
  check(
    'it protects the question, which is the one thing brevity must not cost',
    /never drop a question/i.test(on)
  );

  // It applies whether or not GUI adaptation is on: the tool-calling rule that
  // lengthens the sentence is core, not adaptation-only.
  const noGui = buildSystemPrompt(workflow(false), STAGE_META, 'en', false, true);
  check('it is not conditional on GUI adaptation', noGui.includes(BREVITY_MARKER));
}

console.log('\n6. the two demo directives cannot argue with each other');
{
  /*
    A quick card asks the planner to describe what it did to the screen; a voice
    session asks it to leave the screen to speak for itself. Both on would be a
    prompt contradicting itself, so `buildSystemPrompt` resolves it rather than
    trusting the caller — the card wins, being the more specific situation.
  */
  const cardOnly = buildSystemPrompt(workflow(true), STAGE_META, 'en', true, false);
  const both = buildSystemPrompt(workflow(true), STAGE_META, 'en', true, true);
  check('a card with brevity also asked for is just a card', cardOnly === both);
  check('and carries no brevity section', !both.includes(BREVITY_MARKER));
}

console.log('\n7. the brevity flag is part of the memo key too');
{
  const briefFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, true);
  const plainAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false);
  const briefAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, true);
  check('plain after brief is plain', !plainAfter.includes(BREVITY_MARKER));
  check('brief after plain is brief again', briefAgain.includes(BREVITY_MARKER));
  check('and the two brief builds agree', briefFirst === briefAgain);
  check(
    'language still separates with the brevity flag on',
    buildSystemPrompt(workflow(true), STAGE_META, 'ko', false, true) !== briefAgain
  );
}

console.log('\n8. a profile-seeded demo session gets the remembered-preferences section');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, true);
  check('the section is appended', on.includes(PRELOAD_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check(
    'it restates the visibility gate: augment before filter, sort or highlight',
    /FIRST augment[\s\S]*THEN filter, sort or highlight/.test(on)
  );
  check(
    'it comes after the GUI rules whose gate it restates',
    on.indexOf(PRELOAD_MARKER) > on.indexOf('Step 1 — visibility gate')
  );
  check(
    'and before the brevity section, which still wins on wording',
    on.indexOf(PRELOAD_MARKER) < on.indexOf(BREVITY_MARKER)
  );
  check('and before the language section', on.indexOf(PRELOAD_MARKER) < on.indexOf('Language:'));
  const plain = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, false);
  const asked = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, true);
  check('with GUI adaptation off there is nothing to order, so nothing is added', plain === asked);
  const withFirst = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, true);
  const withoutAfter = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, false);
  const withAgain = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(PRELOAD_MARKER));
  check('and on after off is on again', withAgain.includes(PRELOAD_MARKER) && withFirst === withAgain);
}

console.log('\n9. a booth demo session gets the demo section, before brevity and language');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, true, true);
  check('the section is appended', on.includes(DEMO_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check('it forbids talking about tool availability', /Never tell the user which tools/.test(on));
  check('it tells the planner where the booking summary is', /currentView\.booking/.test(on));
  check(
    'it sits after the GUI rules and before the remembered-preferences, brevity and language sections',
    on.indexOf(DEMO_MARKER) > on.indexOf('Step 1 — visibility gate') &&
      on.indexOf(DEMO_MARKER) < on.indexOf(PRELOAD_MARKER) &&
      on.indexOf(DEMO_MARKER) < on.indexOf(BREVITY_MARKER) &&
      on.indexOf(DEMO_MARKER) < on.indexOf('Language:')
  );
  const withFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true);
  const withoutAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, false);
  const withAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(DEMO_MARKER));
  check('and on after off is on again', withAgain.includes(DEMO_MARKER) && withFirst === withAgain);
}

console.log('\n10. a booth demo session that asks for decisive selection gets the section, after brevity');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, true, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, true, true, true);
  check('the section is appended', on.includes(DECISIVE_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check('it says which side wins on conflict', /this section wins/i.test(on.slice(on.indexOf(DECISIVE_MARKER))));
  check(
    'it names the brevity section among what it overrides, since brevity forbids selecting without consent',
    /the brevity section/.test(on.slice(on.indexOf(DECISIVE_MARKER)))
  );
  check(
    'it sits after the demo, remembered-preferences and brevity sections and before the language section',
    on.indexOf(DECISIVE_MARKER) > on.indexOf(DEMO_MARKER) &&
      on.indexOf(DECISIVE_MARKER) > on.indexOf(PRELOAD_MARKER) &&
      on.indexOf(DECISIVE_MARKER) > on.indexOf(BREVITY_MARKER) &&
      on.indexOf(DECISIVE_MARKER) < on.indexOf('Language:')
  );
  const tail = on.slice(on.indexOf(DECISIVE_MARKER));
  check('it keeps the final booking confirmation', /\[confirm-booking\]/.test(tail) && /always stays/.test(tail));
  check('a position in the visible list names an option', /A position names an option too/.test(tail));
  check('it keeps the fuzzy-match clarification', /\[ask-fuzzy\]/.test(tail) && /Never select a near miss/.test(tail));
  check('it keeps the remembered-preference question', /\[ask-remembered\]/.test(tail) && /prf_/.test(tail));
  check(
    'only a prf_ id is remembered: a pref_ id was said in this session, even after it leaves history',
    /Only "prf_" ids are remembered/.test(tail) &&
      /"pref_" was extracted from what the visitor said in this session/.test(tail) &&
      /never under \(6\)/.test(tail) &&
      !/or one the visitor has not stated in history/.test(tail)
  );
  check('a stated day at the date stage is selected, or at most stated', /call select on that day as the FIRST step, never highlight it first/.test(tail));
  check('a direct answer ends with the answer', /\[answer\]/.test(tail) && /nothing after it/.test(tail));
  check('it asks for the rule tag in reason, which the metric script reads', /Begin the reason field with the rule/.test(tail));
  check(
    'it never selects a filtered-down survivor as if it were the only option',
    /never select the one option a filter left on screen/.test(tail)
  );
  const withFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true);
  const withoutAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, false);
  const withAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(DECISIVE_MARKER));
  check('and on after off is on again', withAgain.includes(DECISIVE_MARKER) && withFirst === withAgain);
  const demoOnly = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, false);
  check('without the flag a demo session reads exactly as before', demoOnly === withoutAfter && !demoOnly.includes(DECISIVE_MARKER));
}

console.log('\n11. a booth demo session with CP memory gets the requirement-conflict section, last before language');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true);
  check('the section is appended', on.includes(CONFLICT_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  const tail = on.slice(on.indexOf(CONFLICT_MARKER), on.indexOf('Language:'));
  check(
    'it sits after the decisive-selection and brevity sections it overrides, and before the language section',
    on.indexOf(CONFLICT_MARKER) > on.indexOf(DECISIVE_MARKER) &&
      on.indexOf(CONFLICT_MARKER) > on.indexOf(BREVITY_MARKER) &&
      on.indexOf(CONFLICT_MARKER) < on.indexOf('Language:')
  );
  check('it says which side wins on conflict', /this section wins/i.test(tail));
  check('it names the dead-end and backtracking rules among what it overrides', /Dead-end handling, Backtracking/.test(tail));
  check('it forbids selecting an option that breaks one of the two', /never select an option that breaks one of the two/.test(tail));
  check('it judges a format at the theater stage from amenities', /amenities list it/.test(tail));
  check('it asks for both requirements to be named in one either-or question', /either-or question/.test(tail));
  check('it carries the booking on after one is given up', /that one is relaxed and the other still holds/.test(tail));
  check('it explains uncheckedHardPreferenceIds', /uncheckedHardPreferenceIds/.test(tail));
  check('it never proposes a change that breaks a stated requirement', /Never propose a change that breaks a requirement the visitor stated/.test(tail));
  check('it asks for its own reason tag', /\[conflict\]/.test(tail));
  check('its examples are English, left to the language section to translate', !/[가-힣]/.test(tail));
  const noCp = buildSystemPrompt(workflow(true, false), STAGE_META, 'en', false, false, false, true, true, false);
  const noCpAsked = buildSystemPrompt(workflow(true, false), STAGE_META, 'en', false, false, false, true, true, true);
  check('without CP memory (no conflictMemory, no counts) nothing is added', noCp === noCpAsked);
  const withFirst = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, false, true, true, true);
  const withoutAfter = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, false, true, true, false);
  const withAgain = buildSystemPrompt(workflow(true, true), STAGE_META, 'en', false, false, false, true, true, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(CONFLICT_MARKER));
  check('and on after off is on again', withAgain.includes(CONFLICT_MARKER) && withFirst === withAgain);
}

/*
  The booth sections' exact text, pinned by content like the study prompt
  above. A booth deploy is measured against these words (docs/scenarios/
  ksea2026-korean-simulation.md, "Round 2"), so an edit should fail here and be
  re-measured, not slip through because every regex still matches.
*/
const PINNED_BOOTH_SECTIONS: Record<string, string> = {
  [DECISIVE_MARKER]: 'cface6aed128cd7e',
  [OPENING_MARKER]: 'c8c8a3a878a2ab86',
  [SEAT_MARKER]: 'caf0d17d0a680b41',
  // Round 3 (2026-10-24): measured with noiseRepeat.regress.ts.
  [HIDDEN_ONCE_MARKER]: '14586fdcee64e58c',
};

/** One section of a built prompt: from its marker up to the next blank-free section header. */
function sectionText(prompt: string, marker: string): string {
  const start = prompt.indexOf(marker);
  if (start < 0) return '';
  const rest = prompt.slice(start);
  const end = rest.slice(marker.length).search(/\n[A-Z][^\n]*:\n/);
  return end < 0 ? rest : rest.slice(0, marker.length + end);
}

function fullBoothPrompt(language: string): string {
  return buildSystemPrompt(workflow(true, true), STAGE_META, language, false, true, false, true, true, true, true, true, true);
}

console.log('\n13. a booth demo session gets the opening-question section, after decisive selection');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, false, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, true, false);
  check('the section is appended', on.includes(OPENING_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check(
    'it sits after the brevity and decisive-selection sections, and before the conflict and language sections',
    on.indexOf(OPENING_MARKER) > on.indexOf(BREVITY_MARKER) &&
      on.indexOf(OPENING_MARKER) > on.indexOf(DECISIVE_MARKER) &&
      on.indexOf(OPENING_MARKER) < on.indexOf(CONFLICT_MARKER) &&
      on.indexOf(OPENING_MARKER) < on.indexOf('Language:')
  );
  const text = sectionText(on, OPENING_MARKER);
  check('it applies only where nothing bears on the stage yet', /It applies only when nothing bears on this stage yet/.test(text) && /this section does not apply/.test(text));
  check('it replaces "which one?" with one preference question', /do not ask which option they want/.test(text) && /Ask ONE short question/.test(text));
  for (const stage of ['movie', 'theater', 'date', 'time', 'seat']) {
    check(`it names the dimensions for the ${stage} stage`, new RegExp(`\\n  ${stage}: `).test(text));
  }
  check('it never lists every field or reads the options out', /Never list every field/.test(text) && /never read the options out/.test(text));
  check('it allows one lead-in naming what is on screen', /One short lead-in/.test(text));
  check('it is asked once per stage', /Ask it once per stage/.test(text) && /Never ask this question again on the same stage/.test(text));
  check('it asks for its own reason tag', /\[open-stage\]/.test(text));
  const withFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, true);
  const withoutAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false);
  const withAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(OPENING_MARKER));
  check('and on after off is on again', withAgain.includes(OPENING_MARKER) && withFirst === withAgain);
}

console.log('\n14. a booth demo session gets the seat-choice section, after the opening section');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, true, true);
  check('the section is appended', on.includes(SEAT_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check(
    'it sits after the opening section and before the conflict and language sections',
    on.indexOf(SEAT_MARKER) > on.indexOf(OPENING_MARKER) &&
      on.indexOf(SEAT_MARKER) < on.indexOf(CONFLICT_MARKER) &&
      on.indexOf(SEAT_MARKER) < on.indexOf('Language:')
  );
  const text = sectionText(on, SEAT_MARKER);
  check('party size comes from what the visitor said', /never what the layout suggests/.test(text));
  check('it marks up to three whole choices of the party size and asks', /Mark up to three whole choices of exactly the party size/.test(text));
  check('it keeps the ceiling: three pairs is three choices', /three pairs is six ids and three choices/.test(text));
  check('a choice of the wrong size is never marked', /never four seats in a row/.test(text));
  check('a delegation selects one whole choice and calls it a recommendation', /pick ONE whole choice/.test(text) && /say it is your recommendation/.test(text) && /do not ask anything/.test(text));
  check('it names the Korean delegations the cards use', /추천해 주시는 자리로/.test(text) && /골라 주세요/.test(text));
  check('it asks for its own reason tags', /\[seat-choices\]/.test(text) && /\[seat-recommend\]/.test(text));
  const noGui = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, false, true, true, true, true, false);
  const noGuiAsked = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, false, true, true, true, true, true);
  check('without GUI adaptation there are no marks to govern, so nothing is added', noGui === noGuiAsked);
  const withFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, true);
  const withoutAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, false);
  const withAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(SEAT_MARKER));
  check('and on after off is on again', withAgain.includes(SEAT_MARKER) && withFirst === withAgain);
}

console.log('\n14b. a booth demo session gets the hidden-count-once section, after the seat section');
{
  const off = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, true, true, false);
  const on = buildSystemPrompt(workflow(true, true), STAGE_META, 'ko', false, true, false, true, true, true, true, true, true);
  check('the section is appended', on.includes(HIDDEN_ONCE_MARKER));
  check('it only adds — every line of the off prompt is still there', off.split('\n').every((line) => on.includes(line)));
  check(
    'it sits after the decisive and seat sections and before the conflict and language sections',
    on.indexOf(HIDDEN_ONCE_MARKER) > on.indexOf(DECISIVE_MARKER) &&
      on.indexOf(HIDDEN_ONCE_MARKER) > on.indexOf(SEAT_MARKER) &&
      on.indexOf(HIDDEN_ONCE_MARKER) < on.indexOf(CONFLICT_MARKER) &&
      on.indexOf(HIDDEN_ONCE_MARKER) < on.indexOf('Language:')
  );
  check('the Filtered stages rule it narrows is still there, byte for byte', on.includes('Whenever hiddenByFilterCount is present, say it'));
  const text = sectionText(on, HIDDEN_ONCE_MARKER);
  check('it is said once per filter, in the turn that changes it', /once per filter/.test(text) && /applies, changes or removes a filter/.test(text));
  check('or when the visitor asks', /when the visitor asks what is hidden/.test(text));
  check('never again at the stage unless the count changed', /unless the count has changed/.test(text));
  check('it overrides the Filtered stages rule and rule (4)', /this section wins/.test(text) && /rule \(4\)/.test(text));
  check('its examples are English, left to the language section to translate', !/[가-힣]/.test(text));
  const noGui = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, false, true, true, true, true, false, false);
  const noGuiAsked = buildSystemPrompt(workflow(false, true), STAGE_META, 'en', false, false, false, true, true, true, true, false, true);
  check('without GUI adaptation there is no Filtered stages rule, so nothing is added', noGui === noGuiAsked);
  const withFirst = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, false, true);
  const withoutAfter = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, false, false);
  const withAgain = buildSystemPrompt(workflow(true), STAGE_META, 'en', false, false, false, true, true, false, false, false, true);
  check('the memo keys on the flag: off after on is off', !withoutAfter.includes(HIDDEN_ONCE_MARKER));
  check('and on after off is on again', withAgain.includes(HIDDEN_ONCE_MARKER) && withFirst === withAgain);
}

console.log('\n15. the booth sections, pinned by content');
for (const [marker, pinned] of Object.entries(PINNED_BOOTH_SECTIONS)) {
  const text = sectionText(fullBoothPrompt('en'), marker);
  check(`"${marker}" is the measured text`, digest(text) === pinned, `now ${digest(text)}`);
  check(`"${marker}" reads the same in a Korean session`, sectionText(fullBoothPrompt('ko'), marker) === text);
}

console.log('\n12. the extractor: a study session is unchanged, the booth rewrites only the format notes');
{
  /*
    The frontend sends STAGE_META to study sessions too, so the booth rewrite
    lives on the agent. Two things to hold: without the flag the extractor
    prompt is exactly the old construction, and the study sentences the booth
    replaces are still what generators.ts sends (if someone rewords them there,
    the booth would append its note next to the old one instead).
  */
  const generators = fs.readFileSync(
    path.resolve(__dirname, '../../../frontend/src/spec/generators.ts'),
    'utf8'
  );
  check('generators.ts still sends the theater format note the booth replaces', generators.includes(STUDY_THEATER_FORMAT_NOTE));
  check('generators.ts still sends the time format note the booth replaces', generators.includes(STUDY_TIME_FORMAT_NOTE));
  const meta = [
    { stage: 'movie', goal: 'g', fieldGuide: 'Film selection.' },
    { stage: 'theater', goal: 'g', fieldGuide: `Cinema location selection. ${STUDY_THEATER_FORMAT_NOTE}` },
    { stage: 'time', goal: 'g', fieldGuide: `Showtime selection. ${STUDY_TIME_FORMAT_NOTE}` },
  ];
  const core = getExtractorSystemPrompt().replace(/^Preference Extraction Prompt:\n/, '');
  const oldConstruction =
    core + '\n\nstageFieldGuides:\n' + meta.map((s) => `- ${s.stage}: ${s.fieldGuide}`).join('\n');
  for (const language of ['en', 'ko', undefined]) {
    check(
      `study extractor prompt (${language ?? 'no language'}) is the old construction`,
      buildPreferenceSystemPrompt(meta, language) === oldConstruction &&
        buildPreferenceSystemPrompt(meta, language, false) === oldConstruction
    );
  }
  check('no stage meta, no flag: the bare prompt', buildPreferenceSystemPrompt(undefined, 'en') === core);
  const booth = buildPreferenceSystemPrompt(meta, 'ko', true);
  check('the booth drops the study theater note', !booth.includes(STUDY_THEATER_FORMAT_NOTE));
  check('the booth drops the study time note', !booth.includes(STUDY_TIME_FORMAT_NOTE));
  check('the booth assigns a format requirement to theater and time', /assign it to both theater and time/.test(booth));
  check('the booth reads a positional answer to a two-way-out question', /a positional answer counts in the order/.test(booth) && /the one that way out goes WITHOUT/.test(booth));
  check('the booth leaves the movie guide alone', booth.includes('- movie: Film selection.'));
  check(
    'the booth only rewrites: the study prompt minus its two notes is still all there',
    oldConstruction
      .replace(` ${STUDY_THEATER_FORMAT_NOTE}`, '')
      .replace(` ${STUDY_TIME_FORMAT_NOTE}`, '')
      .split('\n')
      .every((line) => booth.includes(line.replace(/^- (theater|time): /, '')))
  );
}

console.log('\nL. the post-study languages add a section and leave en/ko alone');
{
  const NEW_LANGUAGES = ['ja', 'zh-Hans', 'zh-Hant', 'de', 'fr', 'es'];
  for (const language of NEW_LANGUAGES) {
    const section = buildLanguageSection(language);
    check(`${language}: a language section exists`, section !== null);
    check(`${language}: it starts with "Language:"`, Boolean(section?.startsWith('Language:')));
    const prompt = buildSystemPrompt(workflow(true, true), STAGE_META, language);
    check(`${language}: the system prompt carries it`, Boolean(section && prompt.includes(section)));
    check(
      `${language}: and is the English study prompt plus that section`,
      Boolean(section) &&
        prompt.replace(`\n${section}`, '') === buildSystemPrompt(workflow(true, true), STAGE_META, 'en')
    );
  }
  // Building the new languages must not disturb the pinned ones: rebuild en and
  // ko after them (the prompt is memoized in one slot) and compare to the pins.
  for (const config of STUDY_CONFIGS) {
    const key = `gui:${config.gui ? 1 : 0} cp:${config.cp ? 1 : 0} ${config.language}`;
    check(`${key} is still byte-identical after the new languages`, digest(studyPrompt(config)) === PINNED_STUDY_PROMPTS[key]);
  }
}

console.log(
  failures === 0 ? '\nall planner prompt checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
