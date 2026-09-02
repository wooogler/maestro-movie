/**
 * UI Spec System
 *
 * LLM Agent가 GUI를 조작할 수 있도록 설계된 선언적 UI Spec 시스템
 *
 * @example
 * ```typescript
 * // 1. Spec 생성 (visibleItems 자동 계산됨)
 * const spec = generateMovieSpec(movies);
 * // spec.visibleItems = [{ id: 'm1', value: 'Dune: Part Two' }, ...]
 *
 * // 2. Modification 적용 (Agent Tool Call) - visibleItems 자동 갱신
 * const filtered = applyFilter(spec, { field: 'genre', operator: 'contains', value: 'Sci-Fi' });
 * const narrowed = applyFilter(filtered, { field: 'rating', operator: 'gte', value: 4 });
 * const highlighted = applyHighlight(narrowed, { itemIds: ['m1'] });
 *
 * // 3. Agent는 visibleItems를 직접 읽어 화면 상태 파악
 * // highlighted.visibleItems = [{ id: 'm1', value: 'Dune: Part Two', isHighlighted: true }]
 * ```
 */

// Types
export type {
  Stage,
  UISpec,
  DataItem,
  DisplayItem,
  WorkflowSelectionState,
  BookingContext,
  DisplayConfig,
  StateModel,
  ModificationState,
  FilterState,
  FilterOperator,
  SortState,
  HighlightState,
  AugmentState,
  // deprecated
  VisibleItem,
  InternalState,
} from './types';

// Modifiers
export {
  computeDisplayItems,
  computeVisibleItems,
  refreshVisibleItems,
  applyFilter,
  applySort,
  applyHighlight,
  applyAugment,
  selectItem,
  selectItems,
  toggleItem,
  clearModification,
  clearHighlight,
  pruneFilters,
  getVisibleItems, // deprecated
} from './modifiers';

// Generators
export type {
  MovieItem,
  TheaterItem,
  DateItem,
  TimeItem,
  SeatItem,
  ConfirmMeta,
  BookingCompleteMeta,
} from './generators';

export {
  generateMovieSpec,
  generateTheaterSpec,
  generateDateSpec,
  createDateItems,
  generateTimeSpec,
  generateSeatSpec,
  generateConfirmSpec,
  generateBookingCompleteSpec,
  isBookingCompleteMeta,
} from './generators';
