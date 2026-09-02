/**
 * Checks the five quick-demo cards against the world they are printed for.
 *
 *   npx tsx --tsconfig apps/frontend/tsconfig.node.json \
 *     apps/frontend/src/study/quickDemoCards.check.ts
 *
 * A quick card is the one artefact in this repo that is simultaneously (a)
 * printed on paper and handed to a stranger, (b) a promise about what a specific
 * screen will do, and (c) a set of ids into a GENERATED world. Reseeding the
 * Detroit dataset renumbers every showing and reshuffles every seat, and the
 * only symptom would be a visitor holding a card that opens on an error, or —
 * worse — one that opens fine and then does not do what it says.
 *
 * So this replays each card's sentence against the dataset and asserts both
 * halves: the prefill resolves, and the change the card promises is a real,
 * partial change. "Partial" is the load-bearing word. A sentence that empties
 * the screen is a dead end (a thing the full demo shows on purpose, on its own
 * card) and a sentence that removes nothing shows nothing at all, so every card
 * below is asserted to leave strictly between one option and all of them.
 */
import fs from 'fs';
import path from 'path';
import { QUICK_DEMO_CARDS, buildQuickDemoCardUrl, parseQuickDemoCardFragment } from './quickDemoCards';
import type { Stage } from '../spec/types';

let failures = 0;

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

interface Movie {
  id: string;
  title: string;
  ageRating: string;
  duration: string;
}
interface Theater {
  id: string;
  name: string;
  distanceMiles: number;
  amenities: string[];
}
interface Showing {
  id: string;
  movieId: string;
  theaterId: string;
  date: string;
  time: string;
}
interface SeatOverride {
  showingId: string;
  row: string;
  occupiedNumbers: number[];
}
interface SeatTemplate {
  rows: string[];
  seatsPerRow: number;
}
interface Dataset {
  todayIso: string;
  dateCount: number;
  movies: Movie[];
  theaters: Theater[];
  showings: Showing[];
  seatTemplate: SeatTemplate;
  seatTemplateOverrides: Array<SeatTemplate & { theaterId: string }>;
  seatOverrides: SeatOverride[];
}

const DATASET_PATH = path.resolve(
  process.cwd(),
  'apps/backend/scenarios/data/demo_uist2026_detroit.json'
);
const world = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as Dataset;

const movieById = new Map(world.movies.map((movie) => [movie.id, movie]));
const theaterById = new Map(world.theaters.map((theater) => [theater.id, theater]));
const showingById = new Map(world.showings.map((showing) => [showing.id, showing]));

function minutes(time: string): number {
  return Number.parseInt(time.slice(0, 2), 10) * 60 + Number.parseInt(time.slice(3, 5), 10);
}
function durationMinutes(movie: Movie): number {
  const match = /(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(movie.duration);
  return Number.parseInt(match?.[1] ?? '0', 10) * 60 + Number.parseInt(match?.[2] ?? '0', 10);
}
function calendarDays(): string[] {
  const days: string[] = [];
  const start = new Date(`${world.todayIso}T00:00:00`);
  for (let index = 0; index < world.dateCount; index += 1) {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

// ---------------------------------------------------------------------------
section('1. STRUCTURE — a card prefills exactly the stages before its own');
// ---------------------------------------------------------------------------
{
  /*
    The rule the whole idea rests on. `loadStageData` refuses a stage whose
    workflow context is incomplete ("Missing movie, theater, or date"), so a card
    that under-prefills lands on an error screen; one that over-prefills has
    silently chosen something on the visitor's behalf that its own stage was
    about to ask them for.
  */
  const requiredDepth: Record<Stage, Array<keyof (typeof QUICK_DEMO_CARDS)[number]['prefill']>> = {
    movie: [],
    theater: ['movieId'],
    date: ['movieId', 'theaterId'],
    time: ['movieId', 'theaterId', 'date'],
    seat: ['movieId', 'theaterId', 'date', 'showingId'],
    confirm: ['movieId', 'theaterId', 'date', 'showingId'],
  };

  check('there is one card per selection stage', QUICK_DEMO_CARDS.length === 5);
  check(
    'and no two land on the same stage',
    new Set(QUICK_DEMO_CARDS.map((card) => card.stage)).size === QUICK_DEMO_CARDS.length
  );
  check(
    'no card lands on confirm, which selects nothing and so adapts nothing',
    QUICK_DEMO_CARDS.every((card) => card.stage !== 'confirm')
  );

  for (const card of QUICK_DEMO_CARDS) {
    const required = requiredDepth[card.stage];
    const present = Object.entries(card.prefill)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    check(
      `${card.id}: prefills exactly ${required.length} step(s), as its stage needs`,
      present.length === required.length && required.every((key) => present.includes(key))
    );
    check(
      `${card.id}: has a line to say and a thing to watch, in both languages`,
      Boolean(card.opener.en && card.opener.ko && card.watch.en && card.watch.ko)
    );
  }
}

// ---------------------------------------------------------------------------
section('2. PREFILL — every id still names something in the generated world');
// ---------------------------------------------------------------------------
{
  const days = calendarDays();
  for (const card of QUICK_DEMO_CARDS) {
    const { movieId, theaterId, date, showingId } = card.prefill;
    if (movieId) check(`${card.id}: movie ${movieId} exists`, movieById.has(movieId));
    if (theaterId) {
      check(`${card.id}: theater ${theaterId} exists`, theaterById.has(theaterId));
      check(
        `${card.id}: ${movieId} actually plays at ${theaterId}`,
        world.showings.some((s) => s.movieId === movieId && s.theaterId === theaterId)
      );
    }
    if (date) {
      check(`${card.id}: ${date} is on the calendar`, days.includes(date));
      check(
        `${card.id}: that pairing has showings on ${date}`,
        world.showings.some(
          (s) => s.movieId === movieId && s.theaterId === theaterId && s.date === date
        )
      );
    }
    if (showingId) {
      const showing = showingById.get(showingId);
      check(`${card.id}: showing ${showingId} exists`, Boolean(showing));
      check(
        `${card.id}: and belongs to the movie, theater and date above`,
        showing?.movieId === movieId &&
          showing?.theaterId === theaterId &&
          showing?.date === date
      );
    }
  }
}

// ---------------------------------------------------------------------------
section('3. THE PROMISE — each sentence leaves a real, partial choice');
// ---------------------------------------------------------------------------
{
  // Card 1 — "nothing scary": G/PG survive.
  const family = world.movies.filter((m) => m.ageRating === 'G' || m.ageRating === 'PG');
  check(
    `movie: "nothing scary" leaves ${family.length} of ${world.movies.length} films`,
    family.length >= 2 && family.length < world.movies.length
  );

  // Card 2 — "within 15 miles, free parking", on the film the card prefills.
  const theaterCard = QUICK_DEMO_CARDS.find((c) => c.id === 'theater')!;
  const showing2 = new Set(
    world.showings
      .filter((s) => s.movieId === theaterCard.prefill.movieId)
      .map((s) => s.theaterId)
  );
  const near = [...showing2]
    .map((id) => theaterById.get(id)!)
    .filter((t) => t.distanceMiles <= 15 && t.amenities.includes('Free Parking'));
  check(
    `theater: "within 15 miles, free parking" leaves ${near.length} of ${showing2.size} cinemas`,
    near.length >= 2 && near.length < showing2.size
  );
  check(
    'theater: and the film it prefills is the one that plays everywhere, so the list starts full',
    showing2.size === world.theaters.length
  );

  // Card 3 — "the weekend".
  const dateCard = QUICK_DEMO_CARDS.find((c) => c.id === 'date')!;
  const offered = [
    ...new Set(
      world.showings
        .filter(
          (s) =>
            s.movieId === dateCard.prefill.movieId && s.theaterId === dateCard.prefill.theaterId
        )
        .map((s) => s.date)
    ),
  ];
  const weekend = offered.filter((day) => {
    const weekday = new Date(`${day}T00:00:00`).getDay();
    return weekday === 0 || weekday === 6;
  });
  check(
    `date: "the weekend" leaves ${weekend.length} of ${offered.length} days`,
    weekend.length >= 1 && weekend.length < offered.length
  );

  // Card 4 — "nothing before 8, out by 11".
  const timeCard = QUICK_DEMO_CARDS.find((c) => c.id === 'time')!;
  const sameSlot = world.showings.filter(
    (s) =>
      s.movieId === timeCard.prefill.movieId &&
      s.theaterId === timeCard.prefill.theaterId &&
      s.date === timeCard.prefill.date
  );
  const runtime = durationMinutes(movieById.get(timeCard.prefill.movieId!)!);
  const lateEnough = sameSlot.filter(
    (s) => minutes(s.time) >= 20 * 60 && minutes(s.time) + runtime <= 23 * 60
  );
  check(
    `time: "after 8, out by 11" leaves ${lateEnough.length} of ${sameSlot.length} showtimes`,
    lateEnough.length >= 2 && lateEnough.length < sameSlot.length
  );
  check(
    'time: and it prefills a busy screen, so the filter has something to bite on',
    sameSlot.length >= 10
  );

  // Card 5 — "two together, toward the back".
  const seatCard = QUICK_DEMO_CARDS.find((c) => c.id === 'seat')!;
  const seatShowing = showingById.get(seatCard.prefill.showingId!)!;
  const template =
    world.seatTemplateOverrides.find((o) => o.theaterId === seatShowing.theaterId) ??
    world.seatTemplate;
  const occupied = new Map<string, Set<number>>();
  for (const override of world.seatOverrides) {
    if (override.showingId !== seatCard.prefill.showingId) continue;
    occupied.set(override.row, new Set(override.occupiedNumbers));
  }
  const seatsTotal = template.rows.length * template.seatsPerRow;
  const seatsTaken = [...occupied.values()].reduce((sum, set) => sum + set.size, 0);
  // "Toward the back, not the front rows" — the back half of the house.
  const backRows = template.rows.slice(Math.ceil(template.rows.length / 2));
  let pairs = 0;
  for (const row of backRows) {
    const busy = occupied.get(row) ?? new Set<number>();
    for (let seat = 1; seat < template.seatsPerRow; seat += 1) {
      if (!busy.has(seat) && !busy.has(seat + 1)) pairs += 1;
    }
  }
  check(
    `seat: the map is ${Math.round((100 * seatsTaken) / seatsTotal)}% sold, so it looks used`,
    seatsTaken > 0 && seatsTaken < seatsTotal
  );
  check(
    `seat: "two together, toward the back" has ${pairs} candidate pairs — a set, not a guess`,
    pairs >= 3
  );
}

// ---------------------------------------------------------------------------
section('4. THE LINK — what a QR carries, and what it survives');
// ---------------------------------------------------------------------------
{
  const url = buildQuickDemoCardUrl('seat', 'https://maestro.example', { accessCode: 'AB12CD' });
  check('the card id and the code both ride the fragment', url.includes('#c=seat&k=AB12CD'));
  check(
    'so neither reaches the server, a proxy log or a Referer header',
    url.split('#')[0] === 'https://maestro.example/demo/card'
  );

  const round = parseQuickDemoCardFragment(`#${url.split('#')[1]}`);
  check('a scanned link resolves back to its card', round.card?.id === 'seat');
  check('and to its code', round.accessCode === 'AB12CD');

  const codeless = parseQuickDemoCardFragment('#c=movie');
  check('a link printed before codes were switched on still names its card', codeless.card?.id === 'movie');
  check('and asks for a code rather than assuming one', codeless.accessCode === null);

  const stale = parseQuickDemoCardFragment('#c=intermission');
  check('an id this build does not know resolves to no card...', stale.card === null);
  check('...but is kept, so the dead end can name itself', stale.rawCardId === 'intermission');
  check('an empty fragment is not a crash', parseQuickDemoCardFragment('').card === null);
}

console.log(
  failures === 0
    ? '\nAll quick-demo card checks passed.'
    : `\n${failures} quick-demo card check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
