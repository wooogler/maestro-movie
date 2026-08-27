import type { GeneratedShowing } from './schedule';
import type { WorldSpec } from './world';

/**
 * The printed cards are for visitors who arrive without a plan of their own.
 * They are the one part of the demo where the constraints are fixed in advance,
 * which makes them the one part that can silently stop working when the world is
 * regenerated: a card whose every constraint is satisfied by exactly one showing
 * is not a decision, and a card satisfied by none is a dead end.
 *
 * Each card is encoded here as the constraints actually printed on it, together
 * with what has to be true for it to be worth handing to someone.
 */
export interface CardCheck {
  id: string;
  label: string;
  /** Showings that satisfy every hard constraint printed on the card. */
  satisfies: (showing: GeneratedShowing, world: WorldSpec) => boolean;
  /** At least this many distinct showings must satisfy it, so there is a choice. */
  minOptions: number;
  /**
   * ...and across at least this many theaters. A card whose every option is at
   * one cinema gives the "closest theater" preference nothing to weigh, which is
   * the half of the demo the card exists to show.
   */
  minTheaters: number;
  /**
   * Card B is deliberately unsatisfiable as stated — that is the conflict it
   * exists to trigger. What it needs instead is a real way out.
   */
  expectUnsatisfiable?: boolean;
  fallback?: {
    label: string;
    satisfies: (showing: GeneratedShowing, world: WorldSpec) => boolean;
    minOptions: number;
    minTheaters: number;
  };
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function endsBy(showing: GeneratedShowing, limitMinutes: number): boolean {
  return showing.startMinutes + showing.durationMinutes <= limitMinutes;
}

function theaterOf(showing: GeneratedShowing, world: WorldSpec) {
  return world.theaters.find((theater) => theater.id === showing.theaterId);
}

function movieOf(showing: GeneratedShowing, world: WorldSpec) {
  return world.movies.find((movie) => movie.id === showing.movieId);
}

export const DEMO_CARDS: CardCheck[] = [
  {
    id: 'demo_card_a_tonight',
    label: 'A — Klara and the Sun tonight, within 15 miles, starts after 20:00, back by midnight',
    minOptions: 2,
    minTheaters: 2,
    satisfies: (showing, world) => {
      const theater = theaterOf(showing, world);
      return (
        showing.movieId === 'm2' &&
        showing.date === world.todayIso &&
        showing.startMinutes >= 20 * 60 &&
        endsBy(showing, 24 * 60) &&
        (theater?.distanceMiles ?? Infinity) <= 15
      );
    },
  },
  {
    id: 'demo_card_b_imax_night',
    label: 'B — Street Fighter in IMAX within 15 miles, 18:30-23:00',
    minOptions: 1,
    minTheaters: 1,
    expectUnsatisfiable: true,
    satisfies: (showing, world) => {
      const theater = theaterOf(showing, world);
      return (
        showing.movieId === 'm1' &&
        showing.date === '2026-11-05' &&
        showing.format === 'IMAX' &&
        showing.startMinutes >= 18 * 60 + 30 &&
        endsBy(showing, 23 * 60) &&
        (theater?.distanceMiles ?? Infinity) <= 15
      );
    },
    fallback: {
      // Two ways out: drop IMAX and stay close, or keep IMAX and drive further.
      label: 'B fallback — same night, either drop IMAX or extend the drive',
      minOptions: 2,
      minTheaters: 2,
      satisfies: (showing, world) => {
        const theater = theaterOf(showing, world);
        if (showing.movieId !== 'm1' || showing.date !== '2026-11-05') return false;
        if (showing.startMinutes < 18 * 60 + 30 || !endsBy(showing, 23 * 60)) return false;
        const close = (theater?.distanceMiles ?? Infinity) <= 15;
        const imax = showing.format === 'IMAX';
        return close || imax;
      },
    },
  },
  {
    id: 'demo_card_c_family_matinee',
    label: 'C — PG or below on 5 Nov, out by 17:00',
    minOptions: 4,
    minTheaters: 3,
    satisfies: (showing, world) => {
      const movie = movieOf(showing, world);
      return (
        showing.date === '2026-11-05' &&
        (movie?.ageRating === 'G' || movie?.ageRating === 'PG') &&
        endsBy(showing, 17 * 60)
      );
    },
  },
];

export interface CardFeasibilityResult {
  card: CardCheck;
  optionCount: number;
  optionTheaters: number;
  fallbackCount: number | null;
  fallbackTheaters: number | null;
  ok: boolean;
  message: string;
}

export function checkCardFeasibility(
  world: WorldSpec,
  showings: GeneratedShowing[]
): CardFeasibilityResult[] {
  const countTheaters = (matches: GeneratedShowing[]) =>
    new Set(matches.map((showing) => showing.theaterId)).size;

  return DEMO_CARDS.map((card) => {
    const matches = showings.filter((showing) => card.satisfies(showing, world));
    const optionCount = matches.length;
    const optionTheaters = countTheaters(matches);

    const fallbackMatches = card.fallback
      ? showings.filter((showing) => card.fallback!.satisfies(showing, world))
      : null;
    const fallbackCount = fallbackMatches?.length ?? null;
    const fallbackTheaters = fallbackMatches ? countTheaters(fallbackMatches) : null;

    if (card.expectUnsatisfiable) {
      const conflictHolds = optionCount === 0;
      const hasWayOut =
        (fallbackCount ?? 0) >= (card.fallback?.minOptions ?? 1) &&
        (fallbackTheaters ?? 0) >= (card.fallback?.minTheaters ?? 1);
      return {
        card,
        optionCount,
        optionTheaters,
        fallbackCount,
        fallbackTheaters,
        ok: conflictHolds && hasWayOut,
        message: conflictHolds
          ? hasWayOut
            ? `conflict holds, ${fallbackCount} way(s) out at ${fallbackTheaters} theaters`
            : `conflict holds but only ${fallbackCount} way(s) out at ${fallbackTheaters} theaters`
          : `expected no direct match, found ${optionCount} — the card no longer conflicts`,
      };
    }

    const ok = optionCount >= card.minOptions && optionTheaters >= card.minTheaters;
    return {
      card,
      optionCount,
      optionTheaters,
      fallbackCount,
      fallbackTheaters,
      ok,
      message: ok
        ? `${optionCount} option(s) at ${optionTheaters} theaters`
        : `${optionCount} option(s) at ${optionTheaters} theaters, needs ${card.minOptions} at ${card.minTheaters}`,
    };
  });
}
