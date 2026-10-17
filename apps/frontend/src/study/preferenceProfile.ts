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

/**
 * Korean copy for every preset, keyed by id so the English data above stays the
 * single source for ids, strengths and stages. A preset or preference missing
 * here falls back to English rather than disappearing; the check script keeps
 * the two in step.
 */
const PRESET_KO: Record<string, { label: string; blurb: string; preferences: Record<string, string> }> = {
  family_matinee: {
    label: '가족 낮 상영',
    blurb: '아이들과 함께 보려는 부모, 이른 시간대.',
    preferences: {
      prf_family_rating: 'G 또는 PG 등급 영화만.',
      prf_family_early: '상영 시작이 오후 5시 이전이어야 합니다.',
      prf_family_close: '더 가까운 극장을 선호합니다.',
    },
  },
  date_night: {
    label: '데이트 나이트',
    blurb: '두 사람, 커플석, 저녁 시간.',
    preferences: {
      prf_date_couple: '붙어 있는 커플석 두 자리가 필요합니다.',
      prf_date_evening: '상영 시작이 오후 6시 이후여야 합니다.',
      prf_date_recliner: '리클라이너 좌석을 선호합니다.',
    },
  },
  big_screen: {
    label: '큰 화면',
    blurb: 'IMAX를 원하지만 멀리 운전은 안 함. 처음부터 충돌 상태.',
    preferences: {
      prf_big_imax: '상영은 IMAX여야 합니다.',
      prf_big_distance: '15마일 넘게 운전하지 않습니다.',
    },
  },
  late_show: {
    label: '심야 상영',
    blurb: '퇴근 후, 집에서 가까운 곳.',
    preferences: {
      prf_late_evening: '상영 시작이 오후 9시 이후여야 합니다.',
      prf_late_distance: '15마일 넘게 운전하지 않습니다.',
    },
  },
  budget: {
    label: '가성비',
    blurb: '가격이 먼저. 극장은 조용히 알아서 골라집니다.',
    preferences: {
      prf_budget_price: '좌석당 12달러 넘게 내지 않습니다.',
      prf_budget_short: '더 짧은 영화를 선호합니다.',
    },
  },
  easy_trip: {
    label: '편한 이동',
    blurb: '느슨하지만, 가장 가까운 극장은 포기하게 됩니다.',
    preferences: {
      prf_easy_amenities: '극장에 무료 주차와 지정 좌석제가 있어야 합니다.',
      prf_easy_rows: '앞 두 줄은 피합니다.',
    },
  },
};

export type PresetLanguage = 'en' | 'ko';

/**
 * The preset as the visitor should read it. Ids, strengths and stages are
 * untouched, so a Korean session loads exactly the same memory -- the agent
 * replaces entries by id -- with the words the visitor can read on the rail.
 */
export function localizePreset(preset: PreferencePreset, language: PresetLanguage): PreferencePreset {
  if (language !== 'ko') return preset;
  const ko = PRESET_KO[preset.id];
  if (!ko) return preset;
  return {
    ...preset,
    label: ko.label,
    blurb: ko.blurb,
    preferences: preset.preferences.map((entry) =>
      ko.preferences[entry.id] ? { ...entry, description: ko.preferences[entry.id] } : entry
    ),
  };
}

/**
 * A loaded profile re-read in the session language. Descriptions are looked up
 * by id in the preset the profile came from, so a profile created before the
 * visitor switched language -- or one carried in from the setup screen -- is
 * sent and shown in the language they are reading now.
 */
export function localizeProfile(
  profile: PreferenceProfile | null,
  language: PresetLanguage
): PreferenceProfile | null {
  if (!profile || language !== 'ko') return profile;
  const preset = PREFERENCE_PRESETS.find((candidate) => candidate.id === profile.presetId);
  if (!preset) return profile;
  const words = new Map(localizePreset(preset, language).preferences.map((entry) => [entry.id, entry.description]));
  return {
    ...profile,
    preferences: profile.preferences.map((entry) =>
      words.has(entry.id) ? { ...entry, description: words.get(entry.id) as string } : entry
    ),
  };
}

/** For the check script: which preset ids and preference ids carry Korean copy. */
export function listPresetKoreanCoverage(): Array<{ presetId: string; preferenceIds: string[] }> {
  return Object.entries(PRESET_KO).map(([presetId, entry]) => ({
    presetId,
    preferenceIds: Object.keys(entry.preferences),
  }));
}

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
  revision: number,
  language: PresetLanguage = 'en'
): PreferenceProfile {
  return {
    presetId: preset.id,
    revision,
    preferences: normalizeProfilePreferences(localizePreset(preset, language).preferences),
  };
}

/** The wire shape. Null when no preset is loaded, which the agent reads as "no instruction". */
export function toPreferenceProfilePayload(
  profile: PreferenceProfile | null
): PreferenceProfilePayload | null {
  if (!profile || profile.preferences.length === 0) return null;
  return { revision: profile.revision, preferences: profile.preferences };
}
