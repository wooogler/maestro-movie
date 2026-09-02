export interface PendingStudyLogEventInput {
  type: string;
  payload: unknown;
  clientTimestamp?: string;
}

const PENDING_STUDY_LOG_EVENTS_KEY = 'tuning-movie-pending-study-log-events';

function readPendingEvents(): PendingStudyLogEventInput[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.sessionStorage.getItem(PENDING_STUDY_LOG_EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingStudyLogEventInput[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingEvents(events: PendingStudyLogEventInput[]): void {
  if (typeof window === 'undefined') return;

  try {
    if (events.length === 0) {
      window.sessionStorage.removeItem(PENDING_STUDY_LOG_EVENTS_KEY);
      return;
    }
    window.sessionStorage.setItem(PENDING_STUDY_LOG_EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Ignore storage failures.
  }
}

export function queuePendingStudyLogEvent(event: PendingStudyLogEventInput): void {
  const events = readPendingEvents();
  events.push(event);
  writePendingEvents(events);
}

export function consumePendingStudyLogEvents(): PendingStudyLogEventInput[] {
  const events = readPendingEvents();
  writePendingEvents([]);
  return events;
}

/**
 * Drops anything queued without writing it anywhere.
 *
 * The queue outlives a page navigation by design — setup happens before a
 * session exists — which also means it outlives a visitor. A booth runs one
 * stranger after another in the same tab, so events queued by someone who then
 * declined to be recorded must be thrown away rather than left to be flushed
 * into the next person's consented log.
 */
export function clearPendingStudyLogEvents(): void {
  writePendingEvents([]);
}
