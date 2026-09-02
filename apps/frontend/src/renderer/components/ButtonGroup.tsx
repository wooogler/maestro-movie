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

type RenderPhase = 'stable' | 'entering' | 'exiting';

interface RenderItem extends DisplayItem {
  phase: RenderPhase;
  textChanged: boolean;
  previousValue?: string;
}

const TEXT_CHANGE_DURATION_MS = 980;
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
const DEFAULT_SORT_MOVE_DURATION_MS = 500;
const FULL_TUNING_SORT_MOVE_DURATION_MS = 760;
const SORT_MOVE_EASING = 'cubic-bezier(0.42, 0, 0.58, 1)';

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
  const sortMoveDurationMs =
    motionProfile === 'full-tuning'
      ? FULL_TUNING_SORT_MOVE_DURATION_MS
      : DEFAULT_SORT_MOVE_DURATION_MS;
  const structuralAnimationDurationMs = sortMoveDurationMs;
  const sortFadeDurationMs = Math.round(sortMoveDurationMs * 0.57);
  const structuralAnimationStyle = useMemo(
    () => ({
      transitionDuration: `${structuralAnimationDurationMs}ms, ${structuralAnimationDurationMs}ms, ${structuralAnimationDurationMs}ms`,
      animationDuration: `${structuralAnimationDurationMs}ms`,
    }),
    [structuralAnimationDurationMs]
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
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const timeoutIdsRef = useRef<number[]>([]);
  const lastAppliedSignatureRef = useRef(itemSignature);
  const skipNextFlipRef = useRef(false);
  const previousStableOrderRef = useRef(sourceItems.map((item) => item.id));

  useEffect(
    () => () => {
      timeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
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
  */
  const lastAnimationScopeRef = useRef(animationScope);

  useEffect(() => {
    if (lastAnimationScopeRef.current === animationScope) return;
    lastAnimationScopeRef.current = animationScope;

    timeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    timeoutIdsRef.current = [];
    previousRectsRef.current = new Map();
    lastAppliedSignatureRef.current = itemSignature;
    skipNextFlipRef.current = false;
    previousStableOrderRef.current = sourceItems.map((item) => item.id);
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
    if (lastAppliedSignatureRef.current === itemSignature) {
      return;
    }
    lastAppliedSignatureRef.current = itemSignature;

    setRenderItems((previous) => {
      const previousById = new Map(previous.map((item) => [item.id, item]));
      const nextById = new Map(sourceItems.map((item) => [item.id, item]));

      const nextRenderItems: RenderItem[] = sourceItems.map((item) => {
        const previousItem = previousById.get(item.id);
        const reenteringFromExit = previousItem?.phase === 'exiting';
        const textChanged =
          !!previousItem && !reenteringFromExit && previousItem.value !== item.value;
        return {
          ...item,
          phase: previousItem ? (reenteringFromExit ? 'entering' : 'stable') : 'entering',
          textChanged,
          previousValue: textChanged ? previousItem?.value : undefined,
        };
      });

      const removedItems = previous
        .filter((item) => !nextById.has(item.id))
        .map((item) => ({
          ...item,
          phase: 'exiting' as const,
          textChanged: false,
          previousValue: undefined,
        }));

      for (const removedItem of removedItems) {
        const previousIndex = previous.findIndex((item) => item.id === removedItem.id);
        const insertIndex = Math.min(previousIndex, nextRenderItems.length);
        nextRenderItems.splice(insertIndex, 0, removedItem);
      }

      return nextRenderItems;
    });
  }, [itemSignature, sourceItems]);

  useEffect(() => {
    timeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    timeoutIdsRef.current = [];

    for (const item of renderItems) {
      if (item.phase === 'entering') {
        timeoutIdsRef.current.push(
          window.setTimeout(() => {
            setRenderItems((previous) =>
              previous.map((entry) =>
                entry.id === item.id
                  ? { ...entry, phase: 'stable', previousValue: undefined }
                  : entry
              )
            );
          }, structuralAnimationDurationMs)
        );
      }

      if (item.phase === 'exiting') {
        timeoutIdsRef.current.push(
          window.setTimeout(() => {
            setRenderItems((previous) =>
              previous.filter((entry) => !(entry.id === item.id && entry.phase === 'exiting'))
            );
          }, structuralAnimationDurationMs)
        );
      }

      if (item.textChanged) {
        timeoutIdsRef.current.push(
          window.setTimeout(() => {
            setRenderItems((previous) =>
              previous.map((entry) =>
                entry.id === item.id
                  ? { ...entry, textChanged: false, previousValue: undefined }
                  : entry
              )
            );
          }, TEXT_CHANGE_DURATION_MS)
        );
      }
    }
  }, [renderItems, structuralAnimationDurationMs]);

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    const hasStructuralAnimation = renderItems.some((item) => item.phase !== 'stable');
    const stableOrder = renderItems
      .filter((item) => item.phase === 'stable')
      .map((item) => item.id);
    const orderChanged =
      stableOrder.length !== previousStableOrderRef.current.length ||
      stableOrder.some((id, index) => id !== previousStableOrderRef.current[index]);

    for (const item of renderItems) {
      const node = itemRefs.current.get(item.id);
      if (!node) continue;
      nextRects.set(item.id, node.getBoundingClientRect());
    }

    if (hasStructuralAnimation) {
      skipNextFlipRef.current = true;
      for (const item of renderItems) {
        const node = itemRefs.current.get(item.id);
        if (!node) continue;
        node.style.transition = '';
        node.style.transform = '';
      }

      previousRectsRef.current = nextRects;
      return;
    }

    if (skipNextFlipRef.current) {
      skipNextFlipRef.current = false;
      for (const item of renderItems) {
        const node = itemRefs.current.get(item.id);
        if (!node) continue;
        node.style.transition = '';
        node.style.transform = '';
      }

      previousRectsRef.current = nextRects;
      previousStableOrderRef.current = stableOrder;
      return;
    }

    if (!orderChanged) {
      for (const item of renderItems) {
        const node = itemRefs.current.get(item.id);
        if (!node) continue;
        node.style.transition = '';
        node.style.transform = '';
      }

      previousRectsRef.current = nextRects;
      previousStableOrderRef.current = stableOrder;
      return;
    }

    for (const item of renderItems) {
      const node = itemRefs.current.get(item.id);
      const previousRect = previousRectsRef.current.get(item.id);
      const nextRect = nextRects.get(item.id);
      if (!node) continue;
      if (item.phase !== 'stable') {
        node.style.transition = '';
        node.style.transform = '';
        continue;
      }
      if (!previousRect || !nextRect) continue;

      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

      node.style.transition = 'none';
      node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

      requestAnimationFrame(() => {
        node.style.transition =
          `transform ${sortMoveDurationMs}ms ${SORT_MOVE_EASING}, opacity ${sortFadeDurationMs}ms ease-in-out`;
        node.style.transform = '';
      });
    }

    previousRectsRef.current = nextRects;
    previousStableOrderRef.current = stableOrder;
  }, [renderItems, sortFadeDurationMs, sortMoveDurationMs]);

  return (
    <div
      className={`flex w-full flex-col ${
        isGrid ? 'gui-item-group max-w-lg' : 'max-w-md'
      }`}
      style={isGrid ? ({ '--gui-grid-columns': columnCount } as CSSProperties) : undefined}
    >
      {hasExpandableFilter ? (
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
          const isFilteredOut = filteredOutSet.has(item.id);

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
              style={structuralAnimationStyle}
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
