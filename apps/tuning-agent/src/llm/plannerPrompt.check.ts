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

import { buildSystemPrompt } from './llmPlanner';
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

console.log(
  failures === 0 ? '\nall planner prompt checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
