import type { AgentPreference, PreferenceProfilePayload } from '../agent/protocol';
import { MEMORY_STAGE_ORDER, type MemoryStage } from '../components/memory/memoryFormat';

/**
 * Preference memory the booth can hand the agent before anyone says a word.
 *
 * The demo's claim is that a preference memory outlives the session that built
 * it. Nothing here actually persists — a preset is a way to SIMULATE the state
 * that claim produces, so a visitor can walk up to an agent that already knows
 * something and watch what that changes. Deliberately not stored: the booth runs
 * one stranger after another in the same tab, and a remembered profile would be
 * answering on behalf of whoever walks up next.
 */

export interface PreferenceProfile {
  /** Which preset this came from, for logging and for the picker's checkmark. */
  presetId: string;
  /**
   * Monotonic, and the agent's idempotence key. It applies a revision once, so
   * the profile can ride every snapshot without a re-send undoing a removal the
   * visitor made in the meantime.
   */
  revision: number;
  preferences: AgentPreference[];
}

export interface PreferencePreset {
  id: string;
  label: string;
  /** One line, read aloud at the booth as often as it is read on screen. */
  blurb: string;
  preferences: AgentPreference[];
}

/**
 * Ids are frozen literals, never minted at load time.
 *
 * A preset that re-minted its ids would duplicate itself: the agent replaces
 * profile entries by id, so fresh ids on every load would pile a second copy of
 * the same three preferences onto the rail after a reset. The `prf_` prefix is
 * also load-bearing — it is the only provenance marker that survives, and the
 * extractor uses it to carry a seeded SOFT preference forward, which the
 * hard-only rule would otherwise drop on the visitor's first sentence.
 */
const preference = (
  id: string,
  description: string,
  strength: 'hard' | 'soft',
  relevantStages: MemoryStage[]
): AgentPreference => ({ id, description, strength, relevantStages });

/*
  Every reach figure below was measured by replaying the preference against
  apps/backend/scenarios/data/demo_uist2026_detroit.json — 679 showings, 5
  movies, 5 theaters, 4,020 seat-occupancy overrides, Tue 3 Nov to Sun 8 Nov.
  They are properties of a generated world, not constants: reseeding the dataset
  changes every showtime and every occupied seat.

  Two authoring rules the data enforces:
    - `format` (IMAX, 3D, Standard) is a SHOWTIME field, not a theater one, so
      "must be IMAX" binds to `time`. Binding it to `theater` would filter on a
      field that does not exist there, and nothing would catch it.
    - There is no accessibility, wheelchair, aisle or companion-seat attribute
      anywhere in the schema. A preference naming one is displayable and
      permanently unsatisfiable.
*/
export const PREFERENCE_PRESETS: PreferencePreset[] = [
  {
    id: 'family_matinee',
    label: 'Family matinee',
    blurb: 'A parent booking for kids, early in the day.',
    // 141 showings, all 5 theaters, all 6 dates. G/PG resolves to exactly
    // Wildwood and The Legend of Aang. The soft chip is the one that used to
    // evaporate on the first utterance.
    preferences: [
      preference('prf_family_rating', 'Only movies rated G or PG.', 'hard', ['movie']),
      preference('prf_family_early', 'Showtime must start before 5 PM.', 'hard', ['time']),
      preference('prf_family_close', 'Prefers a closer theater.', 'soft', ['theater']),
    ],
  },
  {
    id: 'date_night',
    label: 'Date night',
    blurb: 'Two people, couple seats, evening.',
    // 93 showings, every one at MJR Troy — the FURTHEST theater at 20.4 mi,
    // because couple seats (row H, $26) exist in exactly one house. A seat-stage
    // preference decides the theater stage three steps earlier. Adding any
    // "within 15 miles" takes it to 0.
    preferences: [
      preference('prf_date_couple', 'Needs two couple seats together.', 'hard', ['seat']),
      preference('prf_date_evening', 'Showtime must start at 6 PM or later.', 'hard', ['time']),
      preference('prf_date_recliner', 'Prefers recliner seating.', 'soft', ['theater']),
    ],
  },
  {
    id: 'big_screen',
    label: 'Big screen',
    blurb: 'Wants IMAX, will not drive for it. Starts in conflict.',
    // 0 — verified. IMAX runs only at MJR Troy (20.4 mi): 32 showings rotating
    // one title a day. Dropping the distance chip opens 32. A dead end reachable
    // in zero conversational turns, which makes it the fallback when the room is
    // too loud for speech to land.
    preferences: [
      preference('prf_big_imax', 'The showing must be IMAX.', 'hard', ['time']),
      preference('prf_big_distance', 'Will not drive more than 15 miles.', 'hard', ['theater']),
    ],
  },
  {
    id: 'late_show',
    label: 'Late show',
    blurb: 'After work, and close to home.',
    // 90 showings across Cinema Detroit / Bel Air / Emagine, all 6 dates.
    // Dropping the distance chip opens 138 by adding MJR Troy.
    preferences: [
      preference('prf_late_evening', 'Showtime must start at 9 PM or later.', 'hard', ['time']),
      preference('prf_late_distance', 'Will not drive more than 15 miles.', 'hard', ['theater']),
    ],
  },
  {
    id: 'budget',
    label: 'Budget',
    blurb: 'Price first, and it quietly picks the theater.',
    // 48 showings at Cinema Detroit ($12) and Redford ($10) only — every other
    // house starts at $14–15. A seat-stage constraint prunes the theater stage
    // with no theater preference stated at all.
    preferences: [
      preference('prf_budget_price', 'Will not pay more than $12 for a seat.', 'hard', ['seat']),
      preference('prf_budget_short', 'Prefers a shorter movie.', 'soft', ['movie']),
    ],
  },
  {
    id: 'easy_trip',
    label: 'Easy trip',
    blurb: 'Loose, but it costs the nearest theater.',
    // 631 showings at Bel Air / Emagine / MJR Troy. Free parking ALONE is 643
    // and includes Redford; the reserved-seating clause is what drops it. Free
    // parking also eliminates Cinema Detroit, the only sub-5-mile option and the
    // only Paid Parking house — "nearest" and "easiest" are different theaters.
    preferences: [
      preference(
        'prf_easy_amenities',
        'Theater must have free parking and reserved seating.',
        'hard',
        ['theater']
      ),
      preference('prf_easy_rows', 'Avoid the front two rows.', 'hard', ['seat']),
    ],
  },
];

export function findPreferencePreset(presetId: string): PreferencePreset | null {
  return PREFERENCE_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

/**
 * Refuses what the agent's store would otherwise swallow without a word.
 *
 * All three rules below drop or distort an entry with no error anywhere, so the
 * only symptom is a preference that behaves oddly or never appears:
 *   - a blank id or description is skipped by the normalizer;
 *   - an EMPTY stage list does not scope a preference to nothing, it widens it
 *     to all six stages, so a seat requirement starts steering movie choice;
 *   - a duplicate id makes the normalizer UNION the two stage lists.
 */
export function normalizeProfilePreferences(preferences: AgentPreference[]): AgentPreference[] {
  const byId = new Map<string, AgentPreference>();
  for (const entry of preferences) {
    const id = entry.id.trim();
    const description = entry.description.trim().replace(/\s+/g, ' ');
    if (!id || !description || byId.has(id)) continue;
    const relevantStages = entry.relevantStages.filter((stage): stage is MemoryStage =>
      (MEMORY_STAGE_ORDER as readonly string[]).includes(stage)
    );
    if (relevantStages.length === 0) continue;
    byId.set(id, {
      id,
      description,
      strength: entry.strength === 'soft' ? 'soft' : 'hard',
      relevantStages,
    });
  }
  return Array.from(byId.values());
}

export function createProfileFromPreset(
  preset: PreferencePreset,
  revision: number
): PreferenceProfile {
  return {
    presetId: preset.id,
    revision,
    preferences: normalizeProfilePreferences(preset.preferences),
  };
}

/** The wire shape. Null when no preset is loaded, which the agent reads as "no instruction". */
export function toPreferenceProfilePayload(
  profile: PreferenceProfile | null
): PreferenceProfilePayload | null {
  if (!profile || profile.preferences.length === 0) return null;
  return { revision: profile.revision, preferences: profile.preferences };
}
