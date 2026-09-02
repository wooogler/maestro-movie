/**
 * SeatStage Component
 *
 * 좌석 선택 Stage - SeatMap 사용
 */

import type { SeatItem } from '../../spec';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';
import { useLanguage } from '../../i18n';

interface SeatStageProps extends StageProps<SeatItem> {
  onToggle: (id: string) => void;
}

export function SeatStage({
  spec,
  onToggle,
  onNext,
  onBack,
  motionProfile = 'default',
}: SeatStageProps) {
  const { s } = useLanguage();
  const formatUsd = (value: number): string =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const selectedList = spec.state.selectedList ?? [];
  const selectedIds = selectedList.map((item) => item.id);
  const canProceed = selectedIds.length > 0;
  const hasRestoredSelection = spec.meta?.selectionRestored === true;

  // Derive row ordering from the seat items instead of stage meta.
  const rows = [...new Set(spec.items.map((seat) => seat.row))].sort();
  const maxSeatNumber = Math.max(...spec.items.map((seat) => seat.number), 0);

  // Highlight 정보
  const highlightedIds = new Set(spec.modification.highlight?.itemIds ?? []);

  // 좌석을 행별로 그룹화 (원본 items 사용)
  const seatsByRow = rows.map((row) =>
    spec.items
      .filter((seat) => seat.row === row)
      .sort((a, b) => a.number - b.number)
  );
  const rowPriceMap = new Map(
    seatsByRow
      .filter((rowSeats) => rowSeats.length > 0)
      .map((rowSeats) => [rowSeats[0].row, rowSeats[0].price])
  );

  return (
    <div className="flex w-full max-w-full flex-col items-center gap-5 sm:gap-6">
      {/* Screen indicator */}
      <div className="w-full max-w-sm sm:max-w-lg">
        <div className="w-3/4 h-2 mx-auto bg-gradient-to-b from-fg-faint to-dark-border rounded-t-full mb-2" />
        <div className="text-center text-sm text-fg-faint mb-6">SCREEN</div>
      </div>

      {/* Seat map */}
      <div className="w-full max-w-xl">
        <div className="mx-auto flex w-full flex-col gap-2">
          {seatsByRow.map((rowSeats, rowIndex) => (
            <div
              key={rows[rowIndex]}
              className="grid grid-cols-[2.6rem_minmax(0,1fr)] items-center gap-1.5 sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-2"
            >
              {/* Row label */}
              <span className="text-center text-[10px] text-fg-faint sm:text-[11px]">
                {rows[rowIndex]}
                {rowPriceMap.has(rows[rowIndex]) && (
                  <span className="block text-[9px] sm:text-[10px]">
                    {formatUsd(rowPriceMap.get(rows[rowIndex]) ?? 0)}
                  </span>
                )}
              </span>

              {/* Seats */}
              <div
                className="grid min-w-0 gap-0.5 sm:gap-1"
                style={{ gridTemplateColumns: `repeat(${maxSeatNumber}, minmax(0, 1fr))` }}
              >
                {rowSeats.map((seat) => {
                  const isSelected = selectedIds.includes(seat.id);
                  const isOccupied = seat.status !== 'available';
                  const isHighlighted = highlightedIds.has(seat.id);
                  // Premium seats get a gold tint rather than a gold fill: solid gold
                  // is the agent-highlight border/ring below, and it has to stay
                  // readable when the agent highlights a premium seat.
                  const isPremium = seat.type === 'premium';

                  const highlightClass = isHighlighted
                    ? motionProfile === 'full-tuning'
                      ? 'border-accent-line border-2 shadow-[0_0_0_4px_var(--app-accent-glow-strong)] gui-highlight-border-once'
                      : 'ring-[4px] ring-accent-line gui-highlight-wave'
                    : '';

                  return (
                    <button
                      key={seat.id}
                      onClick={() => !isOccupied && onToggle(seat.id)}
                      disabled={isOccupied}
                      title={seat.label}
                      style={{ gridColumn: `${seat.number} / span 1` }}
                      className={`
                        relative aspect-square min-w-0 w-full rounded-t-md text-[10px] transition-[color,background-color,border-color,opacity] sm:rounded-t-lg sm:text-xs
                        ${
                          isOccupied
                            ? 'cursor-not-allowed bg-dark-light text-fg-muted font-normal'
                            : isSelected
                            ? hasRestoredSelection
                              ? 'border border-primary bg-primary/12 text-fg-strong font-semibold'
                              : 'bg-primary text-primary-fg font-semibold'
                            : isPremium
                            ? 'bg-dark-lighter text-fg-strong font-semibold ring-1 ring-inset ring-fg-faint/45 hover:bg-dark-border'
                            : 'bg-dark-light text-fg-strong font-semibold hover:bg-dark-lighter'
                        }
                        ${highlightClass}
                      `}
                    >
                      {seat.number}
                      {isOccupied ? (
                        <span className="pointer-events-none absolute left-[18%] right-[18%] top-1/2 h-px -translate-y-1/2 bg-fg-faint/70" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-fg-muted sm:gap-x-6 sm:text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-t bg-dark-light" />
          <span>{s.legendStandard}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-t bg-dark-lighter ring-1 ring-inset ring-fg-faint/45" />
          <span>{s.legendPremium}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-t bg-primary" />
          <span>{s.legendSelected}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-4 w-4 rounded-t bg-dark-border">
            <span className="absolute left-[18%] right-[18%] top-1/2 h-px -translate-y-1/2 bg-fg-faint/70" />
          </div>
          <span>{s.legendOccupied}</span>
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
