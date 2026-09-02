/**
 * Modifier Functions
 *
 * Deterministic 함수들 - 같은 입력 → 같은 출력
 * UISpec의 state와 modification을 업데이트하는 pure functions
 */

import type {
  UISpec,
  DataItem,
  DisplayItem,
  FilterState,
  FilterOperator,
  SortState,
  HighlightState,
  AugmentState,
} from './types';
import { parseDurationToMinutes, parseTimeToMinutes } from '../utils/displayFormats';

function normalizeFilters(filters: FilterState | FilterState[] | undefined): FilterState[] {
  if (!filters) return [];
  return Array.isArray(filters) ? filters : [filters];
}

function getItemFieldValue<T extends DataItem>(
  item: T,
  field: string,
  valueField: string
): unknown {
  if (field === 'value') {
    return item[valueField];
  }
  return item[field];
}

const MINUTES_PER_DAY = 1440;

/**
 * `endTime` wraps past midnight — `addEndTimeToItems` computes it with `% 24`,
 * so a 10:00 PM screening of a 2h04m film ends at "00:04". Compared as a plain
 * clock time that lands *before* every evening showing, which is how a
 * "ends by 10 PM" filter (`endTime lte 22:00`) used to leave a 12:04 AM finish
 * on screen.
 *
 * The rule: an end time belongs to the next day iff it is earlier than the
 * item's own start `time`, and then it counts as minutes + one full day, so it
 * sorts and compares after 23:59. Filter values carry no start time of their
 * own and so never wrap — "22:00" always means 22:00 today.
 */
function getEndTimeComparable(rawValue: unknown, item?: DataItem): unknown {
  const endMinutes = parseTimeToMinutes(rawValue);
  if (endMinutes === null) return rawValue;
  if (!item) return endMinutes;

  const startMinutes = parseTimeToMinutes(item.time);
  if (startMinutes === null) return endMinutes;
  return endMinutes < startMinutes ? endMinutes + MINUTES_PER_DAY : endMinutes;
}

function getComparableValue(
  field: string,
  rawValue: unknown,
  valueField: string,
  item?: DataItem
): unknown {
  const effectiveField = field === 'value' ? valueField : field;

  if (effectiveField === 'rating') {
    const parsed = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue));
    return Number.isFinite(parsed) ? parsed : rawValue;
  }

  if (effectiveField === 'duration') {
    return parseDurationToMinutes(rawValue) ?? rawValue;
  }

  if (effectiveField === 'time') {
    return parseTimeToMinutes(rawValue) ?? rawValue;
  }

  if (effectiveField === 'endTime') {
    return getEndTimeComparable(rawValue, item);
  }

  return rawValue;
}

function areFilterValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasSameFilter(existing: FilterState[], next: FilterState): boolean {
  return existing.some(
    (filter) =>
      filter.field === next.field &&
      filter.operator === next.operator &&
      areFilterValuesEqual(filter.value, next.value)
  );
}

/** Operators that pin a field to a value: a second one contradicts the first. */
const EXACT_VALUE_OPERATORS = new Set<FilterOperator>(['eq', 'contains', 'in']);
const LOWER_BOUND_OPERATORS = new Set<FilterOperator>(['gt', 'gte']);
const UPPER_BOUND_OPERATORS = new Set<FilterOperator>(['lt', 'lte']);

/**
 * Does `next` replace `existing` rather than stack on top of it?
 *
 * Filters used to be appended unconditionally, so a second constraint on the
 * same field was ANDed with the first even when it contradicted it. Across the
 * study that drove 495 stage states in 77 sessions down to one visible option
 * or none, with no participant-facing way to undo it.
 *
 * Ranges must still compose — `time >= 16:00` AND `time <= 22:00` is one
 * interval — so only genuinely competing constraints replace: a new exact value
 * supersedes an old exact value, a new lower bound supersedes the old lower
 * bound, and a new upper bound supersedes the old upper bound. `neq` always
 * accumulates, since excluding several values at once is meaningful.
 */
function filterSupersedes(existing: FilterState, next: FilterState): boolean {
  if (existing.field !== next.field) return false;
  if (existing.operator === 'neq' || next.operator === 'neq') return false;
  if (EXACT_VALUE_OPERATORS.has(next.operator)) {
    return EXACT_VALUE_OPERATORS.has(existing.operator);
  }
  if (LOWER_BOUND_OPERATORS.has(next.operator)) {
    return LOWER_BOUND_OPERATORS.has(existing.operator);
  }
  if (UPPER_BOUND_OPERATORS.has(next.operator)) {
    return UPPER_BOUND_OPERATORS.has(existing.operator);
  }
  return false;
}

// =============================================================================
// Visible Items Computation
// =============================================================================

/**
 * items + modification → visibleItems 계산
 */
export function computeDisplayItems<T extends DataItem>(
  spec: UISpec<T>,
  options?: { ignoreFilter?: boolean }
): DisplayItem[] {
  const { items, modification, display } = spec;
  const valueField = display.valueField;
  const ignoreFilter = options?.ignoreFilter ?? false;

  // 1. Filter 적용
  let filteredItems = [...items];
  if (!ignoreFilter) {
    const filters = normalizeFilters(modification.filter);
    for (const filter of filters) {
      filteredItems = applyFilterLogic(filteredItems, filter, valueField);
    }
  }

  // 2. Sort 적용
  if (modification.sort) {
    filteredItems = applySortLogic(filteredItems, modification.sort, valueField);
  }

  // 3. Augment 맵 생성
  const augmentMap = new Map<string, AugmentState>();
  if (modification.augment) {
    modification.augment.forEach((a) => augmentMap.set(a.itemId, a));
  }

  // 4. DisplayItem 생성
  return filteredItems.map((item) => {
    let value = String(item[valueField] ?? item.id);

    // Augment 적용 - value 직접 교체
    const augment = augmentMap.get(item.id);
    if (augment) {
      value = augment.value;
    }

    const displayItem: DisplayItem = { id: item.id, value };

    // Disabled 상태
    if ('status' in item && typeof item.status === 'string' && item.status !== 'available') {
      displayItem.isDisabled = true;
    }
    if ('available' in item && item.available === false) {
      displayItem.isDisabled = true;
    }

    return displayItem;
  });
}

export function computeVisibleItems<T extends DataItem>(
  spec: UISpec<T>
): DisplayItem[] {
  return computeDisplayItems(spec);
}

/**
 * ID → DisplayItem 맵 생성 헬퍼
 */
function createDisplayItemMap<T extends DataItem>(
  spec: UISpec<T>,
  visibleItems: DisplayItem[]
): Map<string, DisplayItem> {
  const map = new Map<string, DisplayItem>();
  const valueField = spec.display.valueField;

  visibleItems.forEach((item) => map.set(item.id, item));

  // visibleItems에 없는 아이템은 원본에서 생성
  spec.items.forEach((item) => {
    if (!map.has(item.id)) {
      map.set(item.id, {
        id: item.id,
        value: String(item[valueField] ?? item.id),
      });
    }
  });

  return map;
}

function findSelectableDisplayItem<T extends DataItem>(
  spec: UISpec<T>,
  itemId: string
): DisplayItem | undefined {
  const item = spec.visibleItems.find((visible) => visible.id === itemId);
  if (!item || item.isDisabled) return undefined;
  return item;
}

/**
 * modification.highlight → state.highlighted 동기화
 */
function syncHighlighted<T extends DataItem>(
  spec: UISpec<T>,
  visibleItems: DisplayItem[]
): DisplayItem[] | undefined {
  const highlightIds = spec.modification.highlight?.itemIds;
  if (!highlightIds || highlightIds.length === 0) return undefined;

  const map = createDisplayItemMap(spec, visibleItems);
  return highlightIds
    .map((id) => map.get(id))
    .filter((item): item is DisplayItem => item !== undefined);
}

/**
 * Spec 업데이트 후 visibleItems 재계산 및 highlighted 동기화
 */
export function refreshSpec<T extends DataItem>(spec: UISpec<T>): UISpec<T> {
  const visibleItems = computeVisibleItems(spec);
  const highlighted = syncHighlighted(spec, visibleItems);

  return {
    ...spec,
    visibleItems,
    state: {
      ...spec.state,
      highlighted,
    },
  };
}

/**
 * @deprecated Use refreshSpec instead
 */
export function refreshVisibleItems<T extends DataItem>(
  spec: UISpec<T>
): UISpec<T> {
  return refreshSpec(spec);
}

// =============================================================================
// Selection Functions
// =============================================================================

/**
 * 단일 아이템 선택
 */
export function selectItem<T extends DataItem>(
  spec: UISpec<T>,
  itemId: string
): UISpec<T> {
  const displayItem = findSelectableDisplayItem(spec, itemId);
  if (!displayItem) return spec;

  return {
    ...spec,
    state: {
      ...spec.state,
      selected: displayItem,
    },
  };
}

/**
 * 다중 아이템 선택
 */
export function selectItems<T extends DataItem>(
  spec: UISpec<T>,
  itemIds: string[]
): UISpec<T> {
  const selectedList = itemIds
    .map((id) => findSelectableDisplayItem(spec, id))
    .filter((item): item is DisplayItem => item !== undefined);

  return {
    ...spec,
    state: {
      ...spec.state,
      selectedList,
    },
  };
}

/**
 * 아이템 선택 토글 (다중 선택용)
 */
export function toggleItem<T extends DataItem>(
  spec: UISpec<T>,
  itemId: string
): UISpec<T> {
  const currentList = spec.state.selectedList ?? [];
  const currentIds = currentList.map((item) => item.id);

  const newIds = currentIds.includes(itemId)
    ? currentIds.filter((id) => id !== itemId)
    : [...currentIds, itemId];

  return selectItems(spec, newIds);
}

// =============================================================================
// Modification Functions
// =============================================================================

/**
 * Filter 적용
 */
export function applyFilter<T extends DataItem>(
  spec: UISpec<T>,
  params: FilterState
): UISpec<T> {
  const existingFilters = normalizeFilters(spec.modification.filter);
  const nextFilters = hasSameFilter(existingFilters, params)
    ? existingFilters
    : [...existingFilters.filter((filter) => !filterSupersedes(filter, params)), params];
  const newSpec = {
    ...spec,
    modification: { ...spec.modification, filter: nextFilters },
  };
  return refreshSpec(newSpec);
}

/**
 * Sort 적용
 */
export function applySort<T extends DataItem>(
  spec: UISpec<T>,
  params: SortState
): UISpec<T> {
  const newSpec = {
    ...spec,
    modification: { ...spec.modification, sort: params },
  };
  return refreshSpec(newSpec);
}

/**
 * Highlight 적용
 */
export function applyHighlight<T extends DataItem>(
  spec: UISpec<T>,
  params: HighlightState
): UISpec<T> {
  const highlight: HighlightState = { itemIds: params.itemIds };
  const newSpec = {
    ...spec,
    modification: { ...spec.modification, highlight },
  };
  return refreshSpec(newSpec);
}

/**
 * Augment 적용
 */
export function applyAugment<T extends DataItem>(
  spec: UISpec<T>,
  params: AugmentState[],
  replace = false
): UISpec<T> {
  const existingAugment = spec.modification.augment ?? [];
  const newAugment = replace ? params : [...existingAugment, ...params];

  const newSpec = {
    ...spec,
    modification: { ...spec.modification, augment: newAugment },
  };
  return refreshSpec(newSpec);
}

/**
 * Modification 초기화
 */
export function clearModification<T extends DataItem>(
  spec: UISpec<T>,
  type?: 'filter' | 'sort' | 'highlight' | 'augment' | 'all'
): UISpec<T> {
  let newSpec: UISpec<T>;

  if (type === 'all' || !type) {
    newSpec = { ...spec, modification: {} };
  } else {
    const newModification = { ...spec.modification };
    delete newModification[type];
    newSpec = { ...spec, modification: newModification };
  }

  return refreshSpec(newSpec);
}

/**
 * Removes the filters a predicate names, leaving the rest of the modification
 * alone.
 *
 * Used when the agent withdraws an adaptation because the preference behind it
 * is gone. `clearModification('filter')` is the wrong tool there: it would also
 * drop the filters that other, still-live preferences are holding up.
 */
export function pruneFilters<T extends DataItem>(
  spec: UISpec<T>,
  shouldRemove: (filter: FilterState) => boolean
): UISpec<T> {
  const filters = normalizeFilters(spec.modification.filter);
  if (filters.length === 0) return spec;

  const remaining = filters.filter((filter) => !shouldRemove(filter));
  if (remaining.length === filters.length) return spec;

  const modification = { ...spec.modification };
  if (remaining.length === 0) {
    delete modification.filter;
  } else {
    modification.filter = remaining;
  }
  return refreshSpec({ ...spec, modification });
}

/** Drops the highlight, leaving filters and sorting in place. */
export function clearHighlight<T extends DataItem>(spec: UISpec<T>): UISpec<T> {
  if (!spec.modification.highlight) return spec;
  const modification = { ...spec.modification };
  delete modification.highlight;
  return refreshSpec({ ...spec, modification });
}

// =============================================================================
// Internal Logic Functions
// =============================================================================

function applyFilterLogic<T extends DataItem>(
  items: T[],
  filter: FilterState,
  valueField: string
): T[] {
  const { field, operator, value } = filter;

  return items.filter((item) => {
    const itemValue = getItemFieldValue(item, field, valueField);
    const comparableItemValue = getComparableValue(field, itemValue, valueField, item);
    const comparableFilterValue = getComparableValue(field, value, valueField);

    switch (operator) {
      case 'eq':
        return itemValue === value;
      case 'neq':
        return itemValue !== value;
      case 'contains':
        if (Array.isArray(itemValue)) {
          return itemValue.includes(value);
        }
        return String(itemValue).includes(String(value));
      case 'gt':
        if (typeof comparableItemValue === 'number' && typeof comparableFilterValue === 'number') {
          return comparableItemValue > comparableFilterValue;
        }
        return String(comparableItemValue).localeCompare(String(comparableFilterValue)) > 0;
      case 'lt':
        if (typeof comparableItemValue === 'number' && typeof comparableFilterValue === 'number') {
          return comparableItemValue < comparableFilterValue;
        }
        return String(comparableItemValue).localeCompare(String(comparableFilterValue)) < 0;
      case 'gte':
        if (typeof comparableItemValue === 'number' && typeof comparableFilterValue === 'number') {
          return comparableItemValue >= comparableFilterValue;
        }
        return String(comparableItemValue).localeCompare(String(comparableFilterValue)) >= 0;
      case 'lte':
        if (typeof comparableItemValue === 'number' && typeof comparableFilterValue === 'number') {
          return comparableItemValue <= comparableFilterValue;
        }
        return String(comparableItemValue).localeCompare(String(comparableFilterValue)) <= 0;
      case 'in':
        return Array.isArray(value) && value.includes(itemValue);
      default:
        return true;
    }
  });
}

function applySortLogic<T extends DataItem>(
  items: T[],
  sort: SortState,
  valueField: string
): T[] {
  const { field, order } = sort;

  return [...items].sort((a, b) => {
    const aVal = getItemFieldValue(a, field, valueField);
    const bVal = getItemFieldValue(b, field, valueField);
    const comparableAVal = getComparableValue(field, aVal, valueField, a);
    const comparableBVal = getComparableValue(field, bVal, valueField, b);

    let comparison: number;
    if (typeof comparableAVal === 'number' && typeof comparableBVal === 'number') {
      comparison = comparableAVal - comparableBVal;
    } else if (typeof comparableAVal === 'string' && typeof comparableBVal === 'string') {
      comparison = comparableAVal.localeCompare(comparableBVal);
    } else {
      comparison = String(comparableAVal).localeCompare(String(comparableBVal));
    }

    return order === 'asc' ? comparison : -comparison;
  });
}

// =============================================================================
// Legacy Support
// =============================================================================

/**
 * @deprecated Use computeVisibleItems instead
 */
export function getVisibleItems<T extends DataItem>(
  spec: UISpec<T>
): DisplayItem[] {
  return computeVisibleItems(spec);
}
