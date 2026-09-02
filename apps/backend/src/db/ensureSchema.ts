import type Database from 'better-sqlite3';
import { normalizeDurationText } from '../utils/duration';

interface TableInfoRow {
  name: string;
  type: string;
}

function getTableInfoRows(sqlite: Database.Database, tableName: string): TableInfoRow[] {
  return sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
}

function getColumnNames(sqlite: Database.Database, tableName: string): Set<string> {
  return new Set(getTableInfoRows(sqlite, tableName).map((column) => column.name));
}

function normalizedColumnType(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function rebuildMoviesTable(sqlite: Database.Database): void {
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    const transaction = sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE movies_next (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          genre TEXT NOT NULL,
          duration TEXT NOT NULL,
          rating TEXT NOT NULL,
          age_rating TEXT NOT NULL DEFAULT 'NR',
          synopsis TEXT NOT NULL DEFAULT '',
          release_date TEXT NOT NULL
        );

        INSERT INTO movies_next (
          id,
          title,
          genre,
          duration,
          rating,
          age_rating,
          synopsis,
          release_date
        )
        SELECT
          id,
          title,
          genre,
          duration,
          rating,
          COALESCE(age_rating, 'NR'),
          COALESCE(synopsis, ''),
          release_date
        FROM movies;

        DROP TABLE movies;
        ALTER TABLE movies_next RENAME TO movies;
      `);
    });
    transaction();
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Rebuild `theaters` without the legacy `distance_km` column.
 *
 * Adding `distance_miles` was only half of that rename. The old column stayed,
 * and on any database created before it that column is `REAL NOT NULL` with no
 * default — so every INSERT the current seed writes, which names
 * `distance_miles` and not `distance_km`, dies on
 * "NOT NULL constraint failed: theaters.distance_km". It surfaced in a deploy
 * that had already swapped the containers, leaving the site up on a catalogue
 * the seed had emptied and could not refill.
 *
 * SQLite cannot drop a column on the versions this ships against, so the table
 * is rebuilt exactly the way `rebuildMoviesTable` does it. `theaters` is
 * referenced by `showings.theater_id`; foreign keys are off for the swap, and
 * the reference resolves again by name once the rename lands. The only indexes
 * on the table are the PRIMARY KEY autoindexes, which the new table gets on its
 * own.
 */
function rebuildTheatersTable(sqlite: Database.Database): void {
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    const transaction = sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE theaters_next (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          location TEXT NOT NULL,
          screen_count INTEGER NOT NULL,
          distance_miles REAL NOT NULL,
          amenities TEXT NOT NULL
        );

        INSERT INTO theaters_next (
          id,
          name,
          location,
          screen_count,
          distance_miles,
          amenities
        )
        SELECT
          id,
          name,
          location,
          screen_count,
          -- distance_miles was added with DEFAULT 0, so a row still holding 0
          -- is one the copy never reached; prefer the legacy value there rather
          -- than freezing every theater at zero miles away.
          CASE
            WHEN distance_miles IS NOT NULL AND distance_miles <> 0 THEN distance_miles
            ELSE COALESCE(distance_km, 0)
          END,
          COALESCE(amenities, '[]')
        FROM theaters;

        DROP TABLE theaters;
        ALTER TABLE theaters_next RENAME TO theaters;
      `);
    });
    transaction();
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}

function normalizeMovieDurations(sqlite: Database.Database): void {
  const rows = sqlite.prepare('SELECT id, duration FROM movies').all() as Array<{
    id: string;
    duration: unknown;
  }>;
  if (rows.length === 0) return;

  const updateDuration = sqlite.prepare('UPDATE movies SET duration = ? WHERE id = ?');
  const transaction = sqlite.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeDurationText(row.duration);
      if (!normalized || normalized === row.duration) continue;
      updateDuration.run(normalized, row.id);
    }
  });
  transaction();
}

export function ensureDbSchema(sqlite: Database.Database): void {
  const movieTableInfo = getTableInfoRows(sqlite, 'movies');
  let movieColumnNames = new Set(movieTableInfo.map((column) => column.name));
  if (movieColumnNames.size > 0) {
    if (!movieColumnNames.has('age_rating')) {
      sqlite.exec("ALTER TABLE movies ADD COLUMN age_rating TEXT NOT NULL DEFAULT 'NR'");
      movieColumnNames.add('age_rating');
    }
    if (!movieColumnNames.has('synopsis')) {
      sqlite.exec("ALTER TABLE movies ADD COLUMN synopsis TEXT NOT NULL DEFAULT ''");
      movieColumnNames.add('synopsis');
    }

    const durationColumn = movieTableInfo.find((column) => column.name === 'duration');
    if (durationColumn && normalizedColumnType(durationColumn.type) !== 'TEXT') {
      rebuildMoviesTable(sqlite);
      movieColumnNames = getColumnNames(sqlite, 'movies');
    }

    normalizeMovieDurations(sqlite);
  }

  const theaterColumnNames = getColumnNames(sqlite, 'theaters');
  if (theaterColumnNames.size > 0) {
    const hasDistanceKm = theaterColumnNames.has('distance_km');
    const hasDistanceMiles = theaterColumnNames.has('distance_miles');

    if (!hasDistanceMiles) {
      sqlite.exec('ALTER TABLE theaters ADD COLUMN distance_miles REAL NOT NULL DEFAULT 0');
      if (hasDistanceKm) {
        sqlite.exec('UPDATE theaters SET distance_miles = distance_km');
      }
    }

    if (!theaterColumnNames.has('amenities')) {
      sqlite.exec("ALTER TABLE theaters ADD COLUMN amenities TEXT NOT NULL DEFAULT '[]'");
    }

    // Last, so the rebuild copies from columns that are guaranteed to exist by
    // the two steps above. Adding the new column was never the migration —
    // removing the old one is, and until it goes the seed cannot insert a row.
    if (hasDistanceKm) {
      rebuildTheatersTable(sqlite);
    }
  }

  const showingColumnNames = getColumnNames(sqlite, 'showings');
  if (showingColumnNames.size > 0 && !showingColumnNames.has('format')) {
    sqlite.exec("ALTER TABLE showings ADD COLUMN format TEXT NOT NULL DEFAULT 'Standard'");
  }

  const seatColumnNames = getColumnNames(sqlite, 'seats');
  if (seatColumnNames.size > 0 && !seatColumnNames.has('price')) {
    sqlite.exec('ALTER TABLE seats ADD COLUMN price INTEGER NOT NULL DEFAULT 10');
  }
}
