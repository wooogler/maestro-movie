import type { GeneratedShowing } from './schedule';
import { buildDates } from './schedule';
import { buildRowLabels, tierForRow } from './seats';
import type { SeatOccupancyPlan } from './seats';
import type { TheaterSpec, WorldSpec } from './world';

/**
 * The demo is driven by whatever preference a conference visitor happens to
 * state, not by a script. That only works if no branch of the booking tree is a
 * cul-de-sac: every film has several cinemas, every cinema-day has several
 * showtimes, and every showing still has seats worth choosing between.
 *
 * These are the properties that have to hold for that to be true. They are
 * checked after generation and the build fails on any violation, because a
 * dataset that quietly loses a branch looks fine right up until someone at the
 * booth asks for it.
 */
export interface InvariantViolation {
  rule: string;
  detail: string;
}

/** Minimum minutes between the end of one showing and the start of the next on a screen. */
const MIN_TURNOVER = 15;

interface SeatMap {
  rows: string[];
  seatsPerRow: number;
  occupied: Set<string>;
}

function seatMapFor(
  plan: SeatOccupancyPlan,
  theater: TheaterSpec
): SeatMap {
  const occupied = new Set<string>();
  for (const [row, numbers] of plan.occupiedByRow) {
    for (const number of numbers) occupied.add(`${row}${number}`);
  }
  return {
    rows: buildRowLabels(theater.house.rowCount),
    seatsPerRow: theater.house.seatsPerRow,
    occupied,
  };
}

/** Longest stretch of free seats in a row, and where it starts. */
export function longestFreeRun(
  map: SeatMap,
  row: string
): { length: number; start: number } {
  let best = { length: 0, start: 0 };
  let current = 0;
  for (let number = 1; number <= map.seatsPerRow; number += 1) {
    if (map.occupied.has(`${row}${number}`)) {
      current = 0;
      continue;
    }
    current += 1;
    if (current > best.length) best = { length: current, start: number - current + 1 };
  }
  return best;
}

export function bestFreeRun(
  plan: SeatOccupancyPlan,
  theater: TheaterSpec
): { row: string; length: number; start: number } {
  const map = seatMapFor(plan, theater);
  let best = { row: map.rows[0], length: 0, start: 1 };
  for (const row of map.rows) {
    const run = longestFreeRun(map, row);
    if (run.length > best.length) best = { row, length: run.length, start: run.start };
  }
  return best;
}

function freePremiumSeats(plan: SeatOccupancyPlan, theater: TheaterSpec): number {
  const map = seatMapFor(plan, theater);
  let free = 0;
  map.rows.forEach((row, rowIndex) => {
    if (tierForRow(theater.house, rowIndex).type === 'standard') return;
    for (let number = 1; number <= map.seatsPerRow; number += 1) {
      if (!map.occupied.has(`${row}${number}`)) free += 1;
    }
  });
  return free;
}

function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

export function checkInvariants(
  world: WorldSpec,
  showings: GeneratedShowing[],
  plans: SeatOccupancyPlan[]
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const dates = buildDates(world);
  const theaterById = new Map(world.theaters.map((theater) => [theater.id, theater]));
  const planById = new Map(plans.map((plan) => [plan.showingId, plan]));

  const add = (rule: string, detail: string) => violations.push({ rule, detail });

  // --- Reachability: no stage may present a single take-it-or-leave-it option ---

  for (const movie of world.movies) {
    const mine = showings.filter((showing) => showing.movieId === movie.id);
    const theaters = new Set(mine.map((showing) => showing.theaterId));
    if (theaters.size < 3) {
      add('movie-has-3-theaters', `${movie.title} plays at only ${theaters.size} theater(s)`);
    }

    for (const date of dates) {
      const onDate = mine.filter((showing) => showing.date === date);
      const dateTheaters = new Set(onDate.map((showing) => showing.theaterId));
      if (dateTheaters.size < 2) {
        add(
          'movie-has-2-theaters-per-date',
          `${movie.title} on ${date} plays at ${dateTheaters.size} theater(s)`
        );
      }
      if (!onDate.some((showing) => showing.format === 'Standard')) {
        add('standard-format-always-available', `${movie.title} on ${date} has no standard showing`);
      }
    }
  }

  const tripleCounts = new Map<string, number>();
  for (const showing of showings) {
    const key = `${showing.movieId}|${showing.theaterId}|${showing.date}`;
    tripleCounts.set(key, (tripleCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of tripleCounts) {
    if (count < 2) {
      add('two-showtimes-per-theater-day', `${key} has only ${count} showtime`);
    }
  }

  for (const theater of world.theaters) {
    const mine = showings.filter((showing) => showing.theaterId === theater.id);
    const movies = new Set(mine.map((showing) => showing.movieId));
    if (movies.size < 2) {
      add('theater-shows-2-movies', `${theater.name} shows only ${movies.size} movie(s)`);
    }
    for (const date of dates) {
      if (!mine.some((showing) => showing.date === date)) {
        add('theater-open-every-date', `${theater.name} has nothing on ${date}`);
      }
    }

    // A theater that advertises a format has to actually run it, or an amenity
    // preference points at a promise the listings do not keep.
    for (const format of theater.formats) {
      if (format === 'Standard') continue;
      const datesWithFormat = new Set(
        mine.filter((showing) => showing.format === format).map((showing) => showing.date)
      );
      if (datesWithFormat.size < dates.length) {
        add(
          'advertised-format-runs-every-date',
          `${theater.name} advertises ${format} but runs it on ${datesWithFormat.size}/${dates.length} dates`
        );
      }
    }
  }

  for (const date of dates) {
    const onDate = showings.filter((showing) => showing.date === date);
    const movies = new Set(onDate.map((showing) => showing.movieId));
    const theaters = new Set(onDate.map((showing) => showing.theaterId));
    if (movies.size < 4) add('date-offers-4-movies', `${date} offers ${movies.size} movie(s)`);
    if (theaters.size < 4) add('date-offers-4-theaters', `${date} offers ${theaters.size} theater(s)`);

    // Family and adults-only preferences both have to resolve on any given day.
    const ageRatings = new Set(
      onDate.map(
        (showing) => world.movies.find((movie) => movie.id === showing.movieId)?.ageRating
      )
    );
    if (!ageRatings.has('G') && !ageRatings.has('PG')) {
      add('date-has-family-option', `${date} has no G/PG option`);
    }
    if (!ageRatings.has('R')) {
      add('date-has-adult-option', `${date} has no R-rated option`);
    }
  }

  // --- Physical plausibility: one projector cannot run two films at once ---

  const byScreen = new Map<string, GeneratedShowing[]>();
  for (const showing of showings) {
    const key = `${showing.theaterId}|${showing.date}|${showing.screenNumber}`;
    const bucket = byScreen.get(key) ?? [];
    bucket.push(showing);
    byScreen.set(key, bucket);
  }
  for (const [key, bucket] of byScreen) {
    const sorted = bucket.slice().sort((a, b) => a.startMinutes - b.startMinutes);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const previousEnds = previous.startMinutes + previous.durationMinutes;
      if (current.startMinutes < previousEnds + MIN_TURNOVER) {
        add(
          'no-overlapping-showings-on-a-screen',
          `${key}: ${previous.time} (${previous.durationMinutes}m) overlaps ${current.time}`
        );
      }
    }
  }

  for (const showing of showings) {
    if (parseTimeToMinutes(showing.time) !== showing.startMinutes) {
      add('time-matches-start-minutes', `${showing.id} time ${showing.time}`);
    }
  }

  // --- Seats: every showing is bookable, and group bookings always have a home ---

  for (const plan of plans) {
    const showing = showings.find((entry) => entry.id === plan.showingId);
    const theater = showing ? theaterById.get(showing.theaterId) : undefined;
    if (!showing || !theater) continue;

    const occupancy = plan.occupiedCount / plan.totalSeats;
    if (occupancy > 0.88) {
      add('showing-never-sold-out', `${plan.showingId} is ${(occupancy * 100).toFixed(0)}% full`);
    }
    const run = bestFreeRun(plan, theater);
    if (run.length < 2) {
      add('every-showing-keeps-a-free-pair', `${plan.showingId} has no two adjacent free seats`);
    }
  }

  for (const movie of world.movies) {
    for (const date of dates) {
      const group = showings.filter(
        (showing) => showing.movieId === movie.id && showing.date === date
      );
      const withQuad = group.filter((showing) => {
        const plan = planById.get(showing.id);
        const theater = theaterById.get(showing.theaterId);
        if (!plan || !theater) return false;
        return bestFreeRun(plan, theater).length >= 4;
      });
      if (withQuad.length === 0) {
        add(
          'group-of-four-can-always-book',
          `${movie.title} on ${date} has no showing with 4 adjacent free seats`
        );
      }

      const withPremium = group.filter((showing) => {
        const plan = planById.get(showing.id);
        const theater = theaterById.get(showing.theaterId);
        if (!plan || !theater) return false;
        if (!theater.house.tiers.some((tier) => tier.type !== 'standard')) return false;
        return freePremiumSeats(plan, theater) >= 2;
      });
      if (withPremium.length === 0) {
        add(
          'premium-seats-always-available',
          `${movie.title} on ${date} has no showing with 2 free premium seats`
        );
      }
    }
  }

  return violations;
}
