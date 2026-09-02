/**
 * How the full-tuning split arranges itself, extracted from the component so
 * the arrangement can be asserted rather than eyeballed.
 *
 * Keep this module DOM-free: `fullTuningLayout.check.ts` runs it under node,
 * where `tsconfig.node.json` has no DOM lib. Class strings and arithmetic live
 * here; anything that has to measure an element stays in the component.
 *
 * The rule, in one sentence: **below `lg` the booking GUI always owns the whole
 * area, and the conversation is either a dock at the bottom or a sheet floating
 * over it — never a slice taken out of the GUI.**
 *
 * That rule exists because of what the old split did on a phone. The grid was
 * `3fr / 2fr`, so on a 430x932 screen the GUI pane came out around 350px tall,
 * and `guiScale` fits a stage into whatever height it is handed — so the
 * booking UI was scaled to roughly half size to fit a pane that was half the
 * screen. Handing the GUI the full height is what makes it legible again;
 * nothing about the scaling itself changed.
 *
 * At `lg` and up this is exactly the two-column layout it has always been.
 */

const CONTAINER_BASE = 'relative mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 gap-2 sm:gap-4';

/**
 * Collapsed, the conversation cell is `hidden` below `lg`, so a two-row grid
 * would leave an empty `auto` row. One row means the stage gets every pixel.
 */
const CONTAINER_COLLAPSED_ROWS = 'grid-rows-[minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]';

/** Open, the sheet is absolutely positioned, so this row still belongs to the GUI. */
const CONTAINER_OPEN_ROWS = 'grid-rows-[minmax(0,1fr)]';

/** The two-column desktop split, applied only while the conversation is open. */
const CONTAINER_DESKTOP_SPLIT =
  'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1';

/**
 * Closed, on a phone the conversation is not a bar at all — it is a floating
 * button over the bottom-right of the booking UI, so the stage gets the whole
 * screen and not just most of it. `hidden lg:flex` keeps the desktop column,
 * where the same collapsed state is still a header strip in the second grid
 * cell.
 */
const CONVERSATION_DOCKED =
  'hidden min-h-0 lg:flex lg:flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark lg:flex-1';

/**
 * `absolute` is doing two jobs: it lifts the sheet over the GUI, and it takes
 * the conversation out of the grid entirely, so the `1fr` GUI row keeps the full
 * height underneath rather than being squeezed to make room.
 */
const CONVERSATION_SHEET = [
  'absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl',
  'border border-dark-border bg-dark shadow-2xl',
  'lg:static lg:z-auto lg:flex-1 lg:shadow-none',
].join(' ');

/**
 * The pre-existing arrangement, kept verbatim for the study conditions.
 *
 * Below `lg` this splits the screen three-to-two between the booking UI and the
 * transcript. That is what shrank the stage on a phone and is exactly why the
 * demo no longer uses it — but it is also the interface C2 and C4 were run on,
 * and a participant whose browser window happens to be under 1024px wide must
 * not be handed the booth layout instead.
 */
const STUDY_CONTAINER_OPEN =
  'mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1';
const STUDY_CONTAINER_COLLAPSED =
  'mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-4';
const STUDY_CONVERSATION =
  'min-h-0 flex flex-1 flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark';

export interface SplitViewLayoutClasses {
  container: string;
  conversationSection: string;
  /** True when the floating open-conversation button should be shown. */
  showFloatingToggle: boolean;
}

export function splitViewLayout(
  conversationCollapsed: boolean,
  /**
   * Only the demo gets the phone treatment. The study conditions keep the
   * layout the paper describes at every width.
   */
  compactLayoutEnabled = true
): SplitViewLayoutClasses {
  if (!compactLayoutEnabled) {
    return {
      container: conversationCollapsed ? STUDY_CONTAINER_COLLAPSED : STUDY_CONTAINER_OPEN,
      conversationSection: STUDY_CONVERSATION,
      showFloatingToggle: false,
    };
  }

  return {
    container: conversationCollapsed
      ? `${CONTAINER_BASE} ${CONTAINER_COLLAPSED_ROWS}`
      : `${CONTAINER_BASE} ${CONTAINER_OPEN_ROWS} ${CONTAINER_DESKTOP_SPLIT}`,
    conversationSection: conversationCollapsed ? CONVERSATION_DOCKED : CONVERSATION_SHEET,
    showFloatingToggle: conversationCollapsed,
  };
}

/**
 * The scale that fits the booking stage into the height it has been given.
 *
 * `availableHeight` must be the viewport's **content** height — what is left
 * after its own padding. `clientHeight` is not that: it includes padding, and
 * below `lg` the collapsed layout pads the stage viewport by 4rem to keep the
 * booking UI clear of the floating conversation button. Measuring with
 * `clientHeight` therefore scaled the stage to a box 64px taller than the one it
 * actually sits in, and because the stage is centred in that box the overflow
 * was split between the two ends — the booking UI was clipped at the top *and*
 * the bottom on every screen under 1024px. A tablet is where that shows up
 * worst: it is under `lg`, so it takes the padding, and it is short enough in
 * landscape that 64px is a tenth of the stage.
 */
export function guiStageFitScale(availableHeight: number, naturalHeight: number): number {
  if (!Number.isFinite(availableHeight) || !Number.isFinite(naturalHeight)) return 1;
  // Nothing measurable yet (first paint, or a hidden pane): leave it alone
  // rather than collapsing the stage to zero.
  if (availableHeight <= 0 || naturalHeight <= 0) return 1;
  // Never blow the stage up past its natural size; a short stage on a tall
  // screen is centred, not stretched.
  const exact = Math.min(1, availableHeight / naturalHeight);
  /*
    Quantised to hundredths, and rounded *down* so the fit guarantee above still
    holds. An unquantised scale changes on every one-pixel wobble of the measured
    content — and the scale is an inline `transform` on the element that owns
    both stage panels, so a 0.6312 → 0.6313 nudge during a slide restyles and
    recomposites the whole booking UI mid-animation for a difference nobody can
    see. Two decimals is finer than a pixel on a 620px stage.
  */
  return Math.floor(exact * 100) / 100;
}
