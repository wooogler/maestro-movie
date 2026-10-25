/**
 * The two QR codes at the bottom of the demo start screen, side by side.
 *
 *  (a) "Use your phone as the mic for this kiosk" — the companion pairing for
 *      the start screen's standby session (`study/demoStandbySession.ts`). The
 *      token is App's, minted once for that session and passed down; Start
 *      promotes the same session, so a phone that scanned here is still
 *      paired on the booking page, where the memory rail shows the same code.
 *  (b) "Try the demo on your own phone" — the movie quick card's link, with
 *      the booth's access code and the current language in the fragment, so
 *      the visitor's phone lands on a one-tap start with nothing to type and
 *      nothing to pair. Rebuilt when the language changes.
 *
 * Both are bearer links: (a) attaches a phone to this session's voice until the
 * session ends; (b) carries the access code, which starts sessions on the
 * operator key until it is revoked — exactly as a printed quick card does.
 * Neither is ever printed as text; the link rides `data-qr-url` only, for a
 * browser check to read back.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { useLanguage } from '../../i18n';
import { buildCompanionUrl } from '../companion/CompanionPairingCard';
import { buildQuickDemoCardUrl } from '../../study/quickDemoCards';

/** The card whose face is a full booking from the start: nothing prefilled. */
const TRY_ON_PHONE_CARD_ID = 'movie';

function QrTile({
  url,
  caption,
  placeholder,
  testId,
}: {
  url: string | null;
  caption: string;
  /** Shown in the square while there is no link yet, or none to give. */
  placeholder: string;
  testId: string;
}) {
  const [svg, setSvg] = useState<{ url: string; markup: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((markup) => {
        if (!cancelled) setSvg({ url, markup });
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Only the code for the CURRENT link: a stale one would be scannable for a
  // render after the language or the session changed.
  const markup = svg && svg.url === url ? svg.markup : null;

  return (
    <figure className="flex flex-col items-center text-center" data-testid={testId} data-qr-url={markup ? url ?? '' : ''}>
      <div className="flex aspect-square w-full max-w-[200px] items-center lg:max-w-[280px] justify-center overflow-hidden rounded-xl bg-white p-2">
        {markup ? (
          <div
            className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
            role="img"
            aria-label={caption}
            // Self-contained markup built from the link above; no user input.
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : (
          <span className="px-3 text-xs leading-relaxed text-neutral-500">{placeholder}</span>
        )}
      </div>
      <figcaption className="mt-2 text-sm font-medium leading-snug text-fg-strong">{caption}</figcaption>
    </figure>
  );
}

export function DemoStartQrCodes({
  companionToken,
  accessCode,
  standbyFailed,
  children,
  className = '',
}: {
  /** Null until App's mint for the standby session lands, or when it cannot. */
  companionToken: string | null;
  /** The booth code; null when the demo runs on a pasted key, which must never ride a QR. */
  accessCode: string | null;
  /** The standby could not be created, so no pairing code is coming. */
  standbyFailed: boolean;
  /** Under the codes: the device roster, so a visitor sees their scan land. */
  children?: ReactNode;
  className?: string;
}) {
  const { s, language } = useLanguage();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const pairingUrl = companionToken ? buildCompanionUrl(companionToken, origin) : null;
  const tryUrl = useMemo(
    () => (accessCode ? buildQuickDemoCardUrl(TRY_ON_PHONE_CARD_ID, origin, { accessCode, language }) : null),
    [accessCode, language, origin]
  );

  return (
    <section className={`border-t border-dark-border pt-6 ${className}`}>
      <div className="grid grid-cols-2 gap-4 sm:gap-8">
        <QrTile
          url={pairingUrl}
          caption={s.startScreenPhoneMicCaption}
          placeholder={standbyFailed ? s.startScreenStandbyFailed : s.startScreenQrPreparing}
          testId="qr-phone-mic"
        />
        <QrTile
          url={tryUrl}
          caption={s.startScreenTryCaption}
          placeholder={s.startScreenTryNeedsCode}
          testId="qr-try-on-phone"
        />
      </div>
      {children ? <div className="mx-auto mt-4 max-w-md">{children}</div> : null}
    </section>
  );
}
