/**
 * Executable check for `ensureDbSchema`, run against databases shaped the way
 * old ones on disk actually are:
 *
 *   npx tsx apps/backend/src/db/schemaMigration.check.ts
 *
 * It exists because of one deploy. `theaters.distance_km` was renamed to
 * `distance_miles`, and the migration added the new column without removing the
 * old one — which on every database created before the rename is
 * `REAL NOT NULL` with no default. The seed names `distance_miles` and not
 * `distance_km`, so every theater INSERT died on
 * "NOT NULL constraint failed: theaters.distance_km".
 *
 * The damage came from where it failed rather than that it failed: the deploy
 * had already swapped the containers, and `seed.ts` deletes the whole catalogue
 * before rebuilding it, so the site came up serving 8 movies and no theaters,
 * no showings and no seats.
 *
 * Nothing offline could have caught it, because every check in the repo builds
 * its database from the current `CREATE TABLE`, which has been correct all
 * along. The bug only exists in the gap between an old file and new code, so
 * this check writes the old file itself.
 *
 * Exit code 0 means every case passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ensureDbSchema } from './ensureSchema';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function withTempDb(run: (db: Database.Database) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-check-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * The schema as it was written before the rename, reproduced from the live
 * production file. `distance_km` carries no DEFAULT — that is the whole bug —
 * and neither `distance_miles` nor `amenities` exists yet.
 */
function createLegacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE movies (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      duration TEXT NOT NULL,
      rating TEXT NOT NULL,
      release_date TEXT NOT NULL
    );

    CREATE TABLE theaters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      screen_count INTEGER NOT NULL,
      distance_km REAL NOT NULL
    );

    CREATE TABLE showings (
      id TEXT PRIMARY KEY,
      movie_id TEXT NOT NULL REFERENCES movies(id),
      theater_id TEXT NOT NULL REFERENCES theaters(id),
      screen_number INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      total_seats INTEGER NOT NULL
    );

    CREATE TABLE seats (
      id TEXT PRIMARY KEY,
      showing_id TEXT NOT NULL REFERENCES showings(id),
      row TEXT NOT NULL,
      number INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
    );
  `);
}

/** The exact column list the seed and the drizzle schema write. */
const SEED_THEATER_INSERT =
  'INSERT INTO theaters (id, name, location, screen_count, distance_miles, amenities) VALUES (?, ?, ?, ?, ?, ?)';

// -----------------------------------------------------------------------------
section('1. a database from before the rename can be seeded');
// -----------------------------------------------------------------------------
withTempDb((db) => {
  createLegacySchema(db);
  db.prepare(
    'INSERT INTO theaters (id, name, location, screen_count, distance_km) VALUES (?, ?, ?, ?, ?)'
  ).run('t-old', 'Legacy Cinema', 'Somewhere', 6, 4.5);

  ensureDbSchema(db);

  const columns = columnNames(db, 'theaters');
  check('the legacy distance_km column is gone', !columns.has('distance_km'));
  check('distance_miles is there instead', columns.has('distance_miles'));
  check('and so is amenities', columns.has('amenities'));

  let inserted = true;
  let message = '';
  try {
    db.prepare(SEED_THEATER_INSERT).run('ta', 'Regal Battery Park', 'Battery Park', 11, 1.2, '[]');
  } catch (error) {
    inserted = false;
    message = error instanceof Error ? error.message : String(error);
  }
  // The assertion the deploy needed: this is the statement that failed in
  // production, run against the schema the migration leaves behind.
  check('the seed-shaped INSERT succeeds', inserted, message);

  const existing = db.prepare('SELECT distance_miles, amenities FROM theaters WHERE id = ?').get('t-old') as
    | { distance_miles: number; amenities: string }
    | undefined;
  check('the existing row survived the rebuild', Boolean(existing));
  check('its distance carried over rather than defaulting to 0', existing?.distance_miles === 4.5);
  check('and it got an empty amenities list, not null', existing?.amenities === '[]');
});

// -----------------------------------------------------------------------------
section('2. the rebuild does not break what points at theaters');
// -----------------------------------------------------------------------------
withTempDb((db) => {
  createLegacySchema(db);
  db.prepare('INSERT INTO movies VALUES (?, ?, ?, ?, ?, ?)').run(
    'm1',
    'A Film',
    'Drama',
    '1h 40m',
    '4.1',
    '2026-03-14'
  );
  db.prepare(
    'INSERT INTO theaters (id, name, location, screen_count, distance_km) VALUES (?, ?, ?, ?, ?)'
  ).run('t1', 'Cinema One', 'Detroit', 8, 2.0);
  db.prepare('INSERT INTO showings VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    's1',
    'm1',
    't1',
    3,
    '2026-03-14',
    '19:30',
    120
  );

  ensureDbSchema(db);

  check('foreign keys are back on afterwards', db.pragma('foreign_keys', { simple: true }) === 1);
  check(
    'no dangling references were left behind',
    (db.pragma('foreign_key_check') as unknown[]).length === 0
  );
  check(
    'the showing still resolves to its theater',
    (
      db
        .prepare('SELECT t.name AS name FROM showings s JOIN theaters t ON t.id = s.theater_id')
        .get() as { name?: string } | undefined
    )?.name === 'Cinema One'
  );

  // A new child row must still be rejected when its parent is missing: proof
  // the constraint is enforced again, not merely declared.
  let rejected = false;
  try {
    db.prepare('INSERT INTO showings VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      's2',
      'm1',
      'nope',
      1,
      '2026-03-14',
      '21:00',
      80
    );
  } catch {
    rejected = true;
  }
  check('a showing for a theater that does not exist is still refused', rejected);
});

// -----------------------------------------------------------------------------
section('3. a current database is left exactly as it is');
// -----------------------------------------------------------------------------
withTempDb((db) => {
  db.exec(`
    CREATE TABLE theaters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      screen_count INTEGER NOT NULL,
      distance_miles REAL NOT NULL,
      amenities TEXT NOT NULL
    );
  `);
  const before = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'theaters'").get() as { sql: string }
  ).sql;

  ensureDbSchema(db);
  ensureDbSchema(db);

  const after = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'theaters'").get() as { sql: string }
  ).sql;
  // Also the idempotence claim: `ensureDbSchema` runs on every session DB open
  // (`study/dbManager.ts`), not once at startup.
  check('an up-to-date table is not rebuilt, twice over', before === after);
});

// -----------------------------------------------------------------------------
section('4. an empty database is not touched');
// -----------------------------------------------------------------------------
withTempDb((db) => {
  let threw = false;
  try {
    // Every branch is guarded on the table existing; a fresh file has none.
    ensureDbSchema(db);
  } catch {
    threw = true;
  }
  check('ensureDbSchema on a database with no tables is a no-op', !threw);
});

console.log(failures === 0 ? '\nall schema migration checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
