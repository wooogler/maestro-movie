import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMemorySnapshot, AgentPreference } from '../../agent/protocol';
import {
  MEMORY_STAGE_INITIALS,
  MEMORY_STAGE_LABELS,
  MEMORY_STAGE_ORDER,
  describeFilter,
  describeScope,
  formatUpdatedAt,
  isMemoryStage,
  readCommittedSelection,
  type MemoryStage,
} from './memoryFormat';

interface AgentMemoryPanelProps {
  snapshot: AgentMemorySnapshot | null;
  /** Stage the booking GUI is currently on, used to mark the rail. */
  currentStage?: string | null;
  /** `mirror` is the second-screen layout: larger type, no scroll container. */
  variant?: 'rail' | 'mirror';
  /** Off where the container already names the panel, e.g. inside a disclosure. */
  showHeading?: boolean;
}

const FLASH_MS = 1600;

/** Ids that appeared since the previous snapshot, so new memory can announce itself. */
function useRecentlyAdded(ids: string[]): Set<string> {
  const seenRef = useRef<Set<string> | null>(null);
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const key = ids.join('|');

  useEffect(() => {
    const seen = seenRef.current;
    const next = new Set(ids);
    if (seen === null) {
      // First snapshot of a session is not "new" — everything would flash at once.
      seenRef.current = next;
      return;
    }
    const added = ids.filter((id) => !seen.has(id));
    seenRef.current = next;
    if (added.length === 0) return;
    setRecent(new Set(added));
    const timer = window.setTimeout(() => setRecent(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
    // `key` collapses the array into a stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return recent;
}

function StageDots({ stages }: { stages: string[] }) {
  const active = new Set(stages);
  return (
    <span className="flex items-center gap-0.5" aria-label={`Applies to: ${stages.join(', ')}`}>
      {MEMORY_STAGE_ORDER.map((stage) => (
        <span
          key={stage}
          title={MEMORY_STAGE_LABELS[stage]}
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[9px] font-semibold leading-none ${
            active.has(stage)
              ? 'bg-fg-strong/85 text-dark'
              : 'bg-dark-lighter text-fg-faint'
          }`}
        >
          {MEMORY_STAGE_INITIALS[stage]}
        </span>
      ))}
    </span>
  );
}

function PreferenceChip({
  preference,
  isNew,
  isBlocked,
}: {
  preference: AgentPreference;
  isNew: boolean;
  isBlocked: boolean;
}) {
  const hard = preference.strength === 'hard';
  return (
    <li
      className={`rounded-lg border px-2.5 py-2 transition-colors ${
        hard ? 'border-solid border-fg-muted/70' : 'border-dashed border-fg-faint/70'
      } ${isBlocked ? 'bg-red-500/10' : 'bg-dark-light/60'} ${
        isNew ? 'animate-[memory-flash_1.6s_ease-out]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm leading-5 text-fg-strong">{preference.description}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            hard ? 'bg-fg-strong/85 text-dark' : 'bg-dark-lighter text-fg-muted'
          }`}
        >
          {hard ? 'Hard' : 'Soft'}
        </span>
      </div>
      <div className="mt-1.5">
        <StageDots stages={preference.relevantStages} />
      </div>
    </li>
  );
}

function SectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
      {title}
      {typeof count === 'number' && (
        <span className="rounded bg-dark-lighter px-1.5 py-0.5 text-[10px] font-bold text-fg">
          {count}
        </span>
      )}
    </h3>
  );
}

export function AgentMemoryPanel({
  snapshot,
  currentStage,
  variant = 'rail',
  showHeading = true,
}: AgentMemoryPanelProps) {
  const preferences = snapshot?.preferences ?? [];
  const deadEnds = snapshot?.deadEnds ?? [];
  const attemptedBranches = snapshot?.attemptedBranches ?? [];
  const stageBindings = snapshot?.stageBindings ?? [];
  const pendingConflict = snapshot?.pendingConflict ?? null;
  const backtrackTarget = snapshot?.backtrackContinuation?.targetStage ?? null;

  const newPreferenceIds = useRecentlyAdded(preferences.map((item) => item.id));
  const newDeadEndIds = useRecentlyAdded(deadEnds.map((item) => item.id));

  /** Preferences named by a dead end are the ones that closed a path. */
  const blockedPreferenceIds = useMemo(() => {
    const blocked = new Set<string>();
    for (const deadEnd of deadEnds) {
      for (const id of deadEnd.preferenceIds) blocked.add(id);
    }
    for (const id of pendingConflict?.preferenceIds ?? []) blocked.add(id);
    return blocked;
  }, [deadEnds, pendingConflict]);

  const preferencesById = useMemo(
    () => new Map(preferences.map((item) => [item.id, item])),
    [preferences]
  );

  const deadEndsByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, typeof deadEnds>();
    for (const deadEnd of deadEnds) {
      if (!isMemoryStage(deadEnd.scope.stage)) continue;
      const bucket = grouped.get(deadEnd.scope.stage) ?? [];
      bucket.push(deadEnd);
      grouped.set(deadEnd.scope.stage, bucket);
    }
    return grouped;
  }, [deadEnds]);

  const attemptedByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, string[]>();
    for (const branch of attemptedBranches) {
      if (!isMemoryStage(branch.stage)) continue;
      const bucket = grouped.get(branch.stage) ?? [];
      bucket.push(branch.itemId);
      grouped.set(branch.stage, bucket);
    }
    return grouped;
  }, [attemptedBranches]);

  const bindingsByStage = useMemo(() => {
    const grouped = new Map<MemoryStage, typeof stageBindings>();
    for (const binding of stageBindings) {
      if (!isMemoryStage(binding.stage)) continue;
      const bucket = grouped.get(binding.stage) ?? [];
      bucket.push(binding);
      grouped.set(binding.stage, bucket);
    }
    return grouped;
  }, [stageBindings]);

  const hardPreferences = preferences.filter((item) => item.strength === 'hard');
  const softPreferences = preferences.filter((item) => item.strength === 'soft');
  const isMirror = variant === 'mirror';
  const activeStage =
    currentStage && isMemoryStage(currentStage) ? currentStage : null;

  return (
    <div className={`flex h-full flex-col gap-4 ${isMirror ? 'text-base' : 'text-sm'}`}>
      {showHeading && (
        <header className="flex items-baseline justify-between gap-2">
          <h2 className={`font-semibold text-fg-strong ${isMirror ? 'text-2xl' : 'text-base'}`}>
            What the agent remembers
          </h2>
          {snapshot?.updatedAt && (
            <span className="text-[11px] tabular-nums text-fg-faint">
              {formatUpdatedAt(snapshot.updatedAt)}
            </span>
          )}
        </header>
      )}

      {!snapshot && (
        <p className="rounded-lg border border-dashed border-dark-border px-3 py-6 text-center text-sm text-fg-muted">
          Nothing yet — say what you are looking for and it will appear here.
        </p>
      )}

      {snapshot && (
        <>
          <section className="space-y-2">
            <SectionHeading title="Preference memory" count={preferences.length} />
            {preferences.length === 0 ? (
              <p className="text-sm text-fg-muted">No preferences extracted yet.</p>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {hardPreferences.map((preference) => (
                    <PreferenceChip
                      key={preference.id}
                      preference={preference}
                      isNew={newPreferenceIds.has(preference.id)}
                      isBlocked={blockedPreferenceIds.has(preference.id)}
                    />
                  ))}
                </ul>
                {softPreferences.length > 0 && (
                  <ul className="space-y-1.5">
                    {softPreferences.map((preference) => (
                      <PreferenceChip
                        key={preference.id}
                        preference={preference}
                        isNew={newPreferenceIds.has(preference.id)}
                        isBlocked={blockedPreferenceIds.has(preference.id)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {pendingConflict && (
            <section className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-3 py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">
                Conflict detected
              </h3>
              <p className="mt-1 text-sm leading-5 text-fg-strong">{pendingConflict.description}</p>
              {describeScope(pendingConflict.scope) && (
                <p className="mt-1 text-xs text-fg-muted">{describeScope(pendingConflict.scope)}</p>
              )}
            </section>
          )}

          {backtrackTarget && (
            <section className="rounded-lg border border-sky-500/60 bg-sky-500/10 px-3 py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-300">
                Backtracking
              </h3>
              <p className="mt-1 text-sm text-fg-strong">
                Going back to the {MEMORY_STAGE_LABELS[backtrackTarget as MemoryStage] ?? backtrackTarget} step
              </p>
            </section>
          )}

          <section className="space-y-2">
            <SectionHeading title="Workflow navigation" />
            <ol className="space-y-1.5">
              {MEMORY_STAGE_ORDER.map((stage) => {
                const committed = readCommittedSelection(snapshot, stage);
                const stageDeadEnds = deadEndsByStage.get(stage) ?? [];
                const abandoned = attemptedByStage.get(stage) ?? [];
                const bindings = bindingsByStage.get(stage) ?? [];
                const isActive = activeStage === stage;
                const isBacktrackTarget = backtrackTarget === stage;

                return (
                  <li
                    key={stage}
                    className={`rounded-lg border px-2.5 py-2 ${
                      isActive
                        ? 'border-fg-strong/70 bg-dark-light'
                        : 'border-dark-border bg-dark-light/40'
                    } ${isBacktrackTarget ? 'ring-1 ring-sky-400/70' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-xs font-semibold uppercase tracking-wide ${
                          isActive ? 'text-fg-strong' : 'text-fg-muted'
                        }`}
                      >
                        {MEMORY_STAGE_LABELS[stage]}
                      </span>
                      <span className="truncate text-sm text-fg-strong">{committed ?? '—'}</span>
                    </div>

                    {bindings.map((binding) => (
                      <div key={`${binding.stage}-${binding.parentContextKey}`} className="mt-1.5 space-y-1">
                        {binding.filters.map((filter, index) => (
                          <p
                            key={`${filter.field}-${index}`}
                            className="text-[11px] leading-4 text-fg-muted"
                          >
                            <span className="text-fg-faint">filtered</span> {describeFilter(filter)}
                            {filter.preferenceIds.length > 0 && (
                              <span className="text-fg-faint">
                                {' ← '}
                                {filter.preferenceIds
                                  .map((id) => preferencesById.get(id)?.description ?? id)
                                  .join(', ')}
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
                              {binding.highlight.preferenceIds
                                .map((id) => preferencesById.get(id)?.description ?? id)
                                .join(', ')}
                            </span>
                          </p>
                        )}
                      </div>
                    ))}

                    {abandoned.length > 0 && (
                      <p className="mt-1.5 text-[11px] leading-4 text-fg-faint line-through">
                        tried: {abandoned.join(', ')}
                      </p>
                    )}

                    {stageDeadEnds.map((deadEnd) => (
                      <div
                        key={deadEnd.id}
                        className={`mt-1.5 rounded border border-red-500/60 bg-red-500/10 px-2 py-1.5 ${
                          newDeadEndIds.has(deadEnd.id) ? 'animate-[memory-flash_1.6s_ease-out]' : ''
                        }`}
                      >
                        <p className="text-xs font-semibold text-red-300">
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
                            caused by:{' '}
                            {deadEnd.preferenceIds
                              .map((id) => preferencesById.get(id)?.description ?? id)
                              .join(' + ')}
                          </p>
                        )}
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
