/**
 * Regression harness for the planner's highlight-economy rules.
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/highlightPrompt.regress.ts
 *
 * Like extractorPrompt.regress.ts, this one is not pure: it replays real turns
 * from the March 2026 study through the CURRENT planner prompt and makes real
 * API calls, so it stays out of `npm run check`.
 *
 * The defect it guards: highlight was being spent on sets so large they
 * distinguished nothing. Across the study's 613 highlight calls, 41 marked
 * every visible item on a screen showing two or more, and 31 marked four or
 * more items. Highlight renders as a 4px ring plus a wave animation, so a
 * whole-screen highlight is noise with the cost of a signal.
 *
 * Each case replays the exact planner input the model faced -- history,
 * memory, workflow, currentView -- with only the prompt and the tool
 * descriptions changed. Control cases are as load-bearing as the failures:
 * a fix that stops highlighting altogether is not a fix.
 *
 * Pass `--verbose` to print the returned action for every case.
 * Pass `--runs N` to replay each case N times and report a rate.
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
 * Groups seat ids into the contiguous runs a user would read as one choice.
 * Seat ids end in a row letter and a number — "…_1310-D1", "…_standard-C4" —
 * so the label is whatever follows the final hyphen.
 */
function seatRuns(ids: string[]): string[][] {
  const byRow = new Map<string, number[]>();
  for (const id of ids) {
    const label = id.split('-').pop() ?? '';
    const match = /^([A-Za-z]+)(\d+)$/.exec(label);
    if (!match) continue;
    const row = byRow.get(match[1]) ?? [];
    row.push(Number(match[2]));
    byRow.set(match[1], row);
  }
  const runs: string[][] = [];
  for (const [row, numbers] of byRow) {
    numbers.sort((a, b) => a - b);
    let run: string[] = [];
    for (const number of numbers) {
      const previous = run[run.length - 1];
      if (previous && number !== Number(previous.slice(row.length)) + 1) {
        runs.push(run);
        run = [];
      }
      run.push(`${row}${number}`);
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

interface Expectation {
  /**
   * If a highlight is emitted, its item set must be a strict subset of the
   * visible items. Marking the whole screen is the defect itself.
   */
  notWholeScreen?: boolean;
  /** If a highlight is emitted, it may mark at most this many items. */
  maxItems?: number;
  /** No highlight at all is acceptable for this turn -- and often correct. */
  mayDeclineToHighlight?: boolean;
  /**
   * Seat stages only. A choice there is a contiguous run of seats in one row,
   * so these two assert the ceiling in the unit the prompt uses.
   *
   * `wholeRunsOf` — every marked run must be exactly this long. Marking two
   * seats of a four-seat block is not a smaller highlight, it is a wrong one.
   * `maxRuns` — at most this many runs, i.e. at most this many choices.
   */
  wholeRunsOf?: number;
  maxRuns?: number;
  /**
   * A control case: the turn had a real, narrow reason to highlight, so the
   * fix must leave it emitting one within this range.
   */
  mustHighlight?: { min: number; max: number };
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
    name: 'no criterion at all — five dates, five rings',
    why:
      'The stage offered highlight and clearModification and nothing else, and the model ' +
      'spent the highlight on the entire date row to say "Showing the available dates for ' +
      'your next choice" — a mark applied to everything, for no stated criterion. The ' +
      'Guardrails line used to name sort, filter and augment but not highlight.',
    trace: 'P02-C4-S4-hard-20260325-105040.llm-trace.jsonl',
    requestId: 'planner-32',
    expect: { notWholeScreen: true, mayDeclineToHighlight: true },
  },
  {
    name: 'whole screen with filter available — three showtimes, three rings',
    why:
      'Every visible showtime satisfied the constraint, so marking all three distinguished ' +
      'nothing. filter and sort were both on the table this turn.',
    trace: 'P12-C4-S3-easy-20260326-153947.llm-trace.jsonl',
    requestId: 'planner-22',
    expect: { notWholeScreen: true, mayDeclineToHighlight: true },
  },
  {
    name: 'whole screen with no escape — eight seat groups, eight rings',
    why:
      'The seat stage never offers filter, sort or augment, so the old "if filter is not ' +
      'available, highlight ALL matching items" fired unconditionally. respond was the only ' +
      'other move and the turn-sequencing rule pushed the model away from it.',
    trace: 'P16-C4-S4-easy-20260327-110613.llm-trace.jsonl',
    requestId: 'planner-36',
    // Two four-seat blocks, D standard and E premium, and together they are the
    // entire visible set. Declining and asking is the cleanest outcome, but a
    // mark is defensible here — the grid around these eight is all occupied
    // seats, so a ring still carries contrast. What is never right is marking
    // two loose seats when a choice is a block of four.
    expect: { wholeRunsOf: 4, maxRuns: 2, mayDeclineToHighlight: true },
  },
  {
    name: 'the worst case in the study — 32 of 48 seats',
    why:
      '"I am highlighting the available standard seats." Two thirds of the house wearing a ' +
      'ring, which is a repaint, not a recommendation.',
    trace: 'P24-C4-S2-easy-20260328-101834.llm-trace.jsonl',
    requestId: 'planner-26',
    expect: { notWholeScreen: true, maxItems: 6, mayDeclineToHighlight: true },
  },
  {
    name: 'choices, not items — four qualifying seat pairs',
    why:
      'Eight seat ids, but the user needed two together: that is four choices, and the four ' +
      'rings merge into shapes you cannot parse as pairs. The ceiling counts choices, so ' +
      'three pairs (six ids) is the most that can be marked. NOTE: this case is the one that ' +
      'stays flaky — measured 3 of 5 on gpt-5.4 against 0 of 5 before the fix. When it misses, ' +
      "the model's own reason says the ceiling is exceeded and no highlight should be used, " +
      'and it calls highlight regardless. Run it with --runs 5 before concluding anything from ' +
      'a single result.',
    trace: 'P07-C4-S3-hard-20260326-110452.llm-trace.jsonl',
    requestId: 'planner-52',
    expect: { wholeRunsOf: 2, maxRuns: 3, mayDeclineToHighlight: true },
  },
  {
    name: 'whole screen at the theater stage — three theaters, three rings',
    why:
      '"I am highlighting the theater options, with the single-screen one standing out." ' +
      'If one option stands out, it is the one to mark.',
    trace: 'P51-C4-S3-hard-20260331-203543.llm-trace.jsonl',
    requestId: 'planner-8',
    expect: { notWholeScreen: true, mayDeclineToHighlight: true },
  },
  {
    // Controls. A rule that stops the model highlighting is not a fix, it is a
    // different bug, and this is the case most at risk: one item, one visible,
    // so it is technically a whole-visible-set highlight too.
    name: 'CONTROL — the single viable option must still be pointed at',
    why:
      'Filtering left one showtime, and the pre-select rule marks it before asking. A ' +
      'one-item highlight is a pointer, not a filter gesture, and is exempt from the ceiling ' +
      'even when it is the only thing on screen.',
    trace: 'P01-C4-S3-easy-20260324-124842.llm-trace.jsonl',
    requestId: 'planner-36',
    expect: { mustHighlight: { min: 1, max: 1 } },
  },
  {
    name: 'CONTROL — one best match among four movies',
    why: 'A soft categorical preference with a clear winner. This is what highlight is for.',
    trace: 'P01-C4-S3-easy-20260324-124842.llm-trace.jsonl',
    requestId: 'planner-3',
    expect: { mustHighlight: { min: 1, max: 2 } },
  },
  {
    name: 'CONTROL — two weekend dates out of five',
    why:
      'Two marked, three unmarked: inside the ceiling, and the contrast is the whole point. ' +
      'The date stage has no filter, so suppressing this would leave the preference invisible.',
    trace: 'P01-C4-S3-hard-20260324-125556.llm-trace.jsonl',
    requestId: 'planner-19',
    expect: { mustHighlight: { min: 1, max: 3 } },
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
  const isHighlight = action.type === 'tool.call' && action.toolName === 'highlight';
  const ids = isHighlight
    ? ((action.params as { itemIds?: unknown }).itemIds as string[] | undefined) ?? []
    : [];

  if (VERBOSE) {
    console.log(`    action: ${isHighlight ? `highlight ${ids.length} item(s)` : action.type === 'tool.call' ? action.toolName : 'respond'}`);
    console.log(`    says:   ${output.assistantMessage}`);
    if (action.type === 'tool.call') console.log(`    why:    ${action.reason}`);
  }

  let ok = true;
  const expect = testCase.expect;

  if (expect.mustHighlight) {
    if (!isHighlight) {
      console.error(`  FAIL  expected a highlight, got ${action.type === 'tool.call' ? action.toolName : 'respond'}`);
      ok = false;
    } else if (ids.length < expect.mustHighlight.min || ids.length > expect.mustHighlight.max) {
      console.error(
        `  FAIL  highlighted ${ids.length}, expected ${expect.mustHighlight.min}-${expect.mustHighlight.max}`
      );
      ok = false;
    } else {
      console.log(`  ok    still highlights ${ids.length} of ${turn.visibleIds.length} visible`);
    }
  }

  if (expect.notWholeScreen && isHighlight) {
    const marked = new Set(ids);
    const coversAll = turn.visibleIds.every((id) => marked.has(id));
    if (coversAll) {
      console.error(
        `  FAIL  highlighted the whole visible set (${ids.length}/${turn.visibleIds.length})`
      );
      ok = false;
    } else {
      console.log(`  ok    marked ${ids.length} of ${turn.visibleIds.length} visible`);
    }
  }

  if (typeof expect.maxItems === 'number' && isHighlight) {
    if (ids.length > expect.maxItems) {
      console.error(`  FAIL  highlighted ${ids.length} items, ceiling is ${expect.maxItems}`);
      ok = false;
    } else {
      console.log(`  ok    marked ${ids.length} item(s), ceiling is ${expect.maxItems}`);
    }
  }

  if (isHighlight && ids.length === 0) {
    console.error('  FAIL  emitted a highlight with no items');
    ok = false;
  }

  if (isHighlight && ids.length > 0 && (expect.wholeRunsOf || expect.maxRuns)) {
    const runs = seatRuns(ids);
    const shape = runs.map((run) => run.length).join('+');
    if (expect.maxRuns && runs.length > expect.maxRuns) {
      console.error(
        `  FAIL  marked ${runs.length} choices (${shape}), ceiling is ${expect.maxRuns}`
      );
      ok = false;
    } else if (expect.wholeRunsOf && runs.some((run) => run.length !== expect.wholeRunsOf)) {
      console.error(
        `  FAIL  marked partial blocks (${shape}) where a choice is ${expect.wholeRunsOf} adjacent seats`
      );
      ok = false;
    } else {
      console.log(`  ok    marked ${runs.length} whole choice(s) (${shape})`);
    }
  }

  if (!isHighlight && expect.mayDeclineToHighlight) {
    const what = action.type === 'tool.call' ? action.toolName : 'respond';
    console.log(`  ok    declined to highlight, used ${what} instead`);
  }

  return ok;
}

async function main(): Promise<void> {
  requireApiKey('highlightPrompt.regress.ts');

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
      `  stage ${turn.stage}, ${turn.visibleIds.length} visible, study run highlighted ` +
        `${turn.loggedHighlight ? turn.loggedHighlight.length : 0}`
    );

    let passes = 0;
    for (let run = 1; run <= RUNS; run += 1) {
      if (RUNS > 1) console.log(`  -- run ${run}/${RUNS}`);
      if (await runOnce(testCase, turn)) passes += 1;
    }
    if (RUNS > 1) {
      const rate = `${passes}/${RUNS}`;
      if (passes * 2 >= RUNS) {
        console.log(`  RATE  ${rate} — treated as passing`);
      } else {
        console.error(`  RATE  ${rate} — treated as FAILING`);
        failures += 1;
      }
    } else if (passes === 0) {
      failures += 1;
    }
  }

  console.log(
    failures === 0
      ? `\nAll highlight-prompt regressions passed${skipped ? ` (${skipped} skipped)` : ''}.`
      : `\n${failures} highlight-prompt regression(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
