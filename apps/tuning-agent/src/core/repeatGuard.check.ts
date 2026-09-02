/**
 * Executable check for the per-turn repeat guard. No test runner is configured,
 * so this is a plain script:
 *
 *   npx tsx apps/tuning-agent/src/core/repeatGuard.check.ts
 *
 * Sections 1 and 2 replay the two loops today's demo trace actually produced;
 * the rest are the sequences that must keep working around them.
 */
import {
  buildActionSignature,
  buildViewFingerprint,
  createTurnRepeatGuard,
  MAX_ACTIONS_PER_TURN,
} from './repeatGuard';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** A time-stage screen: four showings, one of them filtered out. */
function timeSpec(options: {
  visible: string[];
  inventory?: number;
  filter?: unknown;
  selected?: string;
} = { visible: ['s1', 's2'] }) {
  return {
    stage: 'time',
    items: Array.from({ length: options.inventory ?? 6 }, (_, i) => ({ id: `s${i + 1}` })),
    visibleItems: options.visible.map((id) => ({ id, value: `${id} showing` })),
    state: options.selected ? { selected: { id: options.selected } } : {},
    ...(options.filter ? { modification: { filter: options.filter } } : {}),
  };
}

const filterEndTime = { field: 'endTime', operator: 'lte', value: '22:00' };

section('1. THE FIVE IDENTICAL FILTERS — planner-33..37');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const view = buildViewFingerprint(timeSpec({ visible: ['s1', 's2'], filter: filterEndTime }));
  const message = 'Applying your 10:00 PM end time.';

  const first = guard.evaluate({
    toolName: 'filter',
    params: filterEndTime,
    viewFingerprint: view,
    assistantMessage: message,
  });
  check('the first filter runs', first.kind === 'execute', first.kind);
  check('and is spoken', first.speak);
  guard.noteExecuted(first.signature, view);
  guard.noteSpoken(message);

  // The filter changed nothing on screen (the comparison bug being fixed
  // elsewhere), so the planner sees the same view and decides the same thing.
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const repeat = guard.evaluate({
      toolName: 'filter',
      params: filterEndTime,
      viewFingerprint: view,
      assistantMessage: message,
    });
    check(`attempt ${attempt} is suppressed`, repeat.kind === 'repeat', repeat.kind);
    check(`attempt ${attempt} is not spoken again`, !repeat.speak);
  }

  check('only one mutation was spent', guard.executedCount() === 1);
  guard.settle();
  check('the turn is settled', guard.isSettled());
  guard.reset('user-message');
  check('the next user message opens it again', !guard.isSettled());
}

section('2. clearModification / augment FLICKER — planner-21..27');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const view = buildViewFingerprint(timeSpec({ visible: ['s1', 's2', 's3'] }));

  // Six mutations: clear filter, clear filter, clear all, clear all, and two
  // augments whose labels differ only in the separator glyph.
  const emitted: Array<{ tool: string; params: unknown }> = [
    { tool: 'clearModification', params: { type: 'filter' } },
    { tool: 'clearModification', params: { type: 'filter' } },
    { tool: 'clearModification', params: { type: 'all' } },
    { tool: 'clearModification', params: { type: 'all' } },
    { tool: 'augment', params: { template: '{time} — {format}' } },
    { tool: 'augment', params: { template: '{time} · {format}' } },
    { tool: 'augment', params: { template: '{time} | {format}' } },
  ];
  let executed = 0;
  let suppressed = 0;
  for (const item of emitted) {
    const verdict = guard.evaluate({
      toolName: item.tool,
      params: item.params,
      viewFingerprint: view,
    });
    if (verdict.kind === 'execute') {
      executed += 1;
      guard.noteExecuted(verdict.signature, view);
    } else {
      suppressed += 1;
    }
  }
  check('the exact repeats are suppressed', suppressed === 2, `suppressed=${suppressed}`);
  check('the punctuation variants still cost a mutation', executed === 5, `executed=${executed}`);
  check(
    'and the budget is what would stop a longer run of them',
    executed <= MAX_ACTIONS_PER_TURN
  );
}

section('3. SAME TOOL, DIFFERENT PARAMS — both must run');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const view = buildViewFingerprint(timeSpec({ visible: ['s1', 's2', 's3'] }));
  const format = { field: 'format', operator: 'eq', value: '3D' };

  const a = guard.evaluate({ toolName: 'filter', params: format, viewFingerprint: view });
  check('filter format eq 3D runs', a.kind === 'execute');
  guard.noteExecuted(a.signature, view);
  const b = guard.evaluate({ toolName: 'filter', params: filterEndTime, viewFingerprint: view });
  check('filter endTime lte 22:00 also runs', b.kind === 'execute', b.kind);
  guard.noteExecuted(b.signature, view);

  // Different tools over the same item are different signatures too.
  const highlight = guard.evaluate({
    toolName: 'highlight',
    params: { itemIds: ['s2'] },
    viewFingerprint: view,
  });
  check('highlight runs', highlight.kind === 'execute');
  guard.noteExecuted(highlight.signature, view);
  const select = guard.evaluate({
    toolName: 'select',
    params: { itemIds: ['s2'] },
    viewFingerprint: view,
  });
  check('select of the same item runs', select.kind === 'execute', select.kind);
}

section('4. SAME SIGNATURE, MOVED SCREEN — a legitimate refinement');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const before = buildViewFingerprint(timeSpec({ visible: ['s1', 's2', 's3'] }));
  const first = guard.evaluate({
    toolName: 'filter',
    params: filterEndTime,
    viewFingerprint: before,
  });
  guard.noteExecuted(first.signature, before);

  const after = buildViewFingerprint(
    timeSpec({ visible: ['s1', 's2'], filter: filterEndTime })
  );
  check('the view fingerprint moved', before !== after);
  const again = guard.evaluate({
    toolName: 'filter',
    params: filterEndTime,
    viewFingerprint: after,
  });
  check('so the same filter is allowed again', again.kind === 'execute', again.kind);
}

section('5. FIVE-STEP TURN FITS THE BUDGET');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const steps = [
    { tool: 'augment', params: { template: '{time}' } },
    { tool: 'filter', params: filterEndTime },
    { tool: 'filter', params: { field: 'format', operator: 'eq', value: '3D' } },
    { tool: 'select', params: { itemIds: ['s2'] } },
    { tool: 'next', params: {} },
  ];
  let view = buildViewFingerprint(timeSpec({ visible: ['s1', 's2', 's3'] }));
  let allRan = true;
  for (const step of steps) {
    const verdict = guard.evaluate({
      toolName: step.tool,
      params: step.params,
      viewFingerprint: view,
    });
    if (verdict.kind !== 'execute') allRan = false;
    guard.noteExecuted(verdict.signature, view);
    // Each step moves the screen, as a real one would.
    view = `${view}#${step.tool}`;
  }
  check('all five steps run', allRan);
  check('with a step of slack left', guard.executedCount() < MAX_ACTIONS_PER_TURN);
}

section('6. BUDGET EXHAUSTION');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i += 1) {
    const view = `view-${i}`;
    const verdict = guard.evaluate({
      toolName: 'augment',
      params: { template: `t${i}` },
      viewFingerprint: view,
    });
    guard.noteExecuted(verdict.signature, view);
  }
  const overflow = guard.evaluate({
    toolName: 'augment',
    params: { template: 'one-too-many' },
    viewFingerprint: 'view-final',
  });
  check('the next mutation is refused', overflow.kind === 'budget', overflow.kind);
  check(
    'and reports the count',
    overflow.kind === 'budget' && overflow.executedCount === MAX_ACTIONS_PER_TURN
  );
  guard.reset('stage-change');
  const afterStage = guard.evaluate({
    toolName: 'augment',
    params: { template: 'one-too-many' },
    viewFingerprint: 'view-final',
  });
  check('a stage change refills the budget', afterStage.kind === 'execute', afterStage.kind);
}

section('7. SPEECH DEDUPE WITHIN A TURN');
{
  const guard = createTurnRepeatGuard();
  guard.reset('user-message');
  const line = 'Applying your 10:00 PM start and 3D requirements.';
  const first = guard.evaluate({
    toolName: 'filter',
    params: filterEndTime,
    viewFingerprint: 'v1',
    assistantMessage: line,
  });
  check('the first utterance is spoken', first.speak);
  guard.noteExecuted(first.signature, 'v1');
  guard.noteSpoken(line);

  check('the same sentence is recognised', guard.hasSpoken(line));
  check('whitespace does not disguise it', guard.hasSpoken(`  ${line}  `));
  const second = guard.evaluate({
    toolName: 'filter',
    params: { field: 'format', operator: 'eq', value: '3D' },
    viewFingerprint: 'v2',
    assistantMessage: line,
  });
  check('a different action carrying it stays silent', !second.speak);
  const third = guard.evaluate({
    toolName: 'filter',
    params: { field: 'format', operator: 'eq', value: 'IMAX' },
    viewFingerprint: 'v2',
    assistantMessage: 'Only IMAX is left after that.',
  });
  check('a new sentence is let through', third.speak);
  guard.reset('user-message');
  check('and the next turn may say the old one again', !guard.hasSpoken(line));
}

section('8. SIGNATURE CANONICALISATION');
{
  check(
    'key order does not make a new signature',
    buildActionSignature('filter', { field: 'endTime', value: '22:00' }) ===
      buildActionSignature('filter', { value: '22:00', field: 'endTime' })
  );
  check(
    'array order does',
    buildActionSignature('highlight', { itemIds: ['a', 'b'] }) !==
      buildActionSignature('highlight', { itemIds: ['b', 'a'] })
  );
  check(
    'missing params equal empty params',
    buildActionSignature('next', undefined) === buildActionSignature('next', {})
  );
}

section('9. VIEW FINGERPRINT — what counts as the screen moving');
{
  const base = timeSpec({ visible: ['s1', 's2'], filter: filterEndTime });
  check(
    'an identical spec fingerprints the same',
    buildViewFingerprint(base) === buildViewFingerprint(timeSpec({
      visible: ['s1', 's2'],
      filter: filterEndTime,
    }))
  );
  check(
    'one fewer visible option moves it',
    buildViewFingerprint(base) !== buildViewFingerprint(timeSpec({ visible: ['s1'], filter: filterEndTime }))
  );
  check(
    'a selection moves it',
    buildViewFingerprint(base) !==
      buildViewFingerprint(timeSpec({ visible: ['s1', 's2'], filter: filterEndTime, selected: 's1' }))
  );
  check(
    'dropping the filter moves it',
    buildViewFingerprint(base) !== buildViewFingerprint(timeSpec({ visible: ['s1', 's2'] }))
  );
  check(
    'a larger inventory behind the same filter moves it',
    buildViewFingerprint(base) !==
      buildViewFingerprint(timeSpec({ visible: ['s1', 's2'], filter: filterEndTime, inventory: 9 }))
  );
  check('a null spec is tolerated', buildViewFingerprint(null) === 'null');
  check('so is a non-object', buildViewFingerprint('nonsense') === 'null');
}

console.log(
  failures === 0
    ? '\nAll repeat-guard checks passed.'
    : `\n${failures} repeat-guard check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
