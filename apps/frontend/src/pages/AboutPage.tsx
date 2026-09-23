/**
 * /about — what the demo is, in the booth's two languages.
 *
 * Modelled on swag.cs.vt.edu/about: a product explainer that quotes the app's
 * own labels in bold and says exactly what they do. The figures are the real
 * booking components playing scripted specs (see about/aboutFigures.tsx), so
 * the page cannot show an interface the app does not have.
 *
 * It sits outside any session: no API call, no relay, nothing stored except the
 * language choice, which is the app's own shared setting.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { LANGUAGES, LANGUAGE_LABELS, useLanguage } from '../i18n';
import { renderMessageText } from '../components/chat/renderMessageText';
import { QUICK_DEMO_CARDS } from '../study/quickDemoCards';
import { ABOUT_COPY, PAPER_TITLE, SOURCE_URL, type FigureText } from './about/aboutCopy';
import {
  AdaptationFigure,
  BrowserFrame,
  HeroFigure,
  MemoryFigure,
  VoiceFigure,
  WorkflowFigure,
} from './about/aboutFigures';
import {
  DEMO_MOVIES,
  KLARA_THEATERS,
  augmentSteps,
  filterSteps,
  heroSteps,
  highlightSteps,
  sortSteps,
  type FigureStep,
} from './about/aboutFixtures';

/** Which formats each film plays in across the week (the dataset's showings). */
const FILM_FORMATS: Record<string, string> = {
  m1: 'Standard · 3D · IMAX',
  m2: 'Standard',
  m3: 'Standard · 3D',
  m4: 'Standard · 3D · IMAX',
  m5: 'Standard · IMAX',
};

function Rich({ text }: { text: string }) {
  return <>{renderMessageText(text)}</>;
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-dark-border py-14 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <h2 id={`${id}-title`} className="text-2xl font-semibold text-fg-strong sm:text-3xl">
          {title}
        </h2>
        {lead ? (
          <p className="mt-3 max-w-3xl text-base leading-relaxed text-fg-muted">
            <Rich text={lead} />
          </p>
        ) : null}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3 text-[15px] leading-relaxed text-fg">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span aria-hidden className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            <Rich text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <p className="mt-3 text-sm leading-relaxed text-fg-muted">
      <Rich text={text} />
    </p>
  );
}

function AdaptationCard({
  text,
  steps,
  replayLabel,
}: {
  text: FigureText;
  steps: FigureStep[];
  replayLabel: string;
}) {
  return (
    <article className="flex flex-col rounded-2xl border border-dark-border bg-dark-light p-5">
      <h3 className="text-lg font-semibold text-fg-strong">{text.title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-fg">
        <Rich text={text.body} />
      </p>
      <div className="mt-5 flex-1 overflow-hidden rounded-xl border border-dark-border bg-dark px-3 py-4">
        <AdaptationFigure steps={steps} sentences={text.sentences} replayLabel={replayLabel} />
      </div>
      <p className="mt-3 text-sm italic leading-relaxed text-fg-muted">{text.caption}</p>
    </article>
  );
}

function LanguageSwitch({ label }: { label: string }) {
  const { language, setLanguage } = useLanguage();
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1">
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
  );
}

export function AboutPage() {
  const { language } = useLanguage();
  const copy = ABOUT_COPY[language];
  const navigate = useNavigate();

  useEffect(() => {
    const previous = document.title;
    document.title = copy.documentTitle;
    return () => {
      document.title = previous;
    };
  }, [copy.documentTitle]);

  const hero = useMemo(() => heroSteps(), []);
  const augment = useMemo(() => augmentSteps(), []);
  const filter = useMemo(() => filterSteps(), []);
  const sort = useMemo(() => sortSteps(), []);
  const highlight = useMemo(() => highlightSteps(), []);
  const heroCard = QUICK_DEMO_CARDS.find((card) => card.stage === 'theater');
  const cinemasByDistance = useMemo(
    () => [...KLARA_THEATERS].sort((a, b) => a.distanceMiles - b.distanceMiles),
    []
  );

  const tryDemo = () => navigate('/demo');

  return (
    <main className="h-full overflow-y-auto bg-dark text-fg" lang={language}>
      <header className="sticky top-0 z-20 border-b border-dark-border bg-dark/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm font-bold tracking-[0.16em] text-fg-strong">MAESTRO</span>
          <div className="flex items-center gap-2 sm:gap-3">
            <LanguageSwitch label={copy.languageLabel} />
            <button
              type="button"
              onClick={tryDemo}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg transition-colors hover:bg-primary-hover sm:text-sm"
            >
              {copy.ctaTry}
            </button>
          </div>
        </div>
      </header>

      <section className="px-4 pb-10 pt-14 text-center sm:px-6 sm:pt-20">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-text">{copy.eyebrow}</p>
        <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-bold leading-tight text-fg-strong sm:text-5xl">
          {copy.headline}
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-base leading-relaxed text-fg-muted sm:text-lg">{copy.intro}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={tryDemo}
            className="w-full rounded-xl bg-primary px-6 py-3 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-hover sm:w-auto sm:rounded-lg sm:py-2.5 sm:text-sm"
          >
            {copy.ctaTry}
          </button>
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="w-full rounded-xl border border-dark-border bg-dark px-6 py-3 text-base font-semibold text-fg transition-colors hover:border-primary hover:text-fg-strong sm:w-auto sm:rounded-lg sm:py-2.5 sm:text-sm"
          >
            {copy.ctaSource}
          </a>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <HeroFigure
          steps={hero}
          question={copy.heroQuestion}
          userLine={heroCard?.opener[language] ?? ''}
          sentences={copy.heroSentences}
          conversationLabel={copy.conversationLabel}
          replayLabel={copy.replay}
          caption={copy.heroCaption}
        />
      </div>

      <Section id="how" title={copy.howTitle}>
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {copy.howSteps.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-dark-border bg-dark-light p-5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary-text">
                {index + 1}
              </span>
              <h3 className="mt-3 text-base font-semibold text-fg-strong">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                <Rich text={step.body} />
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="adaptation" title={copy.adaptTitle} lead={copy.adaptLead}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <AdaptationCard text={copy.adaptCards.augment} steps={augment} replayLabel={copy.replay} />
          <AdaptationCard text={copy.adaptCards.filter} steps={filter} replayLabel={copy.replay} />
          <AdaptationCard text={copy.adaptCards.sort} steps={sort} replayLabel={copy.replay} />
          <AdaptationCard text={copy.adaptCards.highlight} steps={highlight} replayLabel={copy.replay} />
        </div>
        <p className="mt-5 rounded-lg border border-info-border bg-info-bg px-4 py-3 text-sm text-info-text">
          <Rich text={copy.adaptNote} />
        </p>
        <div className="mt-8 max-w-3xl">
          <Bullets items={copy.adaptBullets} />
        </div>
      </Section>

      <Section id="memory" title={copy.memoryTitle} lead={copy.memoryLead}>
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
          <Bullets items={copy.memoryBullets} />
          <figure>
            <MemoryFigure />
            <figcaption>
              <Caption text={copy.memoryFigureCaption} />
              <p className="mt-2 text-xs leading-relaxed text-fg-faint">
                <Rich text={copy.memoryFigureNote} />
              </p>
            </figcaption>
          </figure>
        </div>
      </Section>

      <Section id="navigation" title={copy.navTitle} lead={copy.navLead}>
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
          <figure className="lg:order-1">
            <WorkflowFigure />
            <figcaption>
              <Caption text={copy.navFigureCaption} />
            </figcaption>
          </figure>
          <div className="lg:order-2">
            <Bullets items={copy.navBullets} />
          </div>
        </div>
      </Section>

      <Section id="voice" title={copy.voiceTitle} lead={copy.voiceLead}>
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
          <Bullets items={copy.voiceBullets} />
          <figure>
            <BrowserFrame>
              <div className="bg-dark p-4">
                <VoiceFigure />
              </div>
            </BrowserFrame>
            <figcaption>
              <Caption text={copy.voiceFigureCaption} />
            </figcaption>
          </figure>
        </div>
      </Section>

      <Section id="cards" title={copy.cardsTitle} lead={copy.cardsLead}>
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {QUICK_DEMO_CARDS.map((card) => (
            <li key={card.id} className="flex flex-col rounded-2xl border border-dark-border bg-dark-light p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-fg">
                  {card.badge}
                </span>
                <span className="text-sm font-semibold text-fg-strong">{card.title[language]}</span>
              </div>
              <blockquote className="mt-3 text-sm font-medium leading-snug text-fg-strong">
                &ldquo;{card.opener[language]}&rdquo;
              </blockquote>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="world" title={copy.worldTitle} lead={copy.worldLead}>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{copy.worldFilmsHeading}</h3>
            <div className="mt-3 overflow-x-auto rounded-xl border border-dark-border">
              <table className="w-full min-w-[26rem] text-left text-sm">
                <thead className="bg-dark-light text-xs text-fg-muted">
                  <tr>
                    {copy.worldFilmColumns.map((column) => (
                      <th key={column} scope="col" className="px-3 py-2 font-semibold">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-border">
                  {DEMO_MOVIES.map((movie) => (
                    <tr key={movie.id}>
                      <th scope="row" className="px-3 py-2 font-medium text-fg-strong">
                        {movie.title}
                      </th>
                      <td className="px-3 py-2 text-fg">{movie.ageRating}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-fg">{movie.duration}</td>
                      <td className="px-3 py-2 text-fg">{FILM_FORMATS[movie.id]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{copy.worldCinemasHeading}</h3>
            <div className="mt-3 overflow-x-auto rounded-xl border border-dark-border">
              <table className="w-full min-w-[26rem] text-left text-sm">
                <thead className="bg-dark-light text-xs text-fg-muted">
                  <tr>
                    {copy.worldCinemaColumns.map((column) => (
                      <th key={column} scope="col" className="px-3 py-2 font-semibold">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-border">
                  {cinemasByDistance.map((theater) => (
                    <tr key={theater.id}>
                      <th scope="row" className="px-3 py-2 font-medium text-fg-strong">
                        {theater.name}
                      </th>
                      <td className="px-3 py-2 tabular-nums text-fg">{theater.distanceMiles}</td>
                      <td className="px-3 py-2 text-fg">{copy.cinemaNotes[theater.id]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs text-fg-faint">{copy.worldGeneratedNote}</p>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">{copy.worldNote}</p>
      </Section>

      <Section id="privacy" title={copy.privacyTitle}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {copy.privacyBlocks.map((block) => (
            <article key={block.title} className="rounded-2xl border border-dark-border bg-dark-light p-5">
              <h3 className="text-base font-semibold text-fg-strong">{block.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-fg">
                <Rich text={block.body} />
              </p>
            </article>
          ))}
        </div>
      </Section>

      <Section id="hood" title={copy.hoodTitle}>
        <div className="max-w-3xl">
          <Bullets items={copy.hoodBullets} />
          <p className="mt-6 text-sm leading-relaxed text-fg-muted">
            <span className="font-semibold text-fg-strong">{copy.paperLabel}.</span> <cite className="not-italic">{PAPER_TITLE}</cite>. UIST 2026.
          </p>
        </div>
      </Section>

      <Section id="glossary" title={copy.glossaryTitle}>
        <dl className="grid grid-cols-1 gap-x-10 gap-y-5 md:grid-cols-2">
          {copy.glossary.map((entry) => (
            <div key={entry.term}>
              <dt className="text-[15px] font-semibold text-fg-strong">{entry.term}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                <Rich text={entry.definition} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <footer className="border-t border-dark-border bg-dark-light">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>{copy.footerLine}</span>
          <div className="flex gap-4">
            <button type="button" onClick={tryDemo} className="text-primary-text underline underline-offset-2 transition-colors hover:text-primary-hover">
              {copy.ctaTry}
            </button>
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="text-primary-text underline underline-offset-2 transition-colors hover:text-primary-hover">
              {copy.ctaSource}
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
