import fs from 'fs';
import path from 'path';
import { Rng } from './rng';
import { buildDates, buildSchedule, isWeekend } from './schedule';
import type { GeneratedShowing } from './schedule';
import { buildRowLabels, planOccupancy, tierForRow } from './seats';
import type { SeatOccupancyPlan } from './seats';
import { bestFreeRun, checkInvariants } from './invariants';
import { checkCardFeasibility } from './cardFeasibility';
import { DETROIT_UIST_2026 } from './world';
import type { HouseSpec, TheaterSpec, WorldSpec } from './world';
import { formatDurationMinutes } from '../../utils/duration';
import type {
  ScenarioDataset,
  ScenarioSeatOverride,
  ScenarioSeatTemplate,
  ScenarioSeatTemplateOverride,
} from '../../study/scenarioDataset';

function seatTemplateFor(house: HouseSpec): ScenarioSeatTemplate {
  const rows = buildRowLabels(house.rowCount);
  const rowRules = rows.map((row, rowIndex) => {
    const tier = tierForRow(house, rowIndex);
    return { row, type: tier.type, price: tier.price };
  });
  const base = tierForRow(house, 0);
  return {
    rows,
    seatsPerRow: house.seatsPerRow,
    defaultType: base.type,
    defaultPrice: base.price,
    defaultStatus: 'available',
    rowRules,
  };
}

function buildSeatOverrides(plans: SeatOccupancyPlan[]): ScenarioSeatOverride[] {
  const overrides: ScenarioSeatOverride[] = [];
  for (const plan of plans) {
    for (const [row, occupiedNumbers] of plan.occupiedByRow) {
      if (occupiedNumbers.length === 0) continue;
      overrides.push({ showingId: plan.showingId, row, occupiedNumbers });
    }
  }
  return overrides;
}

function buildDataset(
  world: WorldSpec,
  showings: GeneratedShowing[],
  plans: SeatOccupancyPlan[]
): ScenarioDataset {
  // The theater with the most showings supplies the default layout; the rest are
  // overrides, so the common case stays readable in the JSON.
  const showingCountByTheater = new Map<string, number>();
  for (const showing of showings) {
    showingCountByTheater.set(
      showing.theaterId,
      (showingCountByTheater.get(showing.theaterId) ?? 0) + 1
    );
  }
  const defaultTheater = world.theaters.reduce((best, theater) =>
    (showingCountByTheater.get(theater.id) ?? 0) > (showingCountByTheater.get(best.id) ?? 0)
      ? theater
      : best
  );

  const seatTemplate = seatTemplateFor(defaultTheater.house);
  const seatTemplateOverrides: ScenarioSeatTemplateOverride[] = world.theaters
    .filter((theater) => theater.id !== defaultTheater.id)
    .map((theater) => ({ theaterId: theater.id, ...seatTemplateFor(theater.house) }));

  const dateRules = buildDateRules(showings);
  const adjacencyRules = buildAdjacencyRules(world, showings, plans);

  return {
    // Carried into the dataset so the runtime does not have to be told
    // separately what day this world is set on.
    todayIso: world.todayIso,
    dateCount: world.dateCount,
    movies: world.movies.map((movie) => ({
      id: movie.id,
      title: movie.title,
      genre: movie.genre,
      duration: formatDurationMinutes(movie.durationMinutes),
      rating: movie.rating,
      ageRating: movie.ageRating,
      synopsis: movie.synopsis,
      releaseDate: movie.releaseDate,
    })),
    theaters: world.theaters.map((theater) => ({
      id: theater.id,
      name: theater.name,
      location: theater.location,
      screenCount: theater.screenCount,
      distanceMiles: theater.distanceMiles,
      amenities: theater.amenities,
    })),
    showings: showings.map((showing) => ({
      id: showing.id,
      movieId: showing.movieId,
      theaterId: showing.theaterId,
      screenNumber: showing.screenNumber,
      date: showing.date,
      time: showing.time,
      format: showing.format,
      totalSeats: showing.totalSeats,
    })),
    seatTemplate,
    seatTemplateOverrides,
    seatOverrides: buildSeatOverrides(plans),
    assertions: {
      expectedMovieIds: world.movies.map((movie) => movie.id),
      expectedTheaterIds: world.theaters.map((theater) => theater.id),
      theaterDistanceChecks: world.theaters.map((theater) => ({
        theaterId: theater.id,
        distanceMiles: theater.distanceMiles,
      })),
      dateRules,
      adjacencyRules,
    },
  };
}

function buildDateRules(showings: GeneratedShowing[]) {
  const byPair = new Map<string, Set<string>>();
  for (const showing of showings) {
    const key = `${showing.movieId}|${showing.theaterId}`;
    const bucket = byPair.get(key) ?? new Set<string>();
    bucket.add(showing.date);
    byPair.set(key, bucket);
  }
  return Array.from(byPair.entries())
    .map(([key, dates]) => {
      const [movieId, theaterId] = key.split('|');
      return { movieId, theaterId, expectedDates: Array.from(dates).sort() };
    })
    .sort((a, b) => a.movieId.localeCompare(b.movieId) || a.theaterId.localeCompare(b.theaterId));
}

/**
 * Records the group-booking guarantee as an assertion: for each movie and date,
 * the showing that holds the widest free block, and how wide it is.
 */
function buildAdjacencyRules(
  world: WorldSpec,
  showings: GeneratedShowing[],
  plans: SeatOccupancyPlan[]
) {
  const theaterById = new Map(world.theaters.map((theater) => [theater.id, theater]));
  const planById = new Map(plans.map((plan) => [plan.showingId, plan]));
  const rules: Array<{ showingId: string; row: string; minAdjacentAvailable: number }> = [];

  for (const movie of world.movies) {
    for (const date of buildDates(world)) {
      const group = showings.filter(
        (showing) => showing.movieId === movie.id && showing.date === date
      );
      let best: { showingId: string; row: string; length: number } | null = null;
      for (const showing of group) {
        const plan = planById.get(showing.id);
        const theater = theaterById.get(showing.theaterId);
        if (!plan || !theater) continue;
        const run = bestFreeRun(plan, theater);
        if (!best || run.length > best.length) {
          best = { showingId: showing.id, row: run.row, length: run.length };
        }
      }
      if (best && best.length >= 2) {
        rules.push({
          showingId: best.showingId,
          row: best.row,
          minAdjacentAvailable: Math.min(best.length, 4),
        });
      }
    }
  }

  return rules;
}

function occupancyHistogram(plans: SeatOccupancyPlan[]): string {
  const buckets = new Array(10).fill(0);
  for (const plan of plans) {
    const ratio = plan.occupiedCount / plan.totalSeats;
    buckets[Math.min(9, Math.floor(ratio * 10))] += 1;
  }
  const max = Math.max(...buckets, 1);
  return buckets
    .map((count, index) => {
      const label = `${index * 10}-${index * 10 + 9}%`.padStart(8);
      const bar = '#'.repeat(Math.round((count / max) * 40));
      return `    ${label} ${String(count).padStart(4)} ${bar}`;
    })
    .join('\n');
}

function renderSeatMap(plan: SeatOccupancyPlan, theater: TheaterSpec): string {
  const rows = buildRowLabels(theater.house.rowCount);
  const lines = rows.map((row, rowIndex) => {
    const occupied = new Set(plan.occupiedByRow.get(row) ?? []);
    const tier = tierForRow(theater.house, rowIndex);
    const cells = Array.from({ length: theater.house.seatsPerRow }, (_, index) =>
      occupied.has(index + 1) ? 'X' : '.'
    ).join('');
    return `    ${row} ${cells}  ${tier.type}`;
  });
  return lines.join('\n');
}

function parseArgs(argv: string[]): {
  seed: number;
  out: string;
  quiet: boolean;
  verify: boolean;
} {
  let seed = 20261103;
  // Resolved from this file, not from the cwd: `npm run scenarios:generate`
  // goes through the workspace, so the process starts in apps/backend and a
  // repo-root-relative default writes apps/backend/apps/backend/... instead.
  // An explicit --out stays relative to wherever the caller is standing.
  let out = path.resolve(__dirname, '../../../scenarios/data/demo_uist2026_detroit.json');
  let quiet = false;
  let verify = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--seed') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isFinite(value)) throw new Error('--seed needs an integer');
      seed = value;
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out needs a path');
      out = value;
      index += 1;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--verify') {
      verify = true;
    }
  }

  return { seed, out, quiet, verify };
}

function main(): void {
  const { seed, out, quiet, verify } = parseArgs(process.argv.slice(2));
  const world = DETROIT_UIST_2026;
  const rng = new Rng(seed);

  const showings = buildSchedule(world, rng);
  const plans = planOccupancy(showings, world.movies, world.theaters, rng);
  const violations = checkInvariants(world, showings, plans);
  const cardResults = checkCardFeasibility(world, showings);
  for (const result of cardResults) {
    if (!result.ok) {
      violations.push({ rule: 'printed-card-is-runnable', detail: `${result.card.label}: ${result.message}` });
    }
  }

  if (violations.length > 0) {
    console.error(`\n[generate] ${violations.length} invariant violation(s) — nothing was written.`);
    const byRule = new Map<string, string[]>();
    for (const violation of violations) {
      const bucket = byRule.get(violation.rule) ?? [];
      bucket.push(violation.detail);
      byRule.set(violation.rule, bucket);
    }
    for (const [rule, details] of byRule) {
      console.error(`\n  ${rule} (${details.length})`);
      for (const detail of details.slice(0, 6)) console.error(`    - ${detail}`);
      if (details.length > 6) console.error(`    ... ${details.length - 6} more`);
    }
    process.exit(1);
  }

  const dataset = buildDataset(world, showings, plans);
  const outPath = path.resolve(process.cwd(), out);
  const serialized = `${JSON.stringify(dataset, null, 2)}\n`;

  // --verify regenerates and compares instead of writing, so a checked-in
  // dataset cannot drift away from the generator that is supposed to produce it.
  if (verify) {
    if (!fs.existsSync(outPath)) {
      console.error(`[verify] ${outPath} does not exist — run the generator first.`);
      process.exit(1);
    }
    if (fs.readFileSync(outPath, 'utf-8') !== serialized) {
      console.error(
        `[verify] ${outPath} does not match seed ${seed}. Regenerate it, or pass the seed it was built with.`
      );
      process.exit(1);
    }
    console.log(
      `[verify] ${out} matches seed ${seed}; ${showings.length} showings, all invariants and printed cards hold.`
    );
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serialized);

  if (quiet) {
    console.log(`[generate] ${outPath} (seed ${seed})`);
    return;
  }

  const dates = buildDates(world);
  const totalSeats = plans.reduce((sum, plan) => sum + plan.totalSeats, 0);
  const totalOccupied = plans.reduce((sum, plan) => sum + plan.occupiedCount, 0);

  console.log(`\n[generate] seed ${seed} -> ${outPath}`);
  console.log(`\n  Window   ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} days)`);
  console.log(`  Movies   ${world.movies.length}`);
  console.log(`  Theaters ${world.theaters.length}`);
  console.log(`  Showings ${showings.length}`);
  console.log(`  Seats    ${totalSeats} (${((totalOccupied / totalSeats) * 100).toFixed(1)}% sold)`);

  console.log('\n  Showings per theater');
  for (const theater of world.theaters) {
    const mine = showings.filter((showing) => showing.theaterId === theater.id);
    const formats = new Map<string, number>();
    for (const showing of mine) {
      formats.set(showing.format, (formats.get(showing.format) ?? 0) + 1);
    }
    const formatSummary = Array.from(formats.entries())
      .map(([format, count]) => `${format} ${count}`)
      .join(', ');
    console.log(
      `    ${theater.name.padEnd(36)} ${String(mine.length).padStart(4)}  ${formatSummary}`
    );
  }

  console.log('\n  Theaters per movie');
  for (const movie of world.movies) {
    const mine = showings.filter((showing) => showing.movieId === movie.id);
    const theaters = Array.from(new Set(mine.map((showing) => showing.theaterId))).sort();
    console.log(
      `    ${movie.title.padEnd(40)} ${String(mine.length).padStart(4)} showings at ${theaters.join(', ')}`
    );
  }

  console.log('\n  Occupancy distribution');
  console.log(occupancyHistogram(plans));

  const sampleIds = [
    plans.reduce((best, plan) =>
      plan.occupiedCount / plan.totalSeats > best.occupiedCount / best.totalSeats ? plan : best
    ),
    plans.reduce((best, plan) =>
      plan.occupiedCount / plan.totalSeats < best.occupiedCount / best.totalSeats ? plan : best
    ),
  ];
  for (const plan of sampleIds) {
    const showing = showings.find((entry) => entry.id === plan.showingId);
    const theater = world.theaters.find((entry) => entry.id === showing?.theaterId);
    if (!showing || !theater) continue;
    const movie = world.movies.find((entry) => entry.id === showing.movieId);
    const weekendLabel = isWeekend(showing.date) ? 'weekend' : 'weekday';
    console.log(
      `\n  ${movie?.title} — ${theater.name} — ${showing.date} ${showing.time} ${showing.format} (${weekendLabel}, ${(
        (plan.occupiedCount / plan.totalSeats) *
        100
      ).toFixed(0)}% sold)`
    );
    console.log(renderSeatMap(plan, theater));
  }

  console.log('\n  Printed cards');
  for (const result of cardResults) {
    console.log(`    ${result.card.label}\n      ${result.message}`);
  }

  console.log('\n  All invariants hold: every movie, theater, date, showtime and seat block is reachable.\n');
}

main();
