/**
 * Push-to-talk in the browser: the key listener, and the booth setting.
 *
 * The listener only reports presses and releases; what a press does to the
 * Realtime session is `useRealtimeVoice`'s business (it owns the mic track and
 * the data channel). The event filtering itself is the pure
 * `classifyPttKeyEvent` in `voice/pushToTalk.ts`, checked offline.
 *
 * The setting is one shared store rather than per-component state, because it
 * is changed in the settings sheet and read by the page that owns the voice
 * session — two components that would otherwise each hold their own copy and
 * disagree until a remount. It lives in localStorage like the planner model,
 * so it is chosen once on the setup screen and survives every session after.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_PTT_KEY_CODE,
  PTT_MAX_HOLD_MS,
  classifyPttKeyEvent,
  normalizePttKeyCode,
  type PttListenerState,
  type PttTargetInfo,
} from '../voice/pushToTalk';

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

const PTT_ENABLED_STORAGE_KEY = 'tuning-movie-push-to-talk';
const PTT_KEY_STORAGE_KEY = 'tuning-movie-push-to-talk-key';

export interface PushToTalkSettingValue {
  enabled: boolean;
  code: string;
}

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

function readSetting(): PushToTalkSettingValue {
  return {
    // Off unless a person turned it on: VAD stays the default everywhere.
    enabled: readStorage(PTT_ENABLED_STORAGE_KEY) === 'true',
    code: normalizePttKeyCode(readStorage(PTT_KEY_STORAGE_KEY) ?? DEFAULT_PTT_KEY_CODE),
  };
}

let current: PushToTalkSettingValue | null = null;
const listeners = new Set<() => void>();

function snapshot(): PushToTalkSettingValue {
  if (!current) current = readSetting();
  return current;
}

function publish(next: PushToTalkSettingValue): void {
  const previous = snapshot();
  if (previous.enabled === next.enabled && previous.code === next.code) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the same origin (the kiosk and its second screen) changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === PTT_ENABLED_STORAGE_KEY || event.key === PTT_KEY_STORAGE_KEY) {
      publish(readSetting());
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const SERVER_SNAPSHOT: PushToTalkSettingValue = { enabled: false, code: DEFAULT_PTT_KEY_CODE };

export interface PushToTalkSetting extends PushToTalkSettingValue {
  setEnabled: (enabled: boolean) => void;
  setCode: (code: string) => void;
}

export function usePushToTalkSetting(): PushToTalkSetting {
  const value = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
  const setEnabled = useCallback((enabled: boolean) => {
    writeStorage(PTT_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
    publish({ ...snapshot(), enabled });
  }, []);
  const setCode = useCallback((code: string) => {
    const normalized = normalizePttKeyCode(code);
    writeStorage(PTT_KEY_STORAGE_KEY, normalized);
    publish({ ...snapshot(), code: normalized });
  }, []);
  return { ...value, setEnabled, setCode };
}

// ---------------------------------------------------------------------------
// The key listener
// ---------------------------------------------------------------------------

function describeTarget(target: EventTarget | null): PttTargetInfo | null {
  if (!target || typeof (target as Element).tagName !== 'string') return null;
  const element = target as HTMLElement & { type?: string; readOnly?: boolean; disabled?: boolean };
  return {
    tagName: element.tagName,
    type: typeof element.type === 'string' ? element.type : null,
    readOnly: Boolean(element.readOnly),
    disabled: Boolean(element.disabled),
    isContentEditable: Boolean(element.isContentEditable),
  };
}

export interface UsePushToTalkOptions {
  enabled: boolean;
  /** A `KeyboardEvent.code`. */
  code: string;
  onPress?: () => void;
  /** `key-up`, `blur` (the key-up will never arrive), `hidden`, `max-hold`, `disabled`. */
  onRelease?: (reason: string) => void;
}

/**
 * Listens on `window` in the capture phase, so it sees the key before any
 * focused element and its preventDefault lands before Space can scroll the
 * page or activate a button (Chrome clicks a focused button on Space's
 * key-up, which is why the key-up is prevented too).
 *
 * Returns whether the key is physically held, for the settings sheet's test
 * light; a hold that was cut short by blur or the hold cap reads as not held.
 */
export function usePushToTalk({ enabled, code, onPress, onRelease }: UsePushToTalkOptions): {
  held: boolean;
} {
  const [held, setHeld] = useState(false);
  const stateRef = useRef<PttListenerState>('up');
  const onPressRef = useRef(onPress);
  const onReleaseRef = useRef(onRelease);
  onPressRef.current = onPress;
  onReleaseRef.current = onRelease;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let maxHoldTimer: ReturnType<typeof setTimeout> | null = null;

    const clearMaxHold = () => {
      if (maxHoldTimer) clearTimeout(maxHoldTimer);
      maxHoldTimer = null;
    };

    /** Ends a live press. `stale` keeps swallowing until the real key-up. */
    const end = (reason: string, next: PttListenerState) => {
      if (stateRef.current !== 'down') {
        stateRef.current = next;
        return;
      }
      clearMaxHold();
      stateRef.current = next;
      setHeld(false);
      onReleaseRef.current?.(reason);
    };

    const onKey = (event: KeyboardEvent) => {
      const decision = classifyPttKeyEvent(
        {
          type: event.type === 'keyup' ? 'keyup' : 'keydown',
          code: event.code,
          repeat: event.repeat,
          isComposing: event.isComposing,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          target: describeTarget(event.target),
        },
        code,
        stateRef.current
      );
      if (decision === 'ignore') return;
      event.preventDefault();
      if (decision === 'press') {
        stateRef.current = 'down';
        setHeld(true);
        clearMaxHold();
        maxHoldTimer = setTimeout(() => end('max-hold', 'stale'), PTT_MAX_HOLD_MS);
        onPressRef.current?.();
      } else if (decision === 'release') {
        end('key-up', 'up');
      } else if (event.type === 'keyup') {
        // The key-up that ends a stale hold.
        stateRef.current = 'up';
      }
    };

    // The key-up of a press that loses focus is delivered to whatever has
    // focus then — another app — so it is never seen here. A window losing
    // focus ends the press; the key, if still down, must be pressed afresh.
    const onBlur = () => end('blur', 'up');
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') end('hidden', 'up');
    };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      // Turning PTT off (or changing the key) mid-press must close the mic.
      end('disabled', 'up');
      clearMaxHold();
    };
  }, [enabled, code]);

  return { held: enabled && held };
}
