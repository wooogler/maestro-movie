/**
 * ConfirmStage Component
 *
 * 예약 확인 Stage - BookingSummary 사용
 */

import { isBookingCompleteMeta, type BookingCompleteMeta, type ConfirmMeta } from '../../spec';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';
import { useLanguage } from '../../i18n';

interface ConfirmStageProps extends Omit<StageProps, 'onSelect'> {
  onConfirm: () => void;
}

export function ConfirmStage({
  spec,
  onConfirm,
  onNext,
  onFinishTask,
  onBack,
}: ConfirmStageProps) {
  const { s } = useLanguage();
  const meta = spec.meta as unknown as ConfirmMeta | BookingCompleteMeta;
  const totalPrice = meta.totalPrice;
  const formattedTotal = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(totalPrice);

  const summaryCard = (
    <div className="w-full max-w-md bg-dark-light rounded-xl p-6">
      <table className="w-full border-separate border-spacing-y-3">
        <tbody>
          <tr>
            <td className="text-fg-muted pr-6 align-top whitespace-nowrap">{s.summaryMovie}</td>
            <td className="text-fg-strong font-semibold text-right">{meta.movie.title}</td>
          </tr>
          <tr>
            <td className="text-fg-muted pr-6 align-top whitespace-nowrap">{s.summaryTheater}</td>
            <td className="text-fg-strong text-right">{meta.theater.name}</td>
          </tr>
          <tr>
            <td className="text-fg-muted pr-6 align-top whitespace-nowrap">{s.summaryDateTime}</td>
            <td className="text-fg-strong text-right">{meta.date} {meta.time}</td>
          </tr>
          <tr>
            <td className="text-fg-muted pr-6 align-top whitespace-nowrap">{s.summarySeats}</td>
            <td className="text-right">
              <div className="flex flex-col items-end gap-1">
                {meta.seats.map((seat) => (
                  <span key={seat} className="text-fg-strong">{seat}</span>
                ))}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="border-dark-border my-4" />

      <div className="flex justify-between items-center text-lg">
        <span className="text-fg-muted font-semibold">{s.summaryTotal}</span>
        <span className="text-primary-text font-bold">{formattedTotal}</span>
      </div>
    </div>
  );

  if (isBookingCompleteMeta(meta)) {
    return (
      <div className="flex flex-col items-center gap-6">
        <div className="w-full max-w-md rounded-2xl border border-primary/35 bg-dark-light px-6 py-7 text-center shadow-lg shadow-black/15">
          <div className="mb-2 text-2xl font-semibold text-fg-strong">{s.bookingComplete}</div>
          <p className="font-medium text-primary-text">{s.bookingConfirmed}</p>
          <p className="mt-2 text-sm text-fg-muted">Booking ID: {meta.bookingId}</p>
        </div>

        {summaryCard}

        <ActionBar
          onNext={onFinishTask ?? onNext}
          nextLabel={s.finishTask}
          showBack={false}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      {summaryCard}

      <ActionBar
        onBack={onBack}
        onNext={onConfirm}
        nextLabel={s.confirmBooking}
      />
    </div>
  );
}
