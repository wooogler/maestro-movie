/**
 * Dev-only page for eyeballing highlight density. Not routed, not shipped —
 * served by Vite at /highlight-preview.html while calibrating how many marked
 * items a screen can carry before the mark stops meaning anything.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { LanguageProvider } from '../i18n/LanguageProvider';
import { ButtonGroup } from '../renderer/components/ButtonGroup';
import { SeatStage } from '../renderer/stages/SeatStage';
import { generateSeatSpec } from '../spec';
import type { DisplayItem } from '../spec/types';
import type { Seat } from '../types';

const TIMES: DisplayItem[] = [
  { id: 't1', value: '11:20 AM - Standard' },
  { id: 't2', value: '1:05 PM - Standard' },
  { id: 't3', value: '3:40 PM - IMAX' },
  { id: 't4', value: '6:15 PM - Standard' },
  { id: 't5', value: '8:50 PM - IMAX' },
  { id: 't6', value: '10:30 PM - Standard' },
];

const LIST_CASES: Array<{ label: string; ids: string[] }> = [
  { label: '1 of 6', ids: ['t3'] },
  { label: '2 of 6', ids: ['t3', 't5'] },
  { label: '3 of 6', ids: ['t2', 't3', 't5'] },
  { label: '5 of 6', ids: ['t1', 't2', 't3', 't4', 't5'] },
  { label: '6 of 6 (whole screen)', ids: TIMES.map((item) => item.id) },
];

/**
 * A 5x8 house with the same shape the study's seat stage had: some seats
 * already occupied, the rest available. The interesting question here is not
 * item count but choice count — "every adjacent pair that fits two" is four
 * choices wearing eight rings.
 */
const OCCUPIED = new Set(['A3', 'A4', 'B2', 'B6', 'C3', 'C7', 'D5', 'D8', 'E4', 'E6']);
const SEATS: Seat[] = ['A', 'B', 'C', 'D', 'E'].flatMap((row) =>
  Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    return {
      id: `s-${row}${number}`,
      showingId: 'sh1',
      row,
      number,
      type: 'standard' as const,
      price: 14,
      status: OCCUPIED.has(`${row}${number}`) ? ('occupied' as const) : ('available' as const),
    };
  })
);

const SEAT_CASES: Array<{ label: string; ids: string[] }> = [
  { label: 'one pair — 1 choice', ids: ['s-C4', 's-C5'] },
  { label: 'two pairs — 2 choices', ids: ['s-C4', 's-C5', 's-E1', 's-E2'] },
  {
    label: 'every qualifying pair — 8 seats, what the study did',
    ids: ['s-C4', 's-C5', 's-D1', 's-D2', 's-E1', 's-E2', 's-B3', 's-B4'],
  },
];

function seatSpecWith(ids: string[]) {
  const spec = generateSeatSpec(SEATS);
  return { ...spec, modification: { ...spec.modification, highlight: { itemIds: ids } } };
}

/**
 * The "Show all" toggle over a filter, with its callback wired to something
 * visible. This is the escape hatch a participant uses when the agent's filter
 * hid the option they actually wanted, and it is now logged — so this is here
 * to prove the callback fires at all.
 */
function RevealProbe() {
  const [log, setLog] = useState<string[]>([]);
  const hidden = ['t1', 't4', 't6'];
  const root = useRef<HTMLDivElement>(null);
  // `?autoclick=1` presses the toggle once on load, so the headless screenshot
  // in scripts/shot.mjs — which cannot click — still exercises the callback.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('autoclick')) return;
    const timer = window.setTimeout(() => {
      root.current?.querySelector('button')?.click();
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="w-[300px]" ref={root}>
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
        filter hiding 3 of 6 — toggle fires onRevealHidden
      </div>
      <ButtonGroup
        items={TIMES.filter((item) => !hidden.includes(item.id))}
        allItems={TIMES}
        filteredOutIds={hidden}
        onSelect={() => {}}
        onRevealHidden={(revealed, count) =>
          setLog((prev) => [...prev, `${revealed ? 'reveal_filtered' : 'hide_filtered'} hiddenCount=${count}`])
        }
      />
      <pre
        data-testid="reveal-log"
        className="mt-3 whitespace-pre-wrap rounded-lg border border-dark-border p-2 text-[11px] text-fg-muted"
      >
        {log.length ? log.join('\n') : 'no events yet'}
      </pre>
    </div>
  );
}

function Preview() {
  return (
    <div className="min-h-screen bg-dark p-8">
      <div className="mb-12">
        <RevealProbe />
      </div>
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
        list stage — a showtime screen of six
      </div>
      <div className="mb-12 flex flex-wrap gap-8">
        {LIST_CASES.map((testCase) => (
          <div key={testCase.label} className="w-[260px]">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
              {testCase.label}
            </div>
            <ButtonGroup items={TIMES} highlightedIds={testCase.ids} onSelect={() => {}} />
          </div>
        ))}
      </div>
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
        seat stage — 30 available seats, user needs two together
      </div>
      <div className="flex flex-wrap gap-10">
        {SEAT_CASES.map((testCase) => (
          <div key={testCase.label} className="w-[440px]">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
              {testCase.label}
            </div>
            <SeatStage
              spec={seatSpecWith(testCase.ids)}
              onSelect={() => {}}
              onToggle={() => {}}
              onNext={() => {}}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider initialLanguage="en">
      <Preview />
    </LanguageProvider>
  </StrictMode>
);
