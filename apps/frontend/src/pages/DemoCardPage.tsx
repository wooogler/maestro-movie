/**
 * What a scanned quick-demo card opens.
 *
 * The whole screen is one line to say and one button. That is the point of the
 * card: a visitor who has ninety seconds should not meet a setup form, a
 * scenario briefing, a consent question and a pairing QR before they reach the
 * thing the poster promised. Everything that screen normally asks is either
 * carried by the link (the access code) or answered on their behalf in the only
 * direction that is safe to assume (no recording — see below).
 *
 * The button is not avoidable, and it is not only a formality. iOS Safari will
 * not let audio play unless an element was started inside a real gesture, and
 * this tap is the only gesture that will happen before the voice session opens
 * on the next screen. So the tap unlocks the audio element FIRST, before any
 * `await`, and hands it to the booking page through `voiceAudioUnlock`.
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { DEMO_SCENARIO_ID, DEMO_STUDY_MODE } from './studyOptions';
import {
  parseQuickDemoCardFragment,
  type QuickDemoCard,
} from '../study/quickDemoCards';
import { unlockVoiceAudioElement } from '../study/voiceAudioUnlock';
import type { StudySessionState } from '../study/sessionStorage';
import { LANGUAGES, LANGUAGE_LABELS, useLanguage } from '../i18n';

interface DemoCardPageProps {
  /**
   * Hands the session and the card up to App, which owns both the routing and
   * the props the booking page reads. Called before navigating, so `/booking`
   * never renders a frame without them.
   */
  onCardStarted: (session: StudySessionState, card: QuickDemoCard) => void;
}

export function DemoCardPage({ onCardStarted }: DemoCardPageProps) {
  const navigate = useNavigate();
  const { language, setLanguage, s } = useLanguage();

  /*
    Read once, at mount, and never again.

    The fragment holds a credential, so it is read into memory and the visitor's
    address bar is the only place it lingers. Re-reading it on every render
    would also make the code a moving target for the submit handler below.
  */
  const [link] = useState(() =>
    parseQuickDemoCardFragment(typeof window === 'undefined' ? '' : window.location.hash)
  );
  const card = link.card;

  // Prefilled from the QR in the normal case. The field only appears when the
  // link carried no code — a printed sheet from before codes were switched on,
  // or a link someone retyped.
  const [accessCode, setAccessCode] = useState(link.accessCode ?? '');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opener = useMemo(() => card?.opener[language] ?? '', [card, language]);

  const handleStart = useCallback(async () => {
    if (!card || starting) return;
    const code = accessCode.trim();
    if (!code) {
      setError(s.quickCardCodePrompt);
      return;
    }

    /*
      Before the await, deliberately. Browsers grant audio permission to an
      element only from inside the gesture that is still on the stack; moving
      this below the session request would put it after a network round trip,
      which is no longer a gesture as far as Safari is concerned.
    */
    unlockVoiceAudioElement();

    setStarting(true);
    setError(null);
    try {
      const session = await api.createStudySession({
        scenarioId: DEMO_SCENARIO_ID,
        studyMode: DEMO_STUDY_MODE,
        accessCode: code,
        /*
          Never true from here, and not a checkbox that was left unticked.

          A demo session records only what its visitor agreed to record, and
          this route deliberately does not ask: it exists because someone has
          ninety seconds, and a consent question they skim is worse than no
          recording at all. The full demo at `/demo` still asks properly, and
          that is where a visitor who wants to contribute data ends up.
        */
        researchConsent: false,
      });
      onCardStarted(session, card);
      navigate('/booking');
    } catch (err) {
      setStarting(false);
      setError(err instanceof Error ? err.message : s.quickCardFailed);
    }
  }, [accessCode, card, navigate, onCardStarted, s, starting]);

  if (!card) {
    return (
      <main className="h-full overflow-y-auto bg-dark px-6 py-10">
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center text-center">
          <p className="text-lg font-medium text-fg-strong">{s.quickCardUnknownLink}</p>
          {link.rawCardId ? (
            <p className="mt-2 font-mono text-xs text-fg-faint">{link.rawCardId}</p>
          ) : null}
          <button
            type="button"
            onClick={() => navigate('/demo')}
            className="mt-6 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
          >
            {s.quickCardFullDemoLink}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-dark px-5 py-8">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-fg">
              {card.badge}
            </span>
            <span className="text-sm font-semibold text-fg-strong">
              {card.title[language]}
            </span>
          </div>
          {/* A booth runs in two languages and the card face is the first thing
              a visitor reads, so the switch has to be here and not three screens
              in — the sentence they are about to say is on this screen. */}
          <div role="radiogroup" aria-label={s.languageLabel} className="flex gap-1">
            {LANGUAGES.map((candidate) => {
              const selected = candidate === language;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  lang={candidate}
                  onClick={() => setLanguage(candidate)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? 'border-primary bg-primary text-primary-fg'
                      : 'border-dark-border text-fg-muted hover:border-primary hover:text-fg-strong'
                  }`}
                >
                  {LANGUAGE_LABELS[candidate]}
                </button>
              );
            })}
          </div>
        </div>

        <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-fg-faint">
          {s.quickCardKicker}
        </p>

        {/* The opener is the screen. Everything else on it is a caption. */}
        <section className="mt-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-primary-text">
            {s.quickCardSayThis}
          </h2>
          <blockquote
            lang={language}
            className="mt-2 text-2xl font-semibold leading-snug text-fg-strong"
          >
            &ldquo;{opener}&rdquo;
          </blockquote>
        </section>

        <section className="mt-6 rounded-xl border border-dark-border bg-dark-light p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            {s.quickCardWatchFor}
          </h2>
          <p lang={language} className="mt-1.5 text-sm leading-relaxed text-fg">
            {card.watch[language]}
          </p>
        </section>

        {link.accessCode ? null : (
          <label className="mt-6 block">
            <span className="text-xs font-medium text-fg-muted">{s.accessCodeLabel}</span>
            <input
              type="text"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1.5 w-full rounded-xl border border-dark-border bg-dark px-4 py-3 font-mono text-base uppercase tracking-widest text-fg-strong focus:border-primary focus:outline-none"
            />
          </label>
        )}

        {error ? <p className="mt-4 text-sm text-danger-text">{error}</p> : null}

        <div className="mt-auto pt-8">
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            autoFocus
            className="w-full rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {starting ? s.quickCardPreparing : s.quickCardStart}
          </button>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-fg-faint">
            {s.quickCardMicNote}
            <br />
            {s.quickCardNoRecording}
          </p>
        </div>
      </div>
    </main>
  );
}
