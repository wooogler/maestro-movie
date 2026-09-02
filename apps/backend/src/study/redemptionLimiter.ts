/**
 * Rate limiter for access-code redemption.
 *
 * The code alphabet gives 7.29e8 combinations, but that number only protects
 * anything if guessing is slow. With 200 codes live, a blind guess hits with
 * probability ~2.7e-7; an unthrottled attacker at 1000 req/s would expect a hit
 * in about an hour. The limits below turn that into millennia, which is the
 * whole reason a six-character code is acceptable.
 *
 * Deliberately in-memory and dependency-free: this runs on one box for one
 * event, and a limiter that resets on restart is still worth far more than no
 * limiter. It is *not* a general-purpose rate limiter and should not be reused
 * for anything that needs to survive a restart or span replicas.
 */

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Failures from one IP before that IP is locked out.
 *
 * Behind the deployment's nginx this is not per-IP at all. The Fastify server
 * sets no `trustProxy`, so `request.ip` is the socket's peer address, and
 * rootless podman's published-port forwarder rewrites the source — every
 * visitor arrives as nginx's own container address (2000+ requests, one "IP",
 * many user agents). So this is a single bucket for the whole internet, and
 * since the per-IP branch trips at 10 while the global branch needs 100, ten
 * wrong codes from anyone lock out every visitor for IP_WINDOW_MS. Fixing it
 * needs a real client address to reach nginx first (host networking, a
 * source-preserving publish path, or PROXY protocol) and only then
 * `trustProxy` with an explicit trusted-hop list — turning `trustProxy` on
 * alone would read a client-supplied X-Forwarded-For and be worse.
 */
const MAX_FAILURES_PER_IP = parsePositiveIntEnv(
  process.env.DEMO_ACCESS_MAX_FAILURES_PER_IP,
  10
);
/** Window over which failures accumulate, and the lockout length once tripped. */
const IP_WINDOW_MS = parsePositiveIntEnv(process.env.DEMO_ACCESS_IP_WINDOW_MS, 10 * 60_000);
/** Failures across all IPs per window before redemption closes entirely. */
const MAX_GLOBAL_FAILURES = parsePositiveIntEnv(
  process.env.DEMO_ACCESS_MAX_GLOBAL_FAILURES,
  100
);
const GLOBAL_WINDOW_MS = parsePositiveIntEnv(
  process.env.DEMO_ACCESS_GLOBAL_WINDOW_MS,
  10 * 60_000
);

interface Bucket {
  failures: number[];
}

const perIp = new Map<string, Bucket>();
const globalFailures: number[] = [];

function prune(timestamps: number[], windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
}

export type RedemptionBlock =
  | { blocked: false }
  | { blocked: true; scope: 'ip' | 'global'; retryAfterMs: number };

/**
 * Check before attempting a redemption. Callers must still report the outcome
 * via `recordRedemptionFailure` / `recordRedemptionSuccess`.
 */
export function checkRedemptionAllowed(ip: string, now = Date.now()): RedemptionBlock {
  prune(globalFailures, GLOBAL_WINDOW_MS, now);
  if (globalFailures.length >= MAX_GLOBAL_FAILURES) {
    return {
      blocked: true,
      scope: 'global',
      retryAfterMs: Math.max(0, globalFailures[0] + GLOBAL_WINDOW_MS - now),
    };
  }

  const bucket = perIp.get(ip);
  if (bucket) {
    prune(bucket.failures, IP_WINDOW_MS, now);
    if (bucket.failures.length >= MAX_FAILURES_PER_IP) {
      return {
        blocked: true,
        scope: 'ip',
        retryAfterMs: Math.max(0, bucket.failures[0] + IP_WINDOW_MS - now),
      };
    }
  }

  return { blocked: false };
}

export function recordRedemptionFailure(ip: string, now = Date.now()): void {
  const bucket = perIp.get(ip) ?? { failures: [] };
  bucket.failures.push(now);
  prune(bucket.failures, IP_WINDOW_MS, now);
  perIp.set(ip, bucket);

  globalFailures.push(now);
  prune(globalFailures, GLOBAL_WINDOW_MS, now);
}

/**
 * A success clears that IP's failure history. Someone who fat-fingers a code
 * twice and then gets it right should not be carrying a near-lockout around for
 * the next ten minutes.
 */
export function recordRedemptionSuccess(ip: string): void {
  perIp.delete(ip);
}

export function getRedemptionLimiterStats(now = Date.now()): {
  trackedIps: number;
  globalFailuresInWindow: number;
  maxGlobalFailures: number;
  maxFailuresPerIp: number;
} {
  prune(globalFailures, GLOBAL_WINDOW_MS, now);
  return {
    trackedIps: perIp.size,
    globalFailuresInWindow: globalFailures.length,
    maxGlobalFailures: MAX_GLOBAL_FAILURES,
    maxFailuresPerIp: MAX_FAILURES_PER_IP,
  };
}

/** Drops accumulated state; used by the presenter's reset control. */
export function resetRedemptionLimiter(): void {
  perIp.clear();
  globalFailures.length = 0;
}
