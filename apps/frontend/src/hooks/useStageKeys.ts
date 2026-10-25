/**
 * Enter / ArrowRight press the stage's Continue, ArrowLeft its Back.
 *
 * The decision — which key, which focus, which modifiers — is `stageKeyAction`
 * in `stageKeys.ts`, pure so it can be checked offline. This is the DOM half:
 * it classifies the focused element, notices an open dialog, finds the live
 * stage's button and clicks it.
 *
 * Clicking the button, rather than calling a handler, is the point. The
 * button already IS the stage's Continue: the confirm step's "Confirm Booking",
 * the completion screen's "Finish", the seat stage's "Continue" that stays
 * disabled until a seat is picked. Pressing it means the key can never disagree
 * with the mouse about what Continue does or whether it is allowed.
 *
 * Which button: the one inside `[data-stage-keys-scope]`, which the split view
 * puts only on the current, interactive stage card. The outgoing card of a
 * slide, an older snapshot scrolled into view, and the card while the agent is
 * working (interaction locked) all carry no scope, so a key press then finds
 * nothing and does nothing — the same as a click, which those cards refuse.
 */
import { useEffect } from 'react';
import { createStageKeyDebouncer, stageKeyAction, type StageKeyAction, type StageKeyTarget } from './stageKeys';

/** On the stage card whose buttons the keys may press. */
export const STAGE_KEYS_SCOPE_ATTR = 'data-stage-keys-scope';
/** On the ActionBar's buttons: `next` or `back`. */
export const STAGE_ACTION_ATTR = 'data-stage-action';

const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week',
]);

const COMPOSITE_SELECTOR = [
  '[role="radiogroup"]', '[role="radio"]', '[role="tablist"]', '[role="tab"]',
  '[role="listbox"]', '[role="option"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="combobox"]', '[role="menu"]', '[role="menubar"]', '[role="menuitem"]',
  '[role="tree"]', '[role="grid"]', 'input[type="range"]', 'input[type="radio"]',
].join(', ');

const CONTROL_SELECTOR =
  'button, a[href], summary, input, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';

function classifyTarget(target: EventTarget | null): StageKeyTarget {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return 'none';
  if (target === document.body || target === document.documentElement) return 'none';
  if (target instanceof HTMLElement && target.isContentEditable) return 'editable';
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return 'editable';
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return 'editable';
  if (target.closest(COMPOSITE_SELECTOR)) return 'composite-widget';
  const control = target.closest(CONTROL_SELECTOR);
  if (!control) return 'none';
  let keyboardFocused = false;
  try {
    keyboardFocused = control.matches(':focus-visible');
  } catch {
    // A browser without :focus-visible: assume the keyboard, and leave Enter alone.
    keyboardFocused = true;
  }
  return keyboardFocused ? 'keyboard-focused-control' : 'pointer-focused-control';
}

function isDialogOpen(): boolean {
  return document.querySelector(DIALOG_SELECTOR) !== null;
}

function findStageButton(action: StageKeyAction): HTMLButtonElement | null {
  const candidates = document.querySelectorAll<HTMLButtonElement>(
    `[${STAGE_KEYS_SCOPE_ATTR}] button[${STAGE_ACTION_ATTR}="${action}"]`
  );
  for (const button of candidates) {
    // `inert` makes a click on it impossible for a person; `.click()` would
    // still fire, so it is refused here. Same for a button that is not laid out.
    if (button.closest('[inert]')) continue;
    if (button.getClientRects().length === 0) continue;
    return button;
  }
  return null;
}

export interface UseStageKeysOptions {
  enabled: boolean;
  /** Called after a key pressed a button: for the interaction log. */
  onKeyNavigate?: (action: StageKeyAction, key: string) => void;
}

export function useStageKeys({ enabled, onKeyNavigate }: UseStageKeysOptions): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const debouncer = createStageKeyDebouncer();
    const onKeyDown = (event: KeyboardEvent) => {
      const action = stageKeyAction(event, {
        target: classifyTarget(event.target),
        dialogOpen: isDialogOpen(),
      });
      if (!action) return;
      const button = findStageButton(action);
      // No live button, or a disabled one: the key is not ours; let it through.
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      // Claimed from here on, even when debounced: a bounced Enter must not
      // fall through to whatever button has focus.
      event.preventDefault();
      if (!debouncer.accept(event.timeStamp)) return;
      button.click();
      onKeyNavigate?.(action, event.key);
    };
    // Bubble phase, so a dialog or widget that handles the key first and calls
    // preventDefault is seen as `defaultPrevented` and respected.
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onKeyNavigate]);
}
