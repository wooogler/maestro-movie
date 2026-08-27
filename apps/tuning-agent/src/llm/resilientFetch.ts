/**
 * Timeout + bounded retry around the OpenAI HTTP calls.
 *
 * The user-study build called `fetch` bare: no timeout, no abort, no retry. A
 * single transient transport failure silently burned the participant's turn —
 * 43 planner requests and 10 extractor requests in the study corpus have a
 * request trace and no response trace, all of them concentrated in one
 * participant's six sessions on 2026-03-26. Two of those were hard sessions
 * scored as task failures, so an API incident was counted as a condition
 * effect.
 *
 * Policy:
 *   - every attempt is bounded by a wall-clock timeout (AbortSignal.timeout)
 *   - transport throws and 408/409/425/429/5xx are retried with exponential
 *     backoff plus jitter
 *   - 401/403 (auth) and other 4xx (malformed request) are NOT retried: they
 *     will fail identically on the next attempt and retrying only delays the
 *     turn further
 *   - a `Retry-After` header, when present and sane, overrides the backoff
 *   - every attempt emits a trace so a failure is diagnosable after the fact
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 20_000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLlmTimeoutMs(): number {
  return readPositiveIntEnv("AGENT_OPENAI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

export function getLlmMaxAttempts(): number {
  return readPositiveIntEnv("AGENT_OPENAI_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
}

/** Statuses worth trying again: transient server-side or rate-limit conditions. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * A transport-level throw is retryable unless it is our own timeout abort on
 * the final attempt (handled by the attempt loop) or an explicit caller abort.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    // Our own per-attempt timeout. Worth one more try within the attempt budget.
    return true;
  }
  return true;
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_DELAY_MS);
  // Full jitter: avoids a thundering herd when several sessions fail together.
  return Math.round(Math.random() * exponential);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResilientFetchOptions {
  url: string;
  apiKey: string;
  body: unknown;
  /** Emitted once per attempt so failures are visible in the trace log. */
  onAttemptError?: (info: {
    attempt: number;
    willRetry: boolean;
    phase: "fetch" | "status";
    status?: number;
    errorMessage: string;
    errorName?: string;
  }) => void;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * POSTs a JSON body and returns the first response that is either OK or a
 * non-retryable failure. Throws only when every attempt failed at the transport
 * level; a non-retryable HTTP error is returned to the caller so existing
 * status handling (auth detection, error-text extraction) still applies.
 */
export async function fetchOpenAiWithRetry(
  options: ResilientFetchOptions,
): Promise<Response> {
  const {
    url,
    apiKey,
    body,
    onAttemptError,
    timeoutMs = getLlmTimeoutMs(),
    maxAttempts = getLlmMaxAttempts(),
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = options;

  const serialized = JSON.stringify(body);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isFinalAttempt = attempt === maxAttempts - 1;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: serialized,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok || !isRetryableStatus(response.status) || isFinalAttempt) {
        return response;
      }

      onAttemptError?.({
        attempt,
        willRetry: true,
        phase: "status",
        status: response.status,
        errorMessage: `Retryable HTTP ${response.status}`,
      });

      // Drain the body so the connection can be reused.
      await response.text().catch(() => undefined);
      const retryAfter = parseRetryAfterMs(response);
      await sleep(retryAfter ?? backoffDelayMs(attempt, baseDelayMs));
      continue;
    } catch (error) {
      lastError = error;
      const willRetry = !isFinalAttempt && isRetryableError(error);
      onAttemptError?.({
        attempt,
        willRetry,
        phase: "fetch",
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
      if (!willRetry) break;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "OpenAI request failed"));
}
