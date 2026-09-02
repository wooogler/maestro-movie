/**
 * Executable check for the past-midnight `endTime` comparison in the planner's
 * filter simulation. No test runner is configured, so this is a plain script:
 *
 *   npx tsx apps/tuning-agent/src/core/filterSimulation.check.ts
 *
 * The defect a demo trace caught: a 10:00 PM showing of a 2h04m film carries
 * `endTime: "00:04"`, and comparing that as a string put it *below* "22:00", so
 * the simulation agreed with the GUI that "ends by 10 p.m." had been satisfied
 * while the 12:04 AM finish was still on screen.
 *
 * The frontend's half of this claim lives in:
 *   apps/frontend/src/spec/endTimeFilter.check.ts
 */
import { applyFilterExpressions } from './filterSimulation';
import { addEndTimeToItems } from './timeUtils';
import type { FilterExpression } from '../types';

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

const RUNTIME_MINUTES = 124; // 2h04m, the film from the trace

function showtime(id: string, time: string): Record<string, unknown> {
  return addEndTimeToItems([{ id, time, displayTime: time }], RUNTIME_MINUTES)[0];
}

const LATE = showtime('t_2200', '22:00'); // ends "00:04" — next day
const EVENING = showtime('t_1855', '18:55'); // ends "20:59"
const LATER = showtime('t_2330', '23:30'); // ends "01:34" — next day

function ids(items: Record<string, unknown>[], filter: FilterExpression): string[] {
  return applyFilterExpressions(items, [filter], 'displayTime').map((item) => String(item.id));
}

// -----------------------------------------------------------------------------
section('1. an "ends by 10 PM" filter removes a post-midnight showing');
// -----------------------------------------------------------------------------
{
  check('the 10:00 PM start really does wrap to "00:04"', LATE.endTime === '00:04', String(LATE.endTime));

  const lte = ids([LATE, EVENING], { field: 'endTime', operator: 'lte', value: '22:00' });
  check('lte 22:00 drops the 12:04 AM finish', !lte.includes('t_2200'), JSON.stringify(lte));
  check('lte 22:00 keeps the 8:59 PM finish', lte.includes('t_1855'), JSON.stringify(lte));

  const lt = ids([LATE, EVENING], { field: 'endTime', operator: 'lt', value: '22:00' });
  check('lt 22:00 drops the 12:04 AM finish', !lt.includes('t_2200'), JSON.stringify(lt));
  check('lt 22:00 keeps the 8:59 PM finish', lt.includes('t_1855'), JSON.stringify(lt));

  const twelveHour = ids([LATE, EVENING], { field: 'endTime', operator: 'lte', value: '10:00 PM' });
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

  const bounded = ids([LATER, EVENING], { field: 'endTime', operator: 'lte', value: '23:59' });
  check('lte 23:59 excludes it', !bounded.includes('t_2330'), JSON.stringify(bounded));

  const late = ids([LATER, EVENING], { field: 'endTime', operator: 'gte', value: '22:00' });
  check('gte 22:00 includes it', late.includes('t_2330'), JSON.stringify(late));
  check('gte 22:00 excludes the 8:59 PM finish', !late.includes('t_1855'), JSON.stringify(late));
}

console.log(
  failures === 0
    ? '\nAll filter-simulation endTime checks passed.'
    : `\n${failures} filter-simulation endTime check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
