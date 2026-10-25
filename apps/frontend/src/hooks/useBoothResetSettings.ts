/**
 * The kiosk/desktop demo's reset numbers: how long after the completion line
 * the booth returns to its start screen, and how long an untouched session
 * may sit before the "still there?" countdown.
 *
 * One shared store, in localStorage, for the same reason as push-to-talk: it
 * is changed in the settings sheet and read by App, which builds the booking
 * page's booth reset. It belongs to the booth, not to a visitor, so it
 * survives every reset. The parsing and the defaults are in
 * `study/boothReset.ts`, checked offline.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  parseKioskIdleMinutes,
  parseKioskReturnAfterSeconds,
  type KioskResetSettings,
} from '../study/boothReset';

const RETURN_AFTER_STORAGE_KEY = 'tuning-movie-kiosk-return-after-seconds';
const IDLE_MINUTES_STORAGE_KEY = 'tuning-movie-kiosk-idle-minutes';

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage disabled: the setting still applies to this page.
  }
}

function readSettings(): KioskResetSettings {
  const idle = readStorage(IDLE_MINUTES_STORAGE_KEY);
  return {
    returnAfterSeconds: parseKioskReturnAfterSeconds(readStorage(RETURN_AFTER_STORAGE_KEY)),
    // Nothing stored is the default (10 min), not "off".
    idleMinutes: idle === null ? parseKioskIdleMinutes(undefined) : parseKioskIdleMinutes(idle),
  };
}

let current: KioskResetSettings | null = null;
const listeners = new Set<() => void>();

function snapshot(): KioskResetSettings {
  if (!current) current = readSettings();
  return current;
}

function publish(next: KioskResetSettings): void {
  const previous = snapshot();
  if (previous.returnAfterSeconds === next.returnAfterSeconds && previous.idleMinutes === next.idleMinutes) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBoothResetSettings(): KioskResetSettings & {
  setReturnAfterSeconds: (seconds: number) => void;
  setIdleMinutes: (minutes: number | null) => void;
} {
  const settings = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setReturnAfterSeconds = useCallback((seconds: number) => {
    const value = parseKioskReturnAfterSeconds(seconds);
    writeStorage(RETURN_AFTER_STORAGE_KEY, String(value));
    publish({ ...snapshot(), returnAfterSeconds: value });
  }, []);
  const setIdleMinutes = useCallback((minutes: number | null) => {
    const value = parseKioskIdleMinutes(minutes);
    writeStorage(IDLE_MINUTES_STORAGE_KEY, value === null ? 'off' : String(value));
    publish({ ...snapshot(), idleMinutes: value });
  }, []);
  return { ...settings, setReturnAfterSeconds, setIdleMinutes };
}
