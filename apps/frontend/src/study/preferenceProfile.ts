import type { AgentPreference, PreferenceProfilePayload } from '../agent/protocol';
import { MEMORY_STAGE_ORDER, type MemoryStage } from '../components/memory/memoryFormat';
import type { Language } from '../i18n/language';

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
    blurb: 'Two people, two seats together, evening.',
    // This used to ask for couple seats, which exist only in row H at MJR Troy
    // (20.4 mi out) — a seat-stage preference that decided the theater three
    // steps earlier and, at any other house, left the agent with nothing it
    // could satisfy. On 2026-10-18 it answered a visitor by blaming its tools.
    // "Two seats together" is satisfiable in every house and still drives the
    // seat stage.
    preferences: [
      preference('prf_date_couple', 'Needs two seats together.', 'hard', ['seat']),
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
 * Translated copy for every preset, keyed by id so the English data above stays the
 * single source for ids, strengths and stages. A preset or preference missing
 * here falls back to English rather than disappearing; the check script keeps
 * the two in step.
 */
/** A preset's words in one language. Any id left out reads in English. */
interface PresetTranslation {
  label: string;
  blurb: string;
  preferences: Record<string, string>;
}

const PRESET_KO: Record<string, PresetTranslation> = {
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
    blurb: '두 사람, 붙어 있는 두 자리, 저녁 시간.',
    preferences: {
      prf_date_couple: '붙어 있는 두 자리가 필요합니다.',
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

/*
  MACHINE-DRAFTED — the Japanese, Simplified Chinese and Traditional Chinese
  preset copy below needs native review. Modelled on the Korean entries, and
  like them it keeps US units (miles, dollars) and US ratings (G, PG), because
  the Detroit catalogue the agent filters on is in miles, USD and MPAA ratings.
*/
const PRESET_JA: Record<string, PresetTranslation> = {
  family_matinee: {
    label: '家族で昼の上映',
    blurb: '子ども連れの親が、早い時間帯に予約。',
    preferences: {
      prf_family_rating: 'G または PG 指定の映画のみ。',
      prf_family_early: '上映開始が午後5時より前である必要があります。',
      prf_family_close: 'より近い映画館を希望します。',
    },
  },
  date_night: {
    label: 'デートの夜',
    blurb: '二人で、隣り合った2席、夜の時間帯。',
    preferences: {
      prf_date_couple: '隣り合った2席が必要です。',
      prf_date_evening: '上映開始が午後6時以降である必要があります。',
      prf_date_recliner: 'リクライニングシートを希望します。',
    },
  },
  big_screen: {
    label: '大きなスクリーン',
    blurb: 'IMAX で見たいけれど、遠くまでは運転しない。最初から条件が競合しています。',
    preferences: {
      prf_big_imax: '上映は IMAX である必要があります。',
      prf_big_distance: '15マイルを超えて運転しません。',
    },
  },
  late_show: {
    label: 'レイトショー',
    blurb: '仕事帰りに、家の近くで。',
    preferences: {
      prf_late_evening: '上映開始が午後9時以降である必要があります。',
      prf_late_distance: '15マイルを超えて運転しません。',
    },
  },
  budget: {
    label: '節約',
    blurb: '価格が最優先。映画館は自然と絞られます。',
    preferences: {
      prf_budget_price: '1席12ドルを超えては払いません。',
      prf_budget_short: '短めの映画を希望します。',
    },
  },
  easy_trip: {
    label: '気軽なお出かけ',
    blurb: '条件はゆるめ。でも一番近い映画館は外れます。',
    preferences: {
      prf_easy_amenities: '映画館に無料駐車場と座席指定制が必要です。',
      prf_easy_rows: '前の2列は避けます。',
    },
  },
};

const PRESET_ZH_HANS: Record<string, PresetTranslation> = {
  family_matinee: {
    label: '家庭日场',
    blurb: '家长带孩子，选较早的时段。',
    preferences: {
      prf_family_rating: '只看 G 或 PG 级电影。',
      prf_family_early: '场次必须在下午 5 点前开始。',
      prf_family_close: '倾向于离得近的影院。',
    },
  },
  date_night: {
    label: '约会之夜',
    blurb: '两个人，两个相邻座位，晚上。',
    preferences: {
      prf_date_couple: '需要两个相邻的座位。',
      prf_date_evening: '场次必须在晚上 6 点或之后开始。',
      prf_date_recliner: '倾向于可躺式座椅。',
    },
  },
  big_screen: {
    label: '大银幕',
    blurb: '想看 IMAX，但不愿为此开远路。一开始就存在冲突。',
    preferences: {
      prf_big_imax: '场次必须是 IMAX。',
      prf_big_distance: '开车不超过 15 英里。',
    },
  },
  late_show: {
    label: '晚场',
    blurb: '下班以后，离家近。',
    preferences: {
      prf_late_evening: '场次必须在晚上 9 点或之后开始。',
      prf_late_distance: '开车不超过 15 英里。',
    },
  },
  budget: {
    label: '省钱',
    blurb: '价格优先，影院也随之被悄悄选定。',
    preferences: {
      prf_budget_price: '每个座位不超过 12 美元。',
      prf_budget_short: '倾向于片长较短的电影。',
    },
  },
  easy_trip: {
    label: '轻松出行',
    blurb: '条件宽松，但会错过最近的影院。',
    preferences: {
      prf_easy_amenities: '影院必须有免费停车和对号入座。',
      prf_easy_rows: '避开前两排。',
    },
  },
};

const PRESET_ZH_HANT: Record<string, PresetTranslation> = {
  family_matinee: {
    label: '親子早場',
    blurb: '家長帶小孩，選較早的時段。',
    preferences: {
      prf_family_rating: '只看 G 或 PG 級的電影。',
      prf_family_early: '場次必須在下午 5 點前開始。',
      prf_family_close: '偏好較近的戲院。',
    },
  },
  date_night: {
    label: '約會夜',
    blurb: '兩個人、兩個相連座位、晚上。',
    preferences: {
      prf_date_couple: '需要兩個相連的座位。',
      prf_date_evening: '場次必須在晚上 6 點或之後開始。',
      prf_date_recliner: '偏好可躺式座椅。',
    },
  },
  big_screen: {
    label: '大銀幕',
    blurb: '想看 IMAX，但不想為此開遠路。一開始就有衝突。',
    preferences: {
      prf_big_imax: '場次必須是 IMAX。',
      prf_big_distance: '開車不超過 15 英里。',
    },
  },
  late_show: {
    label: '晚場',
    blurb: '下班後，離家近。',
    preferences: {
      prf_late_evening: '場次必須在晚上 9 點或之後開始。',
      prf_late_distance: '開車不超過 15 英里。',
    },
  },
  budget: {
    label: '省錢',
    blurb: '價格優先，戲院也會跟著悄悄決定。',
    preferences: {
      prf_budget_price: '每個座位不超過 12 美元。',
      prf_budget_short: '偏好片長較短的電影。',
    },
  },
  easy_trip: {
    label: '輕鬆出門',
    blurb: '條件寬鬆，但會錯過最近的戲院。',
    preferences: {
      prf_easy_amenities: '戲院必須提供免費停車和劃位座位。',
      prf_easy_rows: '避開前兩排。',
    },
  },
};

/**
 * Per language, per preset id. English is the presets themselves, so it has no
 * entry; a language with no entry, or a preset or preference id missing from
 * one, reads in English.
 */
const PRESET_TRANSLATIONS: Partial<Record<Language, Record<string, PresetTranslation>>> = {
  ko: PRESET_KO,
  ja: PRESET_JA,
  'zh-Hans': PRESET_ZH_HANS,
  'zh-Hant': PRESET_ZH_HANT,
};

/**
 * The preset as the visitor should read it. Ids, strengths and stages are
 * untouched, so a translated session loads exactly the same memory -- the agent
 * replaces entries by id -- with the words the visitor can read on the rail.
 */
export function localizePreset(preset: PreferencePreset, language: Language): PreferencePreset {
  const translation = PRESET_TRANSLATIONS[language]?.[preset.id];
  if (!translation) return preset;
  return {
    ...preset,
    label: translation.label,
    blurb: translation.blurb,
    preferences: preset.preferences.map((entry) =>
      translation.preferences[entry.id]
        ? { ...entry, description: translation.preferences[entry.id] }
        : entry
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
  language: Language
): PreferenceProfile | null {
  if (!profile || !PRESET_TRANSLATIONS[language]) return profile;
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

/** For the check script: which preset ids and preference ids carry copy in each translated language. */
export function listPresetTranslationCoverage(): Array<{
  language: Language;
  presetId: string;
  preferenceIds: string[];
}> {
  return (Object.entries(PRESET_TRANSLATIONS) as Array<[Language, Record<string, PresetTranslation>]>).flatMap(
    ([language, presets]) =>
      Object.entries(presets).map(([presetId, entry]) => ({
        language,
        presetId,
        preferenceIds: Object.keys(entry.preferences),
      }))
  );
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
  language: Language = 'en'
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
