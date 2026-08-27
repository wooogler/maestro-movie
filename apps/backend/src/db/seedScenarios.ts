import '../env';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { ensureDbSchema } from './ensureSchema';
import { buildScenarioSeats } from './scenarioSeatBuilder';
import {
  getScenarioCatalog,
  getScenarioTemplatePath,
  resolveScenarioTemplateDir,
} from '../study/scenarioCatalog';
import { loadScenarioDataset } from '../study/scenarioDataset';
import type { ScenarioDefinition } from '../study/types';
import { normalizeParkingAmenities } from '../utils/parkingAmenities';

interface ShowingRow {
  id: string;
  movie_id: string;
  theater_id: string;
}

function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      duration TEXT NOT NULL,
      rating TEXT NOT NULL,
      age_rating TEXT NOT NULL DEFAULT 'NR',
      synopsis TEXT NOT NULL DEFAULT '',
      release_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS theaters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      screen_count INTEGER NOT NULL,
      distance_miles REAL NOT NULL,
      amenities TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS showings (
      id TEXT PRIMARY KEY,
      movie_id TEXT NOT NULL REFERENCES movies(id),
      theater_id TEXT NOT NULL REFERENCES theaters(id),
      screen_number INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'Standard',
      total_seats INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      showing_id TEXT NOT NULL REFERENCES showings(id),
      row TEXT NOT NULL,
      number INTEGER NOT NULL,
      type TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      showing_id TEXT NOT NULL REFERENCES showings(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      total_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS booking_seats (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      seat_id TEXT NOT NULL REFERENCES seats(id)
    );
  `);

  ensureDbSchema(sqlite);
}

function runBaseSeed(targetDbPath: string): void {
  const backendRoot = path.resolve(process.cwd(), 'apps/backend');
  const cwd = fs.existsSync(path.join(backendRoot, 'package.json'))
    ? backendRoot
    : process.cwd();

  const distSeedPath = path.resolve(cwd, 'dist/db/seed.js');
  const commonEnv = {
    ...process.env,
    DATABASE_URL: targetDbPath,
  };
  const result = fs.existsSync(distSeedPath)
    ? spawnSync(process.execPath, [distSeedPath], {
        cwd,
        env: commonEnv,
        stdio: 'inherit',
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'db:seed'], {
        cwd,
        env: commonEnv,
        stdio: 'inherit',
      });

  if (result.status !== 0) {
    throw new Error(`Base seed failed for ${targetDbPath}`);
  }
}

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function applyScenarioFilters(dbPath: string, scenario: ScenarioDefinition): void {
  const filters = scenario.seedFilters;
  if (!filters) return;

  const includeMovieIds =
    Array.isArray(filters.includeMovieIds) && filters.includeMovieIds.length > 0
      ? new Set(filters.includeMovieIds)
      : null;
  const includeTheaterIds =
    Array.isArray(filters.includeTheaterIds) && filters.includeTheaterIds.length > 0
      ? new Set(filters.includeTheaterIds)
      : null;

  if (!includeMovieIds && !includeTheaterIds) return;

  const sqlite = new Database(dbPath);
  try {
    sqlite.exec('PRAGMA foreign_keys = OFF');
    const showings = sqlite
      .prepare('SELECT id, movie_id, theater_id FROM showings')
      .all() as ShowingRow[];

    const allowedShowingIds = showings
      .filter((showing) => {
        if (includeMovieIds && !includeMovieIds.has(showing.movie_id)) return false;
        if (includeTheaterIds && !includeTheaterIds.has(showing.theater_id)) return false;
        return true;
      })
      .map((showing) => showing.id);

    if (allowedShowingIds.length === 0) {
      throw new Error(`Scenario ${scenario.id} filters removed all showings.`);
    }

    const showingsToDelete = showings
      .map((showing) => showing.id)
      .filter((id) => !allowedShowingIds.includes(id));

    if (showingsToDelete.length > 0) {
      const placeholders = inClause(showingsToDelete.length);
      sqlite
        .prepare(`DELETE FROM seats WHERE showing_id IN (${placeholders})`)
        .run(...showingsToDelete);
      sqlite
        .prepare(`DELETE FROM showings WHERE id IN (${placeholders})`)
        .run(...showingsToDelete);
    }

    const usedMovieIds = sqlite
      .prepare('SELECT DISTINCT movie_id AS id FROM showings')
      .all() as Array<{ id: string }>;
    if (usedMovieIds.length > 0) {
      const usedMoviePlaceholders = inClause(usedMovieIds.length);
      sqlite
        .prepare(`DELETE FROM movies WHERE id NOT IN (${usedMoviePlaceholders})`)
        .run(...usedMovieIds.map((item) => item.id));
    }

    const usedTheaterIds = sqlite
      .prepare('SELECT DISTINCT theater_id AS id FROM showings')
      .all() as Array<{ id: string }>;
    if (usedTheaterIds.length > 0) {
      const usedTheaterPlaceholders = inClause(usedTheaterIds.length);
      sqlite
        .prepare(`DELETE FROM theaters WHERE id NOT IN (${usedTheaterPlaceholders})`)
        .run(...usedTheaterIds.map((item) => item.id));
    }

    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('VACUUM');
  } finally {
    sqlite.close();
  }
}

function ensureTemplateDir(): string {
  const dir = resolveScenarioTemplateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedScenarioFromDataset(templatePath: string, scenario: ScenarioDefinition): void {
  const dataset = loadScenarioDataset(scenario);
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  if (fs.existsSync(templatePath)) {
    fs.unlinkSync(templatePath);
  }

  const sqlite = new Database(templatePath);

  try {
    createTables(sqlite);
    sqlite.exec('PRAGMA foreign_keys = ON');

    const insertMovie = sqlite.prepare(
      'INSERT INTO movies (id, title, genre, duration, rating, age_rating, synopsis, release_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertTheater = sqlite.prepare(
      'INSERT INTO theaters (id, name, location, screen_count, distance_miles, amenities) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertShowing = sqlite.prepare(
      'INSERT INTO showings (id, movie_id, theater_id, screen_number, date, time, format, total_seats) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertSeat = sqlite.prepare(
      'INSERT INTO seats (id, showing_id, row, number, type, price, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    const seats = buildScenarioSeats(
      dataset.showings,
      dataset.seatTemplate,
      dataset.seatOverrides,
      dataset.seatTemplateOverrides
    );

    const transaction = sqlite.transaction(() => {
      for (const movie of dataset.movies) {
        insertMovie.run(
          movie.id,
          movie.title,
          JSON.stringify(movie.genre),
          movie.duration,
          movie.rating,
          movie.ageRating,
          movie.synopsis,
          movie.releaseDate
        );
      }

      for (const theater of dataset.theaters) {
        insertTheater.run(
          theater.id,
          theater.name,
          theater.location,
          theater.screenCount,
          theater.distanceMiles,
          JSON.stringify(normalizeParkingAmenities(theater.amenities))
        );
      }

      for (const showing of dataset.showings) {
        insertShowing.run(
          showing.id,
          showing.movieId,
          showing.theaterId,
          showing.screenNumber,
          showing.date,
          showing.time,
          showing.format,
          showing.totalSeats
        );
      }

      for (const seat of seats) {
        insertSeat.run(
          seat.id,
          seat.showingId,
          seat.row,
          seat.number,
          seat.type,
          seat.price,
          seat.status
        );
      }
    });

    transaction();
    sqlite.exec('VACUUM');
  } finally {
    sqlite.close();
  }
}

function seedScenarioTemplate(scenario: ScenarioDefinition): void {
  const templatePath = getScenarioTemplatePath(scenario);
  console.log(`[seed:scenarios] Seeding ${scenario.id} -> ${templatePath}`);
  if (scenario.seedDataFile) {
    seedScenarioFromDataset(templatePath, scenario);
    return;
  }

  runBaseSeed(templatePath);
  applyScenarioFilters(templatePath, scenario);
}

async function main(): Promise<void> {
  ensureTemplateDir();
  const scenarios = getScenarioCatalog(true);
  // Several scenarios can share one world — the demo cards all run against the
  // same generated Detroit dataset — so a template is built once, not per card.
  const built = new Set<string>();
  for (const scenario of scenarios) {
    if (built.has(scenario.templateDbFile)) {
      console.log(`[seed:scenarios] ${scenario.id} reuses ${scenario.templateDbFile}`);
      continue;
    }
    seedScenarioTemplate(scenario);
    built.add(scenario.templateDbFile);
  }
  console.log(`[seed:scenarios] Complete. Generated ${built.size} scenario template DBs.`);
}

void main().catch((error) => {
  console.error(
    `[seed:scenarios] Failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
