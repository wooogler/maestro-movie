/**
 * Quick demo cards: one scan, one stage, one sentence.
 *
 * The full demo asks a visitor for the whole booking — five stages, several
 * turns, a couple of minutes. At a busy reception that is more time than most
 * people have, and the part they came to see is small and specific: they say
 * something, and the GUI in front of them rearranges itself to match. These
 * cards deliver exactly that. Each one drops a phone straight onto ONE stage
 * with everything before it already chosen, prints the line to say, and names
 * what to watch happen.
 *
 * Five cards, one per selection stage, so the set as a whole shows that the
 * adaptation is a property of the whole workflow and not a trick that works on
 * one screen. Between them they cover all four adaptation operations: filter
 * and augment on movies, filter and sort on theaters (the line asks for the
 * sort out loud), highlight on dates, filter and augment on showtimes, and
 * highlight on the seat map.
 *
 * `prefill` holds IDS ONLY, never resolved objects. The Detroit world is
 * GENERATED (see apps/backend/src/db/generator) — reseeding it changes every
 * showtime id and every seat occupancy. Ids are resolved against the live world
 * when a card opens, so a card that has outlived its dataset fails loudly on
 * arrival instead of rendering a phantom selection the agent cannot see. The
 * numbers quoted in `watch` are properties of that same generated world; they
 * are checked by quickDemoCards.check.ts against the dataset, so a reseed that
 * invalidates one is a failing check rather than a card that lies at a booth.
 */

// From the types module directly, not the `../spec` barrel: the barrel also
// exports the generators, which reach `import.meta.env` through studyDate, and
// that does not typecheck under the node config the check script next door runs
// with. A card definition needs the stage name and nothing else.
import type { Stage } from '../spec/types';
import { isLanguage, type Language } from '../i18n/language';

/**
 * One line per language. English and Korean are required — the cards were
 * written for those two — and every other language is optional, reading in
 * English until its line is written. Read it through `cardText`, never by
 * indexing, so the fallback is in one place.
 */
export type CardText = Record<'en' | 'ko', string> & Partial<Record<Language, string>>;

/** The card line in `language`, or in English when that line is not written yet. */
export function cardText(text: CardText, language: Language): string {
  return text[language] ?? text.en;
}

/** Which language `cardText` actually returned, for the `lang` attribute around it. */
export function cardTextLanguage(text: CardText, language: Language): Language {
  return text[language] ? language : 'en';
}

export interface QuickDemoPrefill {
  movieId?: string;
  theaterId?: string;
  /** YYYY-MM-DD, matched against the scenario calendar's own day ids. */
  date?: string;
  showingId?: string;
}

export interface QuickDemoCard {
  /**
   * Rides the QR, so it is short and URL-safe. Never renamed casually: a
   * printed card outlives a deploy, and an unknown id is a dead end held in
   * someone's hand.
   */
  id: string;
  /** The stage this card lands on. */
  stage: Stage;
  /** Printed in the corner, and the only thing a presenter says out loud. */
  badge: string;
  /** What the card is about. A noun phrase, not a sentence. */
  title: CardText;
  /** The line to say. Set large — it is the whole interaction. */
  opener: CardText;
  /** What to watch happen, in one line, written before it happens. */
  watch: CardText;
  prefill: QuickDemoPrefill;
}

/*
  Every figure quoted below was measured against
  apps/backend/scenarios/data/demo_uist2026_detroit.json — 5 movies, 5 theaters,
  679 showings, Tue 3 Nov to Sun 8 Nov 2026.

  The shared authoring rule: a card must leave a CHOICE. A sentence that empties
  the screen shows a dead end (which the full demo covers, on its own card), and
  one that changes nothing shows nothing at all. Every card below lands between
  two and four surviving options.
*/
/*
  MACHINE-DRAFTED — the ja, zh-Hans and zh-Hant lines on these cards need native
  review. Each `opener` is what a visitor SAYS, so it is written as natural
  speech; the numbers in it (15 miles, 8, 11) are the catalogue's own.
*/
export const QUICK_DEMO_CARDS: QuickDemoCard[] = [
  {
    id: 'movie',
    stage: 'movie',
    badge: '1',
    // Nothing prefilled: this is the stage the demo already opens on, and the
    // card's job is only to supply the sentence.
    prefill: {},
    title: { en: 'Movies', ko: '영화', ja: '映画', 'zh-Hans': '电影', 'zh-Hant': '電影' },
    opener: {
      // Wildwood (PG) and The Legend of Aang (PG) survive; Street Fighter and
      // Klara (PG-13) and Clayface (R) do not. 5 -> 2.
      en: "I've got my eight-year-old niece with me, so nothing scary.",
      ko: '여덟 살 조카랑 같이 왔어요. 무서운 건 안 돼요.',
      ja: '8歳の姪と一緒なので、怖いのはなしでお願いします。',
      'zh-Hans': '我带着八岁的侄女，所以不要吓人的。',
      'zh-Hant': '我帶著八歲的姪女，所以不要恐怖的。',
    },
    watch: {
      en: 'Five films become two — and the age ratings appear on the ones that stay.',
      ko: '영화 다섯 편이 두 편으로 줄고, 남은 영화에 연령 등급이 붙습니다.',
      ja: '5本の映画が2本に減り、残った映画に年齢区分が表示されます。',
      'zh-Hans': '五部电影减少到两部，留下的电影旁会显示分级。',
      'zh-Hant': '五部電影減少到兩部，留下的電影旁會顯示分級。',
    },
  },
  {
    id: 'theater',
    stage: 'theater',
    // Klara and the Sun is the one film that plays at all five cinemas, so the
    // list starts full and every drop is visible.
    prefill: { movieId: 'm2' },
    badge: '2',
    title: { en: 'Cinemas', ko: '영화관', ja: '映画館', 'zh-Hans': '影院', 'zh-Hant': '戲院' },
    opener: {
      // Drops MJR Troy (20.4 mi) on distance and Cinema Detroit (Paid Parking)
      // on the amenity, leaving Bel Air 9, Redford 13.8, Emagine 14.2. 5 -> 3.
      // "Closest first" is said out loud because, unasked, the planner filtered
      // and showed the miles but never sorted (KSEA simulation, 2/2 runs), and
      // the sort is this card's share of the four operations.
      en: "I'm not driving more than 15 miles, and I don't want to pay for parking. Closest first.",
      ko: '15마일 넘게는 운전 안 할 거고, 주차비도 내기 싫어요. 가까운 순으로 보여 주세요.',
      ja: '15マイル以上は運転したくないし、駐車料金も払いたくないです。近い順にお願いします。',
      'zh-Hans': '我开车不想超过 15 英里，也不想付停车费。按距离从近到远排。',
      'zh-Hant': '我開車不想超過 15 英里，也不想付停車費。依距離由近到遠排。',
    },
    watch: {
      en: 'Two cinemas drop out, the rest reorder by distance, and the miles appear.',
      ko: '영화관 두 곳이 빠지고, 남은 곳은 거리순으로 재정렬되며 거리가 표시됩니다.',
      ja: '映画館が2つ外れ、残りは距離順に並び替わって、マイル数が表示されます。',
      'zh-Hans': '两家影院被排除，其余按距离重新排序，并显示英里数。',
      'zh-Hant': '兩家戲院被排除，其餘依距離重新排序，並顯示英里數。',
    },
  },
  {
    id: 'date',
    stage: 'date',
    prefill: { movieId: 'm2', theaterId: 't4' },
    badge: '3',
    title: { en: 'Dates', ko: '날짜', ja: '日付', 'zh-Hans': '日期', 'zh-Hant': '日期' },
    opener: {
      // The calendar offers Tue 3 Nov through Sun 8 Nov; Sat 7 and Sun 8 are
      // the weekend. The planner highlights those two rather than filtering
      // the calendar 6 -> 2 (KSEA simulation, 2/2 runs), so `watch` promises
      // the highlight.
      en: 'It has to be the weekend.',
      ko: '주말이어야 해요.',
      ja: '週末じゃないとだめです。',
      'zh-Hans': '必须是周末。',
      'zh-Hant': '一定要是週末。',
    },
    watch: {
      en: 'Six days on the calendar — the two weekend days light up.',
      ko: '달력의 여섯 날 중 주말 두 날이 강조됩니다.',
      ja: 'カレンダーの6日間のうち、週末の2日が強調表示されます。',
      'zh-Hans': '日历上的六天中，周末两天会高亮显示。',
      'zh-Hant': '月曆上的六天中，週末兩天會醒目標示。',
    },
  },
  {
    id: 'time',
    stage: 'time',
    // Street Fighter at MJR Troy on Sat 7 Nov: 16 showtimes across a 16-screen
    // multiplex, the busiest list in the world. A filter is worth watching only
    // when there is a lot to filter.
    prefill: { movieId: 'm1', theaterId: 't5', date: '2026-11-07' },
    badge: '4',
    title: { en: 'Showtimes', ko: '상영 시간', ja: '上映時間', 'zh-Hans': '场次', 'zh-Hant': '場次' },
    opener: {
      // Street Fighter runs 2h 4m, so "out by 11" also rules out the 20:45 at
      // some screens. 8:10, 8:10 and 8:45 survive. 16 -> 3.
      en: 'Nothing before 8, and I need to be out by 11.',
      ko: '8시 전은 안 되고, 11시까지는 나와야 해요.',
      ja: '8時より前はだめで、11時までには出たいです。',
      'zh-Hans': '8 点以前的不要，而且我 11 点前得出来。',
      'zh-Hant': '8 點以前的不要，而且我 11 點前要出來。',
    },
    watch: {
      en: 'Sixteen showtimes narrow to three — and the end times appear beside them.',
      ko: '상영 시간 열여섯 개가 세 개로 줄고, 옆에 종료 시각이 표시됩니다.',
      ja: '16の上映時間が3つに絞られ、横に終了時刻が表示されます。',
      'zh-Hans': '十六个场次缩减到三个，旁边会显示结束时间。',
      'zh-Hant': '十六個場次縮減到三個，旁邊會顯示結束時間。',
    },
  },
  {
    id: 'seat',
    stage: 'seat',
    // Klara at Emagine Royal Oak, Wed 4 Nov 7:10 PM: 37% sold, so the map looks
    // used rather than empty, and seven adjacent pairs survive "toward the
    // back, not the front". The planner marks at most three choices (Highlight
    // economy), so `watch` promises "a few of the best-fitting pairs", not
    // every pair: three pairs in row E in a 24 Oct run, none in the two KSEA
    // simulation runs, which asked which row instead. If an agent-side change
    // marks the qualifying pairs as a set again, the old line ("the pairs that
    // actually fit light up") can come back.
    prefill: {
      movieId: 'm2',
      theaterId: 't4',
      date: '2026-11-04',
      showingId: 's_m2_t4_20261104_1910_s2',
    },
    badge: '5',
    title: { en: 'Seats', ko: '좌석', ja: '座席', 'zh-Hans': '座位', 'zh-Hant': '座位' },
    opener: {
      en: 'Two seats together, toward the back — not the front rows.',
      ko: '두 자리 붙어서, 뒤쪽으로요. 앞줄은 말고요.',
      ja: '隣り合った2席で、後ろのほうがいいです。前の列はやめてください。',
      'zh-Hans': '两个连在一起的座位，靠后一点，不要前排。',
      'zh-Hant': '兩個連在一起的座位，靠後面一點，不要前排。',
    },
    watch: {
      en: 'A few of the best-fitting pairs light up, in place, on the map you were already looking at.',
      ko: '조건에 가장 잘 맞는 자리 몇 쌍이 보고 있던 좌석표 위에서 그대로 강조됩니다.',
      ja: '条件に最も合う2席の組がいくつか、今見ている座席表の上でそのまま強調表示されます。',
      'zh-Hans': '最符合条件的几组连座会直接在您正在看的座位图上高亮显示。',
      'zh-Hant': '最符合條件的幾組相連座位會直接在您正在看的座位圖上醒目標示。',
    },
  },
];

export function findQuickDemoCard(id: string | null | undefined): QuickDemoCard | null {
  if (!id) return null;
  return QUICK_DEMO_CARDS.find((card) => card.id === id) ?? null;
}

// =============================================================================
// The link a QR carries
// =============================================================================

export const QUICK_DEMO_CARD_PATH = '/demo/card';

/**
 * Both values ride the URL **fragment**, never the query string.
 *
 * The access code is a credential: it redeems the operator's OpenAI key
 * server-side. A fragment is not sent to the server, so it stays out of access
 * logs, proxy history and `Referer` headers — the same rule the companion and
 * memory-mirror QRs already follow. The card id travels with it only because
 * splitting them across query and fragment would put half the link somewhere it
 * does not need to be.
 */
export function buildQuickDemoCardUrl(
  cardId: string,
  /**
   * Required, rather than defaulted from `window.location`. This module is
   * imported by a node-run check script that typechecks without the DOM lib,
   * and keeping it free of browser globals is what lets the card data be
   * verified against the dataset at all. The one caller that has a `window`
   * passes its origin in.
   */
  origin: string,
  options: { accessCode?: string | null; language?: Language | null } = {}
): string {
  const params = new URLSearchParams({ c: cardId });
  const code = options.accessCode?.trim();
  if (code) params.set('k', code);
  if (options.language) params.set('lang', options.language);
  return `${origin}${QUICK_DEMO_CARD_PATH}#${params.toString()}`;
}

export interface QuickDemoCardLink {
  card: QuickDemoCard | null;
  /** Null when the QR carried no code — the visitor is asked for one instead. */
  accessCode: string | null;
  /** The id as written in the link, kept so an unknown one can be named. */
  rawCardId: string | null;
  /**
   * `lang` in the fragment, for a per-language printed card. LanguageProvider
   * applies it (and removes it from the address bar); it is parsed here too so
   * the card link's whole vocabulary lives in one module.
   */
  language: Language | null;
}

export function parseQuickDemoCardFragment(fragment: string): QuickDemoCardLink {
  const raw = fragment.replace(/^#/, '').trim();
  if (!raw) return { card: null, accessCode: null, rawCardId: null, language: null };
  const params = new URLSearchParams(raw);
  const rawCardId = params.get('c');
  const accessCode = params.get('k')?.trim() || null;
  const rawLanguage = params.get('lang');
  const language = isLanguage(rawLanguage) ? rawLanguage : null;
  return { card: findQuickDemoCard(rawCardId), accessCode, rawCardId, language };
}
