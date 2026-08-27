/**
 * Access codes that let a conference visitor run a demo session on the
 * operator's OpenAI key without ever seeing it.
 *
 * A code is REUSABLE by default: redeeming it does not consume it. Limits are
 * whatever the operator sets — an expiry, a maximum number of uses, or neither.
 *
 * Be clear-eyed about what that means. A reusable code with no expiry is a
 * shared password. Once it is photographed at a booth it is public, and it
 * keeps working for everyone who has the picture until someone revokes it. The
 * defences that remain are:
 *
 *  - **Search space.** Six characters from a 30-symbol alphabet is 7.29e8
 *    combinations, so the code cannot be found by guessing while the redemption
 *    rate limiter is in place. Six *digits* would have been a million
 *    combinations and crackable in minutes; that is why this is not a PIN.
 *  - **Revocation.** One command kills a code or a whole batch immediately.
 *  - **Concurrency.** DEMO_MAX_CONCURRENT_SESSIONS still caps how many sessions
 *    can run at once no matter how many people hold the code.
 *
 * If a leak matters, set `maxRedemptions` or an expiry when generating. If
 * neither is set, plan to revoke the batch when the event ends.
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

/** Hours a generated code stays valid. 0 means it never expires. */
export const DEMO_ACCESS_CODE_TTL_HOURS = (() => {
  const raw = process.env.DEMO_ACCESS_CODE_TTL_HOURS;
  if (raw === undefined) return 24;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24;
})();

export interface AccessCodeRow {
  code: string;
  batch: string | null;
  createdAt: string;
  /** null = valid immediately. */
  validFrom: string | null;
  /** null = never expires. */
  expiresAt: string | null;
  /** null = unlimited uses. */
  maxRedemptions: number | null;
  redemptionCount: number;
  lastRedeemedAt: string | null;
  lastSessionId: string | null;
  revokedAt: string | null;
}

export type RedeemFailure =
  | 'unknown'
  | 'not_yet_valid'
  | 'exhausted'
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
      valid_from TEXT,
      expires_at TEXT,
      max_redemptions INTEGER,
      redemption_count INTEGER NOT NULL DEFAULT 0,
      last_redeemed_at TEXT,
      last_session_id TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_codes_batch ON access_codes(batch);
  `);
  migrateFromSingleUseSchema(db);
  addValidFromColumn(db);
  handle = db;
  return db;
}

/** Adds `valid_from` to a store created before scheduled windows existed. */
function addValidFromColumn(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(access_codes)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  if (columns.has('valid_from')) return;
  db.exec('ALTER TABLE access_codes ADD COLUMN valid_from TEXT');
}

/**
 * Rebuilds a store created by the original single-use schema.
 *
 * That version had `expires_at TEXT NOT NULL` plus `redeemed_at` /
 * `redeemed_session_id`, and SQLite cannot drop a NOT NULL constraint in place,
 * so the table is recreated and copied. An already-redeemed code carries its
 * redemption forward as a count of 1 rather than being reset — the operator
 * handed it out believing it was consumed.
 */
function migrateFromSingleUseSchema(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(access_codes)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  if (!columns.has('redeemed_at')) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE access_codes_next (
        code TEXT PRIMARY KEY,
        batch TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        max_redemptions INTEGER,
        redemption_count INTEGER NOT NULL DEFAULT 0,
        last_redeemed_at TEXT,
        last_session_id TEXT,
        revoked_at TEXT
      );
      INSERT INTO access_codes_next
        (code, batch, created_at, expires_at, max_redemptions,
         redemption_count, last_redeemed_at, last_session_id, revoked_at)
      SELECT code, batch, created_at, expires_at, NULL,
             CASE WHEN redeemed_at IS NULL THEN 0 ELSE 1 END,
             redeemed_at, redeemed_session_id, revoked_at
        FROM access_codes;
      DROP TABLE access_codes;
      ALTER TABLE access_codes_next RENAME TO access_codes;
      CREATE INDEX IF NOT EXISTS idx_access_codes_batch ON access_codes(batch);
    `);
  })();
  console.warn('[study] demo access-code store migrated to the reusable-code schema.');
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
  /** 0 means never expires. Ignored when `validUntil` is given. */
  ttlHours?: number;
  /** ISO instant the codes start working. Omitted = immediately. */
  validFrom?: string;
  /** ISO instant the codes stop working. Overrides `ttlHours`. */
  validUntil?: string;
  /** Omitted means unlimited uses. */
  maxRedemptions?: number;
  batch?: string;
}): string[] {
  const db = getDb();
  const ttlHours = options.ttlHours ?? DEMO_ACCESS_CODE_TTL_HOURS;
  const now = new Date();
  const createdAt = now.toISOString();
  const validFrom = options.validFrom ?? null;
  // An explicit window wins over a relative TTL: a code printed today for a
  // conference next week must not quietly expire 24h after it was generated.
  const expiresAt =
    options.validUntil ??
    (ttlHours > 0 ? new Date(now.getTime() + ttlHours * 3600_000).toISOString() : null);
  if (validFrom && expiresAt && validFrom >= expiresAt) {
    throw new Error('The validity window ends before it begins.');
  }
  const maxRedemptions =
    typeof options.maxRedemptions === 'number' && options.maxRedemptions > 0
      ? Math.floor(options.maxRedemptions)
      : null;
  const batch = options.batch ?? null;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO access_codes
       (code, batch, created_at, valid_from, expires_at, max_redemptions)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const created: string[] = [];
  const write = db.transaction(() => {
    // A collision just means we draw again; the loop is bounded so a
    // pathological alphabet/size mistake cannot hang the process.
    let attempts = 0;
    while (created.length < options.count && attempts < options.count * 50) {
      attempts += 1;
      const code = randomCode();
      const result = insert.run(code, batch, createdAt, validFrom, expiresAt, maxRedemptions);
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
 * Records one use of a code.
 *
 * Every precondition lives in the WHERE clause, so concurrent redemptions are
 * settled by SQLite rather than by application logic. That matters when a code
 * has a `max_redemptions` cap: two people racing the last slot cannot both win,
 * because the count is compared and incremented in the same statement.
 *
 * A code with no expiry and no cap always succeeds until it is revoked.
 */
export function redeemAccessCode(rawCode: string, sessionId: string): RedeemResult {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: 'unknown' };

  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE access_codes
          SET redemption_count = redemption_count + 1,
              last_redeemed_at = ?,
              last_session_id = ?
        WHERE code = ?
          AND revoked_at IS NULL
          AND (valid_from IS NULL OR valid_from <= ?)
          AND (expires_at IS NULL OR expires_at > ?)
          AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`
    )
    .run(now, sessionId, code, now, now);

  if (result.changes > 0) return { ok: true, code };

  // Nothing changed: work out why, for a message the visitor can act on.
  const row = db
    .prepare(
      `SELECT valid_from, expires_at, revoked_at, max_redemptions, redemption_count
         FROM access_codes WHERE code = ?`
    )
    .get(code) as
    | {
        valid_from: string | null;
        expires_at: string | null;
        revoked_at: string | null;
        max_redemptions: number | null;
        redemption_count: number;
      }
    | undefined;

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.valid_from && row.valid_from > now) return { ok: false, reason: 'not_yet_valid' };
  if (row.expires_at && row.expires_at <= now) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'exhausted' };
}

/**
 * Gives back the use a session consumed, for a demo that died before starting.
 * Only meaningful for a code with a `max_redemptions` cap; harmless otherwise.
 */
export function releaseAccessCode(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE access_codes
          SET redemption_count = MAX(0, redemption_count - 1),
              last_session_id = NULL
        WHERE last_session_id = ?`
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
  usable: number;
  pending: number;
  redemptions: number;
  expired: number;
  exhausted: number;
  revoked: number;
}

export function getAccessCodeStats(batch?: string): AccessCodeStats {
  const db = getDb();
  const now = new Date().toISOString();
  const counts = `
    COUNT(*) AS total,
    SUM(CASE WHEN revoked_at IS NULL
              AND (valid_from IS NULL OR valid_from <= $now)
              AND (expires_at IS NULL OR expires_at > $now)
              AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
         THEN 1 ELSE 0 END) AS usable,
    SUM(CASE WHEN revoked_at IS NULL AND valid_from IS NOT NULL AND valid_from > $now
         THEN 1 ELSE 0 END) AS pending,
    SUM(redemption_count) AS redemptions,
    SUM(CASE WHEN revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $now
         THEN 1 ELSE 0 END) AS expired,
    SUM(CASE WHEN revoked_at IS NULL
              AND max_redemptions IS NOT NULL
              AND redemption_count >= max_redemptions
         THEN 1 ELSE 0 END) AS exhausted,
    SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
  `;
  const row = (
    batch === undefined
      ? db.prepare(`SELECT ${counts} FROM access_codes`).get({ now })
      : db.prepare(`SELECT ${counts} FROM access_codes WHERE batch = $batch`).get({ now, batch })
  ) as Record<string, number | null>;

  return {
    total: Number(row.total ?? 0),
    usable: Number(row.usable ?? 0),
    pending: Number(row.pending ?? 0),
    redemptions: Number(row.redemptions ?? 0),
    expired: Number(row.expired ?? 0),
    exhausted: Number(row.exhausted ?? 0),
    revoked: Number(row.revoked ?? 0),
  };
}

/** Codes redeemable right now — the denominator for the brute-force math. */
export function countUsableAccessCodes(): number {
  return getAccessCodeStats().usable;
}

export function listBatches(): Array<{ batch: string | null; total: number }> {
  return getDb()
    .prepare('SELECT batch, COUNT(*) AS total FROM access_codes GROUP BY batch ORDER BY batch')
    .all() as Array<{ batch: string | null; total: number }>;
}
