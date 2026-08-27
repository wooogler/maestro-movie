import type { Rng } from './rng';
import type { MovieSpec, ShowingFormat, TheaterSpec, WorldSpec } from './world';

export interface GeneratedShowing {
  id: string;
  movieId: string;
  theaterId: string;
  screenNumber: number;
  date: string;
  time: string;
  format: ShowingFormat;
  totalSeats: number;
  /** Kept out of the dataset; the seat model needs the clock and the runtime. */
  startMinutes: number;
  durationMinutes: number;
}

/** Minutes between one showing ending and the next starting on the same screen. */
const TURNOVER_MIN = 20;
const TURNOVER_MAX = 35;

export function buildDates(world: WorldSpec): string[] {
  const [year, month, day] = world.todayIso.split('-').map((part) => Number.parseInt(part, 10));
  const dates: string[] = [];
  for (let offset = 0; offset < world.dateCount; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

/** 0 = Sunday. Computed in UTC so it does not drift with the host timezone. */
export function weekdayOf(dateIso: string): number {
  const [year, month, day] = dateIso.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWeekend(dateIso: string): boolean {
  const weekday = weekdayOf(dateIso);
  return weekday === 0 || weekday === 5 || weekday === 6;
}

function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function houseSeatCount(theater: TheaterSpec): number {
  return theater.house.rowCount * theater.house.seatsPerRow;
}

/** Which titles a theater is willing to book, given the kind of house it is. */
function carriedMovies(theater: TheaterSpec, movies: MovieSpec[]): MovieSpec[] {
  switch (theater.lineup) {
    case 'multiplex':
      return movies.slice();
    case 'arthouse':
      // A two-screen indie house books the prestige title and family animation,
      // not a tournament-fighter tentpole. That is a real constraint, and it is
      // what makes "the closest theater" collide with "this specific blockbuster".
      return movies.filter((movie) => movie.artHouse || movie.genre.includes('Animation'));
    case 'repertory':
      // One screen, one title a night, and never a wide-release action opener.
      return movies.filter((movie) => movie.artHouse || movie.ageRating !== 'PG-13');
  }
}

interface ScreenAssignment {
  screenNumber: number;
  movie: MovieSpec;
  format: ShowingFormat;
}

function premiumFormatsFor(theater: TheaterSpec, movie: MovieSpec): ShowingFormat[] {
  return theater.formats.filter(
    (format) => format !== 'Standard' && movie.formats.includes(format)
  );
}

/**
 * Hands out the theater's screens for one day: every title it carries gets a
 * standard screen, then any screens left over go to premium formats, weighted
 * towards the titles people actually queue for.
 */
function assignScreens(
  theater: TheaterSpec,
  movies: MovieSpec[],
  dateIso: string,
  dateIndex: number,
  rng: Rng
): ScreenAssignment[] {
  const carried = carriedMovies(theater, movies);
  if (carried.length === 0) return [];

  const assignments: ScreenAssignment[] = [];

  if (theater.lineup === 'repertory') {
    // Cycles straight through the repertory, so a title cannot be skipped for
    // the whole window and leave someone with no way to book it here.
    assignments.push({
      screenNumber: 1,
      movie: carried[dateIndex % carried.length],
      format: 'Standard',
    });
    return assignments;
  }

  if (theater.lineup === 'arthouse') {
    const anchor = carried.reduce((best, movie) =>
      Number.parseFloat(movie.rating) > Number.parseFloat(best.rating) ? movie : best
    );
    assignments.push({ screenNumber: 1, movie: anchor, format: 'Standard' });
    const rotating = carried.filter((movie) => movie.id !== anchor.id);
    if (rotating.length > 0 && theater.bookableScreens > 1) {
      assignments.push({
        screenNumber: 2,
        movie: rotating[dateIndex % rotating.length],
        format: 'Standard',
      });
    }
    return assignments;
  }

  let screenNumber = 1;
  for (const movie of carried) {
    assignments.push({ screenNumber, movie, format: 'Standard' });
    screenNumber += 1;
  }

  const used = new Set<string>();
  // A cinema has the large-format auditoriums it has: MJR Troy runs one IMAX
  // screen, not four, so only one title can be in IMAX on a given day.
  const formatScreenCap: Record<ShowingFormat, number> = { Standard: Infinity, IMAX: 1, '3D': 3 };
  const formatUsage = new Map<ShowingFormat, number>();

  // Every premium format the theater advertises runs every day, with the title
  // rotating through those that support it. Leaving the large-format screen to a
  // popularity draw both dark-ends whole days and hands it permanently to the
  // biggest release.
  for (const format of theater.formats) {
    if (format === 'Standard') continue;
    if (screenNumber > theater.bookableScreens) break;
    const capable = carried.filter((movie) => movie.formats.includes(format));
    if (capable.length === 0) continue;
    const movie = premiumRotation(capable)[dateIndex % premiumRotation(capable).length];
    used.add(`${movie.id}:${format}`);
    formatUsage.set(format, (formatUsage.get(format) ?? 0) + 1);
    assignments.push({ screenNumber, movie, format });
    screenNumber += 1;
  }

  const premiumCandidates = carried.flatMap((movie) =>
    premiumFormatsFor(theater, movie).map((format) => ({ movie, format }))
  );

  while (screenNumber <= theater.bookableScreens && premiumCandidates.length > 0) {
    const remaining = premiumCandidates.filter(
      (candidate) =>
        !used.has(`${candidate.movie.id}:${candidate.format}`) &&
        (formatUsage.get(candidate.format) ?? 0) < formatScreenCap[candidate.format]
    );
    if (remaining.length === 0) break;
    const chosen = rng.weighted(remaining, (candidate) => {
      // IMAX goes to whoever fills it; 3D skews to animation and action.
      const formatWeight = candidate.format === 'IMAX' ? 1.4 : 1;
      return candidate.movie.popularity * formatWeight;
    });
    used.add(`${chosen.movie.id}:${chosen.format}`);
    formatUsage.set(chosen.format, (formatUsage.get(chosen.format) ?? 0) + 1);
    assignments.push({ screenNumber, movie: chosen.movie, format: chosen.format });
    screenNumber += 1;
  }

  return assignments;
}

/**
 * Order in which titles take the large-format screen on successive days. The
 * biggest release gets it every other day, the way a real IMAX booking works,
 * while the others still get their turn — a straight round robin gives the
 * tentpole too few days and a popularity draw gives the rest none.
 */
function premiumRotation(capable: MovieSpec[]): MovieSpec[] {
  const ordered = capable.slice().sort((a, b) => b.popularity - a.popularity);
  if (ordered.length <= 1) return ordered;
  const rotation: MovieSpec[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    rotation.push(ordered[0], ordered[index]);
  }
  return rotation;
}

/** Runaway guard only; the day is bounded by the theater's operating window. */
const MAX_SHOWINGS_PER_SCREEN = 8;

/**
 * Packs one screen's day. Each showing starts after the previous one has
 * finished and the room has been cleaned, which is why the resulting times land
 * on ragged clock values like 16:25 instead of a tidy grid — a real listing
 * looks like this because a projector can only do one thing at a time.
 */
function packScreen(
  theater: TheaterSpec,
  assignment: ScreenAssignment,
  dateIso: string,
  rng: Rng
): GeneratedShowing[] {
  const { movie, format, screenNumber } = assignment;
  const weekend = isWeekend(dateIso);

  // Weekday matinees start later because the audience is at work — but only at
  // the multiplexes. A two-screen evening house opens when it always opens, and
  // pushing it back takes its late show off the board entirely.
  const weekdayDelay = theater.lineup === 'multiplex' ? rng.int(60, 120) : rng.int(0, 15);
  const openMinutes = weekend
    ? theater.earliestStartMinutes
    : theater.earliestStartMinutes + weekdayDelay;
  const lastStartMinutes = theater.latestStartMinutes + (weekend ? 30 : 0);
  // A small house has one plausible opening time, not a 25-minute spread.
  const openJitter = theater.lineup === 'multiplex' ? 25 : 15;

  const showings: GeneratedShowing[] = [];
  const openAt = openMinutes + rng.int(0, openJitter);

  if (theater.lineup === 'repertory') {
    // A repertory house runs a matinee and an evening show, not a full chain.
    const matinee = theater.earliestStartMinutes + rng.int(0, 45);
    const evening = theater.latestStartMinutes - rng.int(0, 45);
    for (const slot of [matinee, evening]) {
      showings.push(
        buildShowing(theater, movie, format, screenNumber, dateIso, roundToFive(slot))
      );
    }
    return showings;
  }

  // A screen turns over at its own steady pace, so one film's showtimes on one
  // screen come out as a regular series. The ragged look of a real listing comes
  // from screens opening at different times, not from random start times.
  const turnover = rng.int(TURNOVER_MIN, TURNOVER_MAX);
  const slotMinutes = movie.durationMinutes + turnover;
  const span = Math.max(0, lastStartMinutes - openAt);

  // The day is planned to fill the operating window: the last show starts near
  // closing rather than wherever the chain happened to run out. Chaining forward
  // and stopping early left the final screening in the late afternoon, which is
  // how an evening plan ends up with nothing to book.
  const count = Math.max(2, Math.min(MAX_SHOWINGS_PER_SCREEN, Math.floor(span / slotMinutes) + 1));
  const step = count > 1 ? Math.max(slotMinutes, span / (count - 1)) : slotMinutes;

  for (let index = 0; index < count; index += 1) {
    showings.push(
      buildShowing(
        theater,
        movie,
        format,
        screenNumber,
        dateIso,
        roundToFive(openAt + index * step)
      )
    );
  }

  return showings;
}

function roundToFive(minutes: number): number {
  return Math.round(minutes / 5) * 5;
}

function buildShowing(
  theater: TheaterSpec,
  movie: MovieSpec,
  format: ShowingFormat,
  screenNumber: number,
  dateIso: string,
  startMinutes: number
): GeneratedShowing {
  const compactDate = dateIso.replace(/-/g, '');
  const time = formatTime(startMinutes);
  return {
    id: `s_${movie.id}_${theater.id}_${compactDate}_${time.replace(':', '')}_s${screenNumber}`,
    movieId: movie.id,
    theaterId: theater.id,
    screenNumber,
    date: dateIso,
    time,
    format,
    totalSeats: houseSeatCount(theater),
    startMinutes,
    durationMinutes: movie.durationMinutes,
  };
}

export function buildSchedule(world: WorldSpec, rng: Rng): GeneratedShowing[] {
  const dates = buildDates(world);
  const showings: GeneratedShowing[] = [];

  for (const theater of world.theaters) {
    dates.forEach((dateIso, dateIndex) => {
      const dayRng = rng.fork(`${theater.id}:${dateIso}`);
      for (const assignment of assignScreens(theater, world.movies, dateIso, dateIndex, dayRng)) {
        showings.push(...packScreen(theater, assignment, dateIso, dayRng));
      }
    });
  }

  return showings;
}
