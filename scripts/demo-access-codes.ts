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

/**
 * Parses a date the operator typed on the command line.
 *
 * Accepts `YYYY-MM-DD` (midnight), `YYYY-MM-DDTHH:MM`, or a full ISO string
 * with an offset. A value without an offset is read in the SERVER's local
 * timezone, because that is the clock the operator is looking at — but the
 * resolved window is always echoed back in both local and UTC so a conference
 * in another timezone cannot be set wrong silently.
 */
function parseWhen(raw: string, label: string): Date {
  const trimmed = raw.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const naiveDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(trimmed);
  // `new Date('2026-10-12')` is UTC midnight but `new Date('2026-10-12T00:00')`
  // is local midnight. Normalize so both mean local.
  const normalized = dateOnly ? `${trimmed}T00:00` : naiveDateTime ? trimmed.replace(' ', 'T') : trimmed;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    die(`${label} is not a date I can read: "${raw}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  }
  return parsed;
}

function describeWhen(d: Date): string {
  return `${d.toLocaleString('sv-SE')} local  (${d.toISOString()} UTC)`;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const CARD_WIDTH = 34;

/** One bordered line, padded to the card's inner width. */
function cardLine(content: string, align: 'left' | 'center' = 'left'): string {
  // Clamp rather than trust the caller: a long label used to push the right
  // border off and break the whole card.
  const text = content.length > CARD_WIDTH - 4 ? `${content.slice(0, CARD_WIDTH - 5)}…` : content;
  content = text;
  const padding = Math.max(0, CARD_WIDTH - content.length);
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `│${' '.repeat(left)}${content}${' '.repeat(padding - left)}│`;
  }
  return `│  ${content}${' '.repeat(Math.max(0, padding - 2))}│`;
}

/** Split into two groups so a code is easy to read aloud across a noisy booth. */
function formatCards(
  codes: string[],
  expiresLabel: string,
  maxRedemptions: number | undefined
): string {
  const top = `┌${'─'.repeat(CARD_WIDTH)}┐`;
  const bottom = `└${'─'.repeat(CARD_WIDTH)}┘`;
  return codes
    .map((code, i) =>
      [
        top,
        cardLine('MAESTRO demo access code'),
        cardLine(''),
        cardLine(`${code.slice(0, 3)} ${code.slice(3)}`, 'center'),
        cardLine(''),
        // The validity window gets its own line: with both ends and times it is
        // too wide to share one, and a truncated date is worse than useless.
        cardLine(
          maxRedemptions ? `${maxRedemptions} use${maxRedemptions > 1 ? 's' : ''}` : 'reusable'
        ),
        cardLine(expiresLabel),
        `${bottom}  #${String(i + 1).padStart(3, '0')}`,
      ].join('\n')
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
    const ttlHours = hasFlag('no-expiry')
      ? 0
      : ttlRaw
      ? Number.parseFloat(ttlRaw)
      : DEMO_ACCESS_CODE_TTL_HOURS;
    if (!Number.isFinite(ttlHours) || ttlHours < 0) {
      die('--ttl-hours must be a non-negative number (or pass --no-expiry).');
    }

    const fromRaw = readFlag('valid-from');
    const untilRaw = readFlag('valid-until');
    const validFromDate = fromRaw ? parseWhen(fromRaw, '--valid-from') : null;
    const validUntilDate = untilRaw ? parseWhen(untilRaw, '--valid-until') : null;
    // A bare --valid-from with no end still gets the TTL, measured from the
    // start of the window rather than from now — otherwise codes printed a week
    // early would expire before the event opened.
    const resolvedUntil =
      validUntilDate ??
      (validFromDate && ttlHours > 0
        ? new Date(validFromDate.getTime() + ttlHours * 3600_000)
        : null);
    if (validFromDate && resolvedUntil && validFromDate >= resolvedUntil) {
      die('--valid-until must be after --valid-from.');
    }
    const maxUsesRaw = readFlag('max-uses');
    const maxRedemptions = maxUsesRaw ? Number.parseInt(maxUsesRaw, 10) : undefined;
    if (maxUsesRaw && (!Number.isFinite(maxRedemptions) || (maxRedemptions as number) <= 0)) {
      die('--max-uses must be a positive integer.');
    }
    const batch = readFlag('batch');

    const codes = generateAccessCodes({
      count,
      ttlHours,
      maxRedemptions,
      batch,
      ...(validFromDate ? { validFrom: validFromDate.toISOString() } : {}),
      ...(resolvedUntil ? { validUntil: resolvedUntil.toISOString() } : {}),
    });
    const expiresAt =
      resolvedUntil ?? (ttlHours > 0 ? new Date(Date.now() + ttlHours * 3600_000) : null);
    // Local MM-DD HH:MM on the card: the person reading it is standing in the
    // venue, not converting from UTC.
    const atMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0;
    // Times are noise on a card when the window is whole days.
    const wholeDays =
      (!validFromDate || atMidnight(validFromDate)) && (!expiresAt || atMidnight(expiresAt));
    const stamp = (d: Date) =>
      d.toLocaleString('sv-SE').slice(5, wholeDays ? 10 : 16);
    const expiresLabel = validFromDate
      ? `${stamp(validFromDate)} \u2192 ${expiresAt ? stamp(expiresAt) : 'open'}`
      : expiresAt
      ? `until ${stamp(expiresAt)}`
      : 'no expiry';

    if (readFlag('format') === 'cards') {
      console.log(formatCards(codes, expiresLabel, maxRedemptions));
    } else {
      for (const code of codes) console.log(code);
    }

    console.error(
      `\n${codes.length} codes generated${batch ? ` in batch "${batch}"` : ''}.\n` +
        (validFromDate ? `  valid from : ${describeWhen(validFromDate)}\n` : '  valid from : immediately\n') +
        (expiresAt ? `  valid until: ${describeWhen(expiresAt)}\n` : '  valid until: no expiry\n') +
        `${maxRedemptions ? `Max ${maxRedemptions} use(s) each.` : 'Reusable without limit.'}\n` +
        'These are printed once and cannot be listed again. Save this output now.' +
        (!expiresAt && !maxRedemptions
          ? '\nNOTE: with no expiry and no use limit, each code is a shared password.\n' +
            '      Revoke the batch when the event ends: npm run codes:revoke -- --batch <name>'
          : '')
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
      '  demo-access-codes.ts generate --count N [--batch NAME]\n' +
      '        [--ttl-hours H | --no-expiry] [--max-uses N] [--format cards]\n' +
      '        [--valid-from YYYY-MM-DD[THH:MM]] [--valid-until YYYY-MM-DD[THH:MM]]\n' +
      '  demo-access-codes.ts stats [--batch NAME]\n' +
      '  demo-access-codes.ts revoke (--batch NAME | --code CODE | --all)'
  );
}

main();
