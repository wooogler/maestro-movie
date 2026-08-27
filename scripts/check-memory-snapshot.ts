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

section('2. GUI ADAPTATION — a stage with no adaptation has nothing to explain');
const quiet = new AgentMemory();
quiet.setPreferences([
  { id: 'pref_x', description: 'Any seat is fine', strength: 'soft', relevantStages: ['seat'] },
]);
check('no bindings before any filter or highlight', quiet.getStageBindings().length === 0);

section('3. MALFORMED INPUT — the panel degrades, it does not throw');
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
