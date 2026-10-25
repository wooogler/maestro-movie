import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the screen is below Tailwind's `lg` breakpoint — the same line the
 * booking layout switches on.
 *
 * Read once, to pick a starting state. Panels that are a column beside the
 * booking UI on a desktop are a sheet *over* it on a phone, so "open" is a
 * sensible default in one case and covers the whole screen on arrival in the
 * other.
 */

export const COMPACT_VIEWPORT_QUERY = '(max-width: 1023px)';

export function isCompactViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  } catch {
    return false;
  }
}

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * A media query, live. Its caller re-renders only when the answer flips,
 * never on an ordinary resize.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  return useSyncExternalStore(subscribe, () => matches(query), () => false);
}
