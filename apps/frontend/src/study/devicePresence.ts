/**
 * Turning "what the relay last told me" into something a presenter can trust.
 *
 * The hard part of this feature is not showing a green dot. It is refusing to
 * show a red one when the honest answer is "I cannot see right now". Three
 * different situations look identical from a naive reading of the last message:
 *
 *   - the phone genuinely left;
 *   - the phone is fine and OUR OWN socket is between reconnect attempts, so
 *     nothing is arriving about anything;
 *   - the phone's socket is still open but its page is frozen — locked screen,
 *     backgrounded tab — which is the ordinary booth failure and the one an
 *     open socket lies about most confidently.
 *
 * A red "disconnected" during a routine 1200ms host reconnect is worse than no
 * indicator at all: it teaches the presenter to ignore the thing.
 */

/**
 * Roster as it arrives on the wire. Durations, never timestamps — see the relay.
 *
 * `companionAttachCount` and `companionMissingForMs` sit OUTSIDE `companion`
 * because they have to survive the slot emptying: they are what separates
 * "never scanned" from "was here and left", which is the whole question a
 * watching screen is asking. Keeping them server-side is also what lets a
 * freshly loaded page give a truthful "gone for 40s" instead of starting its
 * own clock at zero.
 */
export interface DeviceRoster {
  kioskActive: boolean;
  agentCount: number;
  agents: Array<{ id: string; name: string }>;
  viewerCount: number;
  companionAttachCount: number;
  companionMissingForMs: number | null;
  companion: { lastSeenAgoMs: number | null } | null;
}

export interface DevicePresenceInput {
  /** Whether this session can have a phone at all; false hides the whole thing. */
  pairable: boolean;
  /** Our own connection to the relay, right now. */
  linked: boolean;
  /** Set when the relay refused or ended us; terminal. */
  endedMessage: string | null;
  /**
   * When this roster reached us, by OUR clock.
   *
   * Stamped where the frame is received and nulled when the socket drops, so a
   * roster observed on a previous connection is never reported as a fact about
   * the present one. Its only job is to keep the server's durations ageing
   * between frames — when the phone stops beating, the server stops pushing,
   * and without this the last roster would sit there looking permanently fresh.
   */
  rosterAtMs: number | null;
  roster: DeviceRoster | null;
  nowMs: number;
}

export type DevicePresenceStatus =
  | { kind: 'unavailable' }
  | { kind: 'ended'; message: string | null }
  /** Nothing has attached yet, and nothing is wrong. */
  | { kind: 'waiting' }
  | { kind: 'attached'; attachCount: number }
  /** We cannot currently see. Never rendered as a fault. */
  | { kind: 'checking'; reason: 'link-down' | 'no-roster-yet' | 'grace' }
  | { kind: 'dropped'; reason: 'left' | 'silent'; attachCount: number; forMs: number };

/**
 * How long a fresh negative must persist before it counts as a drop.
 *
 * With no agent socket present, a host disconnect tears the whole session down
 * and force-closes the phone. The host is back at ~1200ms and the phone at
 * ~2000ms, so there is a real window where our link is up and a TRUTHFUL roster
 * says "no phone" about a phone that is on its way back.
 */
export const DEVICE_PRESENCE_GRACE_MS = 3_000;

/**
 * How long the phone may go quiet while its socket stays open.
 *
 * The page sends a heartbeat every 2.5s, so this is roughly three missed beats
 * — long enough to ride out a scheduling hiccup, short enough that a pocketed
 * phone is called before the presenter starts debugging the agent instead.
 */
export const DEVICE_HEARTBEAT_STALE_MS = 8_000;

export function describeDevicePresence(
  input: DevicePresenceInput,
  options?: { graceMs?: number; staleMs?: number }
): DevicePresenceStatus {
  const graceMs = options?.graceMs ?? DEVICE_PRESENCE_GRACE_MS;
  const staleMs = options?.staleMs ?? DEVICE_HEARTBEAT_STALE_MS;

  if (!input.pairable) return { kind: 'unavailable' };
  if (input.endedMessage !== null) return { kind: 'ended', message: input.endedMessage };
  // Checked before the roster: a stale roster from a previous connection must
  // never be reported as a fact about this one.
  if (!input.linked) return { kind: 'checking', reason: 'link-down' };
  if (input.roster === null || input.rosterAtMs === null) {
    return { kind: 'checking', reason: 'no-roster-yet' };
  }

  const roster = input.roster;
  const companion = roster.companion;
  const sinceRosterMs = Math.max(0, input.nowMs - input.rosterAtMs);

  if (companion) {
    // The socket is open. That is not the same as the page being alive, and the
    // heartbeat is the only thing that can tell them apart.
    const silentForMs = companion.lastSeenAgoMs === null ? 0 : companion.lastSeenAgoMs;
    const totalSilentMs = silentForMs + sinceRosterMs;
    if (totalSilentMs >= staleMs) {
      return {
        kind: 'dropped',
        reason: 'silent',
        attachCount: roster.companionAttachCount,
        forMs: totalSilentMs,
      };
    }
    return { kind: 'attached', attachCount: roster.companionAttachCount };
  }

  if (roster.companionAttachCount === 0) return { kind: 'waiting' };

  const missingForMs = (roster.companionMissingForMs ?? 0) + sinceRosterMs;
  if (missingForMs < graceMs) return { kind: 'checking', reason: 'grace' };
  return {
    kind: 'dropped',
    reason: 'left',
    attachCount: roster.companionAttachCount,
    forMs: missingForMs,
  };
}
