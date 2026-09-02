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
 * and augment on movies, sort on theaters, filter on dates and showtimes,
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
import type { Language } from '../i18n/language';

/** One line, in both booth languages. */
export type CardText = Record<Language, string>;

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
export const QUICK_DEMO_CARDS: QuickDemoCard[] = [
  {
    id: 'movie',
    stage: 'movie',
    badge: '1',
    // Nothing prefilled: this is the stage the demo already opens on, and the
    // card's job is only to supply the sentence.
    prefill: {},
    title: { en: 'Movies', ko: '영화' },
    opener: {
      // Wildwood (PG) and The Legend of Aang (PG) survive; Street Fighter and
      // Klara (PG-13) and Clayface (R) do not. 5 -> 2.
      en: "I've got my eight-year-old niece with me, so nothing scary.",
      ko: '여덟 살 조카랑 같이 왔어요. 무서운 건 안 돼요.',
    },
    watch: {
      en: 'Five films become two — and the age ratings appear on the ones that stay.',
      ko: '영화 다섯 편이 두 편으로 줄고, 남은 영화에 연령 등급이 붙습니다.',
    },
  },
  {
    id: 'theater',
    stage: 'theater',
    // Klara and the Sun is the one film that plays at all five cinemas, so the
    // list starts full and every drop is visible.
    prefill: { movieId: 'm2' },
    badge: '2',
    title: { en: 'Cinemas', ko: '영화관' },
    opener: {
      // Drops MJR Troy (20.4 mi) on distance and Cinema Detroit (Paid Parking)
      // on the amenity, leaving Bel Air 9, Redford 13.8, Emagine 14.2. 5 -> 3.
      en: "I'm not driving more than 15 miles, and I don't want to pay for parking.",
      ko: '15마일 넘게는 운전 안 할 거고, 주차비도 내기 싫어요.',
    },
    watch: {
      en: 'Two cinemas drop out, the rest reorder by distance, and the miles appear.',
      ko: '영화관 두 곳이 빠지고, 남은 곳은 거리순으로 재정렬되며 거리가 표시됩니다.',
    },
  },
  {
    id: 'date',
    stage: 'date',
    prefill: { movieId: 'm2', theaterId: 't4' },
    badge: '3',
    title: { en: 'Dates', ko: '날짜' },
    opener: {
      // The calendar offers Tue 3 Nov through Sun 8 Nov. Sat 7 and Sun 8 stay.
      // 6 -> 2.
      en: 'It has to be the weekend.',
      ko: '주말이어야 해요.',
    },
    watch: {
      en: 'Six days on the calendar, two left standing.',
      ko: '달력의 여섯 날 중 두 날만 남습니다.',
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
    title: { en: 'Showtimes', ko: '상영 시간' },
    opener: {
      // Street Fighter runs 2h 4m, so "out by 11" also rules out the 20:45 at
      // some screens. 8:10, 8:10 and 8:45 survive. 16 -> 3.
      en: 'Nothing before 8, and I need to be out by 11.',
      ko: '8시 전은 안 되고, 11시까지는 나와야 해요.',
    },
    watch: {
      en: 'Sixteen showtimes narrow to three — and the end times appear beside them.',
      ko: '상영 시간 열여섯 개가 세 개로 줄고, 옆에 종료 시각이 표시됩니다.',
    },
  },
  {
    id: 'seat',
    stage: 'seat',
    // Klara at Emagine Royal Oak, Wed 4 Nov 7:10 PM: 37% sold, so the map looks
    // used rather than empty, and seven adjacent pairs survive "middle, not the
    // front" — enough that the highlight reads as a set and not a single guess.
    prefill: {
      movieId: 'm2',
      theaterId: 't4',
      date: '2026-11-04',
      showingId: 's_m2_t4_20261104_1910_s2',
    },
    badge: '5',
    title: { en: 'Seats', ko: '좌석' },
    opener: {
      en: 'Two seats together, toward the back — not the front rows.',
      ko: '두 자리 붙어서, 뒤쪽으로요. 앞줄은 말고요.',
    },
    watch: {
      en: 'The pairs that actually fit light up, in place, on the map you were already looking at.',
      ko: '조건에 맞는 자리 쌍이 보고 있던 좌석표 위에서 그대로 강조됩니다.',
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
  options: { accessCode?: string | null } = {}
): string {
  const params = new URLSearchParams({ c: cardId });
  const code = options.accessCode?.trim();
  if (code) params.set('k', code);
  return `${origin}${QUICK_DEMO_CARD_PATH}#${params.toString()}`;
}

export interface QuickDemoCardLink {
  card: QuickDemoCard | null;
  /** Null when the QR carried no code — the visitor is asked for one instead. */
  accessCode: string | null;
  /** The id as written in the link, kept so an unknown one can be named. */
  rawCardId: string | null;
}

export function parseQuickDemoCardFragment(fragment: string): QuickDemoCardLink {
  const raw = fragment.replace(/^#/, '').trim();
  if (!raw) return { card: null, accessCode: null, rawCardId: null };
  const params = new URLSearchParams(raw);
  const rawCardId = params.get('c');
  const accessCode = params.get('k')?.trim() || null;
  return { card: findQuickDemoCard(rawCardId), accessCode, rawCardId };
}
