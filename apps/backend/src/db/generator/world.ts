/**
 * The world the UIST 2026 booth demo books tickets in: five films that are
 * genuinely in theaters on Tuesday 3 November 2026, and five real Detroit-area
 * cinemas, anchored at the Detroit Marriott at the Renaissance Center where the
 * conference runs.
 *
 * Titles, release dates, theater names, distances, screen counts and amenities
 * are real. Runtimes, MPAA ratings, critic scores, house layouts, prices and
 * every showtime are invented — those values do not exist yet for unreleased
 * films, and no real box office is being mirrored here.
 *
 * Nothing in this file is a script for a particular scenario. It describes a
 * world with natural constraints (a repertory house runs one title a night; only
 * one cinema in the region has a laser IMAX) and lets the generator fill it in,
 * so a visitor can state whatever preference they actually have and still find a
 * way through.
 */
export type ShowingFormat = 'Standard' | 'IMAX' | '3D';

export interface MovieSpec {
  id: string;
  title: string;
  genre: string[];
  /** Invented. Drives showtime chaining, so it must be plausible, not accurate. */
  durationMinutes: number;
  /** Invented critic score, 0-5, rendered as a string in the dataset. */
  rating: string;
  ageRating: 'G' | 'PG' | 'PG-13' | 'R';
  synopsis: string;
  releaseDate: string;
  /** 0-1. Drives how many screens it gets and how full those screens are. */
  popularity: number;
  /** Formats the distributor supplies. A theater still has to be able to project it. */
  formats: ShowingFormat[];
  /** Repertory and arthouse screens will pick this title up. */
  artHouse: boolean;
}

export interface SeatTier {
  /** Fraction of rows, from the screen backwards, this tier covers. */
  fromRowFraction: number;
  type: 'standard' | 'premium' | 'couple';
  price: number;
}

export interface HouseSpec {
  rowCount: number;
  seatsPerRow: number;
  /** Applied front to back; the last matching tier wins. */
  tiers: SeatTier[];
}

export type LineupPolicy = 'multiplex' | 'arthouse' | 'repertory';

export interface TheaterSpec {
  id: string;
  name: string;
  location: string;
  /** Real driving distance from the Renaissance Center, rounded. */
  distanceMiles: number;
  /** The theater's real screen count, which visitors may express a preference about. */
  screenCount: number;
  /** How many of those screens this demo schedules. A 16-plex has other films on. */
  bookableScreens: number;
  amenities: string[];
  formats: ShowingFormat[];
  house: HouseSpec;
  lineup: LineupPolicy;
  /** Earliest and latest showtime START, in minutes from midnight. */
  earliestStartMinutes: number;
  latestStartMinutes: number;
  /** 0-1 multiplier on how full this house runs. */
  demandFactor: number;
}

export interface WorldSpec {
  /** The demo reception. Everything is scheduled relative to this. */
  todayIso: string;
  /** Bookable dates, inclusive. */
  dateCount: number;
  movies: MovieSpec[];
  theaters: TheaterSpec[];
}

// Houses stay at or below 12 seats per row: the seat map renders one CSS grid
// column per seat inside a ~440px card, and a wider house squeezes the targets
// past the point of being clickable.
const HOUSE_SMALL: HouseSpec = {
  rowCount: 5,
  seatsPerRow: 8,
  tiers: [{ fromRowFraction: 0, type: 'standard', price: 12 }],
};

const HOUSE_RECLINER: HouseSpec = {
  rowCount: 7,
  seatsPerRow: 10,
  tiers: [
    { fromRowFraction: 0, type: 'standard', price: 14 },
    { fromRowFraction: 0.6, type: 'premium', price: 19 },
  ],
};

const HOUSE_ATMOS: HouseSpec = {
  rowCount: 6,
  seatsPerRow: 10,
  tiers: [
    { fromRowFraction: 0, type: 'standard', price: 15 },
    { fromRowFraction: 0.55, type: 'premium', price: 21 },
  ],
};

const HOUSE_GRAND: HouseSpec = {
  rowCount: 8,
  seatsPerRow: 11,
  tiers: [
    { fromRowFraction: 0, type: 'standard', price: 15 },
    { fromRowFraction: 0.55, type: 'premium', price: 20 },
    { fromRowFraction: 0.88, type: 'couple', price: 26 },
  ],
};

/** A 1920s movie palace: one big room, one flat price. */
const HOUSE_PALACE: HouseSpec = {
  rowCount: 8,
  seatsPerRow: 12,
  tiers: [{ fromRowFraction: 0, type: 'standard', price: 10 }],
};

export const DETROIT_UIST_2026: WorldSpec = {
  todayIso: '2026-11-03',
  dateCount: 6,

  movies: [
    {
      id: 'm1',
      title: 'Street Fighter',
      genre: ['Action', 'Adventure'],
      durationMinutes: 124,
      rating: '3.8',
      ageRating: 'PG-13',
      synopsis:
        'Two street brawlers are pulled into a global fighting tournament run by the people who rigged it.',
      releaseDate: '2026-10-16',
      popularity: 0.95,
      formats: ['Standard', 'IMAX', '3D'],
      artHouse: false,
    },
    {
      id: 'm2',
      title: 'Klara and the Sun',
      genre: ['Drama', 'Sci-Fi'],
      durationMinutes: 118,
      rating: '4.4',
      ageRating: 'PG-13',
      synopsis:
        'An artificial friend watches the family who bought her, and tries to work out what love is for.',
      releaseDate: '2026-10-23',
      popularity: 0.5,
      formats: ['Standard'],
      artHouse: true,
    },
    {
      id: 'm3',
      title: 'Wildwood',
      genre: ['Animation', 'Adventure', 'Family'],
      durationMinutes: 106,
      rating: '4.2',
      ageRating: 'PG',
      synopsis:
        'A girl crosses into the wild country at the edge of the city to get her baby brother back.',
      releaseDate: '2026-10-23',
      popularity: 0.72,
      formats: ['Standard', '3D'],
      artHouse: true,
    },
    {
      id: 'm4',
      title: 'The Legend of Aang: The Last Airbender',
      genre: ['Animation', 'Action', 'Family'],
      durationMinutes: 112,
      rating: '3.9',
      ageRating: 'PG',
      synopsis:
        'The last airbender wakes after a century of ice and finds the world already at war.',
      releaseDate: '2026-10-09',
      popularity: 0.78,
      formats: ['Standard', 'IMAX', '3D'],
      artHouse: false,
    },
    {
      id: 'm5',
      title: 'Clayface',
      genre: ['Horror', 'Thriller'],
      durationMinutes: 109,
      rating: '3.5',
      ageRating: 'R',
      synopsis:
        'A failing actor takes a treatment that lets him become anyone, and stops being able to stop.',
      releaseDate: '2026-10-23',
      popularity: 0.62,
      formats: ['Standard', 'IMAX'],
      artHouse: false,
    },
  ],

  theaters: [
    {
      id: 't1',
      name: 'Cinema Detroit',
      location: 'Midtown, Third Street',
      distanceMiles: 2.5,
      screenCount: 2,
      bookableScreens: 2,
      amenities: ['Reserved Seating', 'Cafe', 'Paid Parking'],
      formats: ['Standard'],
      house: HOUSE_SMALL,
      lineup: 'arthouse',
      // An evening house: a late-afternoon show, an after-work show, and a late
      // one. The last of those is the only screening within walking-ish distance
      // of downtown after a conference reception, so it has to exist.
      earliestStartMinutes: 15 * 60 + 45,
      latestStartMinutes: 21 * 60 + 30,
      demandFactor: 0.72,
    },
    {
      id: 't2',
      name: 'Bel Air Luxury Cinema',
      location: 'East Eight Mile Road',
      distanceMiles: 9.0,
      screenCount: 10,
      bookableScreens: 7,
      amenities: ['Reserved Seating', 'Free Parking', 'Recliner Seating', '3D Screens'],
      formats: ['Standard', '3D'],
      house: HOUSE_RECLINER,
      lineup: 'multiplex',
      earliestStartMinutes: 11 * 60,
      latestStartMinutes: 22 * 60,
      demandFactor: 0.9,
    },
    {
      id: 't3',
      name: 'Redford Theatre',
      location: 'Lahser Road, Old Redford',
      distanceMiles: 13.8,
      screenCount: 1,
      bookableScreens: 1,
      amenities: ['Free Parking', 'Historic Organ', 'Large Auditorium'],
      formats: ['Standard'],
      house: HOUSE_PALACE,
      lineup: 'repertory',
      earliestStartMinutes: 14 * 60,
      latestStartMinutes: 20 * 60,
      demandFactor: 0.6,
    },
    {
      id: 't4',
      name: 'Emagine Royal Oak',
      location: 'North Main Street, Royal Oak',
      distanceMiles: 14.2,
      screenCount: 10,
      bookableScreens: 6,
      amenities: [
        'Reserved Seating',
        'Free Parking',
        'Recliner Seating',
        'Dolby Atmos',
        '3D Screens',
        'Bar',
      ],
      formats: ['Standard', '3D'],
      house: HOUSE_ATMOS,
      lineup: 'multiplex',
      earliestStartMinutes: 11 * 60 + 30,
      latestStartMinutes: 22 * 60,
      demandFactor: 0.95,
    },
    {
      id: 't5',
      name: 'MJR Troy Grand Digital Cinema 16',
      location: 'East Maple Road, Troy',
      distanceMiles: 20.4,
      screenCount: 16,
      bookableScreens: 8,
      amenities: [
        'Reserved Seating',
        'Free Parking',
        'Recliner Seating',
        'IMAX',
        '3D Screens',
        'Arcade',
      ],
      formats: ['Standard', 'IMAX', '3D'],
      house: HOUSE_GRAND,
      lineup: 'multiplex',
      earliestStartMinutes: 10 * 60 + 45,
      latestStartMinutes: 22 * 60 + 45,
      demandFactor: 1,
    },
  ],
};
