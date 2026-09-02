import { useEffect, useRef } from 'react';

/**
 * Keeps the screen awake while something is actually running.
 *
 * A phone acting as the session's microphone locks itself after ~30 seconds in
 * someone's hand, and a locked screen suspends timers and can drop the WebRTC
 * session — so the visitor is mid-sentence when the agent stops hearing them.
 *
 * Two things make this less trivial than the one-line version. The lock is
 * released by the browser whenever the page is hidden, so it has to be
 * re-acquired on `visibilitychange` rather than only once. And the API is
 * missing entirely on iOS below 16.4 and on any non-secure origin, where the
 * request throws — a phone without it must still work, just dimly.
 */
export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (sentinelRef.current) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        // The browser drops the sentinel on its own when the page is hidden;
        // clearing the ref is what lets the visibility handler re-acquire.
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        // Unsupported, insecure origin, or refused. Not worth surfacing: the
        // page works, the screen just dims.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
