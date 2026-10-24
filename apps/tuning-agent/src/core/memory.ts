import {
  isProfilePreferenceId,
  normalizeDeadEnds,
  normalizePreferenceList,
  preferenceDescriptionKey,
} from './cpMemory';
import { countSelectableFilteredItems } from './filterSimulation';
import type {
  AlternativeFilterTrace,
  AlternativeHighlightTrace,
  AttemptedBranch,
  DeadEnd,
  EpisodicRecord,
  FilterExpression,
  ForgottenPreference,
  PerceivedContext,
  PreferenceBinding,
  Preference,
  PreferenceProfilePayload,
  RevokedAdaptation,
  StageAlternativeMemory,
  StageBinding,
} from '../types';
import type { WorkflowStage } from './workflowState';

const MAX_EPISODIC_RECORDS = 200;
const INFRA_ERROR_CODES = new Set(['SESSION_NOT_ACTIVE', 'RELAY_ERROR']);

/**
 * A dead end records a fact about the world — "no two adjacent seats remain in
 * this showing" — so it should outlive incidental churn in the preference list.
 *
 * This used to require EVERY referenced preference to still exist, to be hard,
 * AND to list the dead end's own stage in `relevantStages`. That last condition
 * destroyed exactly the dead ends worth keeping: the whole point of the store is
 * to remember at the DATE stage that a date cannot satisfy a SEAT requirement,
 * and a seat preference's relevantStages is `['seat']`, not `['date']`. In the
 * study, 131 of 470 disclosed conflicts (27.9%) named a preference whose stages
 * did not include the stage where the conflict arose, and 127 of those pointed
 * downstream — the look-ahead case. All of them were pruned on the next
 * extraction turn.
 *
 * Now a dead end survives while any referenced preference is still around, and
 * a rewording that changes one id no longer takes the fact with it.
 */
function shouldRetainDeadEnd(deadEnd: DeadEnd, preferencesById: ReadonlyMap<string, Preference>): boolean {
  if (deadEnd.preferenceIds.length === 0) return true;
  return deadEnd.preferenceIds.some((id) => preferencesById.has(id));
}

function shouldRetainAlternativeFilter(
  stage: StageAlternativeMemory['stage'],
  trace: AlternativeFilterTrace,
  preferencesById: ReadonlyMap<string, Preference>
): boolean {
  if (trace.preferenceBindings.length === 0) return false;
  return trace.preferenceBindings.every((binding) => {
    const preference = preferencesById.get(binding.id);
    return (
      preference !== undefined &&
      preference.strength === binding.strength &&
      preference.relevantStages.includes(stage)
    );
  });
}

function shouldRetainAlternativeHighlight(
  stage: StageAlternativeMemory['stage'],
  trace: AlternativeHighlightTrace | null,
  preferencesById: ReadonlyMap<string, Preference>
): boolean {
  if (!trace || trace.preferenceBindings.length === 0) return false;
  return trace.preferenceBindings.every((binding) => {
    const preference = preferencesById.get(binding.id);
    return (
      preference !== undefined &&
      preference.strength === binding.strength &&
      preference.relevantStages.includes(stage)
    );
  });
}

function countSelectableHighlightItems(
  items: Record<string, unknown>[],
  itemIds: string[]
): number {
  const highlightSet = new Set(itemIds);
  return items.filter((item) => {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id || !highlightSet.has(id)) return false;
    if (item.available === false) return false;
    if (typeof item.status === 'string' && item.status !== 'available') return false;
    return true;
  }).length;
}

export class AgentMemory {
  private context: PerceivedContext | null = null;
  private episodic: EpisodicRecord[] = [];
  private preferences: Preference[] = [];
  private deadEnds: DeadEnd[] = [];
  private attemptedBranches = new Map<string, AttemptedBranch>();
  private stageAlternatives = new Map<string, StageAlternativeMemory>();
  private committedWorkflowState: Record<string, unknown> | null = null;
  /**
   * Preferences the visitor removed by hand, keyed by id.
   *
   * Consulted at WRITE time by `setPreferences`, which is the only production
   * path that writes preferences. That placement is what makes a removal stick
   * without a lock or a queue: the extractor captures the preference list
   * before a multi-second model call and writes it back afterwards, so a
   * removal landing inside that window would otherwise be overwritten — and,
   * for a hard preference, actively reinstated by the carry-forward rule.
   */
  private forgotten = new Map<string, ForgottenPreference>();
  /** Highest profile revision applied, so re-sent snapshots are no-ops. */
  private profileRevision = 0;

  reset(): void {
    this.context = null;
    this.episodic = [];
    this.preferences = [];
    this.deadEnds = [];
    this.attemptedBranches = new Map();
    this.stageAlternatives = new Map();
    this.committedWorkflowState = null;
    // Cleared with the rest: a tombstone that outlived its session would block
    // the next visitor from ever stating that preference, and a stale revision
    // would stop the profile being re-seeded after the reset that just wiped it.
    this.forgotten = new Map();
    this.profileRevision = 0;
  }

  /**
   * True while at least one preference came from a visitor profile (the
   * `prf_` id prefix) rather than from the conversation. The planner prompt
   * gains a section when this holds — a study session never loads a profile,
   * so its prompt is untouched.
   */
  hasProfilePreferences(): boolean {
    return this.preferences.some((item) => isProfilePreferenceId(item.id));
  }

  getPreferences(): Preference[] {
    return this.preferences.map((item) => ({
      ...item,
      relevantStages: item.relevantStages.slice(),
    }));
  }

  getDeadEnds(): DeadEnd[] {
    return this.deadEnds.map((item) => ({
      ...item,
      preferenceIds: item.preferenceIds.slice(),
      scope: { ...item.scope },
    }));
  }

  /**
   * The filters and highlights currently in force, each carrying the preference
   * ids that justified it. Only stages that actually carry an adaptation are
   * returned — an untouched stage has nothing to explain.
   */
  getStageBindings(): StageBinding[] {
    return Array.from(this.stageAlternatives.values())
      .filter((record) => record.filters.length > 0 || record.highlight !== null)
      .map((record) => ({
        stage: record.stage,
        parentContextKey: record.parentContextKey,
        filters: record.filters.map((trace) => ({
          field: trace.filter.field,
          operator: trace.filter.operator,
          value: trace.filter.value,
          preferenceIds: trace.preferenceBindings.map((binding) => binding.id),
        })),
        highlight: record.highlight
          ? {
              itemIds: record.highlight.itemIds.slice(),
              coverage: record.highlight.coverage,
              preferenceIds: record.highlight.preferenceBindings.map((binding) => binding.id),
            }
          : null,
        updatedAt: record.updatedAt,
      }));
  }

  private cloneWorkflowValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? { ...(entry as Record<string, unknown>) }
          : entry
      );
    }
    if (typeof value === 'object' && value !== null) {
      return { ...(value as Record<string, unknown>) };
    }
    return value;
  }

  private getWorkflowStateKey(stage: WorkflowStage): 'movie' | 'theater' | 'date' | 'showing' | 'seats' {
    switch (stage) {
      case 'movie':
        return 'movie';
      case 'theater':
        return 'theater';
      case 'date':
        return 'date';
      case 'time':
        return 'showing';
      case 'seat':
        return 'seats';
      case 'confirm':
        return 'seats';
    }
  }

  getCommittedWorkflowState(): Record<string, unknown> | null {
    if (!this.committedWorkflowState) return null;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.committedWorkflowState)) {
      copy[key] = this.cloneWorkflowValue(value);
    }
    return copy;
  }

  commitWorkflowSelection(stage: WorkflowStage, selection: unknown): void {
    const key = this.getWorkflowStateKey(stage);
    const nextState = this.getCommittedWorkflowState() ?? {};
    nextState[key] = this.cloneWorkflowValue(selection);
    this.committedWorkflowState = nextState;
  }

  clearCommittedWorkflowAfter(stage: WorkflowStage): void {
    if (!this.committedWorkflowState) return;
    const nextState = this.getCommittedWorkflowState() ?? {};
    switch (stage) {
      case 'movie':
        delete nextState.theater;
        delete nextState.date;
        delete nextState.showing;
        delete nextState.seats;
        break;
      case 'theater':
        delete nextState.date;
        delete nextState.showing;
        delete nextState.seats;
        break;
      case 'date':
        delete nextState.showing;
        delete nextState.seats;
        break;
      case 'time':
        delete nextState.seats;
        break;
      case 'seat':
      case 'confirm':
        break;
    }
    this.committedWorkflowState = Object.keys(nextState).length > 0 ? nextState : null;
  }

  clearCommittedWorkflow(): void {
    this.committedWorkflowState = null;
  }

  private buildAttemptedBranchKey(stage: string, parentContextKey: string, itemId: string): string {
    return `${stage}|${parentContextKey}|${itemId}`;
  }

  recordAttemptedBranch(branch: AttemptedBranch): void {
    const stage = branch.stage;
    const parentContextKey = branch.parentContextKey.trim();
    const itemId = branch.itemId.trim();
    if (!parentContextKey || !itemId) return;
    const key = this.buildAttemptedBranchKey(stage, parentContextKey, itemId);
    if (this.attemptedBranches.has(key)) return;
    this.attemptedBranches.set(key, {
      ...branch,
      parentContextKey,
      itemId,
    });
  }

  getAttemptedBranches(): AttemptedBranch[] {
    return Array.from(this.attemptedBranches.values()).map((item) => ({ ...item }));
  }

  getAttemptedBranchesFor(stage: string, parentContextKey: string): AttemptedBranch[] {
    return Array.from(this.attemptedBranches.values())
      .filter((item) => item.stage === stage && item.parentContextKey === parentContextKey)
      .map((item) => ({ ...item }));
  }

  private buildStageAlternativeKey(stage: string, parentContextKey: string): string {
    return `${stage}|${parentContextKey}`;
  }

  upsertStageAlternativeSnapshot(
    snapshot: Omit<StageAlternativeMemory, 'filters' | 'highlight' | 'updatedAt'>,
    timestamp: string
  ): void {
    const key = this.buildStageAlternativeKey(snapshot.stage, snapshot.parentContextKey);
    const existing = this.stageAlternatives.get(key);
    this.stageAlternatives.set(key, {
      ...(existing ?? { filters: [], highlight: null }),
      ...snapshot,
      items: snapshot.items.map((item) => ({ ...item })),
      filters: existing?.filters ?? [],
      highlight: existing?.highlight ?? null,
      updatedAt: timestamp,
    });
  }

  recordStageFilter(
    snapshot: Omit<StageAlternativeMemory, 'filters' | 'highlight' | 'updatedAt'>,
    trace: Omit<AlternativeFilterTrace, 'createdAt'>,
    timestamp: string
  ): void {
    const key = this.buildStageAlternativeKey(snapshot.stage, snapshot.parentContextKey);
    const existing = this.stageAlternatives.get(key);
    const filterSignature = JSON.stringify(trace.filter);
    const nextTrace: AlternativeFilterTrace = {
      ...trace,
      createdAt: timestamp,
    };

    if (!existing) {
      this.stageAlternatives.set(key, {
        ...snapshot,
        items: snapshot.items.map((item) => ({ ...item })),
        filters: [nextTrace],
        highlight: null,
        updatedAt: timestamp,
      });
      return;
    }

    const nextFilters = existing.filters.filter(
      (entry) => JSON.stringify(entry.filter) !== filterSignature
    );
    nextFilters.push(nextTrace);
    this.stageAlternatives.set(key, {
      ...existing,
      valueField: snapshot.valueField,
      items: snapshot.items.map((item) => ({ ...item })),
      filters: nextFilters,
      highlight: null,
      updatedAt: timestamp,
    });
  }

  recordStageHighlight(
    snapshot: Omit<StageAlternativeMemory, 'filters' | 'highlight' | 'updatedAt'>,
    trace: Omit<AlternativeHighlightTrace, 'createdAt'>,
    timestamp: string
  ): void {
    const key = this.buildStageAlternativeKey(snapshot.stage, snapshot.parentContextKey);
    const nextTrace: AlternativeHighlightTrace = {
      ...trace,
      itemIds: Array.from(new Set(trace.itemIds.map((item) => item.trim()).filter(Boolean))),
      createdAt: timestamp,
    };
    this.stageAlternatives.set(key, {
      ...(this.stageAlternatives.get(key) ?? { filters: [] }),
      ...snapshot,
      items: snapshot.items.map((item) => ({ ...item })),
      filters: this.stageAlternatives.get(key)?.filters ?? [],
      highlight: nextTrace,
      updatedAt: timestamp,
    });
  }

  clearStageFilters(stage: string, parentContextKey: string): void {
    const key = this.buildStageAlternativeKey(stage, parentContextKey);
    const existing = this.stageAlternatives.get(key);
    if (!existing) return;
    this.stageAlternatives.set(key, {
      ...existing,
      filters: [],
    });
  }

  clearStageHighlight(stage: string, parentContextKey: string): void {
    const key = this.buildStageAlternativeKey(stage, parentContextKey);
    const existing = this.stageAlternatives.get(key);
    if (!existing) return;
    this.stageAlternatives.set(key, {
      ...existing,
      highlight: null,
    });
  }

  getStageAlternativeItems(stage: string, parentContextKey: string): Record<string, unknown>[] | null {
    const key = this.buildStageAlternativeKey(stage, parentContextKey);
    const record = this.stageAlternatives.get(key);
    if (!record) return null;
    return record.items;
  }

  getStageAlternativeCount(stage: string, parentContextKey: string, excludeItemIds?: Set<string>): number | null {
    const key = this.buildStageAlternativeKey(stage, parentContextKey);
    const record = this.stageAlternatives.get(key);
    if (!record) return null;
    const items = excludeItemIds && excludeItemIds.size > 0
      ? record.items.filter((item) => {
          const id = typeof item.id === 'string' ? item.id : null;
          return !id || !excludeItemIds.has(id);
        })
      : record.items;
    // How many options this stage still HAS — used by the planner to pick a
    // backtrack target. Only a hard requirement removes an option from the
    // stage; a soft one reorders or highlights, and a highlight of any kind is
    // a display act that says nothing about inventory.
    //
    // Previously a `coverage: 'full'` highlight was read as the stage's whole
    // inventory, so highlighting the single matching theater and then selecting
    // it left the stage reporting 0 alternatives while four theaters remained.
    // 81.9% of turns following a full/1 highlight reported zero, against 5.5%
    // with no highlight. Soft-bound highlights were the larger share of that.
    const hardFilters = record.filters.filter(
      (entry) =>
        entry.preferenceBindings.length > 0 &&
        entry.preferenceBindings.every((binding) => binding.strength === 'hard')
    );
    if (hardFilters.length > 0) {
      return countSelectableFilteredItems(
        items,
        hardFilters.map((entry) => entry.filter),
        record.valueField
      );
    }
    return countSelectableFilteredItems(
      items,
      [],
      record.valueField
    );
  }

  /**
   * The preferences the hard-bound filters at this stage were applied for —
   * the ones `getStageAlternativeCount` actually applied. A hard preference
   * relevant to the stage that is not in this list was never turned into a
   * filter (a day the visitor named and the planner simply selected), so the
   * count says nothing about it.
   */
  getStageHardFilterPreferenceIds(stage: string, parentContextKey: string): string[] {
    const record = this.stageAlternatives.get(this.buildStageAlternativeKey(stage, parentContextKey));
    if (!record) return [];
    const ids = new Set<string>();
    for (const entry of record.filters) {
      if (entry.preferenceBindings.length === 0) continue;
      if (!entry.preferenceBindings.every((binding) => binding.strength === 'hard')) continue;
      for (const binding of entry.preferenceBindings) ids.add(binding.id);
    }
    return Array.from(ids);
  }

  getPreferenceBindings(ids: string[]): PreferenceBinding[] {
    const preferencesById = new Map(this.preferences.map((item) => [item.id, item]));
    return Array.from(new Set(ids.map((item) => item.trim()).filter(Boolean)))
      .map((id) => {
        const preference = preferencesById.get(id);
        if (!preference) return null;
        return { id, strength: preference.strength } satisfies PreferenceBinding;
      })
      .filter((item): item is PreferenceBinding => item !== null);
  }

  setPreferences(items: Preference[]): void {
    this.preferences = this.rejectForgotten(normalizePreferenceList(items));
    this.reconcileAdaptations();
  }

  /**
   * Drops anything the visitor removed by hand.
   *
   * Blocks on the id AND on the folded description, because a removed
   * preference has three ways back and they do not all keep the id:
   *   1. the extractor reporting no update returns the list it was handed —
   *      the pre-call snapshot — with the original id intact;
   *   2. the hard carry-forward reinstates any hard preference the model
   *      neither restated nor retracted, also with the original id;
   *   3. the model re-emitting the same sentence gets a NEWLY MINTED id,
   *      because description matching only ever looks at the surviving list.
   * The id covers the first two; the description key covers the third.
   */
  private rejectForgotten(items: Preference[]): Preference[] {
    if (this.forgotten.size === 0) return items;
    const blockedDescriptions = new Set(
      Array.from(this.forgotten.values(), (entry) => entry.descriptionKey)
    );
    return items.filter(
      (item) =>
        !this.forgotten.has(item.id) &&
        !blockedDescriptions.has(preferenceDescriptionKey(item.description))
    );
  }

  /**
   * Re-checks every stored adaptation against the current preference list,
   * drops what no longer holds, and RETURNS what it dropped.
   *
   * The retention predicates use `every`, so a trace dies the moment any one of
   * its bindings breaks — not when the last one does. Reading it the other way
   * would leave the booking screen filtered by a requirement that no longer
   * exists while `getStageAlternativeCount` fell through to the full inventory,
   * which is exactly the divergence the revocation channel exists to close.
   *
   * Idempotent: once a trace is dropped it can never be reported again.
   */
  reconcileAdaptations(): RevokedAdaptation[] {
    const preferencesById = new Map(this.preferences.map((item) => [item.id, item]));
    this.deadEnds = this.deadEnds.filter((item) => shouldRetainDeadEnd(item, preferencesById));

    const revoked: RevokedAdaptation[] = [];
    const nextStageAlternatives = new Map<string, StageAlternativeMemory>();
    for (const [key, record] of this.stageAlternatives.entries()) {
      const droppedFilters: FilterExpression[] = [];
      const filters = record.filters.filter((trace) => {
        if (shouldRetainAlternativeFilter(record.stage, trace, preferencesById)) return true;
        droppedFilters.push({ ...trace.filter });
        return false;
      });
      const keepHighlight = shouldRetainAlternativeHighlight(
        record.stage,
        record.highlight,
        preferencesById
      );
      const clearHighlight = record.highlight !== null && !keepHighlight;
      if (droppedFilters.length > 0 || clearHighlight) {
        revoked.push({ stage: record.stage, filters: droppedFilters, clearHighlight });
      }
      nextStageAlternatives.set(key, {
        ...record,
        filters,
        highlight: keepHighlight ? record.highlight : null,
      });
    }
    this.stageAlternatives = nextStageAlternatives;
    return revoked;
  }

  /**
   * Removes one preference on the visitor's instruction and reports the GUI
   * adaptations that just lost their justification.
   *
   * Dead ends naming the removed preference go with it. A dead end is a fact
   * relative to a constraint — "no showing satisfies both of these" — so once
   * the constraint is deliberately withdrawn the conclusion no longer holds,
   * and leaving it would keep blacklisting options for a reason the visitor
   * just cancelled. Note this is narrower than the retention rule in
   * `shouldRetainDeadEnd`, which stays exactly as it is for extractor churn:
   * only a deliberate removal forces the issue.
   */
  forgetPreference(id: string, timestamp: string): {
    removed: Preference | null;
    revoked: RevokedAdaptation[];
  } {
    const target = this.preferences.find((item) => item.id === id.trim());
    if (!target) return { removed: null, revoked: [] };

    const removed: Preference = { ...target, relevantStages: target.relevantStages.slice() };
    this.forgotten.set(removed.id, {
      preference: removed,
      descriptionKey: preferenceDescriptionKey(removed.description),
      removedAt: timestamp,
    });
    this.preferences = this.preferences.filter((item) => item.id !== removed.id);
    this.deadEnds = this.deadEnds.filter((item) => !item.preferenceIds.includes(removed.id));
    return { removed, revoked: this.reconcileAdaptations() };
  }

  /**
   * Withdraws every preference at once, for a presenter clearing the memory
   * between visitors.
   *
   * Built out of `forgetPreference` rather than emptying the list, so a bulk
   * clear cannot drift from a single removal: each entry still gets its
   * tombstone, each is still individually restorable, and the dead ends that
   * named it still go with it.
   */
  forgetAllPreferences(timestamp: string): {
    removed: Preference[];
    revoked: RevokedAdaptation[];
  } {
    const removed: Preference[] = [];
    const revoked: RevokedAdaptation[] = [];
    for (const id of this.preferences.map((item) => item.id)) {
      const result = this.forgetPreference(id, timestamp);
      if (result.removed) removed.push(result.removed);
      revoked.push(...result.revoked);
    }
    return { removed, revoked };
  }

  /**
   * Puts one back, id and all.
   *
   * Restoring by re-adding the words would mint a new id, and everything that
   * referenced the preference — dead ends, filter traces, conflict references —
   * is keyed on the old one. Deleting the ledger entry lifts the id block and
   * the description block together, which is what lets the visitor state it
   * again afterwards.
   */
  restorePreference(id: string): Preference | null {
    const entry = this.forgotten.get(id.trim());
    if (!entry) return null;
    this.forgotten.delete(entry.preference.id);
    this.preferences = normalizePreferenceList([...this.preferences, entry.preference]);
    return entry.preference;
  }

  getForgottenPreferences(): Preference[] {
    return Array.from(this.forgotten.values())
      .sort((a, b) => a.removedAt.localeCompare(b.removedAt))
      .map((entry) => ({
        ...entry.preference,
        relevantStages: entry.preference.relevantStages.slice(),
      }));
  }

  /**
   * Seeds memory from a host-owned profile, so a session can open with
   * preferences already in it.
   *
   * Reports `applied: false` for a revision already applied, which is what
   * makes the ride-along payload safe to attach to every snapshot: the seed
   * lands once per revision and a re-sent snapshot cannot undo a removal made
   * since.
   *
   * `revoked` matters when one profile REPLACES another — switching presets
   * drops the first one's preferences, and any GUI adaptation they were holding
   * up has to come off the screen with them.
   *
   * Merges by id rather than concatenating, because `normalizePreferenceList`
   * UNIONS `relevantStages` across entries sharing an id — appending the
   * profile to the live list would quietly widen a preference back to every
   * stage it had ever been scoped to.
   */
  applyPreferenceProfile(payload: PreferenceProfilePayload): {
    applied: boolean;
    revoked: RevokedAdaptation[];
  } {
    if (payload.revision <= this.profileRevision) return { applied: false, revoked: [] };
    this.profileRevision = payload.revision;

    const seeded = normalizePreferenceList(payload.preferences);
    const seededIds = new Set(seeded.map((item) => item.id));

    // A new revision is an operator saying "this is the memory now", so it
    // outranks any tombstone covering what it seeds. Without this, loading a
    // preset a second time would come back short by whatever the previous
    // visitor happened to remove from it — and silently, since the write-time
    // filter reports nothing.
    for (const item of seeded) {
      const descriptionKey = preferenceDescriptionKey(item.description);
      for (const [id, entry] of this.forgotten.entries()) {
        if (id === item.id || entry.descriptionKey === descriptionKey) {
          this.forgotten.delete(id);
        }
      }
    }
    // Profile-origin entries are REPLACED wholesale, not merged: switching from
    // one preset to another has to drop the first one's preferences, and they
    // are only identifiable by their id prefix. Anything the conversation
    // produced is left alone.
    const kept = this.preferences.filter(
      (item) => !seededIds.has(item.id) && !isProfilePreferenceId(item.id)
    );
    this.preferences = this.rejectForgotten(normalizePreferenceList([...seeded, ...kept]));
    return { applied: true, revoked: this.reconcileAdaptations() };
  }

  upsertDeadEnds(items: DeadEnd[]): void {
    const incoming = normalizeDeadEnds(items);
    if (incoming.length === 0) return;

    const byId = new Map<string, DeadEnd>(this.deadEnds.map((item) => [item.id, item]));
    for (const next of incoming) {
      const existing = byId.get(next.id);
      if (!existing) {
        byId.set(next.id, next);
        continue;
      }
      byId.set(next.id, {
        ...existing,
        lastSeenAt: next.lastSeenAt,
        count: existing.count + next.count,
      });
    }
    const preferencesById = new Map(this.preferences.map((item) => [item.id, item]));
    this.deadEnds = Array.from(byId.values())
      .filter((item) => shouldRetainDeadEnd(item, preferencesById))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  setContext(context: PerceivedContext): void {
    this.context = context;
  }

  getContext(): PerceivedContext | null {
    return this.context;
  }

  addRecord(record: EpisodicRecord): void {
    this.episodic.push(record);
    if (this.episodic.length > MAX_EPISODIC_RECORDS) {
      this.episodic = this.episodic.slice(-MAX_EPISODIC_RECORDS);
    }
  }

  getRecentRecords(windowSize = 10): EpisodicRecord[] {
    return this.episodic.slice(-windowSize);
  }
  countRecentFailures(stage: string | null, windowSize = 8): number {
    return this.episodic
      .slice(-windowSize)
      .filter((entry) => entry.stage === stage && !entry.ok && !INFRA_ERROR_CODES.has(entry.code ?? ''))
      .length;
  }
}
