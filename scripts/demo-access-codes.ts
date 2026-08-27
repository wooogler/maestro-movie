/**
 * Access-code admin CLI for the conference demo.
 *
 *   npx tsx scripts/demo-access-codes.ts generate --count 120 --batch uist-day1
 *   npx tsx scripts/demo-access-codes.ts generate --count 120 --ttl-hours 24 --format cards
 *   npx tsx scripts/demo-access-codes.ts stats
 *   npx tsx scripts/demo-access-codes.ts revoke --batch uist-day1
 *   npx tsx scripts/demo-access-codes.ts revoke --all
 *
 * Codes are printed to stdout exactly once, at generation. Redirect them to a
 * file you can print from, and keep that file off any shared drive — a code is
 * a bearer credential for one demo session on the operator's key.
 */
import {
  generateAccessCodes,
  getAccessCodeStats,
  listBatches,
  revokeAccessCodes,
  DEMO_ACCESS_CODE_TTL_HOURS,
} from '../apps/backend/src/study/demoAccessCodes';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Grouped into fours so a code is easy to read aloud across a noisy booth. */
function formatCards(codes: string[], expiresLabel: string): string {
  return codes
    .map(
      (code, i) =>
        `┌──────────────────────────────┐\n` +
        `│  MAESTRO demo access code    │\n` +
        `│                              │\n` +
        `│        ${code.slice(0, 3)} ${code.slice(3)}              │\n` +
        `│                              │\n` +
        `│  one session · ${expiresLabel.padEnd(14)}│\n` +
        `└──────────────────────────────┘  #${String(i + 1).padStart(3, '0')}`
    )
    .join('\n');
}

function main(): void {
  const command = process.argv[2];

  if (command === 'generate') {
    const count = Number.parseInt(readFlag('count') ?? '', 10);
    if (!Number.isFinite(count) || count <= 0) {
      die('--count is required and must be a positive integer.');
    }
    if (count > 2000) {
      die('Refusing to generate more than 2000 codes at once; the live pool is the brute-force denominator.');
    }
    const ttlRaw = readFlag('ttl-hours');
    const ttlHours = ttlRaw ? Number.parseFloat(ttlRaw) : DEMO_ACCESS_CODE_TTL_HOURS;
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) die('--ttl-hours must be a positive number.');
    const batch = readFlag('batch');

    const codes = generateAccessCodes({ count, ttlHours, batch });
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    const expiresLabel = expiresAt.toISOString().slice(0, 16).replace('T', ' ');

    if (readFlag('format') === 'cards') {
      console.log(formatCards(codes, expiresLabel));
    } else {
      for (const code of codes) console.log(code);
    }

    console.error(
      `\n${codes.length} codes generated${batch ? ` in batch "${batch}"` : ''}, ` +
        `expiring ${expiresAt.toISOString()} (${ttlHours}h).\n` +
        'These are printed once and cannot be listed again. Save this output now.'
    );
    return;
  }

  if (command === 'stats') {
    const batch = readFlag('batch');
    const stats = getAccessCodeStats(batch);
    console.log(JSON.stringify(stats, null, 2));
    if (!batch) {
      const batches = listBatches();
      if (batches.length > 0) {
        console.log('\nbatches:');
        for (const row of batches) console.log(`  ${row.batch ?? '(none)'}: ${row.total}`);
      }
    }
    return;
  }

  if (command === 'revoke') {
    const batch = readFlag('batch');
    const code = readFlag('code');
    if (!batch && !code && !hasFlag('all')) {
      die('revoke needs --batch <name>, --code <code>, or --all.');
    }
    const changed = revokeAccessCodes({ batch, code });
    console.log(`Revoked ${changed} code(s).`);
    return;
  }

  die(
    'Usage:\n' +
      '  demo-access-codes.ts generate --count N [--batch NAME] [--ttl-hours H] [--format cards]\n' +
      '  demo-access-codes.ts stats [--batch NAME]\n' +
      '  demo-access-codes.ts revoke (--batch NAME | --code CODE | --all)'
  );
}

main();
