/**
 * The five quick-demo cards as QR codes, on screen.
 *
 * The printed sheet (scripts/build-demo-cards.py --set quick) is what a booth
 * actually hands out. This is the same five links for the cases paper does not
 * cover: the presenter's own tablet, a booth that ran out of cards, and testing
 * the whole path without a printer.
 *
 * The access code is typed here rather than read from anywhere. The QR carries
 * it, so a code baked into this page at build time would be a credential
 * published to every visitor who opened the route; typing it makes the presenter
 * the one who decides which code is live, exactly as they do when handing over a
 * printed card. It is held in sessionStorage on the same terms as everywhere
 * else in the app: dies with the tab, never localStorage.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QUICK_DEMO_CARDS, buildQuickDemoCardUrl } from '../study/quickDemoCards';
import { getStoredAccessCode, setStoredAccessCode } from '../study/sessionStorage';
import { useLanguage } from '../i18n';

function CardTile({ cardId, accessCode }: { cardId: string; accessCode: string }) {
  const { language } = useLanguage();
  const card = QUICK_DEMO_CARDS.find((item) => item.id === cardId);
  const [svg, setSvg] = useState<string | null>(null);
  const url = buildQuickDemoCardUrl(cardId, window.location.origin, { accessCode });

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!card) return null;

  return (
    <div className="flex flex-col rounded-2xl border border-dark-border bg-dark-light p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-fg">
          {card.badge}
        </span>
        <span className="text-sm font-semibold text-fg-strong">{card.title[language]}</span>
      </div>
      {svg ? (
        <div
          className="mb-3 w-full overflow-hidden rounded-xl bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
          aria-label={card.title[language]}
          // Self-contained markup built from the URL above; no user input reaches it.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="mb-3 aspect-square w-full rounded-xl border border-dashed border-dark-border" />
      )}
      <blockquote lang={language} className="text-sm font-medium leading-snug text-fg-strong">
        &ldquo;{card.opener[language]}&rdquo;
      </blockquote>
      <p lang={language} className="mt-2 text-[11px] leading-relaxed text-fg-faint">
        {card.watch[language]}
      </p>
    </div>
  );
}

export function DemoCardGalleryPage() {
  const { s } = useLanguage();
  const [accessCode, setAccessCode] = useState(() => getStoredAccessCode());

  useEffect(() => {
    setStoredAccessCode(accessCode);
  }, [accessCode]);

  return (
    <main className="h-full overflow-y-auto bg-dark px-5 py-8">
      <div className="mx-auto w-full max-w-5xl">
        <h1 className="text-2xl font-semibold text-fg-strong">{s.quickCardGalleryTitle}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-fg-muted">{s.quickCardGalleryHint}</p>

        <label className="mt-5 block max-w-xs">
          <span className="text-xs font-medium text-fg-muted">{s.accessCodeLabel}</span>
          <input
            type="text"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-xl border border-dark-border bg-dark px-4 py-2.5 font-mono text-sm uppercase tracking-widest text-fg-strong focus:border-primary focus:outline-none"
          />
        </label>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_DEMO_CARDS.map((card) => (
            <CardTile key={card.id} cardId={card.id} accessCode={accessCode} />
          ))}
        </div>
      </div>
    </main>
  );
}
