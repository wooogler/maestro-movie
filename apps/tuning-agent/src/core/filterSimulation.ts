import type { FilterExpression } from '../types';
import { parseDurationMinutes } from './timeUtils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    return hours * 60 + minutes;
  }

  // End times are surfaced to the planner as "12:04 AM" too, so a filter value
  // may come back written that way; accept it rather than fall through to a
  // string compare.
  const twelveHour = trimmed.match(/^(1[0-2]|[1-9]):([0-5]\d)\s*([AaPp][Mm])$/);
  if (!twelveHour) return null;
  const hours12 = Number.parseInt(twelveHour[1], 10) % 12;
  const minutes = Number.parseInt(twelveHour[2], 10);
  const isPm = twelveHour[3].toUpperCase() === 'PM';
  return (isPm ? hours12 + 12 : hours12) * 60 + minutes;
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
function getEndTimeComparable(rawValue: unknown, item?: Record<string, unknown>): unknown {
  const endMinutes = parseTimeToMinutes(rawValue);
  if (endMinutes === null) return rawValue;
  if (!item) return endMinutes;

  const startMinutes = parseTimeToMinutes(item.time);
  if (startMinutes === null) return endMinutes;
  return endMinutes < startMinutes ? endMinutes + MINUTES_PER_DAY : endMinutes;
}

function getItemFieldValue(item: Record<string, unknown>, field: string, valueField: string): unknown {
  if (field === 'value') {
    return item[valueField];
  }
  return item[field];
}

function getComparableValue(
  field: string,
  rawValue: unknown,
  valueField: string,
  item?: Record<string, unknown>
): unknown {
  const effectiveField = field === 'value' ? valueField : field;
  if (effectiveField === 'rating') {
    const parsed = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue));
    return Number.isFinite(parsed) ? parsed : rawValue;
  }
  if (effectiveField === 'duration') {
    return typeof rawValue === 'string' ? (parseDurationMinutes(rawValue) ?? rawValue) : rawValue;
  }
  if (effectiveField === 'time') {
    return parseTimeToMinutes(rawValue) ?? rawValue;
  }
  if (effectiveField === 'endTime') {
    return getEndTimeComparable(rawValue, item);
  }
  return rawValue;
}

function matchesFilter(item: Record<string, unknown>, filter: FilterExpression, valueField: string): boolean {
  const itemValue = getItemFieldValue(item, filter.field, valueField);
  const comparableItemValue = getComparableValue(filter.field, itemValue, valueField, item);
  const comparableFilterValue = getComparableValue(filter.field, filter.value, valueField);

  switch (filter.operator) {
    case 'eq':
      return itemValue === filter.value;
    case 'neq':
      return itemValue !== filter.value;
    case 'contains':
      if (Array.isArray(itemValue)) {
        return itemValue.includes(filter.value);
      }
      return String(itemValue).includes(String(filter.value));
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
      return Array.isArray(filter.value) && filter.value.includes(itemValue);
    default:
      return true;
  }
}

export function isSelectableItem(item: Record<string, unknown>): boolean {
  if (item.available === false) return false;
  if (typeof item.status === 'string' && item.status !== 'available') return false;
  return true;
}

export function applyFilterExpressions(
  items: Record<string, unknown>[],
  filters: FilterExpression[],
  valueField: string
): Record<string, unknown>[] {
  let filtered = items.filter(isRecord).map((item) => ({ ...item }));
  for (const filter of filters) {
    filtered = filtered.filter((item) => matchesFilter(item, filter, valueField));
  }
  return filtered;
}

export function countSelectableFilteredItems(
  items: Record<string, unknown>[],
  filters: FilterExpression[],
  valueField: string
): number {
  return applyFilterExpressions(items, filters, valueField).filter(isSelectableItem).length;
}
