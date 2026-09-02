/**
 * Spec Generator Functions
 *
 * 각 Stage별 UISpec 생성 함수
 * 백엔드 데이터를 받아 Agent가 읽을 수 있는 UISpec으로 변환
 */

import type { UISpec, DataItem, StateModel, Stage } from './types';
import type { Movie, Theater, Showing, Seat } from '../types';
import { computeVisibleItems } from './modifiers';
import { formatTime12Hour } from '../utils/displayFormats';
import { formatLocalDate } from '../utils/studyDate';

// =============================================================================
// Stage Metadata (초기화 시 agent에 전송, extractor + planner 공용)
// =============================================================================

export interface StageMeta {
  /** stage 식별자 */
  stage: Stage;
  /** stage에서 수행할 목표 (planner용) */
  goal: string;
  /** stage의 item 필드 및 preference 배정 가이드 (extractor용) */
  fieldGuide: string;
}

/**
 * 전체 stage 메타데이터 (순서 보존).
 * 세션 초기화 시 snapshot으로 한 번 전송되어,
 * - extractor: relevantStages 배정에 fieldGuide 사용
 * - planner: stage order/goal을 system prompt에 포함 (prompt caching 대상)
 */
export const STAGE_META: StageMeta[] = [
  {
    stage: 'movie',
    goal: 'Pick one movie title.',
    fieldGuide:
      'Film selection. Item fields: title, genre (array), rating, duration, ageRating, synopsis. ' +
      'Assign preferences about: specific movie title, genre, rating threshold, duration, age appropriateness.',
  },
  {
    stage: 'theater',
    goal: 'Pick one theater for the selected movie.',
    fieldGuide:
      'Cinema location selection. Item fields: name, location, distanceMiles, screenCount, amenities. ' +
      'Assign preferences about: theater distance/proximity, specific theater name, location constraints. ' +
      'Note: screening format (IMAX, 3D) is NOT a property of theaters — it varies per showtime and belongs to the time stage.',
  },
  {
    stage: 'date',
    goal: 'Pick one date for the selected movie and theater.',
    fieldGuide:
      'Calendar date selection. Item fields: date, dayOfWeek, displayText, available, isToday. ' +
      'Assign preferences about: specific dates, weekday/weekend constraints, date ranges.',
  },
  {
    stage: 'time',
    goal: 'Select Showtime.',
    fieldGuide:
      'Showtime/screening selection. Item fields: time, displayTime, endTime (HH:MM 24h), displayEndTime, format ("Standard" | "IMAX" | "3D"), screenNumber. ' +
      'An endTime earlier than its own time is the next day and sorts after 23:59, so "ends by 10 PM" is endTime lte 22:00 and drops a 12:04 AM finish. ' +
      'Assign preferences about: start/end time constraints, arrival time, screening format (IMAX, 3D), and specific screen number when relevant. ' +
      'Important: IMAX and 3D are per-showtime attributes determined at this stage, not at the theater stage.',
  },
  {
    stage: 'seat',
    goal: 'Select one or more seats.',
    fieldGuide:
      'Seat selection within a screening room. Item fields: row, number, label, type ("standard" | "premium" | "couple"), price, status. ' +
      'Assign preferences about: seat position (center, front, back), row avoidance, seat type (premium, couple), adjacent seats, price.',
  },
  {
    stage: 'confirm',
    goal: 'Submit confirmation to finalize booking.',
    fieldGuide:
      'Final booking review and confirmation. Summary of all prior selections (movie, theater, date, time, seats, totalPrice). ' +
      'No item-level filtering preferences apply at this stage.',
  },
];

// =============================================================================
// Helper: Create Spec
// =============================================================================

/**
 * UISpec 생성 헬퍼
 */
function createSpec<T extends DataItem>(
  base: Omit<UISpec<T>, 'visibleItems' | 'state'> & { initialState?: Partial<StateModel> }
): UISpec<T> {
  // visibleItems 계산
  const tempSpec = { ...base, visibleItems: [], state: {} } as UISpec<T>;
  const visibleItems = computeVisibleItems(tempSpec);

  // 초기 state 생성
  const state: StateModel = base.initialState ?? {};

  return {
    stage: base.stage,
    title: base.title,
    description: base.description,
    visibleItems,
    state,
    items: base.items,
    modification: base.modification,
    display: base.display,
    meta: base.meta,
  };
}

// =============================================================================
// Movie Stage
// =============================================================================

export interface MovieItem extends DataItem {
  id: string;
  title: string;
  genre: string[];
  rating: string;
  duration: string;
  ageRating: string;
  synopsis: string;
}

export function generateMovieSpec(movies: Movie[]): UISpec<MovieItem> {
  const items: MovieItem[] = movies.map((m) => ({
    id: m.id,
    title: m.title,
    genre: m.genre,
    rating: m.rating,
    duration: m.duration,
    ageRating: m.ageRating,
    synopsis: m.synopsis,
  }));

  return createSpec({
    stage: 'movie',
    title: 'Select Movie',
    description: 'Choose a movie you want to watch',
    items,
    modification: {},
    display: {
      valueField: 'title',
      component: 'buttonGroup',
    },
  });
}

// =============================================================================
// Theater Stage
// =============================================================================

export interface TheaterItem extends DataItem {
  id: string;
  name: string;
  location: string;
  screenCount: number;
  distanceMiles: number;
  amenities: string[];
}

export function generateTheaterSpec(
  theaters: Theater[],
  movieId: string
): UISpec<TheaterItem> {
  const items: TheaterItem[] = theaters.map((t) => ({
    id: t.id,
    name: t.name,
    location: t.location,
    screenCount: t.screenCount,
    distanceMiles: t.distanceMiles,
    amenities: t.amenities,
  }));

  return createSpec({
    stage: 'theater',
    title: 'Select Theater',
    description: 'Choose a theater near you',
    items,
    modification: {},
    display: {
      valueField: 'name',
      component: 'buttonGroup',
    },
    meta: { movieId },
  });
}

// =============================================================================
// Date Stage
// =============================================================================

export interface DateItem extends DataItem {
  id: string;
  date: string;
  dayOfWeek: string;
  displayText: string;
  available: boolean;
  isToday: boolean;
}

export function generateDateSpec(
  dates: DateItem[],
  movieId: string,
  theaterId: string,
  /** YYYY-MM-DD. The month the calendar opens on, and the day it marks "today". */
  today?: string
): UISpec<DateItem> {
  return createSpec({
    stage: 'date',
    title: 'Select Date',
    description: 'Pick a date for your movie',
    items: dates,
    modification: {},
    display: {
      valueField: 'displayText',
      component: 'calendar',
    },
    meta: { movieId, theaterId, ...(today ? { today } : {}) },
  });
}

/**
 * 날짜 범위에서 DateItem 배열 생성 (헬퍼 함수)
 */
export function createDateItems(
  startDate: Date,
  days: number,
  availableDates?: string[]
): DateItem[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const items: DateItem[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const dateStr = formatLocalDate(date);
    const dayOfWeek = dayNames[date.getDay()];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();

    items.push({
      id: dateStr,
      date: dateStr,
      dayOfWeek,
      displayText: `${month} ${day} (${dayOfWeek})`,
      available: availableDates ? availableDates.includes(dateStr) : true,
      isToday: i === 0,
    });
  }

  return items;
}

// =============================================================================
// Time Stage
// =============================================================================

export interface TimeItem extends DataItem {
  id: string;
  screenNumber: number;
  time: string;
  displayTime: string;
  endTime: string;
  displayEndTime: string;
  format: 'Standard' | 'IMAX' | '3D';
}

export function generateTimeSpec(
  showings: Showing[],
  movieId: string,
  theaterId: string,
  date: string
): UISpec<TimeItem> {
  const items: TimeItem[] = showings.map((s) => ({
    id: s.id,
    screenNumber: s.screenNumber,
    time: s.time,
    displayTime: formatTime12Hour(s.time),
    endTime: s.endTime,
    displayEndTime: s.displayEndTime,
    format: s.format,
  }));

  return createSpec({
    stage: 'time',
    title: 'Select Showtime',
    description: 'Showtime with screen type',
    items,
    modification: {},
    display: {
      valueField: 'displayTime',
      component: 'buttonGroup',
    },
    meta: { movieId, theaterId, date },
  });
}

// =============================================================================
// Seat Stage
// =============================================================================

export interface SeatItem extends DataItem {
  id: string;
  showingId: string;
  row: string;
  number: number;
  label: string;
  type: 'standard' | 'premium' | 'couple';
  price: number;
  status: 'available' | 'occupied' | 'selected';
}

function formatSeatTypeLabel(type: SeatItem['type']): string {
  switch (type) {
    case 'premium':
      return 'Premium';
    case 'couple':
      return 'Couple';
    case 'standard':
    default:
      return 'Standard';
  }
}

export function generateSeatSpec(seats: Seat[]): UISpec<SeatItem> {
  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  const items: SeatItem[] = seats
    .map((s) => ({
      id: s.id,
      showingId: s.showingId,
      row: s.row,
      number: s.number,
      label: `${s.row}${s.number} - ${formatSeatTypeLabel(s.type)} - ${currencyFormatter.format(s.price)}`,
      type: s.type,
      price: s.price,
      status: s.status,
    }));

  return createSpec({
    stage: 'seat',
    title: 'Select Seats',
    description: 'Choose your seats',
    items,
    modification: {},
    display: {
      valueField: 'label',
      component: 'seatMap',
    },
    initialState: {
      selectedList: [],
    },
  });
}

// =============================================================================
// Confirm Stage
// =============================================================================

export interface ConfirmMeta {
  movie: { id: string; title: string };
  theater: { id: string; name: string };
  date: string;
  time: string;
  seats: string[];
  totalPrice: number;
}

export interface BookingCompleteMeta extends ConfirmMeta {
  status: 'completed';
  bookingId: string;
}

export function isBookingCompleteMeta(value: unknown): value is BookingCompleteMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === 'completed' && typeof record.bookingId === 'string';
}

export function generateConfirmSpec(meta: ConfirmMeta): UISpec {
  return createSpec({
    stage: 'confirm',
    title: 'Confirm Booking',
    description: 'Review your booking details',
    items: [],
    modification: {},
    display: {
      valueField: 'id',
      component: 'summary',
    },
    meta: meta as unknown as Record<string, unknown>,
  });
}

export function generateBookingCompleteSpec(meta: BookingCompleteMeta): UISpec {
  return createSpec({
    stage: 'confirm',
    title: 'Booking Complete',
    description: 'Your booking has been confirmed',
    items: [],
    modification: {},
    display: {
      valueField: 'id',
      component: 'summary',
    },
    meta: meta as unknown as Record<string, unknown>,
  });
}
