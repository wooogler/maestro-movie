import { useMemo } from 'react';
import type {
  AgentDeadEnd,
  AgentMemorySnapshot,
  AgentStageBinding,
} from '../../agent/protocol';
import {
  MEMORY_STAGE_LABELS,
  MEMORY_STAGE_ORDER,
  describeFilter,
  describeScope,
  isMemoryStage,
  readCommittedSelection,
  type MemoryStage,
} from './memoryFormat';

interface WorkflowGraphProps {
  snapshot: AgentMemorySnapshot;
  /** Stage the booking GUI is currently on. */
  activeStage: MemoryStage | null;
  backtrackTarget: string | null;
  /** Dead ends that arrived with the latest snapshot, so a new branch can grow in. */
  newDeadEndIds: Set<string>;
  isMirror: boolean;
}

/** Abandoned options a stage draws as its own branch before the rest collapse to a count. */
const MAX_TRIED_BRANCHES = 3;

/**
 * The elbow that joins a side branch back to the trunk.
 *
 * `-left-4` is not a guess: the trunk is a border on the left rail (`w-4`), the
 * rail and this column are `gap-2` apart, so 16px to the left of the branch box
 * lands exactly on the trunk line. Change either and this stops meeting it.
 */
function BranchElbow({ tone }: { tone: 'danger' | 'muted' }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute -left-4 top-0 h-[15px] w-4 rounded-bl-[7px] border-b border-l ${
        tone === 'danger' ? 'border-danger/70' : 'border-dark-border'
      }`}
    />
  );
}

function StageNode({
  state,
  isActive,
}: {
  state: 'committed' | 'blocked' | 'open';
  isActive: boolean;
}) {
  const fill =
    state === 'committed'
      ? 'border-primary bg-primary'
      : state === 'blocked'
        ? 'border-danger bg-danger/30'
        : isActive
          ? 'border-primary bg-dark'
          : 'border-dark-border bg-dark-light';
  return (
    <span
      aria-hidden
      className={`absolute left-1/2 top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 ${fill} ${
        isActive ? 'memory-node-active' : ''
      }`}
    />
  );
}

/**
 * The agent's workflow memory as a tree that grows downward: one trunk of stages,
 * with every option it tried and abandoned hanging off the side — dead ends in
 * red. A list said the same thing, but flat; the point of the demo is that the
 * agent *searched*, and a search has shape.
 */
export function WorkflowGraph({
  snapshot,
  activeStage,
  backtrackTarget,
  newDeadEndIds,
  isMirror,
}: WorkflowGraphProps) {
  const preferencesById = useMemo(
    () => new Map((snapshot.preferences ?? []).map((item) => [item.id, item])),
    [snapshot.preferences]
  );

  const deadEndsByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, AgentDeadEnd[]>();
    for (const deadEnd of snapshot.deadEnds ?? []) {
      if (!isMemoryStage(deadEnd.scope.stage)) continue;
      const bucket = grouped.get(deadEnd.scope.stage) ?? [];
      bucket.push(deadEnd);
      grouped.set(deadEnd.scope.stage, bucket);
    }
    return grouped;
  }, [snapshot.deadEnds]);

  const attemptedByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, string[]>();
    for (const branch of snapshot.attemptedBranches ?? []) {
      if (!isMemoryStage(branch.stage)) continue;
      const bucket = grouped.get(branch.stage) ?? [];
      bucket.push(branch.itemId);
      grouped.set(branch.stage, bucket);
    }
    return grouped;
  }, [snapshot.attemptedBranches]);

  const bindingsByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, AgentStageBinding[]>();
    for (const binding of snapshot.stageBindings ?? []) {
      if (!isMemoryStage(binding.stage)) continue;
      const bucket = grouped.get(binding.stage) ?? [];
      bucket.push(binding);
      grouped.set(binding.stage, bucket);
    }
    return grouped;
  }, [snapshot.stageBindings]);

  const namePreferences = (ids: string[], separator: string) =>
    ids.map((id) => preferencesById.get(id)?.description ?? id).join(separator);

  return (
    <div className="space-y-2">
      <ol>
        {MEMORY_STAGE_ORDER.map((stage, index) => {
          const committed = readCommittedSelection(snapshot, stage);
          const stageDeadEnds = deadEndsByStage.get(stage) ?? [];
          const abandoned = attemptedByStage.get(stage) ?? [];
          const bindings = bindingsByStage.get(stage) ?? [];
          const isActive = activeStage === stage;
          const isBacktrackTarget = backtrackTarget === stage;
          const isLast = index === MEMORY_STAGE_ORDER.length - 1;
          const nodeState = committed
            ? 'committed'
            : stageDeadEnds.length > 0
              ? 'blocked'
              : 'open';
          const shownTried = abandoned.slice(0, MAX_TRIED_BRANCHES);
          const hiddenTried = abandoned.length - shownTried.length;

          return (
            <li key={stage} className="flex gap-2 pb-3 last:pb-0">
              <div className="relative w-4 shrink-0" aria-hidden>
                {!isLast && (
                  /* The trunk runs the full height of the row, branches included,
                     so a side branch leaves it wherever it happens to hang. */
                  <span
                    className={`absolute -bottom-3 left-1/2 top-5 w-0 border-l ${
                      committed ? 'border-primary/50' : 'border-dashed border-dark-border'
                    }`}
                  />
                )}
                <StageNode state={nodeState} isActive={isActive} />
              </div>

              <div className="min-w-0 flex-1 space-y-1.5">
                <div
                  className={`rounded-lg border px-2.5 py-1.5 ${
                    isActive
                      ? 'border-fg-strong/70 bg-dark-light'
                      : 'border-dark-border bg-dark-light/40'
                  } ${isBacktrackTarget ? 'ring-1 ring-primary/70' : ''}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`text-xs font-semibold uppercase tracking-wide ${
                        isActive ? 'text-fg-strong' : 'text-fg-muted'
                      }`}
                    >
                      {MEMORY_STAGE_LABELS[stage]}
                    </span>
                    {committed ? (
                      <span
                        className={`truncate text-fg-strong ${isMirror ? 'text-base' : 'text-sm'}`}
                      >
                        {committed}
                      </span>
                    ) : (
                      <span className="truncate text-sm text-fg-faint">
                        {isActive ? 'exploring…' : '—'}
                      </span>
                    )}
                  </div>

                  {bindings.map((binding) => (
                    <div
                      key={`${binding.stage}-${binding.parentContextKey}`}
                      className="mt-1 space-y-0.5"
                    >
                      {binding.filters.map((filter, filterIndex) => (
                        <p
                          key={`${filter.field}-${filterIndex}`}
                          className="text-[11px] leading-4 text-fg-muted"
                        >
                          <span className="text-fg-faint">filtered</span> {describeFilter(filter)}
                          {filter.preferenceIds.length > 0 && (
                            <span className="text-fg-faint">
                              {' ← '}
                              {namePreferences(filter.preferenceIds, ', ')}
                            </span>
                          )}
                        </p>
                      ))}
                      {binding.highlight && binding.highlight.preferenceIds.length > 0 && (
                        <p className="text-[11px] leading-4 text-fg-muted">
                          <span className="text-fg-faint">highlighted</span>{' '}
                          {binding.highlight.itemIds.length} option
                          {binding.highlight.itemIds.length === 1 ? '' : 's'}
                          <span className="text-fg-faint">
                            {' ← '}
                            {namePreferences(binding.highlight.preferenceIds, ', ')}
                          </span>
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                {stageDeadEnds.map((deadEnd) => (
                  <div
                    key={deadEnd.id}
                    className={`relative ${
                      newDeadEndIds.has(deadEnd.id) ? 'memory-branch-enter' : ''
                    }`}
                  >
                    <BranchElbow tone="danger" />
                    <div className="rounded-lg border border-danger bg-danger/10 px-2 py-1.5">
                      <p className="text-xs font-semibold text-danger-text">
                        ✕ Dead end
                        {deadEnd.count > 1 && (
                          <span className="ml-1 font-normal text-fg-muted">×{deadEnd.count}</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs leading-4 text-fg-strong">{deadEnd.reason}</p>
                      {describeScope(deadEnd.scope) && (
                        <p className="mt-0.5 text-[11px] text-fg-muted">
                          {describeScope(deadEnd.scope)}
                        </p>
                      )}
                      {deadEnd.preferenceIds.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-fg-faint">
                          caused by: {namePreferences(deadEnd.preferenceIds, ' + ')}
                        </p>
                      )}
                    </div>
                  </div>
                ))}

                {shownTried.map((itemId) => (
                  <div key={itemId} className="relative">
                    <BranchElbow tone="muted" />
                    <p className="truncate text-[11px] leading-4 text-fg-faint line-through">
                      {itemId}
                    </p>
                  </div>
                ))}
                {hiddenTried > 0 && (
                  <div className="relative">
                    <BranchElbow tone="muted" />
                    <p className="text-[11px] leading-4 text-fg-faint">
                      +{hiddenTried} more tried
                    </p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-faint">
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-primary bg-primary" />
          decided
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-primary bg-dark" />
          exploring
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-danger bg-danger/30" />
          dead end
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="line-through">abc</span>
          tried, dropped
        </span>
      </p>
    </div>
  );
}
