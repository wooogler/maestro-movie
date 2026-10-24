import type { GuiMotionProfile } from '../stages/types';

/*
  Every duration the option lists' motion uses, in one place. App.css reads the
  CSS-driven ones through custom properties (set on the ButtonGroup wrapper and
  on the split view's fit-to-height element), so the stylesheet and the timers
  that drop an exited item can never disagree.

  - exit:  an item a filter removed fades and collapses (opacity + max-height +
           margin-bottom transitions on `.gui-item-shell`); the survivors below
           it close up through that same collapse.
  - enter: an item a cleared filter or "Show all" brings back fades and rises
           in (opacity + transform keyframe), after a short delay so the items
           it displaces have started moving out of its slot.
  - move:  an item whose slot changed — a sort, or a neighbour arriving or
           leaving — slides from where it was drawn to where it now is, as a
           transform-only animation (FLIP via the Web Animations API).
  - text:  an augment swaps the label in place (`gui-item-text-*` keyframes;
           this is how long the swap state is held).
  - fit:   the split view's fit-to-height scale easing to the list's new
           height once it has settled (a transform transition).

  `exitDropGraceMs`: the exit clock starts when the change is scheduled, the
  collapse a commit later, so an exited item is dropped a couple of frames
  after its transition ends rather than with a sliver of it left — dropping it
  early made every survivor jump by that sliver.
*/
export const LIST_MOTION = {
  exitMs: 380,
  exitDropGraceMs: 50,
  enterMs: 420,
  enterDelayMs: 140,
  textChangeMs: 980,
  moveMs: { default: 500, 'full-tuning': 760 } satisfies Record<GuiMotionProfile, number>,
  moveEasing: 'cubic-bezier(0.42, 0, 0.58, 1)',
  fitScaleMs: 380,
} as const;

/**
 * Dispatched (bubbling) from an option list once its exited items are dropped
 * or its entering ones settle — the moments its height stops changing.
 */
export const GUI_LIST_SETTLED_EVENT = 'gui-list-settled';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
