/**
 * Which of our own client events a Realtime `error` event is about.
 *
 * The Realtime API puts the id of the client event that failed in
 * `error.event_id`. The top-level `event.event_id` is the server's own id for
 * the error event (`event_…`), so it never equals an id this app stamped. Until
 * 2026-10-24 the hook matched on the top-level field, which meant two things:
 *
 *  - a barge-in's `response.cancel` that found nothing to cancel ("no active
 *    response", `response_cancel_not_active`, 55 of them at the KSEA hall) was
 *    logged as a session error instead of being swallowed as expected;
 *  - a rejected `response.create` (`speak-<seq>`) was never matched, so the
 *    utterance sat active until the 30 s speak watchdog instead of releasing
 *    the queue at once.
 *
 * Seen live with the fake mic: `{ event_id: "event_Echp…", error: { code:
 * "response_cancel_not_active", event_id: "bargein-cancel-2" } }`.
 */

function readId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The failing client event's id: `error.event_id`, falling back to the
 * top-level `event_id` in case the shape ever differs.
 */
export function realtimeErrorClientEventId(event: Record<string, unknown>): string | null {
  const error = event.error;
  const nested =
    error && typeof error === 'object' ? readId((error as Record<string, unknown>).event_id) : null;
  return nested ?? readId(event.event_id);
}

export type RealtimeErrorMatch =
  /** A push-to-talk commit the server refused (e.g. buffer too small). */
  | 'ptt-commit'
  /** A push-to-talk buffer clear; never worth a log line. */
  | 'ptt-clear'
  /** A barge-in cancel/clear that found nothing to act on: expected, swallow. */
  | 'barge-in'
  /** The active utterance's `response.create` was rejected: release it now. */
  | 'speak-rejected'
  | 'other';

export function matchRealtimeError(
  clientEventId: string | null,
  context: { bargeInEventIds: ReadonlySet<string>; activeSpeakEventId: string | null }
): RealtimeErrorMatch {
  if (!clientEventId) return 'other';
  if (clientEventId.startsWith('ptt-commit-')) return 'ptt-commit';
  if (clientEventId.startsWith('ptt-clear-')) return 'ptt-clear';
  if (context.bargeInEventIds.has(clientEventId)) return 'barge-in';
  if (context.activeSpeakEventId && clientEventId === context.activeSpeakEventId) return 'speak-rejected';
  return 'other';
}
