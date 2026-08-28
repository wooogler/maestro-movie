/**
 * Executable check for the navigation-memory fixes. No test runner is
 * configured, so this is a plain script:
 *
 *   npx tsx apps/tuning-agent/src/core/navigationMemory.check.ts
 *
 * Each case is a failure the March 2026 study logs actually exhibited.
 */
import { AgentMemory } from './memory';
import { deadEndBlacklistStage, findDeadEndItemIds } from './planner';
import type { ConflictStage, DeadEnd, Preference } from '../types';

const T0 = new Date(0).toISOString();

function snapshot(stage: ConflictStage, items: Record<string, unknown>[], valueField: string) {
  return { stage, parentContextKey: 'ctx', valueField, items };
}

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

function pref(
  id: string,
  description: string,
  strength: Preference['strength'],
  relevantStages: Preference['relevantStages']
): Preference {
  return { id, description, strength, relevantStages };
}

function deadEnd(id: string, preferenceIds: string[], scope: DeadEnd['scope']): DeadEnd {
  const now = new Date(0).toISOString();
  return { id, preferenceIds, scope, reason: 'test', createdAt: now, lastSeenAt: now, count: 1 };
}

section('1. LOOK-AHEAD DEAD END — the store’s whole reason to exist');
{
  // At the date stage the agent works out that this date cannot satisfy a SEAT
  // requirement. The seat preference's relevantStages is ['seat'], not ['date'],
  // and the old rule pruned exactly this. 127 of 470 disclosed conflicts in the
  // study pointed downstream like this.
  const memory = new AgentMemory();
  const seats = pref('p_seats', 'Needs two adjacent seats.', 'hard', ['seat']);
  memory.setPreferences([seats]);
  memory.upsertDeadEnds([deadEnd('de1', ['p_seats'], { stage: 'date', date: '2026-03-14' })]);
  check('recorded', memory.getDeadEnds().length === 1);

  // A later extraction turn re-emits the same preference.
  memory.setPreferences([seats]);
  check(
    'survives an extraction turn even though its stage is not in relevantStages',
    memory.getDeadEnds().length === 1,
    JSON.stringify(memory.getDeadEnds())
  );
}

section('2. SOFT-BACKED DEAD END — still a fact about the world');
{
  const memory = new AgentMemory();
  const soft = pref('p_soft', 'Prefers an evening showtime.', 'soft', ['time']);
  memory.setPreferences([soft]);
  memory.upsertDeadEnds([deadEnd('de2', ['p_soft'], { stage: 'time', showing: '7:30 PM' })]);
  memory.setPreferences([soft]);
  check('retained for a soft preference', memory.getDeadEnds().length === 1);
}

section('3. REWORDING — one changed id must not take the fact with it');
{
  const memory = new AgentMemory();
  const a = pref('p_a', 'Needs IMAX.', 'hard', ['time']);
  const b = pref('p_b', 'Must end before 10 PM.', 'hard', ['time']);
  memory.setPreferences([a, b]);
  memory.upsertDeadEnds([deadEnd('de3', ['p_a', 'p_b'], { stage: 'time', showing: '9:10 PM' })]);
  // The model rewords one of them, so its derived id changes.
  memory.setPreferences([a, pref('p_b2', 'Must end by 10 PM.', 'hard', ['time'])]);
  check(
    'survives while any referenced preference remains',
    memory.getDeadEnds().length === 1,
    JSON.stringify(memory.getDeadEnds())
  );
}

section('4. FULLY ORPHANED — dropped when nothing references it any more');
{
  const memory = new AgentMemory();
  memory.setPreferences([pref('p_x', 'Needs IMAX.', 'hard', ['time'])]);
  memory.upsertDeadEnds([deadEnd('de4', ['p_x'], { stage: 'time', showing: '9:10 PM' })]);
  memory.setPreferences([pref('p_y', 'Wants a comedy.', 'soft', ['movie'])]);
  check('pruned once every reference is gone', memory.getDeadEnds().length === 0);
}

section('5. STAGE ALTERNATIVES — a highlight is not an inventory count');
{
  const memory = new AgentMemory();
  const items = [
    { id: 't1', name: 'Metro 8' },
    { id: 't2', name: 'Picture Shack' },
    { id: 't3', name: 'Terminal Screens' },
    { id: 't4', name: 'SoundSphere' },
    { id: 't5', name: 'Grand Central' },
  ];
  memory.upsertStageAlternativeSnapshot(snapshot('theater', items, 'name'), T0);
  check('all five options counted', memory.getStageAlternativeCount('theater', 'ctx') === 5);

  // The agent highlights the single IMAX theater and calls it full coverage.
  memory.recordStageHighlight(
    snapshot('theater', items, 'name'),
    { itemIds: ['t1'], coverage: 'full', preferenceBindings: [{ id: 'p_imax', strength: 'hard' }] },
    T0
  );
  check(
    'a full-coverage highlight does not shrink the stage',
    memory.getStageAlternativeCount('theater', 'ctx') === 5,
    String(memory.getStageAlternativeCount('theater', 'ctx'))
  );

  // The user then selects it. The stage still has four other theaters.
  check(
    'selecting the highlighted item still leaves the others',
    memory.getStageAlternativeCount('theater', 'ctx', new Set(['t1'])) === 4,
    String(memory.getStageAlternativeCount('theater', 'ctx', new Set(['t1'])))
  );
}

section('6. STAGE ALTERNATIVES — only a hard filter removes options');
{
  const showings = [
    { id: 's1', format: 'IMAX' },
    { id: 's2', format: 'Standard' },
    { id: 's3', format: 'Standard' },
  ];
  const base = () => {
    const memory = new AgentMemory();
    memory.upsertStageAlternativeSnapshot(snapshot('time', showings, 'format'), T0);
    return memory;
  };

  const soft = base();
  soft.recordStageFilter(
    snapshot('time', showings, 'format'),
    {
      filter: { field: 'format', operator: 'eq', value: 'IMAX' },
      preferenceBindings: [{ id: 'p_fmt', strength: 'soft' }],
    },
    T0
  );
  check(
    'a soft-bound filter does not shrink the stage',
    soft.getStageAlternativeCount('time', 'ctx') === 3,
    String(soft.getStageAlternativeCount('time', 'ctx'))
  );

  const hard = base();
  hard.recordStageFilter(
    snapshot('time', showings, 'format'),
    {
      filter: { field: 'format', operator: 'eq', value: 'IMAX' },
      preferenceBindings: [{ id: 'p_fmt', strength: 'hard' }],
    },
    T0
  );
  check(
    'a hard-bound filter does shrink it',
    hard.getStageAlternativeCount('time', 'ctx') === 1,
    String(hard.getStageAlternativeCount('time', 'ctx'))
  );
}

section('7. BLACKLIST STAGE — a seat conflict kills the showing, not the movie');
{
  // buildConflictScope records the whole ancestor path, so a seat conflict
  // carries movie/theater/date/showing. It used to be matched at every one of
  // those stages: 574 of 960 (dead end, turn) pairs projected two or more
  // stages up, blacklisting the movie itself in 126 turns.
  const seatConflict = deadEnd('de_seat', ['p_seats'], {
    stage: 'seat',
    movie: 'Flash District',
    theater: 'Metro 8',
    date: '2026-03-14',
    showing: '7:30 PM',
  });
  check('enforced at the time stage', deadEndBlacklistStage(seatConflict) === 'time');

  const movies = [{ id: 'm1', title: 'Flash District' }, { id: 'm2', title: 'Quiet Harbor' }];
  check(
    'does not blacklist the movie',
    findDeadEndItemIds(movies, [seatConflict], 'movie', null).length === 0,
    JSON.stringify(findDeadEndItemIds(movies, [seatConflict], 'movie', null))
  );

  const theaters = [{ id: 't1', name: 'Metro 8' }, { id: 't2', name: 'Picture Shack' }];
  check(
    'does not blacklist the theater',
    findDeadEndItemIds(theaters, [seatConflict], 'theater', null).length === 0
  );

  const showings = [{ id: 's1', time: '7:30 PM' }, { id: 's2', time: '9:10 PM' }];
  check(
    'does blacklist the showing it actually failed on',
    JSON.stringify(findDeadEndItemIds(showings, [seatConflict], 'time', null)) === '["s1"]',
    JSON.stringify(findDeadEndItemIds(showings, [seatConflict], 'time', null))
  );
}

section('8. BLACKLIST STAGE — a date conflict stays at the date stage');
{
  const dateConflict = deadEnd('de_date', ['p_x'], {
    stage: 'date',
    movie: 'Flash District',
    theater: 'Metro 8',
    date: '2026-03-14',
  });
  check('enforced at the date stage', deadEndBlacklistStage(dateConflict) === 'date');
  const movies = [{ id: 'm1', title: 'Flash District' }];
  check(
    'does not reach back to the movie',
    findDeadEndItemIds(movies, [dateConflict], 'movie', null).length === 0
  );
  const dates = [{ id: 'd1', date: '2026-03-14' }, { id: 'd2', date: '2026-03-15' }];
  check(
    'blacklists the date',
    JSON.stringify(findDeadEndItemIds(dates, [dateConflict], 'date', null)) === '["d1"]',
    JSON.stringify(findDeadEndItemIds(dates, [dateConflict], 'date', null))
  );
}

console.log(
  failures === 0
    ? '\nAll navigation-memory checks passed.'
    : `\n${failures} navigation-memory check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
