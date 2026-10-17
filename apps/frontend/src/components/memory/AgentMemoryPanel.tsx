import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMemorySnapshot } from '../../agent/protocol';
import {
  MEMORY_STAGE_ORDER,
  describeScope,
  isMemoryStage,
  memoryStageLabel,
  readCommittedSelection,
} from './memoryFormat';
import { WorkflowGraph } from './WorkflowGraph';
import { PreferenceChip } from './PreferenceChip';
// The rest of this panel is still hardcoded English; this is the first string
// that reaches it through the provider. Safe without one — the context carries
// a real default — which is what lets the render check mount it bare.
import { useLanguage } from '../../i18n';

interface AgentMemoryPanelProps {
  snapshot: AgentMemorySnapshot | null;
  /** Stage the booking GUI is currently on, used to mark the rail. */
  currentStage?: string | null;
  /** `mirror` is the second-screen layout: larger type, no scroll container. */
  variant?: 'rail' | 'mirror';
  /** Off where the container already names the panel, e.g. inside a disclosure. */
  showHeading?: boolean;
  /**
   * Remove a preference the agent got wrong, or put one back.
   *
   * Absence is what keeps the panel read-only, and it is the ONLY gate: the
   * second screen and the paired phone render this same component, and neither
   * has any business rewriting memory. Gating on `variant` instead would put
   * live-looking controls on a phone somebody scanned off a QR code, where the
   * relay would refuse the frame anyway and the button would simply appear
   * broken.
   */
  onPreferenceDelete?: (preferenceId: string) => void;
  onPreferenceRestore?: (preferenceId: string) => void;
  /**
   * Withdraw the whole list at once.
   *
   * Its own affordance rather than "tap Forget six times": between visitors a
   * presenter wants the memory empty, and each individual removal costs a round
   * trip and a replan.
   */
  onPreferenceClearAll?: () => void;
  /** Ids with an unacknowledged edit in flight; their controls are inert. */
  pendingPreferenceIds?: ReadonlySet<string>;
}

type MemoryTab = 'preferences' | 'workflow';

const FLASH_MS = 1600;

/**
 * How long a press stays armed before it forgets it was asked.
 *
 * Long enough to reach the same spot twice, short enough that a chip cannot sit
 * one accidental brush away from being deleted while nobody is looking at it —
 * which at a booth is most of the time.
 */
const CONFIRM_WINDOW_MS = 4000;

/**
 * Which control is one press from committing.
 *
 * Held per mount on purpose. This panel renders twice at once in the booking
 * page — desktop rail and phone sheet, separated only by a CSS breakpoint — and
 * arming the copy nobody is looking at would be a control armed off-screen.
 */
function useArmedControl(): {
  armed: string | null;
  press: (key: string, commit: () => void) => void;
} {
  const [armed, setArmed] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const press = (key: string, commit: () => void) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (armed === key) {
      timerRef.current = null;
      setArmed(null);
      commit();
      return;
    }
    // Arming a different control disarms the previous one, so only ever one
    // thing is live at a time.
    setArmed(key);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setArmed(null);
    }, CONFIRM_WINDOW_MS);
  };

  return { armed, press };
}

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

/**
 * Whether the hidden tab changed while it was hidden. Splitting the panel in two
 * means half of it moves where nobody is looking; the dot is how that half says
 * so. It clears the moment the tab is opened, not on a timer.
 *
 * The state is adjusted during render rather than in an effect: what the open
 * tab shows is already known at render time, so publishing it from an effect
 * would only add a second render pass to say what the first one knew.
 */
function usePendingChange(signature: string, isVisible: boolean): boolean {
  const [seen, setSeen] = useState(signature);
  if (isVisible && seen !== signature) setSeen(signature);
  return !isVisible && seen !== signature;
}

function TabButton({
  id,
  label,
  count,
  isActive,
  hasPending,
  onSelect,
}: {
  id: MemoryTab;
  label: string;
  count?: number;
  isActive: boolean;
  hasPending: boolean;
  onSelect: (tab: MemoryTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`memory-tab-${id}`}
      aria-selected={isActive}
      aria-controls={`memory-panel-${id}`}
      onClick={() => onSelect(id)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
        isActive
          ? 'bg-dark-light text-fg-strong shadow-sm'
          : 'text-fg-muted hover:text-fg-strong'
      }`}
    >
      {label}
      {typeof count === 'number' && (
        <span
          className={`rounded px-1 py-0.5 text-[10px] font-bold ${
            isActive ? 'bg-dark-lighter text-fg' : 'bg-dark-light text-fg-muted'
          }`}
        >
          {count}
        </span>
      )}
      {hasPending && !isActive && (
        <span aria-label="new" className="h-1.5 w-1.5 rounded-full bg-accent" />
      )}
    </button>
  );
}

export function AgentMemoryPanel({
  snapshot,
  currentStage,
  variant = 'rail',
  showHeading = true,
  onPreferenceDelete,
  onPreferenceRestore,
  onPreferenceClearAll,
  pendingPreferenceIds,
}: AgentMemoryPanelProps) {
  const { s, language } = useLanguage();
  const preferences = snapshot?.preferences ?? [];
  const forgotten = snapshot?.forgottenPreferences ?? [];
  const deadEnds = snapshot?.deadEnds ?? [];
  const pendingConflict = snapshot?.pendingConflict ?? null;
  const backtrackTarget = snapshot?.backtrackContinuation?.targetStage ?? null;

  const [tab, setTab] = useState<MemoryTab>('preferences');

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

  const preferenceSignature = preferences.map((item) => item.id).join('|');
  /** Everything the graph draws, so the tab dot fires on a commit as well as a dead end. */
  const workflowSignature = [
    snapshot?.stage ?? '',
    backtrackTarget ?? '',
    MEMORY_STAGE_ORDER.map((stage) => readCommittedSelection(snapshot, stage) ?? '').join('/'),
    deadEnds.map((item) => `${item.id}:${item.count}`).join(','),
    (snapshot?.attemptedBranches ?? []).map((item) => `${item.stage}:${item.itemId}`).join(','),
  ].join('#');

  const preferencesPending = usePendingChange(preferenceSignature, tab === 'preferences');
  const workflowPending = usePendingChange(workflowSignature, tab === 'workflow');

  const hardPreferences = preferences.filter((item) => item.strength === 'hard');
  const softPreferences = preferences.filter((item) => item.strength === 'soft');
  const isPending = (id: string) => pendingPreferenceIds?.has(id) ?? false;
  const confirm = useArmedControl();
  const requestDelete = onPreferenceDelete
    ? (preferenceId: string) =>
        confirm.press(preferenceId, () => onPreferenceDelete(preferenceId))
    : undefined;
  const isMirror = variant === 'mirror';
  const activeStage =
    currentStage && isMemoryStage(currentStage) ? currentStage : null;

  return (
    /*
      No `h-full`. This panel is rendered inside a scroll container that also
      holds the pairing QR below it, and a definite height turned every section
      into a shrinkable flex item: the sections squeezed, their content spilled
      out of its own box, and the spill painted straight over the QR. Letting
      the panel size to its content puts the QR back under it where it belongs.
    */
    <div className={`flex flex-col gap-4 ${isMirror ? 'text-base' : 'text-sm'}`}>
      {showHeading && (
        <header>
          {/*
            No timestamp here. `snapshot.updatedAt` used to be printed beside the
            title as a bare HH:MM:SS, which was a liveness cue while this panel
            was being built and reads to a visitor as an unexplained clock. What
            the panel is for is what the agent remembers, not when it last
            changed its mind; the tab dots already say something moved.
          */}
          <h2 className={`font-semibold text-fg-strong ${isMirror ? 'text-2xl' : 'text-base'}`}>
            {s.mirrorTitle}
          </h2>
        </header>
      )}

      {!snapshot && (
        <p className="rounded-lg border border-dashed border-dark-border px-3 py-6 text-center text-sm text-fg-muted">
          {s.memoryEmpty}
        </p>
      )}

      {snapshot && (
        <>
          {/* Both banners sit above the tabs: they are the reason the agent is
              about to change course, and hiding one behind a tab would mean the
              room only sees the effect. */}
          {pendingConflict && (
            <section className="rounded-lg border border-accent-line/60 bg-accent/10 px-3 py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-accent-text">
                {s.memoryConflict}
              </h3>
              <p className="mt-1 text-sm leading-5 text-fg-strong">{pendingConflict.description}</p>
              {describeScope(pendingConflict.scope) && (
                <p className="mt-1 text-xs text-fg-muted">{describeScope(pendingConflict.scope)}</p>
              )}
            </section>
          )}

          {backtrackTarget && (
            <section className="rounded-lg border border-primary/60 bg-primary/10 px-3 py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-primary-text">
                {s.memoryBacktracking}
              </h3>
              <p className="mt-1 text-sm text-fg-strong">
                {s.memoryBacktrackTo.replace(
                  '{stage}',
                  isMemoryStage(backtrackTarget) ? memoryStageLabel(backtrackTarget, language) : backtrackTarget
                )}
              </p>
            </section>
          )}

          <div role="tablist" aria-label="Agent memory" className="flex gap-1 rounded-lg bg-dark-lighter p-1">
            <TabButton
              id="preferences"
              label={s.memoryTabPreferences}
              count={preferences.length}
              isActive={tab === 'preferences'}
              hasPending={preferencesPending}
              onSelect={setTab}
            />
            <TabButton
              id="workflow"
              label={s.memoryTabWorkflow}
              isActive={tab === 'workflow'}
              hasPending={workflowPending}
              onSelect={setTab}
            />
          </div>

          {tab === 'preferences' && (
            <section
              id="memory-panel-preferences"
              role="tabpanel"
              aria-labelledby="memory-tab-preferences"
              className="space-y-2"
            >
              {preferences.length === 0 ? (
                <p className="text-sm text-fg-muted">{s.memoryNoPreferences}</p>
              ) : (
                <>
                  <ul className="space-y-1.5">
                    {hardPreferences.map((preference) => (
                      <PreferenceChip
                        key={preference.id}
                        preference={preference}
                        isNew={newPreferenceIds.has(preference.id)}
                        isBlocked={blockedPreferenceIds.has(preference.id)}
                        onDelete={requestDelete}
                        isPending={isPending(preference.id)}
                        isArmed={confirm.armed === preference.id}
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
                          onDelete={requestDelete}
                          isPending={isPending(preference.id)}
                          isArmed={confirm.armed === preference.id}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}

              {onPreferenceClearAll && preferences.length > 0 && (
                <button
                  type="button"
                  onClick={() => confirm.press('__all__', onPreferenceClearAll)}
                  className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                    confirm.armed === '__all__'
                      ? 'border-danger bg-danger/20 text-fg-strong'
                      : 'border-dashed border-dark-border text-fg-muted hover:border-danger hover:text-fg-strong'
                  }`}
                >
                  {confirm.armed === '__all__' ? s.memoryForgetAllConfirm : s.memoryForgetAll}
                </button>
              )}

              {/*
                What was forgotten, and the way back.

                Not decoration and not only an undo. A removal is enforced by a
                tombstone the agent checks on every write, including a block on
                the wording — so restating a forgotten preference out loud does
                NOTHING, silently, on every screen at once. Without somewhere
                showing the removal and offering it back, that reads as the
                system having stopped listening.
              */}
              {forgotten.length > 0 && onPreferenceRestore && (
                <section className="mt-3 border-t border-dark-border pt-3">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                    {s.memoryForgotten}
                  </h3>
                  <ul className="mt-1.5 space-y-1">
                    {forgotten.map((preference) => (
                      <li
                        key={preference.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-dark-border px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs leading-4 text-fg-muted line-through">
                          {preference.description}
                        </span>
                        <button
                          type="button"
                          onClick={() => onPreferenceRestore(preference.id)}
                          disabled={isPending(preference.id)}
                          title={`${s.memoryRestore}: ${preference.description}`}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted transition-colors hover:bg-primary/20 hover:text-fg-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {s.memoryRestore}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </section>
          )}

          {tab === 'workflow' && (
            <section
              id="memory-panel-workflow"
              role="tabpanel"
              aria-labelledby="memory-tab-workflow"
            >
              <WorkflowGraph
                snapshot={snapshot}
                activeStage={activeStage}
                backtrackTarget={backtrackTarget}
                newDeadEndIds={newDeadEndIds}
                isMirror={isMirror}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
