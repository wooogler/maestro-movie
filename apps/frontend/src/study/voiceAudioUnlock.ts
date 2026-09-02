/**
 * One audio element, unlocked inside a real tap, shared with whatever opens the
 * voice session afterwards.
 *
 * iOS Safari refuses `play()` unless the element descends from a user gesture,
 * and it grants that permission to the ELEMENT, once, for the element's whole
 * life. On the kiosk this never mattered: the voice session opens from the
 * visitor's own click on the mic button, so an element created right there is
 * already blessed.
 *
 * A scanned quick-demo card breaks that. The visitor taps "start" on the card
 * face, and the session opens a moment later — after a network round trip, on
 * the booking screen, with no gesture anywhere near it. The `play()` rejection
 * is caught, so the phone would look connected and stay silent. The paired
 * phone has exactly this problem and solves it the same way, through
 * `useRealtimeVoice`'s `audioSink`; the difference is only that the phone can
 * hold the element in a component ref because it never leaves the page, while
 * the card face hands off to another route.
 *
 * Hence a module-level singleton. It is deliberately a single element and never
 * torn down: browser audio permission is not transferable, so replacing it
 * would throw away the only blessed element in the tab.
 */

let unlocked: HTMLAudioElement | null = null;

/**
 * Call from inside a real user gesture — a click or touch handler, before any
 * `await`. Returns the element so a caller can pass it on directly.
 */
export function unlockVoiceAudioElement(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (!unlocked) {
    const element = document.createElement('audio');
    element.autoplay = true;
    element.setAttribute('playsinline', 'true');
    element.style.display = 'none';
    document.body.appendChild(element);
    unlocked = element;
  }
  /*
    Playing an empty element inside the gesture is what marks it user-activated.
    It rejects immediately — there is no source — and that rejection is both
    expected and meaningless.
  */
  void unlocked.play().catch(() => {});
  return unlocked;
}

/**
 * The blessed element, or null if no gesture has unlocked one in this tab.
 *
 * Null is the ordinary case everywhere except the quick-card route, and
 * `useRealtimeVoice` creates its own element when the sink returns nothing — so
 * this can be passed unconditionally.
 */
export function getUnlockedVoiceAudioElement(): HTMLAudioElement | null {
  return unlocked;
}
