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
import {
  COMPACT_CLUSTER_BESIDE_STAGE_MIN_WIDTH_PX,
  DESKTOP_MIN_WIDTH_PX,
  floatingClusterFitsBesideStage,
  guiStageFitScale,
  KIOSK_BOTTOM_FR,
  KIOSK_GUI_CARD_WIDTH_PX,
  KIOSK_GUI_MAX_SCALE,
  KIOSK_MIN_WIDTH_PX,
  KIOSK_STAGE_FR,
  parseLayoutOverride,
  readLayoutOverrideFromSearch,
  selectLayoutMode,
  splitViewLayout,
  type FullTuningLayoutMode,
} from './fullTuningLayout';
import { guiStepContextText } from './voiceTranscript';

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

section('8. with voice on, a step nobody narrated shows no planner reason');
{
  const reason =
    'The user asks which theater has the fewest screens. Screen counts are visible, and Redford Theatre is the single smallest option, so a one-item highlight directly identifies it without selecting it.';
  const base = {
    annotationReason: reason,
    actionReason: undefined,
    stageDescription: 'Choose a theater near you',
    title: 'Select Theater',
  };
  // The sentence the voice said over the step is quoted either way.
  check(
    'a spoken sentence is quoted in voice mode',
    guiStepContextText({ ...base, voiceMode: true, linkedAssistantText: 'Redford has the fewest screens.' }) ===
      'Redford has the fewest screens.'
  );
  check(
    'a spoken sentence is quoted in text mode',
    guiStepContextText({ ...base, voiceMode: false, linkedAssistantText: 'Redford has the fewest screens.' }) ===
      'Redford has the fewest screens.'
  );
  // The regression: an empty or silenced sentence used to surface the reason.
  check(
    'no sentence + voice on = no body text, not the reason',
    guiStepContextText({ ...base, voiceMode: true, linkedAssistantText: undefined }) === ''
  );
  check(
    'a whitespace-only sentence counts as none',
    guiStepContextText({ ...base, voiceMode: true, linkedAssistantText: '  ' }) === ''
  );
  check(
    'a stage change with only an action reason is quiet too',
    guiStepContextText({
      ...base,
      annotationReason: undefined,
      actionReason: 'The user explicitly agreed to the previously suggested theater.',
      voiceMode: true,
    }) === ''
  );
  // Text mode is the interface the paper describes: the fallbacks stay.
  check(
    'text mode still falls back to the tool reason',
    guiStepContextText({ ...base, voiceMode: false, linkedAssistantText: undefined }) === reason
  );
  check(
    'text mode falls through reason → action reason → description → title',
    guiStepContextText({ ...base, annotationReason: undefined, voiceMode: false }) ===
      'Choose a theater near you' &&
      guiStepContextText({
        ...base,
        annotationReason: undefined,
        stageDescription: undefined,
        voiceMode: false,
      }) === 'Select Theater'
  );
}

section('9. the arrangement is chosen from width AND orientation');
{
  // The screens this was built for, and the ones it must not disturb.
  const cases: Array<[string, number, number, FullTuningLayoutMode]> = [
    ['390x844 phone', 390, 844, 'compact'],
    ['430x932 large phone', 430, 932, 'compact'],
    ['690x1000 just under the kiosk line', 690, 1000, 'compact'],
    ['744x1133 iPad mini portrait', 744, 1133, 'kiosk'],
    ['800x1280 portrait tablet', 800, 1280, 'kiosk'],
    ['1080x1920 portrait monitor', 1080, 1920, 'kiosk'],
    ['893x533 landscape tablet', 893, 533, 'compact'],
    ['1333x800 landscape tablet', 1333, 800, 'desktop'],
    ['1920x1080 landscape monitor', 1920, 1080, 'desktop'],
    ['1024x1024 square window keeps the width rule', 1024, 1024, 'desktop'],
  ];
  for (const [label, width, height, expected] of cases) {
    const actual = selectLayoutMode(width, height);
    check(`${label} → ${expected}`, actual === expected, actual);
  }
  check(
    'the kiosk line is the exported constant, and a phone sits well under it',
    KIOSK_MIN_WIDTH_PX === 700 && selectLayoutMode(KIOSK_MIN_WIDTH_PX, 1200) === 'kiosk' &&
      selectLayoutMode(KIOSK_MIN_WIDTH_PX - 1, 1200) === 'compact'
  );
  check(
    'the desktop line is still `lg`',
    DESKTOP_MIN_WIDTH_PX === 1024 && selectLayoutMode(1023, 700) === 'compact' &&
      selectLayoutMode(1024, 700) === 'desktop'
  );
}

section('10. the presenter can override detection');
{
  check('kiosk forced on a landscape monitor', selectLayoutMode(1920, 1080, 'kiosk') === 'kiosk');
  check('desktop forced on a portrait monitor', selectLayoutMode(1080, 1920, 'desktop') === 'desktop');
  check('desktop forced on a portrait tablet, under lg', selectLayoutMode(800, 1280, 'desktop') === 'desktop');
  check('compact forced on a portrait monitor', selectLayoutMode(1080, 1920, 'compact') === 'compact');
  check(
    'override values parse, with friendly aliases',
    parseLayoutOverride('kiosk') === 'kiosk' &&
      parseLayoutOverride(' Portrait ') === 'kiosk' &&
      parseLayoutOverride('desktop') === 'desktop' &&
      parseLayoutOverride('compact') === 'compact' &&
      parseLayoutOverride('phone') === 'compact'
  );
  check(
    'anything else means detect',
    parseLayoutOverride('auto') === null && parseLayoutOverride('') === null &&
      parseLayoutOverride(null) === null && parseLayoutOverride('tv') === null
  );
  check(
    '?layout= pins, ?layout=auto clears, and a URL without it leaves the stored choice alone',
    readLayoutOverrideFromSearch('?layout=kiosk') === 'kiosk' &&
      readLayoutOverrideFromSearch('?lang=ko&layout=desktop') === 'desktop' &&
      readLayoutOverrideFromSearch('?layout=auto') === 'auto' &&
      readLayoutOverrideFromSearch('?layout=nonsense') === 'auto' &&
      readLayoutOverrideFromSearch('?lang=ko') === null &&
      readLayoutOverrideFromSearch('') === null
  );
}

section('11. pinned desktop and compact are the responsive sets, resolved');
{
  /*
    The demo now always passes a mode, so phones and landscape screens get the
    pinned class sets, not the responsive ones sections 1-5 check. These must be
    the same classes the responsive sets resolve to on their side of `lg` — that
    is the "desktop and phone are unchanged" guarantee, as an assertion.
  */
  const groupOf = (token: string): string => {
    if (/^(absolute|relative|static|fixed|sticky)$/.test(token)) return 'position';
    if (/^(hidden|flex|block|grid|inline-flex)$/.test(token)) return 'display';
    if (/^z-/.test(token)) return 'z';
    if (/^grid-cols-/.test(token)) return 'cols';
    if (/^grid-rows-/.test(token)) return 'rows';
    if (/^shadow-/.test(token)) return 'shadow';
    if (/^flex-(1|auto|none)$/.test(token)) return 'flex-grow';
    if (/^pb-/.test(token)) return 'pb';
    return token;
  };
  const resolve = (classes: string, wide: boolean): string[] => {
    const tokens = classes.split(/\s+/).filter(Boolean);
    let resolved = tokens.filter((token) => !token.startsWith('lg:'));
    if (wide) {
      for (const token of tokens.filter((entry) => entry.startsWith('lg:')).map((entry) => entry.slice(3))) {
        resolved = resolved.filter((existing) => groupOf(existing) !== groupOf(token));
        resolved.push(token);
      }
    }
    // `pb-0` and no padding are the same box.
    return resolved.filter((token) => token !== 'pb-0').sort();
  };
  const same = (a: string[], b: string[]) => a.join(' ') === b.join(' ');

  for (const collapsedState of [true, false]) {
    const name = collapsedState ? 'collapsed' : 'open';
    const responsive = splitViewLayout(collapsedState, true);
    const desktop = splitViewLayout(collapsedState, true, 'desktop');
    const compact = splitViewLayout(collapsedState, true, 'compact');
    for (const key of ['container', 'conversationSection', 'stageViewport'] as const) {
      check(
        `${name} ${key}: pinned desktop == responsive at lg`,
        same(resolve(desktop[key], false), resolve(responsive[key], true)),
        `${resolve(desktop[key], false).join(' ')}  vs  ${resolve(responsive[key], true).join(' ')}`
      );
      check(
        `${name} ${key}: pinned compact == responsive below lg`,
        same(resolve(compact[key], false), resolve(responsive[key], false)),
        `${resolve(compact[key], false).join(' ')}  vs  ${resolve(responsive[key], false).join(' ')}`
      );
    }
    // The cluster is `lg:hidden` in the responsive set: shown below, never at lg.
    check(
      `${name}: the floating cluster shows on the pinned phone exactly when it did below lg`,
      compact.showFloatingToggle === responsive.showFloatingToggle && compact.floatingCluster === ''
    );
    check(
      `${name}: and never on the pinned desktop, where it was always lg:hidden`,
      !desktop.showFloatingToggle && responsive.floatingCluster.split(' ').includes('lg:hidden')
    );
    check(
      `${name}: neither pinned set carries a breakpoint, so it holds at any width`,
      ![desktop, compact].some((layout) =>
        [layout.container, layout.conversationSection, layout.stageViewport, layout.floatingCluster].some((c) =>
          /(^|\s)lg:/.test(c)
        )
      )
    );
  }
  const study = splitViewLayout(false, false, 'kiosk');
  check(
    'a mode never reaches the study conditions',
    study.container === splitViewLayout(false, false).container && !study.memorySection
  );
}

section('12. kiosk: the GUI across the top, conversation and memory below');
{
  const kiosk = splitViewLayout(false, true, 'kiosk');
  const kioskCollapsed = splitViewLayout(true, true, 'kiosk');
  const rows = /grid-rows-\[minmax\(0,(\d+)fr\)_minmax\(0,(\d+)fr\)\]/.exec(kiosk.container);
  const share = rows ? Number(rows[1]) / (Number(rows[1]) + Number(rows[2])) : 0;
  check(
    'two rows, the top one 60-65% of the height',
    Boolean(rows) && share >= 0.6 && share <= 0.65,
    rows ? `${(share * 100).toFixed(0)}%` : kiosk.container
  );
  check(
    'the row split is the exported one',
    rows !== null && Number(rows[1]) === KIOSK_STAGE_FR && Number(rows[2]) === KIOSK_BOTTOM_FR
  );
  check(
    'two columns below, conversation the wider',
    kiosk.container.includes('grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')
  );
  check('the stage spans both columns', kiosk.stageSection.split(' ').includes('col-span-2'));
  check(
    'the grid has a definite height, so the stage band is fixed by the screen',
    kiosk.container.includes('h-full') && kiosk.container.includes('min-h-0')
  );
  check(
    'the conversation is a cell, never a sheet over the GUI',
    !kiosk.conversationSection.includes('absolute') && !/(^|\s)hidden(\s|$)/.test(kiosk.conversationSection)
  );
  check(
    'and it cannot be collapsed, so nothing floats and the collapsed state changes nothing',
    !kiosk.conversationCollapsible && !kiosk.showFloatingToggle && kioskCollapsed.container === kiosk.container &&
      kioskCollapsed.conversationSection === kiosk.conversationSection
  );
  check('the memory column exists', kiosk.memorySection.length > 0);
  check(
    'both bottom cells get the 44px touch rule',
    kiosk.conversationSection.split(' ').includes('kiosk-touch') &&
      kiosk.memorySection.split(' ').includes('kiosk-touch')
  );
  check(
    'no breakpoint in kiosk classes: 800px and 1080px wide get the same arrangement',
    ![kiosk.container, kiosk.conversationSection, kiosk.memorySection, kiosk.stageSection].some((c) =>
      /(^|\s)(sm|md|lg|xl):/.test(c)
    )
  );
  for (const mode of ['compact', 'desktop'] as const) {
    const layout = splitViewLayout(false, true, mode);
    check(`${mode}: no memory column, the conversation can still be collapsed`, !layout.memorySection && layout.conversationCollapsible);
  }
}

section('13. kiosk: the stage is scaled UP to fill its band, and never past it');
{
  const kioskFit = (height: number, naturalHeight: number, width: number) =>
    guiStageFitScale(height, naturalHeight, {
      availableWidth: width,
      naturalWidth: KIOSK_GUI_CARD_WIDTH_PX,
      maxScale: KIOSK_GUI_MAX_SCALE,
    });
  // Numbers close to the 1080x1920 band (about 1000 x 1100 of content) and
  // stages of 560-720px natural height.
  const tall = kioskFit(1100, 710, 1000);
  check('a tall stage is enlarged to the height', tall > 1.4 && tall * 710 <= 1100, String(tall));
  const short = kioskFit(1100, 420, 1000);
  check(
    'a short stage is enlarged until the WIDTH runs out',
    short * KIOSK_GUI_CARD_WIDTH_PX <= 1000 && short > 1.8,
    String(short)
  );
  check(
    'and never past the ceiling, however much room there is',
    kioskFit(4000, 300, 4000) === KIOSK_GUI_MAX_SCALE,
    String(kioskFit(4000, 300, 4000))
  );
  check(
    'a band smaller than the stage still shrinks it, as everywhere else',
    kioskFit(560, 700, 760) * 700 <= 560 && kioskFit(560, 700, 760) < 1
  );
  check(
    'the kiosk card is wider than the desktop one, and fits a 700px tablet at 1:1',
    KIOSK_GUI_CARD_WIDTH_PX > 440 && KIOSK_GUI_CARD_WIDTH_PX <= KIOSK_MIN_WIDTH_PX - 64
  );
  check(
    'without the kiosk options nothing is ever enlarged',
    guiStageFitScale(1100, 420) === 1
  );
  check(
    'an unmeasurable width falls back to the height-only rule',
    guiStageFitScale(300, 600, { availableWidth: 0, naturalWidth: 520, maxScale: 2 }) ===
      guiStageFitScale(300, 600)
  );
}

section('14. the floating cluster beside the card on a landscape tablet');
{
  // Galaxy Tab A7 Lite: 893x533 landscape, 533x893 portrait (CSS px).
  check('a landscape A7 Lite has the cluster beside the card', floatingClusterFitsBesideStage(893));
  check('a portrait A7 Lite keeps the reservation under it', !floatingClusterFitsBesideStage(533));
  check('a phone keeps the reservation', !floatingClusterFitsBesideStage(430));
  check('an unmeasurable width keeps the reservation', !floatingClusterFitsBesideStage(Number.NaN));
  // Card right edge (w/2 + 220) against the cluster's left (w - 16 - 12 - 165).
  const w = COMPACT_CLUSTER_BESIDE_STAGE_MIN_WIDTH_PX;
  check('at the threshold a full-size card clears the cluster', w / 2 + 220 <= w - 16 - 12 - 165);
  check('the threshold sits under the desktop line', w < DESKTOP_MIN_WIDTH_PX);
  const beside = splitViewLayout(true, true, 'compact', { clusterBesideStage: true });
  const under = splitViewLayout(true, true, 'compact');
  check('beside: no bottom reservation', beside.stageViewport === '');
  check('under: the 4rem reservation stays', under.stageViewport === 'pb-16');
  check('beside: the cluster is still shown', beside.showFloatingToggle);
  check(
    'the option changes nothing outside the pinned compact',
    splitViewLayout(true, true, 'desktop', { clusterBesideStage: true }).stageViewport ===
      splitViewLayout(true, true, 'desktop').stageViewport &&
      splitViewLayout(true, false, undefined, { clusterBesideStage: true }).stageViewport ===
        splitViewLayout(true, false).stageViewport
  );
}

console.log(
  failures === 0 ? '\nall full-tuning layout checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
