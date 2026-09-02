/**
 * Characterisation harness for filters that survive a backtrack.
 *
 *   OPENAI_API_KEY=... npm run regress:stalefilter -- --runs 5
 *   REPLAY_NO_HIDDEN_FIELD=1 ...   replays the payload as the study logged it
 *
 * Real API calls, so it stays out of `npm run check`.
 *
 * WHAT PROMPTED IT. A filter applied at a stage is restored whole when the
 * stage is re-entered (restoreStageSnapshot in ChatPage.tsx), so after a
 * downstream dead end the agent returns to a screen showing fewer options than
 * the stage has. In the March 2026 traces 82 turns re-entered a filtered stage
 * that way and 26 of them called the short list the only options left.
 *
 * WHAT IT ACTUALLY MEASURES, which is not what it was built for. Replaying
 * those turns through today's prompt showed the study-era behaviour is gone:
 * the agent now clears an inherited filter on arrival. It does that whether or
 * not the filter is one a hard preference requires — which is right for the
 * first two cases here and wrong for three of the five after them, and it is
 * pre-existing. Measured five ways (with and without the prompt rules that were
 * drafted for this, with and without currentView.hiddenByFilterCount) the rates
 * did not move: 5/5 on the first two, 0/5 on the single-screen and 4 PM
 * controls. Those rules were reverted because the numbers did not support them.
 *
 * So this file is a characterisation of where the agent stands, and the thing
 * worth fixing next is the opposite of the one it was written for: it lifts
 * hard requirements the user has not withdrawn. Anyone taking that on should
 * measure at --runs 5 or more; single runs on these cases are coin flips.
 *
 * Pass `--verbose` to print each action, reason and message, `--runs N` to
 * replay each case N times, `--only <substring>` to narrow the run.
 */
import { planActionWithOpenAI } from './llmPlanner';
import {
  loadTurn,
  readOnly,
  readRuns,
  requireApiKey,
  toolsFor,
  type ReplayTurn,
} from './plannerReplay.regress';

const VERBOSE = process.argv.includes('--verbose');
const RUNS = readRuns();
const ONLY = readOnly();

/**
 * Pushing the user out of this stage: either the prev tool, or prose that
 * proposes an earlier stage as the next move.
 */
const ESCALATES = /\bgo back\b|\bgoing back\b|\bnearest place\b|\bnext place\b|\bearlier step\b|\b(movie|theater|date|time) step\b|\bdifferent (film|movie|theater|date)\b/i;

/**
 * Telling the user that this stage still has something behind the filter —
 * a count, the requirement doing the hiding, or an offer to lift it.
 *
 * Deliberately generous: the claim under test is that the hidden options get
 * mentioned at all, not that they are mentioned in any particular phrasing.
 * `\bother\b` does not fire inside "another", which is what the old, wrong
 * messages said ("there isn't another showtime here").
 */
const ACKNOWLEDGES = /\bhidden\b|\bfilter(ed|ing)?\b|\bshow all\b|\bother (option|showtime|show|time|theater|movie|date)|\bmore (option|showtime|show|time|theater|movie|date)|\brelax\b|\bloosen\b|\bdrop the\b|\bwiden\b|\bbring (them|those) back\b|\bset (that|it) aside\b|\bif you (can|could|are willing)\b|\bwithout that\b|\bignore that\b|\bbeyond\b|\boutside\b|\b\d+ (more|other)\b/i;

interface Expectation {
  /**
   * No hard preference backs this filter, so the hidden options are live. The
   * agent must either clear it or say that this stage still holds them —
   * anything else presents a filtered screen as the whole stage.
   */
  mustSurfaceHidden?: boolean;
  /** The filter is current. Clearing it would undo what the user just asked for. */
  mustKeepFilter?: boolean;
  /** Nothing is hidden here — a backtrack suggestion is honest and must survive. */
  escalationIsCorrect?: boolean;
}

interface Case {
  name: string;
  why: string;
  trace: string;
  requestId: string;
  expect: Expectation;
}

const CASES: Case[] = [
  {
    // Two cases where no hard preference for this stage backs the filter, so
    // the hidden options are ones the user never ruled out. These are the only
    // shape where the screen genuinely lies about what the stage still has.
    name: 'back at the movie step with two of three movies hidden',
    why:
      'The user returned to the movie stage to reconsider, and a genre + age-rating filter from ' +
      'earlier is still hiding two of the three movies. No hard movie preference backs it. The ' +
      'study run asked "keep this movie or change it?" while two thirds of the choice was off screen.',
    trace: 'P20-C2-S4-hard-20260327-155704.llm-trace.jsonl',
    requestId: 'planner-21',
    expect: { mustSurfaceHidden: true },
  },
  {
    name: 'back at theaters with the second theater filtered away',
    why:
      'One of two theaters visible, no hard theater preference in memory. The alternative the ' +
      'backtrack was for is the one the filter is holding.',
    trace: 'P04-C2-S4-hard-20260325-171024.llm-trace.jsonl',
    requestId: 'planner-27',
    expect: { mustSurfaceHidden: true },
  },
  {
    // The over-correction guard, and the common shape by a wide margin. In each
    // of these the filter is exactly the user's hard requirement, so what it
    // hides is what they already ruled out. Clearing would put IMAX showings in
    // front of someone who said standard only.
    name: 'CONTROL — a hard single-screen requirement keeps its filter',
    why:
      'One of three theaters visible under screenCount == 1, and "Needs a single-screen theater" ' +
      'is hard. Suggesting the movie step is honest here; clearing the filter is not. NOTE: this ' +
      'case fails 5 of 5 on gpt-5.4 and is the one residual of the stale-filter work. The shape is ' +
      'specific — a hard requirement whose only surviving option has dead-ended — and the agent ' +
      'un-hides the alternatives while correctly naming the requirement ("the single-screen ' +
      'requirement is currently hiding two other theaters"). Whether that is a violation or the ' +
      'honest way to show the tradeoff is a product call; four phrasings of the rule were measured ' +
      'and none moved it.',
    trace: 'P03-C2-S3-hard-20260325-130851.llm-trace.jsonl',
    requestId: 'planner-50',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — hard start and end times keep their filter',
    why: 'One of three showtimes, under two hard time bounds. The other two start too early.',
    trace: 'P07-C4-S3-hard-20260326-110452.llm-trace.jsonl',
    requestId: 'planner-19',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — a hard 4 PM floor keeps its filter',
    why: 'Two of three showtimes, under "starts at or after 4:00 PM" and "ends before 9:00 PM".',
    trace: 'P08-C4-S2-hard-20260326-111413.llm-trace.jsonl',
    requestId: 'planner-20',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — three stacked hard requirements keep their filter',
    why:
      'Standard format, after 4 PM, before 10 PM — all hard, and the two hidden showtimes are ' +
      'IMAX and 3D. The study run named the requirements and offered the movie step, which is right.',
    trace: 'P02-C4-S4-hard-20260325-105040.llm-trace.jsonl',
    requestId: 'planner-34',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — a hard standard-format requirement keeps its filter',
    why: 'One of three showtimes; the hidden two are IMAX and 3D against a hard standard-only need.',
    trace: 'P07-C2-S4-hard-20260326-112703.llm-trace.jsonl',
    requestId: 'planner-21',
    expect: { mustKeepFilter: true },
  },
  {
    // A filter one turn old is the user's live request, not an inheritance.
    name: 'CONTROL — a filter applied one turn ago is current, not inherited',
    why:
      'The agent filtered to evening showtimes on the previous turn and said "I have narrowed it ' +
      'to your evening options." Clearing here would undo what the user just asked for.',
    trace: 'P01-C4-S3-easy-20260324-124842.llm-trace.jsonl',
    requestId: 'planner-23',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — a fresh filter at the theater stage stays',
    why: 'Recliner seating was just applied; "The recliner option left is The Nook."',
    trace: 'P07-C4-S3-easy-20260326-110050.llm-trace.jsonl',
    requestId: 'planner-8',
    expect: { mustKeepFilter: true },
  },
  {
    name: 'CONTROL — a genuine dead end must still send the user back',
    why:
      'The seat stage with no filter at all and no four seats together. Suggesting the showtime ' +
      'stage is correct and the new rules must not suppress it.',
    trace: 'P01-C3-S4-easy-20260324-130953.llm-trace.jsonl',
    requestId: 'planner-20',
    expect: { escalationIsCorrect: true },
  },
];

async function runOnce(testCase: Case, turn: ReplayTurn): Promise<boolean> {
  const output = await planActionWithOpenAI({
    history: turn.history as never,
    ...(turn.memory ? { memory: turn.memory } : {}),
    availableTools: toolsFor(turn.availableToolNames),
    workflow: turn.workflow,
    stageMeta: turn.stageMeta,
  });
  if (!output) {
    console.error('  FAIL  planner returned nothing');
    return false;
  }

  const action = output.action;
  const toolName = action.type === 'tool.call' ? action.toolName : 'respond';
  const message = output.assistantMessage ?? '';
  const clearedFilter =
    toolName === 'clearModification' &&
    ['filter', 'all', undefined].includes(
      (action.params as { type?: string } | undefined)?.type
    );

  if (VERBOSE) {
    console.log(`    action: ${toolName}${clearedFilter ? ' (filter)' : ''}`);
    if (action.type === 'tool.call') console.log(`    why:    ${action.reason}`);
    console.log(`    says:   ${message}`);
  }

  let ok = true;

  if (testCase.expect.mustSurfaceHidden) {
    if (clearedFilter) {
      console.log('  ok    cleared the inherited filter, restoring the hidden options');
    } else if (ACKNOWLEDGES.test(message)) {
      console.log(`  ok    said this stage still holds ${turn.hiddenByFilterCount} more (${toolName})`);
    } else {
      console.error(
        `  FAIL  presented ${turn.visibleIds.length} of ${turn.itemCount} as the whole stage; ` +
          `${turn.hiddenByFilterCount} hidden option(s) no hard preference rules out`
      );
      ok = false;
    }
  }

  if (testCase.expect.mustKeepFilter) {
    if (clearedFilter) {
      console.error('  FAIL  cleared a filter that is still required here');
      ok = false;
    } else {
      console.log(`  ok    kept the current filter (${toolName})`);
    }
  }

  if (testCase.expect.escalationIsCorrect) {
    const escalating = toolName === 'prev' || ESCALATES.test(message);
    if (!escalating) {
      console.error(`  FAIL  a real dead end no longer sends the user back (${toolName})`);
      ok = false;
    } else {
      console.log(`  ok    still sends the user back (${toolName})`);
    }
  }

  return ok;
}

async function main(): Promise<void> {
  requireApiKey('staleFilterPrompt.regress.ts');
  let failures = 0;
  let skipped = 0;

  for (const testCase of CASES) {
    if (ONLY && !testCase.name.toLowerCase().includes(ONLY)) continue;
    console.log(`\n${testCase.name}`);
    console.log(`  ${testCase.why}`);

    const turn = await loadTurn(testCase.trace, testCase.requestId);
    if (!turn) {
      console.log(`  SKIP  could not load ${testCase.trace} ${testCase.requestId}`);
      skipped += 1;
      continue;
    }
    console.log(
      `  stage ${turn.stage}, ${turn.visibleIds.length} of ${turn.itemCount} on screen, ` +
        `${turn.hiddenByFilterCount} hidden by filter; study run called ${turn.loggedTool}`
    );

    let passes = 0;
    for (let run = 1; run <= RUNS; run += 1) {
      if (RUNS > 1) console.log(`  -- run ${run}/${RUNS}`);
      if (await runOnce(testCase, turn)) passes += 1;
    }
    if (RUNS > 1) {
      const rate = `${passes}/${RUNS}`;
      if (passes * 2 >= RUNS) console.log(`  RATE  ${rate} — treated as passing`);
      else {
        console.error(`  RATE  ${rate} — treated as FAILING`);
        failures += 1;
      }
    } else if (passes === 0) {
      failures += 1;
    }
  }

  console.log(
    failures === 0
      ? `\nAll stale-filter regressions passed${skipped ? ` (${skipped} skipped)` : ''}.`
      : `\n${failures} stale-filter regression(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
