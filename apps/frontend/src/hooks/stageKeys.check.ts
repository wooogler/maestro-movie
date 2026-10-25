/**
 * Executable check for keyboard stage navigation's key filter:
 *
 *   npx tsx apps/frontend/src/hooks/stageKeys.check.ts
 *
 * The filter decides, from a key press and where focus is, whether Enter / →
 * mean Continue and ← means Back — or whether the key belongs to something
 * else. `useStageKeys` is only the DOM around it. Exit code 0 means every case
 * passed.
 */
import {
  STAGE_KEY_COOLDOWN_MS,
  createStageKeyDebouncer,
  stageKeyAction,
  type StageKeyContext,
  type StageKeyEventLike,
  type StageKeyTarget,
} from './stageKeys';

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

const free: StageKeyContext = { target: 'none', dialogOpen: false };
const press = (key: string, extra: Partial<StageKeyEventLike> = {}, context: StageKeyContext = free) =>
  stageKeyAction({ key, ...extra }, context);

section('1. the three keys, nothing else');
{
  check('Enter is Continue', press('Enter') === 'next');
  check('ArrowRight is Continue', press('ArrowRight') === 'next');
  check('ArrowLeft is Back', press('ArrowLeft') === 'back');
  check(
    'Space is push-to-talk, never navigation',
    press(' ') === null && press('Space') === null
  );
  check(
    'other keys pass through',
    ['ArrowUp', 'ArrowDown', 'Tab', 'Escape', 'Backspace', 'a', 'PageDown'].every((key) => press(key) === null)
  );
}

section('2. modifiers, composition, repeats, other handlers');
{
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
    check(`${modifier} + Enter / arrows pass through`, ['Enter', 'ArrowRight', 'ArrowLeft'].every((key) => press(key, { [modifier]: true }) === null));
  }
  check('an IME composition commit (Enter) is not Continue', press('Enter', { isComposing: true }) === null);
  check('a held key: only the first press counts', press('Enter', { repeat: true }) === null && press('ArrowLeft', { repeat: true }) === null);
  check('a key another handler already claimed is left alone', press('Enter', { defaultPrevented: true }) === null);
}

section('3. where focus is');
{
  const at = (target: StageKeyTarget, key: string) => press(key, {}, { target, dialogOpen: false });
  check('typing in a field: every key is the field\'s', ['Enter', 'ArrowRight', 'ArrowLeft'].every((key) => at('editable', key) === null));
  check('a composite widget keeps its arrows and Enter', ['Enter', 'ArrowRight', 'ArrowLeft'].every((key) => at('composite-widget', key) === null));
  check('a control reached by Tab keeps Enter (its own activation)', at('keyboard-focused-control', 'Enter') === null);
  check('but its arrows navigate (a button ignores them)', at('keyboard-focused-control', 'ArrowRight') === 'next' && at('keyboard-focused-control', 'ArrowLeft') === 'back');
  check(
    'a control focused by a tap gives Enter up: tap a seat, press Enter, continue',
    at('pointer-focused-control', 'Enter') === 'next'
  );
  check('nothing focused: all three navigate', at('none', 'Enter') === 'next' && at('none', 'ArrowLeft') === 'back');
  check(
    'a dialog open: nothing navigates, whatever has focus',
    (['none', 'pointer-focused-control', 'keyboard-focused-control'] as const).every((target) =>
      ['Enter', 'ArrowRight', 'ArrowLeft'].every((key) => press(key, {}, { target, dialogOpen: true }) === null)
    )
  );
}

section('4. the debouncer: one stage per burst');
{
  const debouncer = createStageKeyDebouncer(700);
  check('the first press goes through', debouncer.accept(1000));
  check('a second press inside the window does not', !debouncer.accept(1300));
  check(
    'and it extends the window: a stream of presses 100ms apart is one stage, however long',
    [1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100].every((t) => !debouncer.accept(t))
  );
  check('after a full quiet window it goes through again', debouncer.accept(2100 + 700));
  const fresh = createStageKeyDebouncer();
  check('the default window is the exported one, and long enough for a slide', STAGE_KEY_COOLDOWN_MS >= 500 && fresh.accept(0) && !fresh.accept(STAGE_KEY_COOLDOWN_MS - 1) && fresh.accept(2 * STAGE_KEY_COOLDOWN_MS));
  check('event timestamps near zero are not swallowed by the initial state', createStageKeyDebouncer().accept(0));
}

console.log(failures === 0 ? '\nall stage-key checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
