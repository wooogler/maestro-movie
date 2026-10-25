/**
 * The kiosk/desktop demo's two reset numbers, for the presenter: how long the
 * booking-complete screen stays after its spoken line, and how long an
 * untouched session may sit before the "still there?" countdown.
 *
 * Not on the booth tablet, whose numbers come from its profile URL.
 */

import { useLanguage } from '../../i18n';
import { useBoothResetSettings } from '../../hooks/useBoothResetSettings';
import { KIOSK_IDLE_MINUTE_CHOICES, KIOSK_RETURN_AFTER_CHOICES } from '../../study/boothReset';

export function BoothResetSettings() {
  const { s } = useLanguage();
  const settings = useBoothResetSettings();
  const selectClass =
    'h-11 w-full rounded-xl border border-dark-border bg-dark px-3 text-sm font-medium text-fg-strong focus:border-primary focus:outline-none sm:h-10';
  // A value set outside the list (a shorter return for a browser check) still
  // shows as itself rather than as the first option.
  const returnChoices = Array.from(
    new Set<number>([...KIOSK_RETURN_AFTER_CHOICES, settings.returnAfterSeconds])
  ).sort((a, b) => a - b);
  const idleChoices = Array.from(
    new Set<number>([
      ...KIOSK_IDLE_MINUTE_CHOICES,
      ...(settings.idleMinutes === null ? [] : [settings.idleMinutes]),
    ])
  ).sort((a, b) => a - b);

  return (
    <section className="mb-6">
      <div className="mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{s.boothResetTitle}</h3>
        <p className="mt-1 text-xs text-fg-muted">{s.boothResetHint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-fg-strong">{s.boothReturnAfterLabel}</span>
          <select
            data-testid="booth-return-after"
            value={settings.returnAfterSeconds}
            onChange={(event) => settings.setReturnAfterSeconds(Number(event.target.value))}
            className={selectClass}
          >
            {returnChoices.map((seconds) => (
              <option key={seconds} value={seconds}>
                {s.boothSecondsValue.replace('{n}', String(seconds))}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-fg-strong">{s.boothIdleLabel}</span>
          <select
            data-testid="booth-idle-minutes"
            value={settings.idleMinutes === null ? 'off' : String(settings.idleMinutes)}
            onChange={(event) =>
              settings.setIdleMinutes(event.target.value === 'off' ? null : Number(event.target.value))
            }
            className={selectClass}
          >
            {idleChoices.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {s.boothMinutesValue.replace('{n}', String(minutes))}
              </option>
            ))}
            <option value="off">{s.boothIdleOff}</option>
          </select>
        </label>
      </div>
    </section>
  );
}
