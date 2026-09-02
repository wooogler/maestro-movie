/**
 * Checks the `agent.memory` contract end to end: the shape the agent runtime
 * assembles from AgentMemory, serialized as the relay would, and read back by
 * the parser the demo memory panel depends on.
 *
 * The two sides live in different workspaces and have no shared types, so a
 * field rename on one side is otherwise silent until a demo is running in front
 * of people. Run with `npm run check:memory`.
 */
import { AgentMemory } from '../apps/tuning-agent/src/core/memory';
import { parseAgentMemorySnapshot } from '../apps/frontend/src/agent/protocol';

let failures = 0;

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Serialize the way the relay does, so nothing survives on object identity. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

section('1. AGENT -> HOST — what the runtime assembles arrives intact');

const memory = new AgentMemory();
memory.setPreferences([
  { id: 'pref_imax', description: 'The showing must be IMAX', strength: 'hard', relevantStages: ['time'] },
  { id: 'pref_near', description: 'Closer theater is better', strength: 'soft', relevantStages: ['theater'] },
]);
memory.upsertDeadEnds([
  {
    id: 'dead_1',
    preferenceIds: ['pref_imax'],
    scope: { stage: 'time', movie: 'Street Fighter' },
    reason: 'No IMAX showing within 15 miles',
    createdAt: '2026-11-03T19:20:00.000Z',
    lastSeenAt: '2026-11-03T19:20:00.000Z',
    count: 1,
  },
]);
memory.commitWorkflowSelection('movie', { id: 'm1', title: 'Street Fighter' });
memory.recordAttemptedBranch({
  stage: 'theater',
  parentContextKey: 'root|m1',
  itemId: 't_belair',
  createdAt: '2026-11-03T19:19:00.000Z',
});
memory.recordStageFilter(
  {
    stage: 'time',
    parentContextKey: 'root|m1|t_troy',
    valueField: 'format',
    items: [{ id: 's1', format: 'IMAX' }],
  },
  {
    filter: { field: 'format', operator: 'eq', value: 'IMAX' },
    preferenceBindings: [{ id: 'pref_imax', strength: 'hard' }],
  },
  '2026-11-03T19:18:00.000Z'
);

// Mirrors buildMemorySnapshot() in the agent runtime field for field.
const snapshot = {
  updatedAt: '2026-11-03T19:20:31.004Z',
  reason: 'dead-end-recorded',
  stage: 'time',
  preferences: memory.getPreferences(),
  deadEnds: memory.getDeadEnds(),
  attemptedBranches: memory.getAttemptedBranches(),
  committedWorkflow: memory.getCommittedWorkflowState(),
  pendingConflict: null,
  backtrackContinuation: null,
  stageBindings: memory.getStageBindings(),
  forgottenPreferences: memory.getForgottenPreferences(),
  revokedAdaptations: [],
};

const parsed = parseAgentMemorySnapshot(overTheWire(snapshot));
check('round-trips', parsed !== null);
check('both preferences survive', parsed?.preferences.length === 2);
check('hard and soft stay distinguishable', parsed?.preferences[0].strength === 'hard' && parsed?.preferences[1].strength === 'soft');
check('dead end keeps the preference that caused it', parsed?.deadEnds[0]?.preferenceIds[0] === 'pref_imax');
check('dead end keeps its scope', parsed?.deadEnds[0]?.scope.movie === 'Street Fighter');
check('committed movie survives', (parsed?.committedWorkflow?.movie as { title?: string })?.title === 'Street Fighter');
check('abandoned branch survives', parsed?.attemptedBranches[0]?.itemId === 't_belair');
check('stage binding survives', parsed?.stageBindings[0]?.stage === 'time');
check('filter keeps the link back to its preference', parsed?.stageBindings[0]?.filters[0]?.preferenceIds[0] === 'pref_imax');
check('filter operator survives', parsed?.stageBindings[0]?.filters[0]?.operator === 'eq');

section('2. REMOVED BY HAND — the tombstone, the revocation, and the way back');
{
  const store = new AgentMemory();
  const seat = {
    id: 'prf_couple',
    description: 'Needs two couple seats together.',
    strength: 'hard' as const,
    relevantStages: ['seat' as const],
  };
  store.applyPreferenceProfile({ revision: 1, preferences: [seat] });
  check('a profile seeds memory before any conversation', store.getPreferences().length === 1);
  check(
    'the same revision again is a no-op',
    store.applyPreferenceProfile({ revision: 1, preferences: [] }).applied === false
  );
  check('...and does not empty the list', store.getPreferences().length === 1);

  store.recordStageFilter(
    {
      stage: 'seat',
      parentContextKey: 'root|m1|t_troy|s1',
      valueField: 'type',
      items: [{ id: 'H1', type: 'couple' }],
    },
    {
      filter: { field: 'type', operator: 'eq', value: 'couple' },
      preferenceBindings: [{ id: 'prf_couple', strength: 'hard' }],
    },
    '2026-11-03T19:18:00.000Z'
  );

  const { removed, revoked } = store.forgetPreference('prf_couple', '2026-11-03T19:21:00.000Z');
  check('removing returns what was removed', removed?.id === 'prf_couple');
  check('the preference is gone', store.getPreferences().length === 0);
  check('the filter it justified is revoked', revoked[0]?.filters[0]?.field === 'type');
  check('the revocation names the stage to un-apply on', revoked[0]?.stage === 'seat');
  check('it shows up as forgotten', store.getForgottenPreferences()[0]?.id === 'prf_couple');

  // The three ways a removed preference comes back, all of which the store must
  // refuse at write time.
  store.setPreferences([seat]);
  check('the original id cannot be written back', store.getPreferences().length === 0);
  store.setPreferences([{ ...seat, id: 'pref_minted_fresh' }]);
  check('...nor the same wording under a new id', store.getPreferences().length === 0);
  store.setPreferences([{ ...seat, id: 'pref_other', description: 'NEEDS TWO COUPLE SEATS TOGETHER.' }]);
  check('...nor a change of case', store.getPreferences().length === 0);

  check('restoring brings it back with its id', store.restorePreference('prf_couple')?.id === 'prf_couple');
  check('and it is no longer forgotten', store.getForgottenPreferences().length === 0);
  store.setPreferences([seat]);
  check('restoring lifts the wording block too', store.getPreferences().length === 1);

  // Clearing everything must behave exactly like removing each entry by hand,
  // or a presenter emptying the memory between visitors would leave the
  // resurrection paths open on whatever the bulk path skipped.
  const bulk = new AgentMemory();
  bulk.applyPreferenceProfile({
    revision: 1,
    preferences: [
      seat,
      { id: 'pref_late', description: 'After 9 PM.', strength: 'soft', relevantStages: ['time'] },
    ],
  });
  check('two preferences to clear', bulk.getPreferences().length === 2);
  const cleared = bulk.forgetAllPreferences('2026-11-03T19:22:00.000Z');
  check('clearing reports everything it removed', cleared.removed.length === 2);
  check('and the list is empty', bulk.getPreferences().length === 0);
  check('each is individually restorable', bulk.getForgottenPreferences().length === 2);
  bulk.setPreferences([seat]);
  check('a cleared preference cannot be written back', bulk.getPreferences().length === 0);
  check('and can be restored one at a time', bulk.restorePreference('prf_couple')?.id === 'prf_couple');
  check('leaving the other still forgotten', bulk.getPreferences().length === 1);

  const wiped = new AgentMemory();
  wiped.applyPreferenceProfile({ revision: 1, preferences: [seat] });
  wiped.forgetPreference('prf_couple', '2026-11-03T19:21:00.000Z');
  wiped.reset();
  check('a reset clears the tombstone', wiped.getForgottenPreferences().length === 0);
  check(
    'and lets the same revision seed again',
    wiped.applyPreferenceProfile({ revision: 1, preferences: [seat] }).applied === true
  );

  const parsedEdit = parseAgentMemorySnapshot(
    overTheWire({
      updatedAt: '2026-11-03T19:21:00.000Z',
      reason: 'preference-deleted',
      stage: 'seat',
      preferences: [],
      deadEnds: [],
      attemptedBranches: [],
      committedWorkflow: null,
      pendingConflict: null,
      backtrackContinuation: null,
      stageBindings: [],
      forgottenPreferences: [seat],
      revokedAdaptations: revoked,
    })
  );
  check('the host reads back what was forgotten', parsedEdit?.forgottenPreferences[0]?.id === 'prf_couple');
  check('the host reads back the revocation', parsedEdit?.revokedAdaptations[0]?.filters[0]?.operator === 'eq');
  check('...including which stage it belongs to', parsedEdit?.revokedAdaptations[0]?.stage === 'seat');
}

section('3. GUI ADAPTATION — a stage with no adaptation has nothing to explain');
const quiet = new AgentMemory();
quiet.setPreferences([
  { id: 'pref_x', description: 'Any seat is fine', strength: 'soft', relevantStages: ['seat'] },
]);
check('no bindings before any filter or highlight', quiet.getStageBindings().length === 0);

section('4. MALFORMED INPUT — the panel degrades, it does not throw');
check('null payload', parseAgentMemorySnapshot(null) === null);
check('string payload', parseAgentMemorySnapshot('nope') === null);
check('array payload', parseAgentMemorySnapshot([1, 2]) === null);

const bare = parseAgentMemorySnapshot({});
check('empty object yields empty sections', bare !== null && bare.preferences.length === 0 && bare.deadEnds.length === 0);

const junk = parseAgentMemorySnapshot({
  preferences: 'not-an-array',
  deadEnds: [null, { id: 'missing-everything-else' }],
  stageBindings: [{ stage: 'movie', filters: 'nope', highlight: 5 }],
  backtrackContinuation: { targetStage: '   ' },
});
check('non-array preferences', junk?.preferences.length === 0);
check('dead ends missing required fields are dropped', junk?.deadEnds.length === 0);
check('non-array filters', junk?.stageBindings[0]?.filters.length === 0);
check('blank backtrack target reads as none', junk?.backtrackContinuation === null);

const blankPreference = parseAgentMemorySnapshot({
  preferences: [{ id: 'pref_blank', description: '   ', strength: 'hard', relevantStages: [] }],
});
check('a preference with no description is dropped', blankPreference?.preferences.length === 0);

if (failures === 0) {
  console.log('\nAll agent.memory contract checks passed.');
  process.exit(0);
}
console.log(`\n${failures} agent.memory contract check(s) FAILED.`);
process.exit(1);
