/**
 * DateStage Component
 *
 * 날짜 선택 Stage - Full Calendar
 */

import { useMemo } from 'react';
import type { DateItem } from '../../spec';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';
import { formatLocalDate, resolveScenarioToday } from '../../utils/studyDate';
import { useLanguage } from '../../i18n';

interface CalendarDay {
  date: string; // YYYY-MM-DD
  dayNum: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isAvailable: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
}

function generateCalendarDays(
  year: number,
  month: number,
  todayStr: string,
  items: DateItem[],
  selectedId?: string,
  highlightedIds?: string[]
): CalendarDay[] {
  const days: CalendarDay[] = [];

  // First day of the month
  const firstDay = new Date(year, month, 1);
  const startDayOfWeek = firstDay.getDay();

  // Last day of the month
  const lastDay = new Date(year, month + 1, 0);
  const totalDays = lastDay.getDate();

  // Create maps for quick lookup
  const itemMap = new Map<string, DateItem>();
  items.forEach((item) => itemMap.set(item.id, item));

  const highlightSet = new Set(highlightedIds ?? []);

  // Add empty slots for days before the first day of month
  for (let i = 0; i < startDayOfWeek; i++) {
    const prevMonthDay = new Date(year, month, -startDayOfWeek + i + 1);
    const dateStr = formatLocalDate(prevMonthDay);
    days.push({
      date: dateStr,
      dayNum: prevMonthDay.getDate(),
      isCurrentMonth: false,
      isToday: dateStr === todayStr,
      isAvailable: false,
      isSelected: false,
      isHighlighted: false,
    });
  }

  // Add days of the current month
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    const dateStr = formatLocalDate(date);
    const item = itemMap.get(dateStr);
    const isHighlighted = highlightSet.has(dateStr);

    days.push({
      date: dateStr,
      dayNum: day,
      isCurrentMonth: true,
      isToday: dateStr === todayStr,
      isAvailable: item?.available ?? false,
      isSelected: dateStr === selectedId,
      isHighlighted,
    });
  }

  // Add empty slots to complete the last week
  const remainingDays = 7 - (days.length % 7);
  if (remainingDays < 7) {
    for (let i = 1; i <= remainingDays; i++) {
      const nextMonthDay = new Date(year, month + 1, i);
      const dateStr = formatLocalDate(nextMonthDay);
      days.push({
        date: dateStr,
        dayNum: i,
        isCurrentMonth: false,
        isToday: dateStr === todayStr,
        isAvailable: false,
        isSelected: false,
        isHighlighted: false,
      });
    }
  }

  return days;
}

export function DateStage({
  spec,
  onSelect,
  onNext,
  onBack,
  motionProfile = 'default',
}: StageProps<DateItem>) {
  const { s } = useLanguage();
  const canProceed = !!spec.state.selected;
  const hasRestoredSelection = spec.meta?.selectionRestored === true;

  // Fix the month view to the scenario's month. There is no month navigation —
  // deliberately, so the calendar cannot wander off the seeded world — which is
  // why this has to be the month the showings are actually in. The spec states
  // the day it was built for; scenarios that state nothing use the study date.
  const specToday = typeof spec.meta?.today === 'string' ? spec.meta.today : undefined;
  const scenarioToday = resolveScenarioToday(specToday);
  const todayStr = formatLocalDate(scenarioToday);
  const viewYear = scenarioToday.getFullYear();
  const viewMonth = scenarioToday.getMonth();

  // Generate calendar days for current view
  const calendarDays = useMemo(
    () => generateCalendarDays(
      viewYear,
      viewMonth,
      todayStr,
      spec.items,
      spec.state.selected?.id,
      spec.modification.highlight?.itemIds
    ),
    [viewYear, viewMonth, todayStr, spec.items, spec.state.selected?.id, spec.modification.highlight]
  );

  // Format month display
  const monthYearDisplay = new Date(viewYear, viewMonth).toLocaleString(s.locale, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Month header */}
      <div className="w-full max-w-md text-center">
        <div className="text-xl font-semibold text-fg-strong">{monthYearDisplay}</div>
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1 w-full max-w-md">
        {/* 요일 헤더 */}
        {s.weekdayShort.map((day) => (
          <div
            key={day}
            className="text-center text-sm text-fg-faint py-2 font-medium"
          >
            {day}
          </div>
        ))}

        {/* Calendar days */}
        {calendarDays.map((day, index) => {
          const highlightClass = day.isHighlighted
            ? motionProfile === 'full-tuning'
              ? 'border-accent-line border-2 shadow-[0_0_0_4px_var(--app-accent-glow-strong)] gui-highlight-border-once'
              : 'ring-[4px] ring-accent-line gui-highlight-wave'
            : '';
          const isOutsideMonth = !day.isCurrentMonth;
          const isUnavailable = day.isCurrentMonth && !day.isAvailable;

          return (
            <button
              key={`${day.date}-${index}`}
              onClick={() => day.isAvailable && day.isCurrentMonth && onSelect(day.date)}
              disabled={!day.isAvailable || !day.isCurrentMonth}
              className={`
                relative aspect-square flex items-center justify-center rounded-lg border text-sm transition-[color,background-color,border-color,opacity]
                ${isOutsideMonth
                  ? 'border-transparent bg-transparent text-fg-faint/45'
                  : day.isSelected
                  ? hasRestoredSelection
                    ? 'border-primary bg-primary/12 text-fg-strong font-semibold'
                    : 'border-primary bg-primary text-primary-fg font-semibold'
                  : day.isAvailable
                  ? 'border-dark-border bg-dark-light text-fg-strong hover:bg-dark-lighter'
                  : 'border-dark-border bg-dark-border text-fg-muted cursor-not-allowed'
                }
                ${isOutsideMonth
                  ? 'text-fg-faint'
                  : ''
                }
                ${day.isToday && !day.isSelected && !day.isHighlighted ? 'ring-1 ring-primary/50' : ''}
                ${highlightClass}
              `}
            >
              <span>{day.dayNum}</span>

              {isUnavailable && (
                <span className="pointer-events-none absolute left-[18%] right-[18%] top-1/2 h-px -translate-y-1/2 bg-fg-faint/70" />
              )}

              {/* Today indicator */}
              {day.isToday && !day.isSelected && day.isCurrentMonth && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-fg-muted sm:text-sm">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded border border-dark-border bg-dark-light" />
          <span>{s.legendAvailable}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-4 w-4 rounded border border-dark-border bg-dark-border">
            <span className="absolute left-[18%] right-[18%] top-1/2 h-px -translate-y-1/2 rotate-[-32deg] bg-fg-faint/70" />
          </div>
          <span>{s.legendUnavailable}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded border border-primary bg-primary" />
          <span>{s.legendSelected}</span>
        </div>
      </div>

      <ActionBar
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!canProceed}
      />
    </div>
  );
}
