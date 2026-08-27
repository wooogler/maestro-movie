import type { Rng } from './rng';
import type { GeneratedShowing } from './schedule';
import { weekdayOf } from './schedule';
import type { HouseSpec, MovieSpec, SeatTier, TheaterSpec } from './world';

export interface SeatOccupancyPlan {
  showingId: string;
  /** Row label -> occupied seat numbers. Rows with nobody in them are omitted. */
  occupiedByRow: Map<string, number[]>;
  /** Kept for the invariant report, not written to the dataset. */
  demand: number;
  occupiedCount: number;
  totalSeats: number;
}

const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function buildRowLabels(rowCount: number): string[] {
  if (rowCount > ROW_LABELS.length) {
    throw new Error(`House has ${rowCount} rows; only ${ROW_LABELS.length} row labels exist`);
  }
  return ROW_LABELS.slice(0, rowCount).split('');
}

/** Tiers are declared front to back; the last one whose threshold is met wins. */
export function tierForRow(house: HouseSpec, rowIndex: number): SeatTier {
  const fraction = house.rowCount === 1 ? 0 : rowIndex / (house.rowCount - 1);
  let chosen = house.tiers[0];
  for (const tier of house.tiers) {
    if (fraction >= tier.fromRowFraction) chosen = tier;
  }
  return chosen;
}

/**
 * How much people want a given seat. Peaks a little behind the middle of the
 * room and in the centre columns, which is why the front corners of a real
 * auditorium are still empty when the good seats have gone.
 */
function seatDesirability(house: HouseSpec, rowIndex: number, seatNumber: number): number {
  const depth = house.rowCount === 1 ? 0.62 : rowIndex / (house.rowCount - 1);
  const rowScore = clamp(1 - Math.abs(depth - 0.62) * 1.6, 0.15, 1);

  const centre = (house.seatsPerRow + 1) / 2;
  const offset = Math.abs(seatNumber - centre) / Math.max(1, centre - 1);
  const columnScore = clamp(1 - offset * 0.75, 0.25, 1);

  return rowScore * columnScore;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DAY_FACTOR: Record<number, number> = {
  0: 0.72, // Sunday
  1: 0.5,
  2: 0.52,
  3: 0.56,
  4: 0.62,
  5: 0.88, // Friday
  6: 1, // Saturday
};

function timeFactor(startMinutes: number): number {
  if (startMinutes < 12 * 60) return 0.45;
  if (startMinutes < 16 * 60 + 30) return 0.62;
  if (startMinutes < 18 * 60 + 30) return 0.8;
  if (startMinutes < 21 * 60) return 1;
  return 0.62;
}

function formatFactor(format: GeneratedShowing['format']): number {
  if (format === 'IMAX') return 1.18;
  if (format === '3D') return 1.06;
  return 1;
}

/** Never sell a house out: a booking demo with no seats left is a broken demo. */
const MAX_OCCUPANCY = 0.86;

function demandFor(
  showing: GeneratedShowing,
  movie: MovieSpec,
  theater: TheaterSpec,
  rng: Rng
): number {
  const raw =
    movie.popularity *
    (DAY_FACTOR[weekdayOf(showing.date)] ?? 0.6) *
    timeFactor(showing.startMinutes) *
    formatFactor(showing.format) *
    theater.demandFactor *
    rng.float(0.85, 1.15);
  return clamp(0.1 + 1.05 * raw, 0.05, MAX_OCCUPANCY);
}

/** Party sizes, roughly as cinemas actually sell them. */
function drawPartySize(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.22) return 1;
  if (roll < 0.68) return 2;
  if (roll < 0.83) return 3;
  return 4;
}

interface Run {
  rowIndex: number;
  start: number;
  size: number;
  score: number;
}

/** Contiguous free stretches of exactly `size`, ranked by how good the seats are. */
function findRuns(
  house: HouseSpec,
  rows: string[],
  taken: Set<string>,
  size: number
): Run[] {
  const runs: Run[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let start = 1; start + size - 1 <= house.seatsPerRow; start += 1) {
      let free = true;
      let score = 0;
      for (let offset = 0; offset < size; offset += 1) {
        const number = start + offset;
        if (taken.has(`${rows[rowIndex]}${number}`)) {
          free = false;
          break;
        }
        score += seatDesirability(house, rowIndex, number);
      }
      if (free) runs.push({ rowIndex, start, size, score: score / size });
    }
  }
  return runs;
}

/**
 * Picks a good run without always picking THE best one. The exponent does the
 * real work: people take the middle of the room first and the front corners
 * last, so a nearly full house has to be full at the back and empty at the
 * front. Pure greed would produce a perfect diamond, which reads as generated,
 * so the choice stays probabilistic.
 */
const SEAT_PREFERENCE_SHARPNESS = 6;

function chooseRun(runs: Run[], rng: Rng): Run | null {
  if (runs.length === 0) return null;
  return rng.weighted(runs, (run) => Math.pow(run.score, SEAT_PREFERENCE_SHARPNESS));
}

interface Guarantee {
  /** Every showing keeps a free pair, so two people can always sit together. */
  pair: boolean;
  /** One showing per movie and date keeps a free four in the good seats. */
  quad: boolean;
  /** ...and two free premium seats, where the house sells them. */
  premiumPair: boolean;
}

function reserveRun(
  house: HouseSpec,
  rows: string[],
  reserved: Set<string>,
  size: number,
  rowFilter: (rowIndex: number) => boolean,
  prefer: 'best' | 'plausible',
  rng: Rng
): boolean {
  const candidates = findRuns(house, rows, reserved, size).filter((run) =>
    rowFilter(run.rowIndex)
  );
  if (candidates.length === 0) return false;

  // In a quiet house the held-back block sits among the good seats. In a busy
  // one it has to sit where seats would genuinely still be going — the front
  // rows and the edges — or the map shows a suspicious hole in the best row.
  const sorted = candidates
    .slice()
    .sort((a, b) => (prefer === 'best' ? b.score - a.score : a.score - b.score));
  const shortlist = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.3)));
  const chosen = shortlist[rng.int(0, shortlist.length - 1)];
  for (let offset = 0; offset < size; offset += 1) {
    reserved.add(`${rows[chosen.rowIndex]}${chosen.start + offset}`);
  }
  return true;
}

function planShowing(
  showing: GeneratedShowing,
  movie: MovieSpec,
  theater: TheaterSpec,
  guarantee: Guarantee,
  rng: Rng
): SeatOccupancyPlan {
  const house = theater.house;
  const rows = buildRowLabels(house.rowCount);
  const totalSeats = house.rowCount * house.seatsPerRow;
  const demand = demandFor(showing, movie, theater, rng);

  // Reserved seats are held back before anyone is seated, so the guarantees hold
  // by construction instead of being repaired afterwards.
  const reserved = new Set<string>();
  const primeRow = (rowIndex: number) => {
    const depth = house.rowCount === 1 ? 0.62 : rowIndex / (house.rowCount - 1);
    return depth >= 0.35 && depth <= 0.85;
  };

  const prefer = demand > 0.55 ? 'plausible' : 'best';

  if (guarantee.quad) {
    if (!reserveRun(house, rows, reserved, 4, primeRow, prefer, rng)) {
      reserveRun(house, rows, reserved, 4, () => true, prefer, rng);
    }
  }
  if (guarantee.pair) {
    reserveRun(house, rows, reserved, 2, () => true, prefer, rng);
  }
  if (guarantee.premiumPair) {
    const isPremium = (rowIndex: number) => tierForRow(house, rowIndex).type !== 'standard';
    if (rows.some((_, rowIndex) => isPremium(rowIndex))) {
      reserveRun(house, rows, reserved, 2, isPremium, prefer, rng);
    }
    const isStandard = (rowIndex: number) => tierForRow(house, rowIndex).type === 'standard';
    reserveRun(house, rows, reserved, 2, isStandard, prefer, rng);
  }

  const taken = new Set<string>(reserved);
  const occupied = new Set<string>();
  const targetOccupied = Math.min(
    Math.round(totalSeats * demand),
    totalSeats - reserved.size - 2
  );

  const courtesyGapChance = clamp(0.55 - demand * 0.6, 0, 0.5);
  let guard = totalSeats * 4;
  while (occupied.size < targetOccupied && guard > 0) {
    guard -= 1;
    let size = drawPartySize(rng);
    if (occupied.size + size > targetOccupied) {
      size = targetOccupied - occupied.size;
    }
    if (size <= 0) break;

    let run = chooseRun(findRuns(house, rows, taken, size), rng);
    // A party that cannot sit together splits up rather than giving up, which is
    // what leaves the scattered singles a real seat map has.
    while (!run && size > 1) {
      size -= 1;
      run = chooseRun(findRuns(house, rows, taken, size), rng);
    }
    if (!run) break;

    for (let offset = 0; offset < size; offset += 1) {
      const key = `${rows[run.rowIndex]}${run.start + offset}`;
      occupied.add(key);
      taken.add(key);
    }

    // Strangers leave a seat between parties when the room is empty enough to
    // allow it. This is where the single-seat holes in a real map come from.
    if (rng.bool(courtesyGapChance)) {
      for (const neighbour of [run.start - 1, run.start + size]) {
        if (neighbour >= 1 && neighbour <= house.seatsPerRow) {
          taken.add(`${rows[run.rowIndex]}${neighbour}`);
        }
      }
    }
  }

  const occupiedByRow = new Map<string, number[]>();
  for (const key of occupied) {
    const row = key.slice(0, 1);
    const number = Number.parseInt(key.slice(1), 10);
    const bucket = occupiedByRow.get(row) ?? [];
    bucket.push(number);
    occupiedByRow.set(row, bucket);
  }
  for (const numbers of occupiedByRow.values()) {
    numbers.sort((a, b) => a - b);
  }

  return {
    showingId: showing.id,
    occupiedByRow,
    demand,
    occupiedCount: occupied.size,
    totalSeats,
  };
}

export function planOccupancy(
  showings: GeneratedShowing[],
  movies: MovieSpec[],
  theaters: TheaterSpec[],
  rng: Rng
): SeatOccupancyPlan[] {
  const movieById = new Map(movies.map((movie) => [movie.id, movie]));
  const theaterById = new Map(theaters.map((theater) => [theater.id, theater]));

  // One showing per movie per day is nominated to keep a family-sized block and a
  // premium pair free. The quietest one gets the job, where it is most plausible.
  const nominated = new Set<string>();
  const groups = new Map<string, GeneratedShowing[]>();
  for (const showing of showings) {
    const key = `${showing.movieId}|${showing.date}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(showing);
    groups.set(key, bucket);
  }
  for (const [, bucket] of groups) {
    const premiumFirst = bucket
      .slice()
      .sort((a, b) => {
        const aHasPremium = hasPremiumRows(theaterById.get(a.theaterId));
        const bHasPremium = hasPremiumRows(theaterById.get(b.theaterId));
        if (aHasPremium !== bHasPremium) return aHasPremium ? -1 : 1;
        return a.startMinutes - b.startMinutes;
      });
    if (premiumFirst.length > 0) nominated.add(premiumFirst[0].id);
    // A second nomination at a different theater keeps the guarantee from
    // funnelling every group booking into one cinema.
    const other = premiumFirst.find((entry) => entry.theaterId !== premiumFirst[0].theaterId);
    if (other) nominated.add(other.id);
  }

  return showings.map((showing) => {
    const movie = movieById.get(showing.movieId);
    const theater = theaterById.get(showing.theaterId);
    if (!movie || !theater) {
      throw new Error(`Showing ${showing.id} references an unknown movie or theater`);
    }
    const seatRng = rng.fork(`seats:${showing.id}`);
    return planShowing(
      showing,
      movie,
      theater,
      {
        pair: true,
        quad: nominated.has(showing.id),
        premiumPair: nominated.has(showing.id),
      },
      seatRng
    );
  });
}

function hasPremiumRows(theater: TheaterSpec | undefined): boolean {
  if (!theater) return false;
  return theater.house.tiers.some((tier) => tier.type !== 'standard');
}
