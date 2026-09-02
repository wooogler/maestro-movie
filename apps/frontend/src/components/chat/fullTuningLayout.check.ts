/**
 * Executable check for the full-tuning arrangement:
 *
 *   npx tsx apps/frontend/src/components/chat/fullTuningLayout.check.ts
 *
 * Most of these are class strings, so they cannot prove pixels — only that the
 * layout contract described in `fullTuningLayout.ts` is the one being emitted.
 * What that catches is the regression that motivated the change: a phone
 * splitting its screen between the booking UI and the transcript, which left the
 * booking UI scaled to about half size. Section 6 is arithmetic rather than
 * class strings, and covers the second way the stage lost its ends: being fitted
 * to a box larger than the one it is laid out in.
 *
 * Exit code 0 means every case passed.
 */
import { guiStageFitScale, splitViewLayout } from './fullTuningLayout';

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

const open = splitViewLayout(false, true);
const collapsed = splitViewLayout(true, true);
const studyOpen = splitViewLayout(false, false);
const studyCollapsed = splitViewLayout(true, false);

section('1. on a phone the booking UI owns the whole screen');
{
  // The old open state was `grid-rows-[minmax(0,3fr)_minmax(0,2fr)]`. That split
  // is what shrank the stage: `guiScale` fits it into whatever height it gets.
  for (const [name, layout] of [['open', open], ['collapsed', collapsed]] as const) {
    check(
      `${name}: no fractional split of the screen between GUI and transcript`,
      !/grid-rows-\[minmax\(0,\s*[2-9]fr\)/.test(layout.container),
      layout.container
    );
    check(
      `${name}: the stage row takes everything below lg`,
      layout.container.includes('grid-rows-[minmax(0,1fr)]'),
      layout.container
    );
  }
  check(
    'collapsed: the conversation cell is gone below lg, leaving no empty row',
    /(^|\s)hidden(\s|$)/.test(collapsed.conversationSection) &&
      collapsed.conversationSection.includes('lg:flex'),
    collapsed.conversationSection
  );
  check(
    'open: the transcript is lifted out of the grid so the stage row keeps its height',
    open.conversationSection.includes('absolute') && open.conversationSection.includes('inset-0'),
    open.conversationSection
  );
  check('and it is above the stage, not behind it', open.conversationSection.includes('z-30'));
}

section('2. the way back into the conversation is always there');
{
  // With the conversation hidden rather than docked, the floating button is the
  // only route to the transcript and the composer. It has to exist in exactly
  // the state where the panel does not.
  check('collapsed: the floating button is shown', collapsed.showFloatingToggle);
  check('open: it is not', !open.showFloatingToggle);
  check(
    'the two are mutually exclusive',
    collapsed.showFloatingToggle !== open.showFloatingToggle
  );
}

section('3. the desktop split is untouched');
{
  check(
    'open on lg is still two columns, three to two',
    open.container.includes('lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]') &&
      open.container.includes('lg:grid-rows-1'),
    open.container
  );
  check(
    'collapsed on lg is still a single column with a docked strip',
    !collapsed.container.includes('lg:grid-cols-') &&
      collapsed.container.includes('lg:grid-rows-[minmax(0,1fr)_auto]'),
    collapsed.container
  );
  check(
    'the sheet reverts to an ordinary column at lg',
    open.conversationSection.includes('lg:static') &&
      open.conversationSection.includes('lg:z-auto') &&
      open.conversationSection.includes('lg:flex-1'),
    open.conversationSection
  );
  check('and drops its overlay shadow there', open.conversationSection.includes('lg:shadow-none'));
}

section('4. the study conditions keep the interface the paper describes');
{
  // C2 and C4 must not be handed the booth layout because a browser window
  // happens to be under 1024px — a laptop at 125% OS scaling gets there.
  check(
    'study open: still the three-to-two split at every width',
    studyOpen.container.includes('grid-rows-[minmax(0,3fr)_minmax(0,2fr)]'),
    studyOpen.container
  );
  check(
    'study open: still two columns on lg',
    studyOpen.container.includes('lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'),
    studyOpen.container
  );
  check(
    'study collapsed: the conversation is a docked strip, never hidden',
    // The standalone `hidden` utility, not the `hidden` inside `overflow-hidden`.
    !/(^|\s)hidden(\s|$)/.test(studyCollapsed.conversationSection),
    studyCollapsed.conversationSection
  );
  check(
    'study: no floating cluster in either state',
    !studyOpen.showFloatingToggle && !studyCollapsed.showFloatingToggle
  );
  check(
    'study: the conversation is never lifted out of the grid',
    !studyOpen.conversationSection.includes('absolute') &&
      !studyCollapsed.conversationSection.includes('absolute')
  );
}

section('5. the container can actually position the sheet');
{
  check(
    'the grid container is a positioning context in both states',
    open.container.includes('relative') && collapsed.container.includes('relative')
  );
  check(
    'both states still constrain height so the panes scroll internally',
    open.container.includes('h-full') &&
      open.container.includes('min-h-0') &&
      collapsed.container.includes('h-full') &&
      collapsed.container.includes('min-h-0')
  );
}

section('6. the stage is fitted to the box it is actually laid out in');
{
  // The numbers below are a Galaxy Tab A7 Lite in landscape: 893x533 CSS px, so
  // under `lg` (it takes the compact layout and its `pb-16`) and short enough
  // that 64px of padding is a tenth of the stage.
  const VIEWPORT_CLIENT_HEIGHT = 420;
  const FLOATING_TOGGLE_PADDING = 64; // pb-16
  const CONTENT_HEIGHT = VIEWPORT_CLIENT_HEIGHT - FLOATING_TOGGLE_PADDING;
  const NATURAL_STAGE_HEIGHT = 620;

  const correct = guiStageFitScale(CONTENT_HEIGHT, NATURAL_STAGE_HEIGHT);
  // What the component used to do: measure `clientHeight`, padding included.
  const withPaddingCountedAsRoom = guiStageFitScale(
    VIEWPORT_CLIENT_HEIGHT,
    NATURAL_STAGE_HEIGHT
  );

  check(
    'fitting to the content box keeps the whole stage inside it',
    correct * NATURAL_STAGE_HEIGHT <= CONTENT_HEIGHT + 0.5,
    `${(correct * NATURAL_STAGE_HEIGHT).toFixed(1)}px into ${CONTENT_HEIGHT}px`
  );
  check(
    'and counting the padding as room does not — this is the tablet clipping bug',
    withPaddingCountedAsRoom * NATURAL_STAGE_HEIGHT > CONTENT_HEIGHT,
    `${(withPaddingCountedAsRoom * NATURAL_STAGE_HEIGHT).toFixed(1)}px into ${CONTENT_HEIGHT}px`
  );
  check(
    'the stage is never blown up past its natural size',
    guiStageFitScale(900, 400) === 1,
    String(guiStageFitScale(900, 400))
  );
  check(
    'an unmeasurable stage is left alone rather than collapsed to nothing',
    guiStageFitScale(0, 620) === 1 &&
      guiStageFitScale(420, 0) === 1 &&
      guiStageFitScale(Number.NaN, 620) === 1
  );
}

section('7. the scale is quantised, so a one-pixel wobble does not restyle the stage');
{
  // The scale is an inline transform on the element holding both stage panels.
  // An unquantised value changed on every sub-pixel change in measured content
  // — including while a stage slide was running — and each change restyled and
  // recomposited the whole booking UI for a difference below a pixel.
  check(
    'two decimals, not sixteen',
    guiStageFitScale(356, 620) === 0.57,
    String(guiStageFitScale(356, 620))
  );
  check(
    'a sub-pixel change in the measurement lands on the same scale',
    guiStageFitScale(356, 620) === guiStageFitScale(356.4, 620) &&
      guiStageFitScale(356, 620) === guiStageFitScale(355.6, 620),
    `${guiStageFitScale(355.6, 620)} / ${guiStageFitScale(356.4, 620)}`
  );
  check(
    'it rounds down, so quantising can never push the stage past its box',
    guiStageFitScale(419, 620) * 620 <= 419 && guiStageFitScale(561, 620) * 620 <= 561,
    `${(guiStageFitScale(419, 620) * 620).toFixed(2)}px into 419px`
  );
  check(
    'and a stage that already fits is still left at exactly 1',
    guiStageFitScale(900, 400) === 1 && guiStageFitScale(620, 620) === 1
  );
}

console.log(
  failures === 0 ? '\nall full-tuning layout checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
