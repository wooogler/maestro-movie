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
 *
 * A third arrangement, the portrait kiosk, is further down: GUI across the top,
 * conversation and memory side by side below it. The demo picks between the
 * three in JS (`selectLayoutMode`), because a rotated monitor is over `lg` and a
 * width-only breakpoint cannot tell it from a landscape one.
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

/*
  ---------------------------------------------------------------------------
  Which arrangement: compact (phone), desktop (columns) or kiosk (portrait).
  ---------------------------------------------------------------------------

  The two arrangements above are picked by Tailwind's `lg` breakpoint, which
  knows a width and nothing else. A monitor rotated to portrait for a booth
  kiosk is what that rule gets wrong: 1080x1920 is over `lg`, so it got the
  desktop columns — memory rail, stage and transcript side by side — with the
  booking stage at 1:1 in a ~390px-wide column, floating in a screen-tall pane.
  A portrait tablet (800x1280) is under `lg` and got the phone arrangement: a
  stage given the full height of a screen it could use only a slice of.

  So the demo picks its arrangement in JS, from width AND orientation, and each
  arrangement has a pinned class set as well as the responsive one: a pinned
  set means the same thing at every width, which is what lets a presenter force
  one (`?layout=`, or the Settings sheet) where detection guessed wrong.
*/

export type FullTuningLayoutMode = 'compact' | 'desktop' | 'kiosk';

/** `?layout=kiosk|desktop|compact` on any route; `auto` (or anything else) detects. */
export const LAYOUT_URL_PARAM = 'layout';

/** Tailwind's `lg`, the line the desktop columns have always started at. */
export const DESKTOP_MIN_WIDTH_PX = 1024;

/**
 * The narrowest portrait screen that gets the kiosk arrangement.
 *
 * A phone is portrait too, and a phone must keep the full-bleed stage: a
 * bottom band would leave it a GUI too short to use. Phones top out around
 * 430 CSS px (an unfolded foldable is ~600-690); 700 lets in every portrait
 * tablet from an iPad mini (744) up, and a 1080x1920 monitor.
 */
export const KIOSK_MIN_WIDTH_PX = 700;

/** The presenter's choice, or `null` for "detect". */
export function parseLayoutOverride(value: string | null | undefined): FullTuningLayoutMode | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'kiosk' || normalized === 'portrait') return 'kiosk';
  if (normalized === 'desktop') return 'desktop';
  if (normalized === 'compact' || normalized === 'phone') return 'compact';
  return null;
}

/**
 * What a URL's `?layout=` says: a mode to pin, `'auto'` to drop a pinned one,
 * or `null` when the URL does not mention it (the stored choice stands).
 */
export function readLayoutOverrideFromSearch(search: string): FullTuningLayoutMode | 'auto' | null {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  if (!params.has(LAYOUT_URL_PARAM)) return null;
  return parseLayoutOverride(params.get(LAYOUT_URL_PARAM)) ?? 'auto';
}

/**
 * The arrangement for a viewport of `width` x `height` CSS px.
 *
 * Portrait means strictly taller than wide; a square window keeps the
 * width-based answer it always had. An override wins outright.
 */
export function selectLayoutMode(
  width: number,
  height: number,
  override: FullTuningLayoutMode | null = null
): FullTuningLayoutMode {
  if (override) return override;
  if (height > width && width >= KIOSK_MIN_WIDTH_PX) return 'kiosk';
  return width >= DESKTOP_MIN_WIDTH_PX ? 'desktop' : 'compact';
}

export interface SplitViewLayoutClasses {
  container: string;
  conversationSection: string;
  /** True when the floating open-conversation button should be shown. */
  showFloatingToggle: boolean;
  /** Extra classes on the stage viewport: the room kept clear of the floating cluster. */
  stageViewport: string;
  /** Classes on the floating cluster itself. */
  floatingCluster: string;
  /** Classes on the stage's section; kiosk spans it across both columns. */
  stageSection: string;
  /** Kiosk only: the memory column beside the conversation. Empty otherwise. */
  memorySection: string;
  /** False in kiosk, where the conversation is always on screen. */
  conversationCollapsible: boolean;
}

/*
  Pinned twins of the responsive sets above: what those resolve to at `lg` and
  up (desktop) and below it (compact), written out without a breakpoint so that
  they mean the same thing at any width. `fullTuningLayout.check.ts` resolves
  the responsive sets at each side of `lg` and asserts these are the same
  classes, so a change to one that forgets its twin fails instead of drifting.

  Literal strings on purpose: Tailwind only generates a class it can find
  spelled out in the source, so these cannot be derived by stripping `lg:`.
*/
const PINNED_COMPACT_CONTAINER =
  'relative mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 gap-2 sm:gap-4 grid-rows-[minmax(0,1fr)]';
const PINNED_DESKTOP_CONTAINER_COLLAPSED =
  'relative mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 gap-2 sm:gap-4 grid-rows-[minmax(0,1fr)_auto]';
const PINNED_DESKTOP_CONTAINER_OPEN =
  'relative mx-auto grid h-full w-full max-w-6xl min-h-0 gap-2 sm:gap-4 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] grid-rows-1';
const PINNED_COMPACT_CONVERSATION_DOCKED =
  'hidden min-h-0 overflow-hidden rounded-2xl border border-dark-border bg-dark';
const PINNED_COMPACT_CONVERSATION_SHEET = [
  'absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl',
  'border border-dark-border bg-dark shadow-2xl',
].join(' ');
const PINNED_DESKTOP_CONVERSATION_DOCKED =
  'min-h-0 flex flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark flex-1';
const PINNED_DESKTOP_CONVERSATION_OPEN = [
  'inset-0 static z-auto flex min-h-0 flex-col overflow-hidden rounded-2xl',
  'border border-dark-border bg-dark shadow-none flex-1',
].join(' ');

/*
  Kiosk: a portrait screen, used standing.

  Two rows rather than three columns. The top band is the booking stage across
  the full width; the bottom band is the conversation (wider: the latest turns
  and the composer are what a visitor reads and reaches for) beside the memory
  panel. The rows are fractions of a definite `h-full` grid, so the stage's band
  — and therefore its scale — is fixed by the screen, not by how long the
  transcript has grown.

  A fraction of the screen for the GUI is exactly what the phone rule at the
  top of this file forbids, and it is right here for the opposite reason: a
  phone gave the stage too little height, while a portrait monitor gives it far
  more than the 440px-wide card can use at 1:1. So in this mode the stage is
  scaled UP to fill its band (`guiStageFitScale`'s `fit`), which is what makes
  it large rather than merely centred.
*/
export const KIOSK_STAGE_FR = 65;
export const KIOSK_BOTTOM_FR = 35;
const KIOSK_CONTAINER = [
  'relative mx-auto grid h-full w-full max-w-[1400px] min-h-0 gap-3',
  'grid-cols-[minmax(0,3fr)_minmax(0,2fr)] grid-rows-[minmax(0,65fr)_minmax(0,35fr)]',
].join(' ');
const KIOSK_STAGE_SECTION = 'col-span-2';
const KIOSK_CONVERSATION =
  'kiosk-touch min-h-0 flex flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark';
const KIOSK_MEMORY =
  'kiosk-touch relative min-h-0 flex flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark-light';

const NOT_KIOSK = { stageSection: '', memorySection: '', conversationCollapsible: true } as const;

/*
  Kiosk, wide enough: preferences and workflow side by side, not behind tabs.

  Behind tabs, half of what the agent remembers is always hidden, and at a booth
  nobody taps a tab to find it: the visitor talks, the presenter points, and the
  half that moved is the half nobody can see. So on a portrait monitor the
  memory area is two panels at once, and the bottom band reads conversation |
  preferences | workflow.

  The memory area takes the wider share now (it holds two panels), so the
  conversation narrows from 3/5 to 2/5 of the band. Both stay readable at the
  kiosk zoom: at 1440px the transcript is ~410 CSS px after zoom and each memory
  panel ~300; at 1080px, ~350 and ~260.

  Below `KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX` (a portrait tablet) two memory panels
  would be ~150px each, so a tablet keeps the tabbed column it had.
*/
export type MemoryPanelArrangement = 'tabs' | 'side-by-side';

/** The narrowest kiosk that splits the memory column; under it, tabs. */
export const KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX = 1000;

/**
 * How the memory panel lays out its two halves.
 *
 * Only the kiosk ever gets `side-by-side`. Desktop keeps the rail and the phone
 * keeps its sheet, both tabbed; the study conditions have no mode at all.
 */
export function selectMemoryPanelArrangement(
  mode: FullTuningLayoutMode | null | undefined,
  viewportWidth: number
): MemoryPanelArrangement {
  if (mode !== 'kiosk') return 'tabs';
  if (!Number.isFinite(viewportWidth)) return 'tabs';
  return viewportWidth >= KIOSK_SIDE_BY_SIDE_MIN_WIDTH_PX ? 'side-by-side' : 'tabs';
}

const KIOSK_CONTAINER_SIDE_BY_SIDE = [
  'relative mx-auto grid h-full w-full max-w-[1400px] min-h-0 gap-3',
  'grid-cols-[minmax(0,2fr)_minmax(0,3fr)] grid-rows-[minmax(0,65fr)_minmax(0,35fr)]',
].join(' ');
/**
 * No border or fill of its own: the two panels inside are each a card, so the
 * band reads as three columns. The devices button sits under both.
 */
const KIOSK_MEMORY_SIDE_BY_SIDE = 'kiosk-touch relative min-h-0 flex flex-col gap-3';

export function splitViewLayout(
  conversationCollapsed: boolean,
  /**
   * Only the demo gets the phone treatment. The study conditions keep the
   * layout the paper describes at every width.
   */
  compactLayoutEnabled = true,
  /**
   * The demo's arrangement, from `selectLayoutMode`. Absent, the `lg`
   * breakpoint decides between compact and desktop, as it always did.
   */
  mode?: FullTuningLayoutMode,
  /** Kiosk only: `selectMemoryPanelArrangement`. Tabs (the default) is the original band. */
  memoryArrangement: MemoryPanelArrangement = 'tabs'
): SplitViewLayoutClasses {
  if (!compactLayoutEnabled) {
    return {
      container: conversationCollapsed ? STUDY_CONTAINER_COLLAPSED : STUDY_CONTAINER_OPEN,
      conversationSection: STUDY_CONVERSATION,
      showFloatingToggle: false,
      stageViewport: '',
      floatingCluster: '',
      ...NOT_KIOSK,
    };
  }

  if (mode === 'kiosk') {
    const sideBySide = memoryArrangement === 'side-by-side';
    return {
      container: sideBySide ? KIOSK_CONTAINER_SIDE_BY_SIDE : KIOSK_CONTAINER,
      conversationSection: KIOSK_CONVERSATION,
      // The conversation is always on screen, so nothing has to float.
      showFloatingToggle: false,
      stageViewport: '',
      floatingCluster: '',
      stageSection: KIOSK_STAGE_SECTION,
      memorySection: sideBySide ? KIOSK_MEMORY_SIDE_BY_SIDE : KIOSK_MEMORY,
      conversationCollapsible: false,
    };
  }

  if (mode === 'compact') {
    return {
      container: PINNED_COMPACT_CONTAINER,
      conversationSection: conversationCollapsed
        ? PINNED_COMPACT_CONVERSATION_DOCKED
        : PINNED_COMPACT_CONVERSATION_SHEET,
      showFloatingToggle: conversationCollapsed,
      stageViewport: conversationCollapsed ? 'pb-16' : '',
      floatingCluster: '',
      ...NOT_KIOSK,
    };
  }

  if (mode === 'desktop') {
    return {
      container: conversationCollapsed
        ? PINNED_DESKTOP_CONTAINER_COLLAPSED
        : PINNED_DESKTOP_CONTAINER_OPEN,
      conversationSection: conversationCollapsed
        ? PINNED_DESKTOP_CONVERSATION_DOCKED
        : PINNED_DESKTOP_CONVERSATION_OPEN,
      // At `lg` the floating cluster was always `lg:hidden`; the docked strip
      // is the desktop's way back into the conversation.
      showFloatingToggle: false,
      stageViewport: '',
      floatingCluster: '',
      ...NOT_KIOSK,
    };
  }

  return {
    container: conversationCollapsed
      ? `${CONTAINER_BASE} ${CONTAINER_COLLAPSED_ROWS}`
      : `${CONTAINER_BASE} ${CONTAINER_OPEN_ROWS} ${CONTAINER_DESKTOP_SPLIT}`,
    conversationSection: conversationCollapsed ? CONVERSATION_DOCKED : CONVERSATION_SHEET,
    showFloatingToggle: conversationCollapsed,
    stageViewport: conversationCollapsed ? 'pb-16 lg:pb-0' : '',
    floatingCluster: 'lg:hidden',
    ...NOT_KIOSK,
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
export interface GuiStageFitOptions {
  /** The viewport's content width, padding excluded, like `availableHeight`. */
  availableWidth: number;
  /** The card's laid-out width at scale 1. */
  naturalWidth: number;
  /** How far the stage may be blown UP. 1 (the default) means never. */
  maxScale: number;
}

/** Kiosk: the card is wider than the desktop's, and may be scaled up to this. */
export const KIOSK_GUI_CARD_WIDTH_PX = 520;
export const KIOSK_GUI_MAX_SCALE = 2.2;

export function guiStageFitScale(
  availableHeight: number,
  naturalHeight: number,
  /**
   * Kiosk only. Without it the stage is fitted to height and never enlarged,
   * exactly as before. With it the stage also has to fit the width, and may
   * grow up to `maxScale` — the kiosk band is wider and taller than the card.
   */
  fit?: GuiStageFitOptions
): number {
  if (!Number.isFinite(availableHeight) || !Number.isFinite(naturalHeight)) return 1;
  // Nothing measurable yet (first paint, or a hidden pane): leave it alone
  // rather than collapsing the stage to zero.
  if (availableHeight <= 0 || naturalHeight <= 0) return 1;
  let ceiling = 1;
  let byWidth = Number.POSITIVE_INFINITY;
  if (
    fit &&
    Number.isFinite(fit.availableWidth) &&
    Number.isFinite(fit.naturalWidth) &&
    fit.availableWidth > 0 &&
    fit.naturalWidth > 0
  ) {
    ceiling = Number.isFinite(fit.maxScale) && fit.maxScale > 1 ? fit.maxScale : 1;
    byWidth = fit.availableWidth / fit.naturalWidth;
  }
  // Outside the kiosk, never blow the stage up past its natural size; a short
  // stage on a tall screen is centred, not stretched.
  const exact = Math.min(ceiling, byWidth, availableHeight / naturalHeight);
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
