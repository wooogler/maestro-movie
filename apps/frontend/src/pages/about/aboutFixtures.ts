/**
 * The About page's figures, as data.
 *
 * Every figure on /about is the real booking component rendered from a spec,
 * not a screenshot, so it cannot drift from what a visitor sees. What it CAN
 * drift from is the world, so the values below are copied out of
 * apps/backend/scenarios/data/demo_uist2026_detroit.json (seed 20261103): real
 * titles, cinemas, distances and amenities; generated runtimes, showtimes,
 * prices and seat occupancy. Reseeding that dataset changes the showtimes and
 * the occupied seats here too, and nothing checks it — re-copy them.
 *
 * What is NOT copied from anywhere is the agent's wording. Augmented labels and
 * the sentences in the hero are written by the planner at run time; the ones
 * here are illustrative, and the page says so.
 */

import {
  applyAugment,
  applyFilter,
  applyHighlight,
  applySort,
  generateMovieSpec,
  generateSeatSpec,
  generateTheaterSpec,
  generateTimeSpec,
  type UISpec,
} from '../../spec';
import type { Movie, Seat, Showing, Theater } from '../../types';
import type { AgentMemorySnapshot } from '../../agent/protocol';
import { formatTime12Hour } from '../../utils/displayFormats';

// =============================================================================
// The Detroit world, 3–8 November 2026
// =============================================================================

/** In the order the demo lists them (the per-scenario stable shuffle). */
export const DEMO_MOVIES: Movie[] = [
  { id: 'm4', title: 'The Legend of Aang: The Last Airbender', genre: ['Animation', 'Action', 'Family'], duration: '1h 52m', rating: '3.9', ageRating: 'PG', synopsis: 'The last airbender wakes after a century of ice and finds the world already at war.', releaseDate: '2026-10-09' },
  { id: 'm1', title: 'Street Fighter', genre: ['Action', 'Adventure'], duration: '2h 4m', rating: '3.8', ageRating: 'PG-13', synopsis: 'Two street brawlers are pulled into a global fighting tournament run by the people who rigged it.', releaseDate: '2026-10-16' },
  { id: 'm5', title: 'Clayface', genre: ['Horror', 'Thriller'], duration: '1h 49m', rating: '3.5', ageRating: 'R', synopsis: 'A failing actor takes a treatment that lets him become anyone, and stops being able to stop.', releaseDate: '2026-10-23' },
  { id: 'm3', title: 'Wildwood', genre: ['Animation', 'Adventure', 'Family'], duration: '1h 46m', rating: '4.2', ageRating: 'PG', synopsis: 'A girl crosses into the wild country at the edge of the city to get her baby brother back.', releaseDate: '2026-10-23' },
  { id: 'm2', title: 'Klara and the Sun', genre: ['Drama', 'Sci-Fi'], duration: '1h 58m', rating: '4.4', ageRating: 'PG-13', synopsis: 'An artificial friend watches the family who bought her, and tries to work out what love is for.', releaseDate: '2026-10-23' },
];

/** Every cinema shows Klara and the Sun; this is the order its theater list uses. */
export const KLARA_THEATERS: Theater[] = [
  { id: 't1', name: 'Cinema Detroit', location: 'Midtown, Third Street', screenCount: 2, distanceMiles: 2.5, amenities: ['Reserved Seating', 'Cafe', 'Paid Parking'] },
  { id: 't3', name: 'Redford Theatre', location: 'Lahser Road, Old Redford', screenCount: 1, distanceMiles: 13.8, amenities: ['Free Parking', 'Historic Organ', 'Large Auditorium'] },
  { id: 't4', name: 'Emagine Royal Oak', location: 'North Main Street, Royal Oak', screenCount: 10, distanceMiles: 14.2, amenities: ['Reserved Seating', 'Free Parking', 'Recliner Seating', 'Dolby Atmos', '3D Screens', 'Bar'] },
  { id: 't5', name: 'MJR Troy Grand Digital Cinema 16', location: 'East Maple Road, Troy', screenCount: 16, distanceMiles: 20.4, amenities: ['Reserved Seating', 'Free Parking', 'Recliner Seating', 'IMAX', '3D Screens', 'Arcade'] },
  { id: 't2', name: 'Bel Air Luxury Cinema', location: 'East Eight Mile Road', screenCount: 10, distanceMiles: 9, amenities: ['Reserved Seating', 'Free Parking', 'Recliner Seating', '3D Screens'] },
];

/** Street Fighter runs 2h 4m; the backend derives end times from that. */
const STREET_FIGHTER_MINUTES = 124;

function endTimeOf(time: string, minutes: number): { endTime: string; displayEndTime: string } {
  const [hours, mins] = time.split(':').map((part) => Number.parseInt(part, 10));
  const total = (hours * 60 + mins + minutes) % (24 * 60);
  const endTime = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return { endTime, displayEndTime: formatTime12Hour(endTime) };
}

/** Street Fighter at MJR Troy on Saturday 7 November: sixteen shows on three screens. */
const SF_TROY_NOV7: Array<[time: string, format: Showing['format'], screen: number]> = [
  ['10:50', '3D', 7], ['10:55', 'Standard', 1], ['11:05', 'IMAX', 6],
  ['13:25', 'Standard', 1], ['13:55', '3D', 7], ['14:05', 'IMAX', 6],
  ['15:50', 'Standard', 1], ['17:00', '3D', 7], ['17:10', 'IMAX', 6],
  ['18:20', 'Standard', 1], ['20:10', 'IMAX', 6], ['20:10', '3D', 7],
  ['20:45', 'Standard', 1], ['23:15', 'Standard', 1], ['23:15', 'IMAX', 6],
  ['23:15', '3D', 7],
];

const SF_TROY_SHOWINGS: Showing[] = SF_TROY_NOV7.map(([time, format, screen]) => ({
  id: `s_m1_t5_20261107_${time.replace(':', '')}_s${screen}`,
  movieId: 'm1',
  theaterId: 't5',
  screenNumber: screen,
  date: '2026-11-07',
  time,
  format,
  availableSeats: 88,
  totalSeats: 88,
  ...endTimeOf(time, STREET_FIGHTER_MINUTES),
}));

/**
 * Emagine Royal Oak, Wednesday 4 November, 7:10 PM, Klara and the Sun — the
 * house quick card 5 lands on. Rows A–C Standard $15, D–F Premium $21.
 */
const EMAGINE_SHOWING_ID = 's_m2_t4_20261104_1910_s2';
const EMAGINE_OCCUPIED: Record<string, number[]> = {
  B: [4, 5, 6, 7, 8],
  C: [5, 6, 7, 8, 9],
  D: [1, 2, 3, 4, 6, 7, 8, 9],
  E: [3, 4, 7, 8],
};

const EMAGINE_SEATS: Seat[] = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((row) =>
  Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const premium = row >= 'D';
    return {
      id: `${EMAGINE_SHOWING_ID}-${row}${number}`,
      showingId: EMAGINE_SHOWING_ID,
      row,
      number,
      type: premium ? ('premium' as const) : ('standard' as const),
      price: premium ? 21 : 15,
      status: (EMAGINE_OCCUPIED[row] ?? []).includes(number)
        ? ('occupied' as const)
        : ('available' as const),
    };
  })
);

// =============================================================================
// Scripted steps: each figure plays from its first spec to its last
// =============================================================================

export type FigureStepKind = 'stage' | 'augment' | 'filter' | 'sort' | 'highlight';

export interface FigureStep {
  kind: FigureStepKind;
  spec: UISpec;
}

const distanceLabels = [
  { itemId: 't1', value: 'Cinema Detroit · 2.5 mi · paid parking' },
  { itemId: 't3', value: 'Redford Theatre · 13.8 mi · free parking' },
  { itemId: 't4', value: 'Emagine Royal Oak · 14.2 mi · free parking' },
  { itemId: 't5', value: 'MJR Troy Grand Digital Cinema 16 · 20.4 mi · free parking' },
  { itemId: 't2', value: 'Bel Air Luxury Cinema · 9 mi · free parking' },
];

/**
 * Quick card 2's sentence, played out one move per turn the way the planner
 * does it: surface the two missing fields, filter twice, then sort.
 */
export function heroSteps(): FigureStep[] {
  const base = generateTheaterSpec(KLARA_THEATERS, 'm2') as UISpec;
  const labelled = applyAugment(base, distanceLabels);
  const near = applyFilter(labelled, { field: 'distanceMiles', operator: 'lte', value: 15 });
  const freeParking = applyFilter(near, { field: 'amenities', operator: 'contains', value: 'Free Parking' });
  const sorted = applySort(freeParking, { field: 'distanceMiles', order: 'asc' });
  return withWorkflow(
    [
      { kind: 'stage', spec: base },
      { kind: 'augment', spec: labelled },
      { kind: 'filter', spec: near },
      { kind: 'filter', spec: freeParking },
      { kind: 'sort', spec: sorted },
    ],
    { movie: { id: 'm2', title: 'Klara and the Sun' } }
  );
}

/** Augment: the movie list gains the one field a parent is asking about. */
export function augmentSteps(): FigureStep[] {
  const base = generateMovieSpec(DEMO_MOVIES) as UISpec;
  const rated = applyAugment(
    base,
    DEMO_MOVIES.map((movie) => ({ itemId: movie.id, value: `${movie.title} · ${movie.ageRating}` }))
  );
  return [
    { kind: 'stage', spec: base },
    { kind: 'augment', spec: rated },
  ];
}

/** Filter: "Nothing before 8, and I need to be out by 11." — quick card 4. */
export function filterSteps(): FigureStep[] {
  const base = generateTimeSpec(SF_TROY_SHOWINGS, 'm1', 't5', '2026-11-07') as UISpec;
  const withEnds = applyAugment(
    base,
    SF_TROY_SHOWINGS.map((showing) => ({
      itemId: showing.id,
      value: `${formatTime12Hour(showing.time)} – ${showing.displayEndTime} · ${showing.format}`,
    }))
  );
  const afterEight = applyFilter(withEnds, { field: 'time', operator: 'gte', value: '20:00' });
  const outByEleven = applyFilter(afterEight, { field: 'endTime', operator: 'lte', value: '23:00' });
  return withWorkflow(
    [
      { kind: 'stage', spec: base },
      { kind: 'augment', spec: withEnds },
      { kind: 'filter', spec: afterEight },
      { kind: 'filter', spec: outByEleven },
    ],
    {
      movie: { id: 'm1', title: 'Street Fighter' },
      theater: { id: 't5', name: 'MJR Troy Grand Digital Cinema 16' },
      date: { id: '2026-11-07', date: '2026-11-07' },
    }
  );
}

/** Sort: nearest first — legible only because the miles were added first. */
export function sortSteps(): FigureStep[] {
  const labelled = applyAugment(generateTheaterSpec(KLARA_THEATERS, 'm2') as UISpec, distanceLabels);
  return [
    { kind: 'stage', spec: labelled },
    { kind: 'sort', spec: applySort(labelled, { field: 'distanceMiles', order: 'asc' }) },
  ];
}

/** Highlight: the one pair in the middle of row E, marked where it already was. */
export function highlightSteps(): FigureStep[] {
  const base = generateSeatSpec(EMAGINE_SEATS) as UISpec;
  return [
    { kind: 'stage', spec: base },
    {
      kind: 'highlight',
      spec: applyHighlight(base, {
        itemIds: [`${EMAGINE_SHOWING_ID}-E5`, `${EMAGINE_SHOWING_ID}-E6`],
      }),
    },
  ];
}

/** The breadcrumb reads the earlier choices off `state.workflow`. */
function withWorkflow(steps: FigureStep[], workflow: Record<string, unknown>): FigureStep[] {
  return steps.map((step) => ({
    ...step,
    spec: { ...step.spec, state: { ...step.spec.state, workflow } } as UISpec,
  }));
}

// =============================================================================
// Memory: a "Late show" visitor who wanted the old theater with the organ
// =============================================================================

/*
  One story for both memory figures, and it is a real dead end in this world:
  Redford Theatre shows Klara and the Sun only at 2:15 and 7:35 PM on Tuesday
  and 2:25 and 8:00 PM on Saturday, so "starts at 9 PM or later" fails at every
  date Redford has. The nearest earlier step that still has alternatives is
  therefore the theater, not the date.
*/

const AT = '2026-11-03T23:40:00.000Z';

const LATE_EVENING = {
  id: 'prf_late_evening',
  description: 'Showtime must start at 9 PM or later.',
  strength: 'hard' as const,
  relevantStages: ['time'],
};
const LATE_DISTANCE = {
  id: 'prf_late_distance',
  description: 'Will not drive more than 15 miles.',
  strength: 'hard' as const,
  relevantStages: ['theater'],
};
const LIKES_REDFORD = {
  id: 'pref_4b7e21c9d0a3',
  description: 'Would like the historic theater with the organ.',
  strength: 'soft' as const,
  relevantStages: ['theater'],
};

const KLARA = { id: 'm2', title: 'Klara and the Sun' };
const REDFORD = { id: 't3', name: 'Redford Theatre' };

/** At the showtime step, with Redford chosen: nothing starts late enough. */
export const CONFLICT_SNAPSHOT: AgentMemorySnapshot = {
  updatedAt: AT,
  reason: 'pending-conflict:planner-respond-conflict',
  stage: 'time',
  preferences: [LATE_EVENING, LATE_DISTANCE, LIKES_REDFORD],
  deadEnds: [],
  attemptedBranches: [],
  committedWorkflow: {
    movie: KLARA,
    theater: REDFORD,
    date: { id: '2026-11-03', date: '2026-11-03' },
  },
  pendingConflict: {
    preferenceIds: [LATE_EVENING.id],
    description: 'Redford’s last Klara and the Sun on Tuesday starts at 7:35 PM, and on Saturday at 8:00 PM.',
    scope: { stage: 'time', movie: KLARA.title, theater: REDFORD.name, date: '2026-11-03' },
    createdAt: AT,
  },
  backtrackContinuation: null,
  stageBindings: [
    {
      stage: 'theater',
      parentContextKey: 'movie:m2',
      filters: [{ field: 'distanceMiles', operator: 'lte', value: 15, preferenceIds: [LATE_DISTANCE.id] }],
      highlight: null,
      updatedAt: AT,
    },
  ],
  forgottenPreferences: [],
  revokedAdaptations: [],
};

/** The visitor said yes: the agent is on its way back to the theater step. */
export const BACKTRACK_SNAPSHOT: AgentMemorySnapshot = {
  ...CONFLICT_SNAPSHOT,
  reason: 'dead-end-recorded',
  stage: 'date',
  committedWorkflow: { movie: KLARA, theater: REDFORD },
  pendingConflict: null,
  backtrackContinuation: { targetStage: 'theater' },
  deadEnds: [
    {
      id: 'dead_7f3a90c2e1',
      preferenceIds: [LATE_EVENING.id],
      scope: { stage: 'time', movie: KLARA.title, theater: REDFORD.name, date: '2026-11-03' },
      reason: 'No Klara and the Sun at Redford starts at 9 PM or later.',
      createdAt: AT,
      lastSeenAt: AT,
      count: 1,
    },
  ],
  attemptedBranches: [
    { stage: 'date', parentContextKey: 'movie:m2|theater:t3', itemId: '2026-11-03', createdAt: AT },
  ],
};

/**
 * What Forget does to the snapshot, minus the agent: the preference moves to
 * the Forgotten list, leaves the conflict it was named in (clearing it if it
 * was the only one), and takes every filter it justified with it. The real
 * agent also replans afterwards; this page has no agent to do that.
 */
export function forgetPreference(snapshot: AgentMemorySnapshot, id: string): AgentMemorySnapshot {
  const removed = snapshot.preferences.find((item) => item.id === id);
  if (!removed) return snapshot;
  const conflictIds = snapshot.pendingConflict?.preferenceIds.filter((item) => item !== id) ?? [];
  return {
    ...snapshot,
    preferences: snapshot.preferences.filter((item) => item.id !== id),
    forgottenPreferences: [...snapshot.forgottenPreferences, removed],
    pendingConflict:
      snapshot.pendingConflict && conflictIds.length > 0
        ? { ...snapshot.pendingConflict, preferenceIds: conflictIds }
        : null,
    deadEnds: snapshot.deadEnds.filter((deadEnd) => !deadEnd.preferenceIds.includes(id)),
    stageBindings: snapshot.stageBindings.map((binding) => ({
      ...binding,
      filters: binding.filters.filter((filter) => !filter.preferenceIds.includes(id)),
    })),
  };
}

/** Restore puts the preference back with its id. It does not re-apply filters. */
export function restorePreference(snapshot: AgentMemorySnapshot, id: string): AgentMemorySnapshot {
  const restored = snapshot.forgottenPreferences.find((item) => item.id === id);
  if (!restored) return snapshot;
  return {
    ...snapshot,
    preferences: [...snapshot.preferences, restored],
    forgottenPreferences: snapshot.forgottenPreferences.filter((item) => item.id !== id),
  };
}
