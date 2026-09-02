/**
 * The kiosk's pairing control: a QR to scan, and the choice of where voice goes.
 *
 * The normal flow does not use the toggle at all: the visitor scans, taps the
 * microphone on their phone, and the phone claims voice. The toggle here is the
 * kiosk's override — for the presenter who wants voice back on the headset
 * without touching the visitor's phone.
 *
 * Presentational only — the token is minted once by the owner and handed down.
 * See the prop's docstring for why that matters.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useLanguage } from '../../i18n';
import type { VoiceOutputTarget } from '../../hooks/useVoiceCompanionHost';

export function buildCompanionUrl(companionToken: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  // Fragment, not query: a pairing token must not reach access logs or a proxy's
  // history. Same rule as the memory-mirror QR.
  return `${base}/demo/companion#${encodeURIComponent(companionToken)}`;
}

export function CompanionPairingCard({
  companionToken,
  target,
  onTargetChange,
  companionActive,
}: {
  /**
   * Minted ONCE per session by the owner and passed down, never fetched here.
   *
   * This card renders twice at the same time in demo mode — the desktop rail and
   * the phone sheet are separate JSX siblings, hidden from each other only by a
   * CSS breakpoint, so both actually mount. Minting on mount therefore fired
   * twice, and minting rotates the revocation handle, so the second call killed
   * the first card's QR before anyone could scan it. Worse, re-opening the memory
   * panel re-minted and silently revoked a phone that was already paired and
   * working.
   */
  companionToken: string | null;
  /**
   * The kiosk's override, omitted where there is nothing to override yet.
   *
   * The "ready to start" screen shows this card before the relay connection
   * exists, so it cannot know whether a phone has attached and has no voice to
   * move. Passing no target renders the QR alone — the visitor's phone moves
   * voice itself once it is paired, which is the normal path anyway.
   */
  target?: VoiceOutputTarget;
  onTargetChange?: (target: VoiceOutputTarget) => void;
  /**
   * Whether a phone is attached right now.
   *
   * Omitted on the pairing screen, where the answer is "not yet" by definition.
   * Absence is what separates the two uses of this control: with it, the toggle
   * is a live switch and choosing the phone before one is attached would
   * release the kiosk's microphone with nothing to catch it; without it, the
   * choice is a preference recorded before anything is capturing.
   */
  companionActive?: boolean;
}) {
  const { s } = useLanguage();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!companionToken) return;
    let cancelled = false;
    QRCode.toString(buildCompanionUrl(companionToken), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [companionToken]);

  // Null means this session has no phone voice — a study session, or the mint
  // failed. Nothing to say about it; the control simply does not appear.
  if (!companionToken) return null;

  return (
    <div className="rounded-xl border border-dark-border bg-dark p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {s.pairVoiceTitle}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-fg-faint">{s.pairVoiceHint}</p>

      {svg ? (
        <div
          className="mx-auto mb-3 w-full max-w-[180px] overflow-hidden rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
          aria-label={s.pairVoiceTitle}
          // Self-contained markup built from the URL above; no user input.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}

      {target && onTargetChange ? (
        <>
      <div className="mb-1 text-[11px] font-medium text-fg-muted">{s.voiceTargetLabel}</div>
      <div className="flex gap-2" role="group" aria-label={s.voiceTargetLabel}>
        {(['kiosk', 'companion'] as const).map((option) => {
          const selected = target === option;
          // Choosing the phone before one has paired would mute the session: the
          // kiosk releases its microphone and nothing picks it up. Normally the
          // phone moves this itself when the visitor taps its microphone.
          const disabled =
            companionActive !== undefined && option === 'companion' && !companionActive;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onTargetChange(option)}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? 'border-primary bg-primary/10 text-primary-text'
                  : 'border-dark-border text-fg hover:border-primary hover:text-fg-strong'
              } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              {option === 'kiosk' ? s.voiceTargetKiosk : s.voiceTargetCompanion}
            </button>
          );
        })}
      </div>
      {companionActive === false ? (
        <p className="mt-2 text-[10px] text-fg-faint">{s.voiceTargetPhoneWaiting}</p>
      ) : null}
        </>
      ) : null}
    </div>
  );
}
