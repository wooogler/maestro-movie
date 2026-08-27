/**
 * Executable check for access-code redemption and the brute-force limiter.
 * No test runner is configured, so this is a plain script:
 *
 *   npx tsx apps/backend/src/study/demoAccessCodes.check.ts
 *
 * Uses a scratch .runtime directory so it never touches real event codes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-codes-check-'));
fs.mkdirSync(path.join(scratch, '.runtime'), { recursive: true });
process.chdir(scratch);

// Tight limits so the limiter can be exercised without a thousand calls.
process.env.DEMO_ACCESS_MAX_FAILURES_PER_IP = '3';
process.env.DEMO_ACCESS_MAX_GLOBAL_FAILURES = '5';

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

async function main(): Promise<void> {
  const codes = await import('./demoAccessCodes');
  const limiter = await import('./redemptionLimiter');

  section('1. GENERATION — shape and alphabet');
  {
    const batch = codes.generateAccessCodes({ count: 20, ttlHours: 24, batch: 'check' });
    check('generates the requested count', batch.length === 20);
    check('all six characters', batch.every((c) => c.length === 6));
    check(
      'alphabet excludes confusable 0/1/I/L/O/U',
      batch.every((c) => /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(c)),
      batch.find((c) => !/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(c)),
    );
    check('codes are unique', new Set(batch).size === batch.length);
  }

  section('2. SINGLE USE — a code works exactly once');
  {
    const [code] = codes.generateAccessCodes({ count: 1, ttlHours: 24 });
    const first = codes.redeemAccessCode(code, 'st_session_a');
    check('first redemption succeeds', first.ok === true);
    const second = codes.redeemAccessCode(code, 'st_session_b');
    check('second redemption fails', second.ok === false);
    check(
      'and says why',
      second.ok === false && second.reason === 'already_redeemed',
      second.ok === false ? second.reason : 'unexpectedly ok',
    );
  }

  section('3. NORMALIZATION — as printed vs as typed');
  {
    const [code] = codes.generateAccessCodes({ count: 1, ttlHours: 24 });
    const typed = ` ${code.slice(0, 3)}-${code.slice(3).toLowerCase()} `;
    const result = codes.redeemAccessCode(typed, 'st_session_c');
    check('accepts lowercase, spaces and a dash', result.ok === true, JSON.stringify(result));
  }

  section('4. NORMALIZATION — no silent remapping onto valid codes');
  {
    // O/0, I/1, L and U are not in the alphabet. They must NOT be rewritten into
    // valid characters: that would give a brute-force script several codes per
    // guess. A typo has to fail.
    const [code] = codes.generateAccessCodes({ count: 1, ttlHours: 24 });
    const mangled = `O${code.slice(1)}`;
    const result = codes.redeemAccessCode(mangled, 'st_session_d');
    check(
      'a code with an excluded character is rejected',
      result.ok === false,
      JSON.stringify(result),
    );
    check('the real code still works afterwards', codes.redeemAccessCode(code, 'st_e').ok === true);
  }

  section('5. EXPIRY — a stale code is dead even if never used');
  {
    const [code] = codes.generateAccessCodes({ count: 1, ttlHours: 1 / 3600000 }); // ~1ms
    await new Promise((r) => setTimeout(r, 15));
    const result = codes.redeemAccessCode(code, 'st_session_f');
    check('expired code is refused', result.ok === false);
    check(
      'and is reported as expired',
      result.ok === false && result.reason === 'expired',
      result.ok === false ? result.reason : 'unexpectedly ok',
    );
  }

  section('6. REVOCATION — the presenter can kill a batch mid-event');
  {
    const batch = codes.generateAccessCodes({ count: 3, ttlHours: 24, batch: 'killme' });
    const revoked = codes.revokeAccessCodes({ batch: 'killme' });
    check('revokes the whole batch', revoked === 3, String(revoked));
    const result = codes.redeemAccessCode(batch[0], 'st_session_g');
    check('a revoked code is refused', result.ok === false);
    check(
      'and is reported as revoked',
      result.ok === false && result.reason === 'revoked',
      result.ok === false ? result.reason : 'unexpectedly ok',
    );
  }

  section('7. RELEASE — a crashed session returns its code to the pool');
  {
    const [code] = codes.generateAccessCodes({ count: 1, ttlHours: 24 });
    codes.redeemAccessCode(code, 'st_crashed');
    codes.releaseAccessCode('st_crashed');
    check('released code can be redeemed again', codes.redeemAccessCode(code, 'st_retry').ok === true);
  }

  section('8. UNKNOWN CODE — a guess is refused');
  {
    const result = codes.redeemAccessCode('ZZZZZZ', 'st_session_h');
    check('unknown code refused', result.ok === false);
    check(
      'reported as unknown',
      result.ok === false && result.reason === 'unknown',
      result.ok === false ? result.reason : 'unexpectedly ok',
    );
  }

  section('9. RATE LIMITER — brute force is what makes six characters safe');
  {
    limiter.resetRedemptionLimiter();
    const ip = '203.0.113.7';
    check('allowed initially', limiter.checkRedemptionAllowed(ip).blocked === false);
    limiter.recordRedemptionFailure(ip);
    limiter.recordRedemptionFailure(ip);
    check('still allowed under the cap', limiter.checkRedemptionAllowed(ip).blocked === false);
    limiter.recordRedemptionFailure(ip);
    const blocked = limiter.checkRedemptionAllowed(ip);
    check('blocked at the cap', blocked.blocked === true);
    check('blocked by ip scope', blocked.blocked === true && blocked.scope === 'ip');
    check(
      'reports a retry delay',
      blocked.blocked === true && blocked.retryAfterMs > 0,
      blocked.blocked === true ? String(blocked.retryAfterMs) : '',
    );

    const otherIp = '198.51.100.4';
    check('a different ip is unaffected', limiter.checkRedemptionAllowed(otherIp).blocked === false);
  }

  section('10. RATE LIMITER — success clears an honest visitor’s history');
  {
    limiter.resetRedemptionLimiter();
    const ip = '203.0.113.20';
    limiter.recordRedemptionFailure(ip);
    limiter.recordRedemptionFailure(ip);
    limiter.recordRedemptionSuccess(ip);
    limiter.recordRedemptionFailure(ip);
    limiter.recordRedemptionFailure(ip);
    check('two typos after a success do not lock out', limiter.checkRedemptionAllowed(ip).blocked === false);
  }

  section('11. RATE LIMITER — a distributed guess still trips the global cap');
  {
    limiter.resetRedemptionLimiter();
    for (let i = 0; i < 5; i += 1) limiter.recordRedemptionFailure(`10.0.0.${i}`);
    const fresh = limiter.checkRedemptionAllowed('10.0.0.99');
    check('a never-seen ip is blocked once the global cap trips', fresh.blocked === true);
    check('blocked by global scope', fresh.blocked === true && fresh.scope === 'global');
  }

  section('12. STATS — the presenter can see what is left');
  {
    const stats = codes.getAccessCodeStats('check');
    check('counts the generated batch', stats.total === 20, JSON.stringify(stats));
    check('all still available', stats.available === 20, JSON.stringify(stats));
  }

  console.log(
    failures === 0
      ? '\nAll demo access-code checks passed.'
      : `\n${failures} demo access-code check(s) FAILED.`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

void main();
