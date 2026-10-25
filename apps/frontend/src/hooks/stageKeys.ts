/**
 * Keyboard stage navigation: which key press means "Continue" or "Back", and
 * which must be left alone. DOM-free, so `stageKeys.check.ts` runs it under
 * node; `useStageKeys.ts` is the half that reads the page.
 *
 * Why these keys: Space is the booth's push-to-talk, so the presenter's other
 * hand gets Enter / ArrowRight for "next" and ArrowLeft for "back".
 *
 * What it must never do is steal a key that already means something where focus
 * is. In order:
 *   - a text field, select or contenteditable: every key is typing;
 *   - a composite widget (radio group, tab list, listbox, slider, menu,
 *     spin button, combobox): the arrows and Enter move inside it;
 *   - a button or link the visitor reached with the KEYBOARD (Tab): Enter is
 *     that control's own activation, so Enter is left to it — the arrows,
 *     which a button ignores, still navigate;
 *   - a button focused by a POINTER (Chrome focuses a button on click, without
 *     `:focus-visible`): taken over, Enter included. Otherwise a visitor who
 *     taps a seat and presses Enter to continue would toggle the seat back off.
 * And: no modifiers (Cmd+→ is the browser's, Shift+Enter is a newline), no
 * IME composition, no auto-repeat, nothing another handler already claimed,
 * nothing while a dialog is open.
 */

export type StageKeyAction = 'next' | 'back';

/** Where the key press landed, as `useStageKeys` classifies `event.target`. */
export type StageKeyTarget =
  | 'none'
  | 'editable'
  | 'composite-widget'
  | 'keyboard-focused-control'
  | 'pointer-focused-control';

export interface StageKeyEventLike {
  key: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface StageKeyContext {
  target: StageKeyTarget;
  dialogOpen: boolean;
}

/** The action a key press asks for, or `null` to let it through untouched. */
export function stageKeyAction(event: StageKeyEventLike, context: StageKeyContext): StageKeyAction | null {
  const action =
    event.key === 'Enter' || event.key === 'ArrowRight'
      ? 'next'
      : event.key === 'ArrowLeft'
      ? 'back'
      : null;
  if (!action) return null;
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  // A held key: the first press navigates, the auto-repeat that follows must
  // not skip a second stage.
  if (event.repeat) return null;
  if (context.dialogOpen) return null;
  switch (context.target) {
    case 'editable':
    case 'composite-widget':
      return null;
    case 'keyboard-focused-control':
      return event.key === 'Enter' ? null : action;
    default:
      return action;
  }
}

/** Long enough that a double tap or a bouncing key is one stage, not two. */
export const STAGE_KEY_COOLDOWN_MS = 700;

/**
 * A navigation goes through only after `cooldownMs` of quiet since the previous
 * navigation key — accepted or not. `event.repeat` already stops a held key;
 * this is the second line, for a bounce or a double tap inside the transition,
 * and for the keyboards and presenter clickers that send repeats without the
 * flag. Counting rejected presses too is what makes such a stream one stage,
 * however long it is held, rather than one stage per `cooldownMs`.
 */
export function createStageKeyDebouncer(cooldownMs = STAGE_KEY_COOLDOWN_MS) {
  let lastPress = Number.NEGATIVE_INFINITY;
  return {
    accept(now: number): boolean {
      const quiet = now - lastPress >= cooldownMs;
      lastPress = now;
      return quiet;
    },
  };
}
