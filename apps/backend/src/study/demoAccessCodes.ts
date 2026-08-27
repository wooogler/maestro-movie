/**
 * Single-use access codes that let a conference visitor run a demo session on
 * the operator's OpenAI key without ever seeing it.
 *
 * Threat model: the codes are printed on cards and handed out at a booth, so
 * assume every code that has been shown is public. Three properties carry the
 * design:
 *
 *  - **Single use.** Redemption is an atomic conditional UPDATE, so a code that
 *    has been used is worthless to whoever photographed it. Two people racing
 *    the same code means exactly one wins.
 *  - **Expiry.** A code is dead after its TTL whether or not it was used.
 *  - **Search space.** Six characters from a 30-symbol alphabet is 7.29e8
 *    combinations. With 200 live codes a blind guess hits with probability
 *    2.7e-7, so brute force needs ~3.6M attempts on average — which the
 *    redemption rate limiter turns into years. Six *digits* would have been a
 *    million combinations and guessable in minutes; that is why this is not a
 *    numeric PIN.
 *
 * None of this is the real ceiling on spend. The only control that survives a
 * bug in this file is a per-project budget limit set at OpenAI on a key minted
 * for the demo and nothing else.
 *
 * Storage is a dedicated SQLite file under `.runtime/`. It deliberately does
 * NOT live in the movie database: `dbManager` clones that file per session, so
 * codes stored there would fork on every visit and a redemption would not stick.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomInt } from 'crypto';

/**
 * Crockford-style base32 minus the characters people misread on a printed card
 * or over a noisy booth: 0/O, 1/I/L, and U. 30 symbols.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

export const DEMO_ACCESS_CODES_ENABLED =
  process.env.DEMO_ACCESS_CODES_ENABLED?.trim() === 'true';

function parsePositiveNumberEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEMO_ACCESS_CODE_TTL_HOURS = parsePositiveNumberEnv(
  process.env.DEMO_ACCESS_CODE_TTL_HOURS,
  24
);

export interface AccessCodeRow {
  code: string;
  batch: string | null;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedSessionId: string | null;
  revokedAt: string | null;
}

export type RedeemFailure =
  | 'unknown'
  | 'already_redeemed'
  | 'expired'
  | 'revoked';

export type RedeemResult =
  | { ok: true; code: string }
  | { ok: false; reason: RedeemFailure };

function dbFileCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'apps/backend/.runtime/demo-access-codes.db'),
    path.resolve(process.cwd(), '.runtime/demo-access-codes.db'),
    path.resolve(__dirname, '../../.runtime/demo-access-codes.db'),
  ];
}

function resolveDbFilePath(): string {
  for (const candidate of dbFileCandidates()) {
    if (fs.existsSync(path.dirname(candidate))) return candidate;
  }
  return dbFileCandidates()[0];
}

let handle: Database.Database | null = null;

function getDb(): Database.Database {
  if (handle) return handle;
  const filePath = resolveDbFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  // WAL keeps a redemption from blocking a concurrent read, and the busy
  // timeout means a race waits instead of throwing SQLITE_BUSY at a visitor.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_codes (
      code TEXT PRIMARY KEY,
      batch TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_session_id TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_codes_batch ON access_codes(batch);
  `);
  handle = db;
  return db;
}

/**
 * Uppercase and drop separators, so a card printed `4F7K-2M` is accepted however
 * the visitor types it.
 *
 * No character substitution happens here on purpose. The alphabet already
 * excludes every commonly-confused symbol (0, 1, I, L, O, U), so those
 * characters cannot appear in a real code — silently rewriting them to valid
 * ones would map several different typos onto real codes and hand a brute-force
 * script extra hits per guess.
 */
export function normalizeAccessCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export function generateAccessCodes(options: {
  count: number;
  ttlHours?: number;
  batch?: string;
}): string[] {
  const db = getDb();
  const ttlHours = options.ttlHours ?? DEMO_ACCESS_CODE_TTL_HOURS;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();
  const batch = options.batch ?? null;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO access_codes (code, batch, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  );

  const created: string[] = [];
  const write = db.transaction(() => {
    // A collision just means we draw again; the loop is bounded so a
    // pathological alphabet/size mistake cannot hang the process.
    let attempts = 0;
    while (created.length < options.count && attempts < options.count * 50) {
      attempts += 1;
      const code = randomCode();
      const result = insert.run(code, batch, createdAt, expiresAt);
      if (result.changes > 0) created.push(code);
    }
  });
  write();

  if (created.length < options.count) {
    throw new Error(
      `Could only generate ${created.length} of ${options.count} codes; the code space may be exhausted.`
    );
  }
  return created;
}

/**
 * Atomically consume a code. The WHERE clause carries every precondition, so
 * concurrent redemptions of the same code cannot both succeed — SQLite settles
 * it, not application logic.
 */
export function redeemAccessCode(rawCode: string, sessionId: string): RedeemResult {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: 'unknown' };

  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE access_codes
          SET redeemed_at = ?, redeemed_session_id = ?
        WHERE code = ?
          AND redeemed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ?`
    )
    .run(now, sessionId, code, now);

  if (result.changes > 0) return { ok: true, code };

  // Nothing changed: work out why, for a message the visitor can act on.
  const row = db
    .prepare('SELECT redeemed_at, revoked_at, expires_at FROM access_codes WHERE code = ?')
    .get(code) as { redeemed_at: string | null; revoked_at: string | null; expires_at: string } | undefined;

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.redeemed_at) return { ok: false, reason: 'already_redeemed' };
  return { ok: false, reason: 'expired' };
}

/** Undo a redemption so the code can be used again — for a demo that crashed. */
export function releaseAccessCode(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE access_codes
          SET redeemed_at = NULL, redeemed_session_id = NULL
        WHERE redeemed_session_id = ?`
    )
    .run(sessionId);
}

export function revokeAccessCodes(options: { batch?: string; code?: string }): number {
  const db = getDb();
  const now = new Date().toISOString();
  if (options.code) {
    return db
      .prepare('UPDATE access_codes SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL')
      .run(now, normalizeAccessCode(options.code)).changes;
  }
  if (options.batch) {
    return db
      .prepare('UPDATE access_codes SET revoked_at = ? WHERE batch = ? AND revoked_at IS NULL')
      .run(now, options.batch).changes;
  }
  return db
    .prepare('UPDATE access_codes SET revoked_at = ? WHERE revoked_at IS NULL')
    .run(now).changes;
}

export interface AccessCodeStats {
  total: number;
  available: number;
  redeemed: number;
  expired: number;
  revoked: number;
}

export function getAccessCodeStats(batch?: string): AccessCodeStats {
  const db = getDb();
  const now = new Date().toISOString();
  const counts = `
    COUNT(*) AS total,
    SUM(CASE WHEN redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > $now THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed,
    SUM(CASE WHEN redeemed_at IS NULL AND revoked_at IS NULL AND expires_at <= $now THEN 1 ELSE 0 END) AS expired,
    SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
  `;
  const row = (
    batch === undefined
      ? db.prepare(`SELECT ${counts} FROM access_codes`).get({ now })
      : db.prepare(`SELECT ${counts} FROM access_codes WHERE batch = $batch`).get({ now, batch })
  ) as Record<string, number | null>;

  return {
    total: Number(row.total ?? 0),
    available: Number(row.available ?? 0),
    redeemed: Number(row.redeemed ?? 0),
    expired: Number(row.expired ?? 0),
    revoked: Number(row.revoked ?? 0),
  };
}

/** Number of codes still redeemable — the denominator for the brute-force math. */
export function countAvailableAccessCodes(): number {
  return getAccessCodeStats().available;
}

export function listBatches(): Array<{ batch: string | null; total: number }> {
  return getDb()
    .prepare('SELECT batch, COUNT(*) AS total FROM access_codes GROUP BY batch ORDER BY batch')
    .all() as Array<{ batch: string | null; total: number }>;
}
