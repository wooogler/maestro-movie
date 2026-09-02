import { useEffect, useState } from 'react';
import {
  describeDevicePresence,
  type DeviceRoster,
  type DevicePresenceStatus,
} from '../study/devicePresence';

const TICK_MS = 1_000;

/**
 * Turns the latest roster into a verdict, for whichever screen is asking.
 *
 * Two screens ask: the pairing screen, watching over a read-only viewer socket,
 * and the booking kiosk, watching over its host socket. They see the same
 * rosters and must reach the same conclusion, so the reasoning lives in one
 * pure function and this hook only supplies it with a clock.
 *
 * It keeps no history at all. Everything historical — how many phones have
 * attached, how long the slot has been empty — is carried in the roster from
 * the server, which is what lets a page that just loaded, or one whose socket
 * reconnected a second ago, give the same honest answer as one that has been
 * watching all evening.
 *
 * The tick is not decoration: "dropped" is a claim about elapsed time, so
 * without something re-rendering, a phone that goes quiet stays green until an
 * unrelated render wanders past.
 */
export function useDevicePresence(args: {
  /** False when this session can have no phone; the caller renders nothing. */
  pairable: boolean;
  /** Whether OUR OWN socket is connected and admitted right now. */
  linked: boolean;
  endedMessage: string | null;
  roster: DeviceRoster | null;
  /** When that roster arrived, stamped where the frame was received. */
  rosterAtMs: number | null;
}): DevicePresenceStatus {
  // Read in a callback and an initialiser, never during render: a render that
  // reads the wall clock returns something different each time it happens to
  // run, which is exactly what an elapsed-time verdict must not do.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return describeDevicePresence({ ...args, nowMs });
}
