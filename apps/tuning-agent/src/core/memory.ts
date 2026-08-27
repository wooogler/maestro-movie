import {
  normalizeDeadEnds,
  normalizePreferenceList,
} from './cpMemory';
import { countSelectableFilteredItems } from './filterSimulation';
import type {
  AlternativeFilterTrace,
  AlternativeHighlightTrace,
  AttemptedBranch,
  DeadEnd,
  EpisodicRecord,
  PerceivedContext,
  PreferenceBinding,
  Preference,
  StageAlternativeMemory,
  StageBinding,
} from '../types';
import type { WorkflowStage } from './workflowState';

const MAX_EPISODIC_RECORDS = 200;
const INFRA_ERROR_CODES = new Set(['SESSION_NOT_ACTIVE', 'RELAY_ERROR']);

function shouldRetainDeadEnd(deadEnd: DeadEnd, preferencesById: ReadonlyMap<string, Preference>): boolean {
  if (deadEnd.preferenceIds.length === 0) return true;
  return deadEnd.preferenceIds.every((id) => {
    const preference = preferencesById.get(id);
    return (
      preference !== undefined &&
      preference.strength === 'hard' &&
      preference.relevantStages.includes(deadEnd.scope.stage)
    );
  });
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

  reset(): void {
    this.context = null;
    this.episodic = [];
    this.preferences = [];
    this.deadEnds = [];
    this.attemptedBranches = new Map();
    this.stageAlternatives = new Map();
    this.committedWorkflowState = null;
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
    if (record.filters.length > 0) {
      return countSelectableFilteredItems(
        items,
        record.filters.map((entry) => entry.filter),
        record.valueField
      );
    }
    if (record.highlight && record.highlight.coverage === 'full') {
      return countSelectableHighlightItems(items, record.highlight.itemIds);
    }
    return countSelectableFilteredItems(
      items,
      [],
      record.valueField
    );
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
    this.preferences = normalizePreferenceList(items);
    const preferencesById = new Map(this.preferences.map((item) => [item.id, item]));
    this.deadEnds = this.deadEnds.filter((item) => shouldRetainDeadEnd(item, preferencesById));

    const nextStageAlternatives = new Map<string, StageAlternativeMemory>();
    for (const [key, record] of this.stageAlternatives.entries()) {
      const filters = record.filters.filter((trace) =>
        shouldRetainAlternativeFilter(record.stage, trace, preferencesById)
      );
      const highlight = shouldRetainAlternativeHighlight(record.stage, record.highlight, preferencesById)
        ? record.highlight
        : null;
      nextStageAlternatives.set(key, {
        ...record,
        filters,
        highlight,
      });
    }
    this.stageAlternatives = nextStageAlternatives;
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
