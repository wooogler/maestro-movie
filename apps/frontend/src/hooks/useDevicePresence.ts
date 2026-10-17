import { useEffect, useRef, useState } from 'react';
import {
  describeDevicePresence,
  sameDevicePresenceVerdict,
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
 *
 * But the tick must not be a render. This hook sits in the booking page, which
 * is the largest component in the app, and an unconditional `setNowMs` once a
 * second re-rendered all of it — one forced layout and three style recalcs per
 * second on a screen where nothing had changed, measured on the lab tablet.
 * So the clock advances inside the interval, where it is cheap, and the page
 * is only told about it when the verdict it would be shown actually differs.
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
  const status = describeDevicePresence({ ...args, nowMs });

  // What the caller was last shown, and from which inputs. The interval reads
  // these rather than closing over render values so that it never has to be
  // re-created — and so never resets its phase — when a roster arrives.
  const shownRef = useRef({ args, status });
  useEffect(() => {
    shownRef.current = { args, status };
  });

  const { pairable } = args;
  useEffect(() => {
    // Nothing can ever be dropped where nothing can be paired, so a study
    // session without a phone does not need a clock at all.
    if (!pairable) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const shown = shownRef.current;
      const next = describeDevicePresence({ ...shown.args, nowMs: now });
      if (sameDevicePresenceVerdict(shown.status, next)) return;
      setNowMs(now);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [pairable]);

  return status;
}
