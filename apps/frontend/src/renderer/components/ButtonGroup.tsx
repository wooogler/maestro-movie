/**
 * ButtonGroup Component
 *
 * Movie, Theater, Time Stage에서 사용하는 텍스트 버튼 목록
 * DisplayItem의 value를 직접 렌더링
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { DisplayItem } from '../../spec';
import type { GuiMotionProfile } from '../stages';
import { useLanguage } from '../../i18n';
import {
  GUI_LIST_SETTLED_EVENT,
  LIST_MOTION,
  prefersReducedMotion,
} from './listMotion';

type RenderPhase = 'stable' | 'entering' | 'exiting';

interface RenderItem extends DisplayItem {
  phase: RenderPhase;
  /** `performance.now()` at which an entering/exiting phase is over. */
  phaseEndsAt?: number;
  textChanged: boolean;
  textEndsAt?: number;
  previousValue?: string;
}

/*
  A showtime list is the one stage that routinely runs long — a popular movie on
  a Saturday is 18 showings — and the split view scales the whole card down to
  fit its height, so an 18-row column was rendered at less than half size and
  became unreadable. Past these counts the buttons wrap into columns instead,
  which trades width (a time label is short) for the height that was costing
  legibility.
*/
const COLUMN_BREAK_TWO = 6;
const COLUMN_BREAK_THREE = 12;

/**
 * Where every item was drawn just before a structural change (`left`/`top`,
 * viewport px, any move still in flight included) and where its layout slot was
 * (`slotLeft`/`slotTop`, the same minus that move).
 */
type FirstRects = Map<string, { left: number; top: number; slotLeft: number; slotTop: number }>;

/** The split view scales the whole card; a translate is in the item's own px. */
function renderScale(list: HTMLElement): number {
  const width = list.getBoundingClientRect().width;
  const scale = list.offsetWidth > 0 ? width / list.offsetWidth : 1;
  return scale > 0 ? scale : 1;
}

interface ButtonGroupProps {
  items: DisplayItem[];
  onSelect: (id: string) => void;
  selectedId?: string;
  selectedVariant?: 'active' | 'visited';
  highlightedIds?: string[];
  disabled?: boolean;
  animationScope?: string;
  motionProfile?: GuiMotionProfile;
  allItems?: DisplayItem[];
  filteredOutIds?: string[];
  density?: 'default' | 'compact';
  /** Fires when the participant opens or closes "Show all" over a filter. */
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
  /** 'auto' wraps a long list into 2-3 columns; 'single' keeps one per row. */
  columns?: 'single' | 'auto';
}

export function ButtonGroup({
  items,
  onSelect,
  selectedId,
  selectedVariant = 'active',
  highlightedIds = [],
  disabled = false,
  animationScope = 'default',
  motionProfile = 'default',
  allItems,
  filteredOutIds = [],
  density = 'default',
  columns = 'single',
  onRevealHidden,
}: ButtonGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const highlightSet = useMemo(() => new Set(highlightedIds), [highlightedIds]);
  const filteredOutSet = useMemo(() => new Set(filteredOutIds), [filteredOutIds]);
  const hasExpandableFilter = Boolean(allItems) && filteredOutIds.length > 0;
  const { s } = useLanguage();
  const filterToggleLabel = isExpanded ? s.showLess : s.showAll;
  const filterToggleTitle = isExpanded
    ? s.hideFilteredOut
    : s.filteredItemsHidden.replace('{count}', String(filteredOutIds.length));
  const sourceItems = useMemo(
    () => (hasExpandableFilter && isExpanded && allItems ? allItems : items),
    [allItems, hasExpandableFilter, isExpanded, items]
  );
  /*
    Counted over the stage's whole inventory, not over what a filter currently
    leaves visible, so narrowing 18 showtimes to 5 does not also snap the grid
    back to one column mid-animation — that reflow made the fit-to-height scale
    swing with it, and the card visibly zoomed out and back in.
  */
  const columnCount = useMemo(() => {
    if (columns !== 'auto') return 1;
    const total = (allItems ?? items).length;
    if (total <= COLUMN_BREAK_TWO) return 1;
    if (total <= COLUMN_BREAK_THREE) return 2;
    return 3;
  }, [allItems, columns, items]);
  const isGrid = columnCount > 1;
  const moveDurationMs = LIST_MOTION.moveMs[motionProfile];
  const motionVars = useMemo(
    () =>
      ({
        '--gui-item-exit-ms': `${LIST_MOTION.exitMs}ms`,
        '--gui-item-enter-ms': `${LIST_MOTION.enterMs}ms`,
        '--gui-item-enter-delay-ms': `${LIST_MOTION.enterDelayMs}ms`,
        ...(isGrid ? { '--gui-grid-columns': columnCount } : {}),
      }) as CSSProperties,
    [columnCount, isGrid]
  );
  const itemSignature = useMemo(
    () =>
      sourceItems
        .map((item) => `${item.id}::${item.value}::${item.isDisabled ? '1' : '0'}`)
        .join('|'),
    [sourceItems]
  );
  const [renderItems, setRenderItems] = useState<RenderItem[]>(() =>
    sourceItems.map((item) => ({
      ...item,
      phase: 'stable',
      textChanged: false,
    }))
  );
  /*
    The "Show all" row sits above the list, so its appearing pushes every item
    down. It is switched in the same commit as the items, after the capture, so
    that push is a glide like any other move instead of a jump one frame ahead
    of the filter it belongs to.
  */
  const [filterToggleShown, setFilterToggleShown] = useState(hasExpandableFilter);

  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFirstRef = useRef<FirstRects | null>(null);
  const moveAnimationsRef = useRef(new Map<string, Animation>());
  const raisedRef = useRef<{ node: HTMLElement; animation: Animation } | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const announceSettledRef = useRef(false);
  const lastAppliedSignatureRef = useRef(itemSignature);
  const itemOrder = useMemo(() => sourceItems.map((item) => item.id).join('|'), [sourceItems]);
  const lastAppliedOrderRef = useRef(itemOrder);

  /*
    "First", in FLIP terms: where each item is drawn right now, read *before*
    the change that will move it is committed. This is the only place the list
    reads layout outside a commit, and it only runs ahead of a structural
    update (new items, a sort, an exit being dropped, the "Show all" row
    appearing) — never per render, never per streamed token.

    `getBoundingClientRect` includes any transform still in flight, so an item
    caught mid-slide (a sort landing while a filter's exits are still
    collapsing, or a second sort) starts its next move from where the visitor
    actually sees it rather than snapping back to its old slot first.

    A capture that has not been consumed yet is kept: two updates batched into
    one commit still start from what was on screen before the first.
  */
  const captureFirstRects = () => {
    if (pendingFirstRef.current) return;
    const list = listRef.current;
    if (!list || itemRefs.current.size === 0 || prefersReducedMotion()) return;
    const scale = renderScale(list);
    const rects: FirstRects = new Map();
    for (const [id, node] of itemRefs.current) {
      const rect = node.getBoundingClientRect();
      const offset = moveOffset(id, node);
      rects.set(id, {
        left: rect.left,
        top: rect.top,
        slotLeft: rect.left - offset.x * scale,
        slotTop: rect.top - offset.y * scale,
      });
    }
    pendingFirstRef.current = rects;
  };

  /** How far a move still in flight currently holds the item off its slot (own px). */
  const moveOffset = (id: string, node: HTMLElement) => {
    if (!moveAnimationsRef.current.has(id)) return { x: 0, y: 0 };
    const transform = window.getComputedStyle(node).transform;
    if (!transform || transform === 'none') return { x: 0, y: 0 };
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  };

  const cancelMoves = () => {
    for (const animation of moveAnimationsRef.current.values()) animation.cancel();
    moveAnimationsRef.current.clear();
  };

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      cancelMoves();
    },
    []
  );

  useEffect(() => {
    if (!hasExpandableFilter) {
      setIsExpanded(false);
    }
  }, [hasExpandableFilter]);

  /*
    Resetting the list when the stage's animation scope changes, and only then.

    It used to run on mount as well, and its `setRenderItems` allocated a fresh
    array every time — so every ButtonGroup rendered twice the moment it
    appeared, and each of those renders dragged the FLIP layout effect below
    through a `getBoundingClientRect` on every item. A stage transition mounts a
    whole new ButtonGroup, so that doubled commit landed inside the slide.

    The FLIP no longer measures on every commit (only after `captureFirstRects`
    has run), but the rule stands: a new scope is a new list, it appears in
    place with nothing animating, and nothing is measured for it.
  */
  const lastAnimationScopeRef = useRef(animationScope);

  useEffect(() => {
    if (lastAnimationScopeRef.current === animationScope) return;
    lastAnimationScopeRef.current = animationScope;

    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    pendingFirstRef.current = null;
    cancelMoves();
    lastAppliedSignatureRef.current = itemSignature;
    lastAppliedOrderRef.current = itemOrder;
    setFilterToggleShown(hasExpandableFilter);
    setRenderItems(
      sourceItems.map((item) => ({
        ...item,
        phase: 'stable',
        textChanged: false,
        previousValue: undefined,
      }))
    );
  }, [animationScope]);

  useEffect(() => {
    const signatureChanged = lastAppliedSignatureRef.current !== itemSignature;
    const toggleChanged = filterToggleShown !== hasExpandableFilter;
    if (!signatureChanged && !toggleChanged) return;
    /*
      Only a change of *which* items are listed, or in what order, is measured
      for a move. An augment rewrites labels in place: the text swap is its
      animation, and the rows below it simply reflow to the new label height,
      as they did before this list could slide at all — gliding every row of a
      16-showtime grid for a label change was most of an augment's frame cost.
    */
    if (itemOrder !== lastAppliedOrderRef.current || toggleChanged) captureFirstRects();
    if (toggleChanged) setFilterToggleShown(hasExpandableFilter);
    if (!signatureChanged) return;
    lastAppliedSignatureRef.current = itemSignature;
    lastAppliedOrderRef.current = itemOrder;
    const now = performance.now();

    setRenderItems((previous) => {
      const previousById = new Map(previous.map((item) => [item.id, item]));
      const nextById = new Map(sourceItems.map((item) => [item.id, item]));

      const nextRenderItems: RenderItem[] = sourceItems.map((item) => {
        const previousItem = previousById.get(item.id);
        const reenteringFromExit = previousItem?.phase === 'exiting';
        const textChanged =
          !!previousItem && !reenteringFromExit && previousItem.value !== item.value;
        if (!previousItem || reenteringFromExit) {
          return {
            ...item,
            phase: 'entering',
            phaseEndsAt: now + LIST_MOTION.enterDelayMs + LIST_MOTION.enterMs,
            textChanged: false,
          };
        }
        return {
          ...item,
          // An item still fading in keeps its own clock.
          phase: previousItem.phase,
          phaseEndsAt: previousItem.phaseEndsAt,
          textChanged: textChanged || previousItem.textChanged,
          textEndsAt: textChanged ? now + LIST_MOTION.textChangeMs : previousItem.textEndsAt,
          previousValue: textChanged ? previousItem.value : previousItem.previousValue,
        };
      });

      const removedItems = previous
        .filter((item) => !nextById.has(item.id))
        .map((item) => ({
          ...item,
          phase: 'exiting' as const,
          // Already leaving: keep its clock rather than restarting the fade.
          phaseEndsAt:
            item.phase === 'exiting'
              ? item.phaseEndsAt
              : now + LIST_MOTION.exitMs + LIST_MOTION.exitDropGraceMs,
          textChanged: false,
          textEndsAt: undefined,
          previousValue: undefined,
        }));

      for (const removedItem of removedItems) {
        const previousIndex = previous.findIndex((item) => item.id === removedItem.id);
        const insertIndex = Math.min(previousIndex, nextRenderItems.length);
        nextRenderItems.splice(insertIndex, 0, removedItem);
      }

      return nextRenderItems;
    });
  }, [filterToggleShown, hasExpandableFilter, itemOrder, itemSignature, sourceItems]);

  /*
    One timer for the whole list, set for the earliest deadline, and every item
    that is due by then is settled in a single update. The deadlines are
    absolute, so a change that lands mid-animation does not restart anyone's
    clock — the per-item timers this replaces were all cleared and re-armed on
    every update, and each one that fired was its own commit.
  */
  useEffect(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    let earliest = Infinity;
    for (const item of renderItems) {
      if (item.phase !== 'stable' && item.phaseEndsAt !== undefined) {
        earliest = Math.min(earliest, item.phaseEndsAt);
      }
      if (item.textChanged && item.textEndsAt !== undefined) {
        earliest = Math.min(earliest, item.textEndsAt);
      }
    }
    if (!Number.isFinite(earliest)) return;

    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      const now = performance.now() + 1;
      const dropsExit = renderItems.some(
        (item) => item.phase === 'exiting' && (item.phaseEndsAt ?? 0) <= now
      );
      // Dropping an exited cell reflows a grid; the survivors glide into place.
      if (dropsExit) captureFirstRects();
      if (
        dropsExit ||
        renderItems.some((item) => item.phase === 'entering' && (item.phaseEndsAt ?? 0) <= now)
      ) {
        announceSettledRef.current = true;
      }
      setRenderItems((previous) =>
        previous
          .filter((entry) => !(entry.phase === 'exiting' && (entry.phaseEndsAt ?? 0) <= now))
          .map((entry) => {
            const phaseDone = entry.phase === 'entering' && (entry.phaseEndsAt ?? 0) <= now;
            const textDone = entry.textChanged && (entry.textEndsAt ?? 0) <= now;
            if (!phaseDone && !textDone) return entry;
            return {
              ...entry,
              ...(phaseDone ? { phase: 'stable' as const, phaseEndsAt: undefined } : {}),
              ...(textDone
                ? { textChanged: false, textEndsAt: undefined, previousValue: undefined }
                : {}),
            };
          })
      );
    }, Math.max(0, earliest - performance.now()));
  }, [renderItems]);

  // Tells a container that fits the stage to its height (the split view) that
  // this list has stopped growing or shrinking.
  useEffect(() => {
    if (!announceSettledRef.current) return;
    announceSettledRef.current = false;
    listRef.current?.dispatchEvent(new Event(GUI_LIST_SETTLED_EVENT, { bubbles: true }));
  }, [renderItems]);

  /*
    "Last" and "Invert/Play": runs only when `captureFirstRects` left a
    measurement behind, so an ordinary re-render (a highlight, a selection, the
    agent's status) reads no layout here at all.

    Every item that was on screen before the change and is not newly entering
    gets measured at its new slot; one that moved is translated back to where
    it was drawn and animated home. That one rule covers a sort, survivors
    closing up after a grid cell is dropped, and items making room for ones
    that come back — and it is the same rule whether or not a filter's exits
    are still collapsing: in a single column the collapse keeps moving the
    layout underneath while the transform runs out, and the two add up to one
    continuous glide.

    Web Animations rather than an inline `transition`: an inline transition
    would replace the stylesheet's own list (the fade, and the collapse on
    `.gui-item-exit`), so an item that started to slide and was then filtered
    out would stop collapsing. A transform-only animation runs on the
    compositor (CDP trace: compositeFailed=0 for every one) and leaves the CSS
    transitions alone.
  */
  useLayoutEffect(() => {
    const first = pendingFirstRef.current;
    if (!first) return;
    pendingFirstRef.current = null;
    const list = listRef.current;
    if (!list || prefersReducedMotion()) return;

    const scale = renderScale(list);
    let farthest: { node: HTMLElement; distance: number; animation: Animation } | null = null;

    for (const item of renderItems) {
      // Entering items fade in at their slot; leaving ones fade out wherever
      // they are — sliding something on its way out only adds frames.
      if (item.phase !== 'stable') continue;
      const node = itemRefs.current.get(item.id);
      const from = first.get(item.id);
      if (!node || !from) continue;
      const drawn = node.getBoundingClientRect();
      const offset = moveOffset(item.id, node);
      const slotLeft = drawn.left - offset.x * scale;
      const slotTop = drawn.top - offset.y * scale;
      // Its slot did not change: a move still in flight just carries on, rather
      // than being restarted from rest for the few pixels it has left.
      if (Math.abs(from.slotLeft - slotLeft) < 1 && Math.abs(from.slotTop - slotTop) < 1) continue;

      // From where it was drawn to its new slot; a move in flight is replaced,
      // starting where it had got to, so there is no jump.
      moveAnimationsRef.current.get(item.id)?.cancel();
      moveAnimationsRef.current.delete(item.id);
      const deltaX = (from.left - slotLeft) / scale;
      const deltaY = (from.top - slotTop) / scale;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

      const animation = node.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0px, 0px)' },
        ],
        { duration: moveDurationMs, easing: LIST_MOTION.moveEasing }
      );
      moveAnimationsRef.current.set(item.id, animation);
      animation.onfinish = () => {
        if (moveAnimationsRef.current.get(item.id) === animation) {
          moveAnimationsRef.current.delete(item.id);
        }
      };
      const distance = Math.hypot(deltaX, deltaY);
      if (!farthest || distance > farthest.distance) farthest = { node, distance, animation };
    }

    /*
      Siblings paint in DOM order, so the item a sort sends to the top — the
      one the visitor's request was about, and the one travelling farthest —
      slid up *underneath* every item it passed and vanished for most of its
      trip. The farthest mover is drawn on top until it lands. A paint-order
      change only: z-index on a flex/grid item needs no positioning and moves
      no layout.
    */
    if (farthest) {
      raisedRef.current?.node.style.removeProperty('z-index');
      const { node, animation } = farthest;
      node.style.zIndex = '1';
      raisedRef.current = { node, animation };
      // Keyed on the animation: a move that is replaced fires `cancel` later,
      // and must not lower the item the replacement has just raised again.
      const lower = () => {
        if (raisedRef.current?.animation !== animation) return;
        node.style.removeProperty('z-index');
        raisedRef.current = null;
      };
      animation.addEventListener('finish', lower);
      animation.addEventListener('cancel', lower);
    }
  }, [filterToggleShown, renderItems, moveDurationMs]);

  return (
    <div
      ref={listRef}
      className={`flex w-full flex-col ${
        isGrid ? 'gui-item-group max-w-lg' : 'max-w-md'
      }`}
      style={motionVars}
    >
      {filterToggleShown ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => {
              // The callback stays out of the state updater: React invokes that
              // twice under StrictMode, which logged every toggle twice.
              const next = !isExpanded;
              onRevealHidden?.(next, filteredOutIds.length);
              setIsExpanded(next);
            }}
            className="rounded-full border border-dark-border bg-dark-light/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted transition-colors hover:border-primary hover:text-fg-strong"
            title={filterToggleTitle}
          >
            {filterToggleLabel}
          </button>
        </div>
      ) : null}
      <div className={isGrid ? 'gui-item-grid' : 'flex flex-col'}>
        {renderItems.map((item) => {
          const isSelected = item.id === selectedId;
          const isHighlighted = highlightSet.has(item.id);
          // An item on its way out keeps the look it had: restyling it as
          // filtered-out ran six colour transitions per leaving item (the
          // button's `transition-[color,…]`), none of them composited, on
          // top of the fade that hides them anyway.
          const isFilteredOut = item.phase !== 'exiting' && filteredOutSet.has(item.id);

          const highlightClass = isHighlighted
            ? motionProfile === 'full-tuning'
              ? 'border-accent-line border-2 shadow-[0_0_0_4px_var(--app-accent-glow-strong)] gui-highlight-border-once'
              : 'ring-[4px] ring-accent-line gui-highlight-wave'
            : '';

          // A filtered-out item stays clickable once the participant has opened
          // "Show all". Leaving it inert was the only affordance for escaping an
          // over-narrow filter, and it did nothing: across the study 495 stage
          // states in 77 sessions were reduced to one option or none with no way
          // back except resetting the whole session. Selecting one now clears the
          // filters hiding it (handled upstream in the select handler).
          const isFilteredOutButReachable = isFilteredOut && isExpanded;
          const isDisabled =
            disabled || item.isDisabled || (isFilteredOut && !isFilteredOutButReachable);

          return (
            <div
              key={item.id}
              ref={(node) => {
                if (node) {
                  itemRefs.current.set(item.id, node);
                } else {
                  itemRefs.current.delete(item.id);
                }
              }}
              className={`gui-item-shell ${isGrid ? 'gui-item-shell-grid' : ''} ${
                density === 'compact' ? 'gui-item-shell-compact' : ''
              } ${
                item.phase === 'entering'
                  ? 'gui-item-enter'
                  : item.phase === 'exiting'
                  ? 'gui-item-exit'
                  : ''
              }`}
            >
              <button
                onClick={() => !isDisabled && onSelect(item.id)}
                disabled={isDisabled || item.phase === 'exiting'}
                title={
                  isFilteredOutButReachable
                    ? s.hiddenByFilter
                    : undefined
                }
                className={`
                  relative w-full rounded-xl border transition-[color,background-color,border-color,opacity] ${
                    isGrid
                      ? 'flex h-full items-center justify-center px-2 py-3 text-center text-[15px] leading-snug'
                      : density === 'compact'
                      ? 'px-5 py-3 text-left text-[15px] leading-snug'
                      : 'px-6 py-4 text-left'
                  }
                  ${
                    isSelected
                      ? selectedVariant === 'visited'
                        ? 'border-primary bg-primary/12 font-semibold text-fg-strong'
                        : 'border-primary bg-primary font-semibold text-primary-fg'
                      : isFilteredOut
                      ? 'border-dark-border/80 bg-dark-border/35 text-fg-faint'
                      : 'border-dark-border bg-dark-light text-fg-strong hover:border-dark-border hover:bg-dark-lighter'
                  }
                  ${highlightClass}
                  ${
                    isDisabled
                      ? isFilteredOut
                        ? 'cursor-not-allowed opacity-65'
                        : 'cursor-not-allowed opacity-50'
                      : isFilteredOutButReachable
                      ? 'cursor-pointer opacity-65'
                      : 'cursor-pointer'
                  }
                  ${item.textChanged ? 'gui-item-text-shift' : ''}
                `}
              >
                {item.textChanged && item.previousValue ? (
                  <span className="gui-item-text-stack">
                    <span aria-hidden="true" className="gui-item-text-previous">
                      {item.previousValue}
                    </span>
                    <span className="gui-item-text-current">{item.value}</span>
                  </span>
                ) : (
                  <span className="block">{item.value}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
