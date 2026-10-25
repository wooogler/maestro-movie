/**
 * The demo's arrangement — compact, desktop or kiosk — as live React state.
 *
 * The rule itself is `selectLayoutMode` in `fullTuningLayout.ts`, which is pure
 * so the check can assert it. This module is the DOM half: it knows the
 * viewport and the presenter's override, and tells React when either changes.
 *
 * Nothing here reads layout during render. The mode is cached and recomputed
 * only when one of a handful of media queries flips — the exact boundaries the
 * rule draws (700px, 1024px, portrait, square) — so a resize that stays inside
 * one arrangement costs nothing, and a render costs a string compare.
 *
 * The override comes from `?layout=kiosk|desktop|compact` (`auto` clears it) or
 * the Settings sheet, and is remembered in localStorage: the presenter adds it
 * to the start page's URL once, and it has to survive the navigation to
 * `/booking` and every visitor after that.
 */
import { useSyncExternalStore } from 'react';
import {
  DESKTOP_MIN_WIDTH_PX,
  KIOSK_MIN_WIDTH_PX,
  parseLayoutOverride,
  readLayoutOverrideFromSearch,
  selectLayoutMode,
  type FullTuningLayoutMode,
} from './fullTuningLayout';

const OVERRIDE_STORAGE_KEY = 'tuning-movie-layout-override';

/** Exactly the lines `selectLayoutMode` draws, so a flip of any one is a possible change. */
const BOUNDARY_QUERIES = [
  `(min-width: ${KIOSK_MIN_WIDTH_PX}px)`,
  `(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`,
  '(orientation: portrait)',
  '(aspect-ratio: 1/1)',
];

type Listener = () => void;
const listeners = new Set<Listener>();

let override: FullTuningLayoutMode | null | undefined;
let mode: FullTuningLayoutMode | undefined;
let mediaLists: MediaQueryList[] | null = null;

function readStoredOverride(): FullTuningLayoutMode | null {
  try {
    return parseLayoutOverride(window.localStorage.getItem(OVERRIDE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredOverride(next: FullTuningLayoutMode | null): void {
  try {
    if (next) window.localStorage.setItem(OVERRIDE_STORAGE_KEY, next);
    else window.localStorage.removeItem(OVERRIDE_STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the choice holds for this page only.
  }
}

function currentOverride(): FullTuningLayoutMode | null {
  if (override !== undefined) return override;
  if (typeof window === 'undefined') return null;
  // The URL wins over storage, once, at first use; and what it says is kept.
  const fromUrl = readLayoutOverrideFromSearch(window.location.search);
  if (fromUrl === 'auto') {
    override = null;
    writeStoredOverride(null);
  } else if (fromUrl) {
    override = fromUrl;
    writeStoredOverride(fromUrl);
  } else {
    override = readStoredOverride();
  }
  return override;
}

function computeMode(): FullTuningLayoutMode {
  if (typeof window === 'undefined') return 'desktop';
  return selectLayoutMode(window.innerWidth, window.innerHeight, currentOverride());
}

function recompute(): void {
  const next = computeMode();
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!mediaLists && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaLists = BOUNDARY_QUERIES.map((query) => window.matchMedia(query));
    for (const list of mediaLists) list.addEventListener('change', recompute);
    // A boundary may have been crossed between the first read and now.
    recompute();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && mediaLists) {
      for (const list of mediaLists) list.removeEventListener('change', recompute);
      mediaLists = null;
    }
  };
}

function getSnapshot(): FullTuningLayoutMode {
  if (mode === undefined) mode = computeMode();
  return mode;
}

function getOverrideSnapshot(): FullTuningLayoutMode | null {
  return currentOverride();
}

/*
  Read `?layout=` when the app loads, not when the booking page first renders.
  The presenter types it on whatever route is open — the start page, a quick
  card — and by the time `/booking` mounts, the SPA navigation has replaced the
  URL and the query is gone. This module is part of the initial bundle (the
  booking page imports it statically), so this runs against the URL as typed.
*/
if (typeof window !== 'undefined') currentOverride();

/** Pin an arrangement, or `null` to go back to detecting it. Remembered. */
export function setFullTuningLayoutOverride(next: FullTuningLayoutMode | null): void {
  override = next;
  writeStoredOverride(next);
  mode = computeMode();
  // Notified even when the resolved mode is unchanged (pinning the mode that
  // detection had already chosen): the Settings sheet shows the override.
  for (const listener of listeners) listener();
}

/**
 * The arrangement to render, or `null` when `enabled` is false — the study
 * conditions, which keep the interface the paper describes at every width and
 * must not be handed a booth layout.
 */
export function useFullTuningLayoutMode(enabled: boolean): FullTuningLayoutMode | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => 'desktop' as const);
  return enabled ? current : null;
}

/** The presenter's pinned arrangement, `null` meaning "detect". */
export function useFullTuningLayoutOverride(): FullTuningLayoutMode | null {
  return useSyncExternalStore(subscribe, getOverrideSnapshot, () => null);
}
