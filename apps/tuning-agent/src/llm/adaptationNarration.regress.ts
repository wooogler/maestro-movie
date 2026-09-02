/**
 * Does the quick-card narration directive actually change what the agent says?
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/adaptationNarration.regress.ts
 *
 * Real API calls against real study turns, so — like the other `*.regress.ts`
 * harnesses — this stays out of `npm run check`. `plannerPrompt.check.ts` is the
 * cheap half: it proves the section is appended for a quick card and that the
 * study prompt is byte-identical without it. This is the half that cannot be
 * asserted offline, because the question is what a model DOES with a prompt.
 *
 * The claim under test is narrow. A booth visitor with ninety seconds is
 * shown one GUI adaptation, and the spoken channel is how they know it
 * happened; the study prompt tells the planner to write a brief cue and not
 * restate what is on screen, which leaves that visitor watching a list twitch
 * with no account of why. Turning the frontend's verbosity gate up cannot fix
 * that — it says the same stripped sentence louder — so the sentence has to be
 * written differently.
 *
 * Each case replays one real turn twice, changing nothing but the flag, and
 * reports both messages. The control matters as much as the effect: the same
 * TOOL should still be chosen, because this touches the spoken channel and
 * nothing else.
 *
 * Pass `--runs N` to replay each case N times (LLM output varies).
 * Pass `--only <substring>` to narrow to one case.
 */
import { planActionWithOpenAI } from './llmPlanner';
import { loadTurn, readOnly, readRuns, requireApiKey, toolsFor } from './plannerReplay.regress';

const RUNS = readRuns();
const ONLY = readOnly();

interface Case {
  name: string;
  trace: string;
  requestId: string;
  /** What the study run actually did, and said, on this turn. */
  loggedTool: string;
}

/*
  Four adaptations across four stages and all four operations, so a change that
  only helps one of them shows up as a change that only helps one of them.
*/
const CASES: Case[] = [
  {
    name: 'augment/theater — surfacing distance and parking',
    trace: 'P01-C2-S2-easy-20260324-123636.llm-trace.jsonl',
    requestId: 'planner-3',
    loggedTool: 'augment',
  },
  {
    name: 'filter/movie — hiding everything over PG-13',
    trace: 'P01-C2-S2-hard-20260324-124119.llm-trace.jsonl',
    requestId: 'planner-3',
    loggedTool: 'filter',
  },
  {
    name: 'sort/theater — reordering by distance',
    trace: 'P01-C2-S2-hard-20260324-124119.llm-trace.jsonl',
    requestId: 'planner-8',
    loggedTool: 'sort',
  },
  {
    name: 'highlight/movie — marking the kid-friendly options',
    trace: 'P02-C2-S1-easy-20260325-101216.llm-trace.jsonl',
    requestId: 'planner-3',
    loggedTool: 'highlight',
  },
];


/** Words that describe a change rather than name a thing on screen. */
const CHANGE_VERBS =
  /\b(hid|hidden|hiding|filtered|removed|narrowed|sorted|ordered|reordered|ranked|highlighted|marked|added|surfaced|showing now|no longer)\b/i;
/** A quantity: "four of the six", "three options", "everything over 15 miles". */
const SCALE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|all|every|everything|both|half)\b/i;

// Wrapped rather than run at the top level: tsx emits CJS for this project,
// which has no top-level await.
async function main(): Promise<void> {
  requireApiKey('adaptationNarration.regress.ts');

  let cases = 0;
  let describedChange = 0;
  let quotedScale = 0;
  let toolChanged = 0;

  for (const testCase of CASES) {
    if (ONLY && !testCase.name.toLowerCase().includes(ONLY)) continue;
    const turn = await loadTurn(testCase.trace, testCase.requestId);
    if (!turn) {
      console.error(`  SKIP ${testCase.name} — could not load ${testCase.trace}#${testCase.requestId}`);
      continue;
    }

    console.log(`\n${testCase.name}`);
    console.log(`  study run said: "${turn.loggedMessage ?? '(nothing)'}"  [${turn.loggedTool}]`);

    const base = {
      history: turn.history,
      availableTools: toolsFor(turn.availableToolNames),
      workflow: turn.workflow,
      stageMeta: turn.stageMeta,
      ...(turn.memory ? { memory: turn.memory } : {}),
    };

    for (let run = 0; run < RUNS; run += 1) {
      const quiet = await planActionWithOpenAI(base);
      const loud = await planActionWithOpenAI({ ...base, narrateAdaptations: true });
      if (!quiet || !loud) {
        console.error('  FAIL planner returned nothing');
        continue;
      }
      cases += 1;
      const quietMessage = quiet.assistantMessage ?? '';
      const loudMessage = loud.assistantMessage ?? '';

      console.log(`  today   : "${quietMessage}"  [${quiet.action.toolName || 'none'}]`);
      console.log(`  card    : "${loudMessage}"  [${loud.action.toolName || 'none'}]`);

      if (CHANGE_VERBS.test(loudMessage)) describedChange += 1;
      if (SCALE.test(loudMessage)) quotedScale += 1;
      if (quiet.action.toolName !== loud.action.toolName) {
        toolChanged += 1;
        console.log(`  NOTE    : the tool changed (${quiet.action.toolName} → ${loud.action.toolName})`);
      }
    }
  }

  console.log(`\n${cases} replay pair(s)`);
  console.log(`  card message names the change   : ${describedChange}/${cases}`);
  console.log(`  card message quotes a scale     : ${quotedScale}/${cases}`);
  console.log(`  tool choice changed (want 0)    : ${toolChanged}/${cases}`);

}

void main();
