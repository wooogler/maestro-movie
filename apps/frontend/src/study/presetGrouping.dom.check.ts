/**
 * Offline check for the start screen's preset list: three presets up front,
 * the rest behind "More presets", and nothing lost or doubled between them.
 *
 *   npx tsx --tsconfig apps/frontend/tsconfig.check-dom.json \
 *     apps/frontend/src/study/presetGrouping.dom.check.ts
 *
 * Renders nothing; it is a `.dom.check.ts` only for its config, because the
 * preset catalogue's types reach app modules that read `import.meta.env`.
 *
 * The grouping is only an order, so the way it goes wrong is quiet: a preset
 * renamed or added that silently falls out of both groups, or a visitor whose
 * chosen preset sits behind a closed expander and looks unselected.
 */
import { PREFERENCE_PRESETS, PRIMARY_PRESET_IDS, groupPreferencePresets } from './preferenceProfile';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const ids = (list: Array<{ id: string }>) => list.map((preset) => preset.id);

console.log('\n1. the three up front, the three behind "More presets"');
{
  const groups = groupPreferencePresets(PREFERENCE_PRESETS, null);
  check('primary is Family matinee, Date night, Big screen, in that order',
    JSON.stringify(ids(groups.primary)) === JSON.stringify(['family_matinee', 'date_night', 'big_screen']),
    ids(groups.primary).join(', '));
  check('more is Late show, Budget, Easy trip, in catalogue order',
    JSON.stringify(ids(groups.more)) === JSON.stringify(['late_show', 'budget', 'easy_trip']),
    ids(groups.more).join(', '));
  check('every primary id names a real preset',
    PRIMARY_PRESET_IDS.every((id) => PREFERENCE_PRESETS.some((preset) => preset.id === id)));
  const all = [...ids(groups.primary), ...ids(groups.more)];
  check('every preset is in exactly one group',
    all.length === PREFERENCE_PRESETS.length && new Set(all).size === all.length &&
      PREFERENCE_PRESETS.every((preset) => all.includes(preset.id)));
  check('"Start empty" (no preset) leaves the expander closed', groups.moreOpen === false);
}

console.log('\n2. the visitor\'s own choice is never hidden');
{
  check('a primary preset leaves it closed', groupPreferencePresets(PREFERENCE_PRESETS, 'date_night').moreOpen === false);
  for (const id of ['late_show', 'budget', 'easy_trip']) {
    check(`${id} chosen opens it`, groupPreferencePresets(PREFERENCE_PRESETS, id).moreOpen === true);
  }
  check('an unknown id opens nothing', groupPreferencePresets(PREFERENCE_PRESETS, 'no_such_preset').moreOpen === false);
}

console.log('\n3. a preset added later lands behind the expander, not nowhere');
{
  const extended = [...PREFERENCE_PRESETS, { ...PREFERENCE_PRESETS[0], id: 'matinee_plus' }];
  const groups = groupPreferencePresets(extended, null);
  check('the new one is under "More presets"', ids(groups.more).includes('matinee_plus'));
  check('and the up-front three are unchanged', groups.primary.length === 3);
}

console.log(failures === 0 ? '\nall preset grouping checks passed' : `\n${failures} preset grouping check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
