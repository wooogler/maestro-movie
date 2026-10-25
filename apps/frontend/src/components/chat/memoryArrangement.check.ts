/**
 * Executable check for the memory panel's arrangement — tabs, or preferences
 * and workflow side by side — and the kiosk band that holds the latter:
 *
 *   npx tsx apps/frontend/src/components/chat/memoryArrangement.check.ts
 *
 * Exit code 0 means every case passed.
 */
import {
  KIOSK_MIN_WIDTH_PX,
  KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX,
  selectLayoutMode,
  selectMemoryPanelArrangement,
  splitViewLayout,
} from './fullTuningLayout';

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

section('1. which arrangement, by screen');
{
  const at = (width: number, height: number) =>
    selectMemoryPanelArrangement(selectLayoutMode(width, height), width);
  const cases: Array<[string, number, number, 'tabs' | 'side-by-side']> = [
    ['1440x2560 27" portrait kiosk', 1440, 2560, 'side-by-side'],
    ['1080x1920 portrait monitor', 1080, 1920, 'side-by-side'],
    ['1200x1920 MacBook-driven portrait', 1200, 1920, 'side-by-side'],
    ['800x1280 portrait tablet', 800, 1280, 'tabs'],
    ['744x1133 iPad mini portrait', 744, 1133, 'tabs'],
    ['1920x1080 desktop', 1920, 1080, 'tabs'],
    ['1280x800 laptop', 1280, 800, 'tabs'],
    ['390x844 phone', 390, 844, 'tabs'],
  ];
  for (const [name, width, height, expected] of cases) {
    const got = at(width, height);
    check(`${name}: ${expected}`, got === expected, got);
  }
  check(
    'the line sits inside the kiosk range: tablets keep tabs, monitors split',
    KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX > KIOSK_MIN_WIDTH_PX && KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX <= 1080
  );
  check(
    'only the kiosk ever splits, however wide',
    selectMemoryPanelArrangement('desktop', 4000) === 'tabs' &&
      selectMemoryPanelArrangement('compact', 4000) === 'tabs' &&
      selectMemoryPanelArrangement(null, 4000) === 'tabs' &&
      selectMemoryPanelArrangement(undefined, 4000) === 'tabs'
  );
  check('a forced kiosk on a narrow window keeps tabs', selectMemoryPanelArrangement('kiosk', 900) === 'tabs');
  check('an unmeasurable width keeps tabs', selectMemoryPanelArrangement('kiosk', Number.NaN) === 'tabs');
}

section('2. the kiosk band, side by side');
{
  const tabs = splitViewLayout(false, true, 'kiosk');
  const split = splitViewLayout(false, true, 'kiosk', 'side-by-side');
  check('tabs is the default, and unchanged', splitViewLayout(false, true, 'kiosk', 'tabs').container === tabs.container);
  const cols = /grid-cols-\[minmax\(0,(\d+)fr\)_minmax\(0,(\d+)fr\)\]/.exec(split.container);
  const memoryShare = cols ? Number(cols[2]) / (Number(cols[1]) + Number(cols[2])) : 0;
  check(
    'the memory area is the wider share: it holds two panels',
    Boolean(cols) && memoryShare > 0.5 && memoryShare <= 0.65,
    cols ? `${(memoryShare * 100).toFixed(0)}%` : split.container
  );
  check(
    'the rows are untouched: the stage band is the same height either way',
    /grid-rows-\[minmax\(0,65fr\)_minmax\(0,35fr\)\]/.test(split.container) &&
      /grid-rows-\[minmax\(0,65fr\)_minmax\(0,35fr\)\]/.test(tabs.container)
  );
  check('the memory area is a definite-height flex column', split.memorySection.includes('min-h-0') && split.memorySection.includes('flex-col'));
  check('it keeps the 44px touch rule', split.memorySection.split(' ').includes('kiosk-touch'));
  check('the stage still spans the band', split.stageSection === tabs.stageSection);
  check(
    'no breakpoint in its classes either',
    ![split.container, split.memorySection].some((c) => /(^|\s)(sm|md|lg|xl):/.test(c))
  );
}

section('3. nothing outside the kiosk moves');
{
  for (const mode of ['compact', 'desktop'] as const) {
    for (const collapsed of [false, true]) {
      const base = splitViewLayout(collapsed, true, mode);
      const asked = splitViewLayout(collapsed, true, mode, 'side-by-side');
      check(
        `${mode}${collapsed ? ' (collapsed)' : ''}: a side-by-side request changes nothing`,
        JSON.stringify(base) === JSON.stringify(asked)
      );
    }
  }
  check(
    'the study conditions ignore it too',
    JSON.stringify(splitViewLayout(false, false)) === JSON.stringify(splitViewLayout(false, false, 'kiosk', 'side-by-side'))
  );
}

console.log(failures === 0 ? '\nall memory-arrangement checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
