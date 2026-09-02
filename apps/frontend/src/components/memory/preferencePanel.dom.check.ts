/**
 * Checks the two halves of hand-edited preference memory that only exist as
 * rendered markup: the preset preview on the setup screen, and the memory
 * panel's removal controls.
 *
 * Worth a check rather than a look, because the thing most likely to go wrong
 * is invisible in a screenshot. The panel is mounted FOUR times — the desktop
 * rail, the phone sheet, the projected second screen and the paired companion
 * phone — and only the first may offer controls. The relay refuses a write from
 * a viewer socket anyway, so a leaked button would not corrupt anything; it
 * would simply sit there looking broken on a stranger's phone.
 *
 * `createElement` rather than JSX so the file matches the `src/**\/*.check.ts`
 * pattern the typecheck already picks up. Run with `npm run check:preferences`.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentMemoryPanel } from './AgentMemoryPanel';
import { PreferencePresetPicker } from './PreferencePresetPicker';
import { PreferenceChip } from './PreferenceChip';
import { CompanionPairingCard } from '../companion/CompanionPairingCard';
import type { AgentMemorySnapshot } from '../../agent/protocol';
import { applyFilter, applyHighlight, clearHighlight, pruneFilters } from '../../spec/modifiers';
import type { UISpec } from '../../spec/types';

let failures = 0;

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const noop = () => {};

section('1. PRESET PICKER — the preview is the rail\'s own vocabulary');
{
  const picked = renderToStaticMarkup(
    createElement(PreferencePresetPicker, { selectedPresetId: 'date_night', onSelect: noop })
  );
  check('the chosen preset reads as chosen', picked.includes('aria-checked="true"'));
  check('its preferences are previewed', picked.includes('Needs two couple seats together.'));
  // Solid means Hard and dashed means Soft on the rail; the preview has to
  // teach the same thing or it is teaching the wrong thing.
  check('a hard preference renders solid', picked.includes('border-solid'));
  check('a soft preference renders dashed', picked.includes('border-dashed'));
  check('stage dots carry their label', picked.includes('Applies to: seat'));
  check('nothing is removable before a session exists', !picked.includes('>Forget<'));

  const empty = renderToStaticMarkup(
    createElement(PreferencePresetPicker, { selectedPresetId: null, onSelect: noop })
  );
  check('"Start empty" previews nothing', !empty.includes('The agent will start with'));
}

section('2. MEMORY PANEL — editable ONLY where handlers are passed');
{
  const snapshot: AgentMemorySnapshot = {
    updatedAt: '2026-11-03T19:20:00.000Z',
    reason: 'preference-deleted',
    stage: 'seat',
    preferences: [
      {
        id: 'prf_couple',
        description: 'Needs two couple seats together.',
        strength: 'hard',
        relevantStages: ['seat'],
      },
      {
        id: 'prf_recliner',
        description: 'Prefers recliner seating.',
        strength: 'soft',
        relevantStages: ['theater'],
      },
    ],
    deadEnds: [],
    attemptedBranches: [],
    committedWorkflow: null,
    pendingConflict: null,
    backtrackContinuation: null,
    stageBindings: [],
    forgottenPreferences: [
      {
        id: 'prf_distance',
        description: 'Will not drive more than 15 miles.',
        strength: 'hard',
        relevantStages: ['theater'],
      },
    ],
    revokedAdaptations: [],
  };

  const readOnly = renderToStaticMarkup(
    createElement(AgentMemoryPanel, { snapshot, currentStage: 'seat' })
  );
  check('no removal control without a handler', !readOnly.includes('>Forget<'));
  check('no Forgotten section without a restore handler', !readOnly.includes('Forgotten'));
  check('the preferences themselves still render', readOnly.includes('Prefers recliner seating.'));

  // The gate is the HANDLERS, not the variant. The cross-device mirror joins the
  // relay as a viewer and passes none, so it renders read-only; the same-machine
  // mirror passes them and can act, by asking the booking window rather than by
  // writing itself.
  const mirrorWatching = renderToStaticMarkup(
    createElement(AgentMemoryPanel, { snapshot, currentStage: 'seat', variant: 'mirror' })
  );
  check(
    'a mirror with no handlers is read-only',
    !mirrorWatching.includes('>Forget<') && !mirrorWatching.includes('>Restore<')
  );

  const mirrorDriving = renderToStaticMarkup(
    createElement(AgentMemoryPanel, {
      snapshot,
      currentStage: 'seat',
      variant: 'mirror',
      onPreferenceDelete: noop,
      onPreferenceRestore: noop,
    })
  );
  check(
    'a mirror given handlers can act',
    mirrorDriving.includes('>Forget<') && mirrorDriving.includes('>Restore<')
  );

  const editable = renderToStaticMarkup(
    createElement(AgentMemoryPanel, {
      snapshot,
      currentStage: 'seat',
      onPreferenceDelete: noop,
      onPreferenceRestore: noop,
      onPreferenceClearAll: noop,
      pendingPreferenceIds: new Set(['prf_recliner']),
    })
  );
  check('one removal control per preference', (editable.match(/>Forget</g) ?? []).length === 2);
  check(
    'the control names what it would remove',
    editable.includes('aria-label="Forget: Needs two couple seats together."')
  );
  // Without this the visitor restates a removed preference, the tombstone
  // refuses it at write time, and NOTHING appears anywhere to say why.
  check('what was forgotten is shown', editable.includes('Forgotten'));
  check('and offered back', editable.includes('>Restore<'));
  check('a preference awaiting its echo is dimmed', editable.includes('opacity-50'));
  check('and its control is inert', editable.includes('disabled=""'));

  // Its own affordance: between visitors the memory has to go empty, and doing
  // that one chip at a time costs a round trip and a replan each.
  check('a clear-everything control is offered', editable.includes('Forget everything'));
  const noClear = renderToStaticMarkup(
    createElement(AgentMemoryPanel, {
      snapshot,
      currentStage: 'seat',
      onPreferenceDelete: noop,
    })
  );
  check('but only when a handler is given', !noClear.includes('Forget everything'));
  const emptied = renderToStaticMarkup(
    createElement(AgentMemoryPanel, {
      snapshot: { ...snapshot, preferences: [] },
      currentStage: 'seat',
      onPreferenceDelete: noop,
      onPreferenceClearAll: noop,
    })
  );
  check('and not when there is nothing to clear', !emptied.includes('Forget everything'));

  /*
    Nothing destructive commits on one press.

    The chip is the whole affordance — no dialog — so the only thing standing
    between a stray thumb on a projected screen and a deleted preference is that
    the first press changes the label instead of acting.
  */
  check('a control starts unarmed', editable.includes('>Forget<') && !editable.includes('Confirm?'));
  check(
    'clearing everything starts unarmed too',
    editable.includes('Forget everything') && !editable.includes('forget all?')
  );

  const preference = snapshot.preferences[0];
  const unarmed = renderToStaticMarkup(
    createElement(PreferenceChip, { preference, isNew: false, isBlocked: false, onDelete: noop })
  );
  const armed = renderToStaticMarkup(
    createElement(PreferenceChip, {
      preference,
      isNew: false,
      isBlocked: false,
      onDelete: noop,
      isArmed: true,
    })
  );
  check('an unarmed chip offers to forget', unarmed.includes('>Forget<'));
  check('an armed one asks instead', armed.includes('>Confirm?<'));
  check('and says which preference it means', armed.includes('Needs two couple seats together.'));
}

section('3. UN-APPLY — a removal takes back its filter and nothing else');
{
  // A real generated spec, not a hand-built one: the un-apply path runs the
  // full refresh, so a stub missing `display` would pass a check the app fails.
  // Two live filters, one of which a different preference is holding up.
  const theaters = [
    {
      id: 't1',
      name: 'Cinema Detroit',
      location: 'Midtown',
      screenCount: 2,
      distanceMiles: 2.5,
      amenities: ['Reserved Seating'],
    },
    {
      id: 't5',
      name: 'MJR Troy',
      location: 'Troy',
      screenCount: 16,
      distanceMiles: 20.4,
      amenities: ['IMAX'],
    },
  ];
  // Built here rather than via generateTheaterSpec, which transitively reads
  // import.meta.env and is undefined outside Vite. `display` is not optional:
  // the un-apply path runs the full refresh, which reads display.valueField.
  const specOf = () => {
    const base: UISpec = {
      stage: 'theater',
      title: 'Pick a theater',
      items: theaters,
      visibleItems: [],
      state: { selected: null, highlighted: [] },
      modification: {},
      display: { valueField: 'name', component: 'buttonGroup' },
    } as unknown as UISpec;
    const filtered = applyFilter(applyFilter(base, {
      field: 'distanceMiles',
      operator: 'lte',
      value: 15,
    }), { field: 'name', operator: 'contains', value: 'Cinema' });
    return applyHighlight(filtered, { itemIds: ['t1'] });
  };

  const matches = (field: string, operator: string, value: unknown) => (filter: {
    field: string;
    operator: string;
    value: unknown;
  }) =>
    filter.field === field &&
    filter.operator === operator &&
    JSON.stringify(filter.value ?? null) === JSON.stringify(value ?? null);

  const pruned = pruneFilters(specOf(), matches('distanceMiles', 'lte', 15));
  const remaining = pruned.modification.filter;
  check(
    'the revoked filter is gone',
    Array.isArray(remaining) && remaining.length === 1 && remaining[0].field === 'name'
  );
  // The point of pruning rather than clearing: the OTHER preference's filter is
  // still in force, so the far theater stays hidden until that one goes too.
  check(
    'the surviving filter still applies',
    !pruned.visibleItems.some((item) => (item as { id?: string }).id === 't5')
  );

  const bothGone = pruneFilters(pruned, matches('name', 'contains', 'Cinema'));
  check('removing the last filter drops the key entirely', !('filter' in bothGone.modification));
  check('and every theater is visible again', bothGone.visibleItems.length === 2);

  // Identity matters: an unchanged spec must not be rewritten, or every
  // snapshot would churn the store and re-render the booking screen.
  const untouched = specOf();
  check('a revocation that matches nothing changes nothing', pruneFilters(untouched, () => false) === untouched);

  const dimmed = clearHighlight(specOf());
  check('a revoked highlight is dropped', !('highlight' in dimmed.modification));
  check('and filters survive that', Array.isArray(dimmed.modification.filter));
}

section('4. PHONE PAIRING — the same card on two screens, one of them earlier');
{
  // The "ready to start" screen shows this before any relay connection exists,
  // so it can neither know whether a phone has attached nor move voice anywhere.
  // Pairing screen: a preference, recorded before anything is capturing.
  const beforeSession = renderToStaticMarkup(
    createElement(CompanionPairingCard, {
      companionToken: 'cmp_demo_token',
      target: 'kiosk',
      onTargetChange: noop,
    })
  );
  check('the pairing card offers both audio targets', beforeSession.includes('Voice in and out'));
  check('neither is refused before a phone exists', !beforeSession.includes('disabled=""'));

  // Booking rail: a live switch. Choosing the phone with none attached would
  // release the kiosk's microphone with nothing to catch it.
  const inSession = renderToStaticMarkup(
    createElement(CompanionPairingCard, {
      companionToken: 'cmp_demo_token',
      target: 'kiosk',
      onTargetChange: noop,
      companionActive: false,
    })
  );
  check('in session the phone is refused until one attaches', inSession.includes('disabled=""'));

  const paired = renderToStaticMarkup(
    createElement(CompanionPairingCard, {
      companionToken: 'cmp_demo_token',
      target: 'companion',
      onTargetChange: noop,
      companionActive: true,
    })
  );
  check('and allowed once one has', !paired.includes('disabled=""'));

  check(
    'no token means no QR anywhere',
    renderToStaticMarkup(createElement(CompanionPairingCard, { companionToken: null })) === ''
  );
}

if (failures > 0) {
  console.error(`\n${failures} preference-panel check(s) failed.`);
  process.exit(1);
}
console.log('\nAll preference-panel checks passed.');
