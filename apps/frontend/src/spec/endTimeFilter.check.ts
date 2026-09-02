/**
 * Executable check for the past-midnight `endTime` comparison. No test runner
 * is configured, so this is a plain script:
 *
 *   npx tsx apps/frontend/src/spec/endTimeFilter.check.ts
 *
 * The defect a demo trace caught: a 10:00 PM showing of a 2h04m film carries
 * `endTime: "00:04"`, and comparing that as a string put it *below* "22:00", so
 * "the movie should end by 10 p.m." left the 12:04 AM finish on screen.
 */
import { computeDisplayItems } from './modifiers';
import type { DataItem, FilterState, SortState, UISpec } from './types';

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

/** Mirrors `addEndTimeToItems`: the same `% 24` wrap that produces "00:04". */
function showtime(id: string, time: string, durationMinutes: number): DataItem {
  const [h, m] = time.split(':').map((part) => Number.parseInt(part, 10));
  const total = h * 60 + m + durationMinutes;
  const endH = Math.floor(total / 60) % 24;
  const endM = total % 60;
  const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
  const displayH = endH % 12 || 12;
  const amPm = endH < 12 ? 'AM' : 'PM';
  return {
    id,
    time,
    displayTime: time,
    endTime,
    displayEndTime: `${displayH}:${String(endM).padStart(2, '0')} ${amPm}`,
  };
}

const LATE = showtime('t_2200', '22:00', 124); // ends "00:04" — next day
const EVENING = showtime('t_1855', '18:55', 124); // ends "20:59"
const LATER = showtime('t_2330', '23:30', 124); // ends "01:34" — next day

function visibleIds(
  items: DataItem[],
  modification: { filter?: FilterState[]; sort?: SortState }
): string[] {
  const spec: UISpec = {
    stage: 'time',
    title: 'Select Showtime',
    visibleItems: [],
    state: {},
    items,
    modification,
    display: { valueField: 'displayTime', component: 'buttonGroup' },
  };
  return computeDisplayItems(spec).map((item) => item.id);
}

function filtered(items: DataItem[], filter: FilterState): string[] {
  return visibleIds(items, { filter: [filter] });
}

// -----------------------------------------------------------------------------
section('1. an "ends by 10 PM" filter removes a post-midnight showing');
// -----------------------------------------------------------------------------
{
  check('the 10:00 PM start really does wrap to "00:04"', LATE.endTime === '00:04', String(LATE.endTime));

  const lte = filtered([LATE, EVENING], { field: 'endTime', operator: 'lte', value: '22:00' });
  check('lte 22:00 drops the 12:04 AM finish', !lte.includes('t_2200'), JSON.stringify(lte));
  check('lte 22:00 keeps the 8:59 PM finish', lte.includes('t_1855'), JSON.stringify(lte));

  const lt = filtered([LATE, EVENING], { field: 'endTime', operator: 'lt', value: '22:00' });
  check('lt 22:00 drops the 12:04 AM finish', !lt.includes('t_2200'), JSON.stringify(lt));
  check('lt 22:00 keeps the 8:59 PM finish', lt.includes('t_1855'), JSON.stringify(lt));

  const twelveHour = filtered([LATE, EVENING], {
    field: 'endTime',
    operator: 'lte',
    value: '10:00 PM',
  });
  check(
    'a filter value written as "10:00 PM" behaves the same',
    !twelveHour.includes('t_2200') && twelveHour.includes('t_1855'),
    JSON.stringify(twelveHour)
  );
}

// -----------------------------------------------------------------------------
section('2. an 11:30 PM start ending "01:34" sits past the end of the day');
// -----------------------------------------------------------------------------
{
  check('the 11:30 PM start wraps to "01:34"', LATER.endTime === '01:34', String(LATER.endTime));

  const bounded = filtered([LATER, EVENING], { field: 'endTime', operator: 'lte', value: '23:59' });
  check('lte 23:59 excludes it', !bounded.includes('t_2330'), JSON.stringify(bounded));

  const late = filtered([LATER, EVENING], { field: 'endTime', operator: 'gte', value: '22:00' });
  check('gte 22:00 includes it', late.includes('t_2330'), JSON.stringify(late));
  check('gte 22:00 excludes the 8:59 PM finish', !late.includes('t_1855'), JSON.stringify(late));
}

// -----------------------------------------------------------------------------
section('3. sorting by endTime puts the next-day finish last');
// -----------------------------------------------------------------------------
{
  const asc = visibleIds([LATE, EVENING, LATER], { sort: { field: 'endTime', order: 'asc' } });
  check(
    'asc orders 20:59 < 00:04 < 01:34',
    JSON.stringify(asc) === JSON.stringify(['t_1855', 't_2200', 't_2330']),
    JSON.stringify(asc)
  );

  const desc = visibleIds([LATE, EVENING, LATER], { sort: { field: 'endTime', order: 'desc' } });
  check(
    'desc puts the latest finish first',
    JSON.stringify(desc) === JSON.stringify(['t_2330', 't_2200', 't_1855']),
    JSON.stringify(desc)
  );
}

console.log(
  failures === 0
    ? '\nAll endTime filter checks passed.'
    : `\n${failures} endTime filter check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
