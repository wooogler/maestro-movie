/**
 * The About page's figures: the real booking components, played from specs.
 *
 * Nothing here draws its own version of the GUI. A figure hands a spec to the
 * same StageRenderer, SelectionBreadcrumb, message bubbles and memory panel the
 * booking page mounts, with `motionProfile="full-tuning"` — the profile the demo
 * runs — so the fold-out of a filter, the FLIP slide of a sort, the text swap of
 * an augment and the single pulse of a highlight are the ones a visitor sees.
 *
 * Two pieces of chrome are copied rather than imported, because their owners
 * are not exported: the GUI card frame (FullTuningSplitView's GuiSnapshotCard)
 * and the transcript's divider row (TimelineMarkerRow). If either changes
 * there, change it here.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StageRenderer } from '../../renderer';
import { clearModification, selectItem, toggleItem, type UISpec } from '../../spec';
import { SelectionBreadcrumb } from '../../components/chat/SelectionBreadcrumb';
import { UserMessage } from '../../components/chat/UserMessage';
import { AgentMessage } from '../../components/chat/AgentMessage';
import { ChatInput } from '../../components/chat/ChatInput';
import { renderMessageText } from '../../components/chat/renderMessageText';
import { AgentMemoryPanel } from '../../components/memory';
import { WorkflowGraph } from '../../components/memory/WorkflowGraph';
import { VoiceVerbosityPanel } from '../../components/voice/VoiceVerbosityPanel';
import { VOICE_PRESET_LABELS } from '../../components/voice/verbosityFormat';
import {
  DEFAULT_VOICE_VERBOSITY,
  VOICE_VERBOSITY_PRESETS,
  matchPreset,
  type VoiceVerbositySettings,
} from '../../voice';
import { useLanguage } from '../../i18n';
import type { AgentMemorySnapshot } from '../../agent/protocol';
import {
  BACKTRACK_SNAPSHOT,
  CONFLICT_SNAPSHOT,
  forgetPreference,
  restorePreference,
  type FigureStep,
  type FigureStepKind,
} from './aboutFixtures';

/** The GUI card's width on the booking page (GUI_CARD_BASE_WIDTH_PX). */
const GUI_CARD_WIDTH_PX = 440;

const noop = () => {};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Plays a figure's steps once it scrolls into view, one per `stepMs`.
 *
 * Under reduced motion it opens on the last step and never plays: the stages
 * already switch their own transitions off there, so a replay would only be a
 * jump cut, and the final state is the one worth reading.
 */
function useStepPlayback(count: number, stepMs: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [reduced] = useState(prefersReducedMotion);
  const [index, setIndex] = useState(() => (reduced ? count - 1 : 0));
  const [visible, setVisible] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced]);

  useEffect(() => {
    if (!visible || reduced) return;
    const timers = Array.from({ length: count - 1 }, (_, offset) =>
      window.setTimeout(() => setIndex(offset + 1), 900 + offset * stepMs)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [visible, reduced, run, count, stepMs]);

  const replay = () => {
    setIndex(0);
    setRun((value) => value + 1);
  };

  return { ref, index, replay, canReplay: !reduced, playing: visible && index < count - 1 };
}

/** What the booking page prints over a card, keyed by the move that made it. */
const STEP_LABELS: Record<Exclude<FigureStepKind, 'stage'>, string> = {
  augment: 'Agent is updating labels',
  filter: 'Agent is filtering',
  sort: 'Agent is sorting',
  highlight: 'Agent is highlighting',
};

function stepLabel(step: FigureStep): string {
  return step.kind === 'stage' ? step.spec.title : STEP_LABELS[step.kind];
}

// =============================================================================
// Chrome
// =============================================================================

/** A window around a figure, the way the page it is modelled on frames its screenshots. */
export function BrowserFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-dark-border bg-dark shadow-[0_18px_48px_rgba(41,40,38,0.10)] ${className}`}>
      <div className="flex items-center gap-1.5 border-b border-dark-border bg-dark-light px-4 py-2.5" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-dark-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-dark-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-dark-border" />
      </div>
      {children}
    </div>
  );
}

function ReplayButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-dark-border bg-dark px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong"
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.5 15a7 7 0 0012.9 1.5M18.5 9A7 7 0 005.6 7.5" />
      </svg>
      {label}
    </button>
  );
}

/**
 * GuiSnapshotCard, minus the snapshot bookkeeping: breadcrumb, the teal
 * monitor avatar, the label and context lines, then the live stage.
 */
function GuiCard({
  spec,
  label,
  context,
  speaking = false,
  onSelect = noop,
  onToggle = noop,
}: {
  spec: UISpec;
  label: string;
  context: string;
  speaking?: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}) {
  const frameClass = speaking
    ? 'border-accent-line/70 shadow-[0_0_0_3px_var(--app-accent-glow)]'
    : 'border-dark-border';
  return (
    <div className="w-full max-w-full" style={{ width: `${GUI_CARD_WIDTH_PX}px` }}>
      <SelectionBreadcrumb spec={spec} stage={spec.stage} />
      <div className={`rounded-2xl border bg-dark p-4 transition-colors ${frameClass}`}>
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-info-border bg-primary text-primary-fg">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <span className="min-w-0 text-sm font-semibold text-info-label">{label}</span>
            <div className="mt-2 text-base font-medium leading-7 text-info-text">{renderMessageText(context)}</div>
          </div>
        </div>
        <div className="rounded-2xl border border-dark-border bg-dark-light p-4">
          <StageRenderer
            spec={spec}
            onSelect={onSelect}
            onToggle={onToggle}
            onNext={noop}
            onBack={noop}
            onConfirm={noop}
            motionProfile="full-tuning"
          />
        </div>
      </div>
    </div>
  );
}

/** TimelineMarkerRow: the transcript's divider for each new card. */
function MarkerRow({ label }: { label: string }) {
  return (
    <div className="rounded-2xl px-3 py-3">
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-fg-faint">
        <span className="h-px flex-1 bg-dark-border" />
        <span className="rounded-full border border-dark-border bg-dark px-3 py-1 font-semibold text-fg-muted">{label}</span>
        <span className="h-px flex-1 bg-dark-border" />
      </div>
    </div>
  );
}

// =============================================================================
// Hero: one spoken sentence, four moves
// =============================================================================

export function HeroFigure({
  steps,
  question,
  userLine,
  sentences,
  conversationLabel,
  replayLabel,
  caption,
}: {
  steps: FigureStep[];
  question: string;
  userLine: string;
  sentences: readonly string[];
  conversationLabel: string;
  replayLabel: string;
  caption: string;
}) {
  const { ref, index, replay, canReplay, playing } = useStepPlayback(steps.length, 2300);
  const step = steps[index];
  const context = index === 0 ? step.spec.description ?? '' : sentences[index - 1] ?? '';

  return (
    <figure ref={ref}>
      <BrowserFrame>
        <div className="grid grid-cols-1 gap-6 bg-dark px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex justify-center lg:justify-end">
            <GuiCard spec={step.spec} label={stepLabel(step)} context={context} speaking={playing} />
          </div>
          <div className="min-w-0 rounded-2xl border border-dark-border bg-dark-light px-3 py-3">
            <div className="flex items-center justify-between px-1 pb-1 text-sm font-semibold text-fg-strong">
              {conversationLabel}
            </div>
            <MarkerRow label={steps[0].spec.title} />
            <AgentMessage message={{ id: 'about-q', type: 'agent', timestamp: 0, stage: 'theater', text: question }} />
            <UserMessage
              message={{ id: 'about-u', type: 'user', timestamp: 0, stage: 'theater', action: 'input', label: userLine, inputSource: 'voice' }}
            />
            {steps.slice(1, index + 1).map((item, offset) => (
              <MarkerRow key={`${item.kind}-${offset}`} label={stepLabel(item)} />
            ))}
          </div>
        </div>
      </BrowserFrame>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-fg-muted">
        <span className="max-w-3xl">{renderMessageText(caption)}</span>
        {canReplay ? <ReplayButton label={replayLabel} onClick={replay} /> : null}
      </figcaption>
    </figure>
  );
}

// =============================================================================
// One adaptation, played on its own
// =============================================================================

export function AdaptationFigure({
  steps,
  sentences,
  replayLabel,
}: {
  steps: FigureStep[];
  /** The agent's line for each step after the first, in order. */
  sentences: readonly string[];
  replayLabel: string;
}) {
  const { ref, index, replay, canReplay } = useStepPlayback(steps.length, 1700);
  const step = steps[index];
  /*
    A visitor's tap, kept only for the step it was made on, so the next step of
    the script (or a replay) starts from the script again. It does what
    ChatPage's handleSelect does: a tap on an option a filter is hiding clears
    that stage's filters first, then selects it.
  */
  const [tapped, setTapped] = useState<{ index: number; spec: UISpec } | null>(null);
  const tappedHere = tapped !== null && tapped.index === index;
  const spec = tappedHere ? tapped.spec : step.spec;
  const select = (id: string) => {
    const hidden = !spec.visibleItems.some((item) => item.id === id);
    const base = hidden ? clearModification(spec, 'filter') : spec;
    setTapped({ index, spec: selectItem(base, id) });
  };
  const toggle = (id: string) => setTapped({ index, spec: toggleItem(spec, id) });

  return (
    <div ref={ref} className="flex flex-col items-center gap-3">
      {/* A tap is the visitor's move, so, as on the booking page, the card
          it makes is headed with the stage itself, not the agent's line. */}
      <GuiCard
        spec={spec}
        label={tappedHere ? spec.title : stepLabel(step)}
        context={
          tappedHere || index === 0 ? spec.description ?? '' : sentences[index - 1] ?? ''
        }
        onSelect={select}
        onToggle={toggle}
      />
      {canReplay ? (
        <div className="flex w-full justify-end" style={{ maxWidth: `${GUI_CARD_WIDTH_PX}px` }}>
          <ReplayButton
            label={replayLabel}
            onClick={() => {
              setTapped(null);
              replay();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// Memory: the live panel, and the graph after going back
// =============================================================================

export function MemoryFigure() {
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot>(CONFLICT_SNAPSHOT);
  return (
    <div className="rounded-2xl border border-dark-border bg-dark-light p-4">
      <AgentMemoryPanel
        snapshot={snapshot}
        currentStage={snapshot.stage}
        onPreferenceDelete={(id) => setSnapshot((current) => forgetPreference(current, id))}
        onPreferenceRestore={(id) => setSnapshot((current) => restorePreference(current, id))}
        onPreferenceClearAll={() =>
          setSnapshot((current) =>
            current.preferences.reduce((next, preference) => forgetPreference(next, preference.id), current)
          )
        }
      />
    </div>
  );
}

export function WorkflowFigure() {
  const snapshot = BACKTRACK_SNAPSHOT;
  const target = snapshot.backtrackContinuation?.targetStage ?? null;
  const noNewDeadEnds = useMemo(() => new Set<string>(), []);
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-dark-border bg-dark-light p-4 text-sm">
      {/* AgentMemoryPanel's backtrack banner; the panel itself opens on
          Preferences and offers no prop to open on Workflow. */}
      <section className="rounded-lg border border-primary/60 bg-primary/10 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-primary-text">Backtracking</h3>
        <p className="mt-1 text-sm text-fg-strong">Going back to the Theater step</p>
      </section>
      <WorkflowGraph
        snapshot={snapshot}
        activeStage="date"
        backtrackTarget={target}
        newDeadEndIds={noNewDeadEnds}
        isMirror={false}
      />
    </div>
  );
}

// =============================================================================
// Voice: the composer at rest and the verbosity sheet
// =============================================================================

export function VoiceFigure() {
  const { s } = useLanguage();
  const [settings, setSettings] = useState<VoiceVerbositySettings>(DEFAULT_VOICE_VERBOSITY);

  const update = (next: Omit<VoiceVerbositySettings, 'preset'>) =>
    setSettings({ ...next, preset: matchPreset(next) });

  return (
    <div className="flex flex-col gap-4">
      {/* The composer as a demo visitor first meets it. Inert: its mic would
          otherwise look like it is listening on a page that has no session. */}
      <div inert className="rounded-2xl border border-dark-border bg-dark px-3 py-3">
        <ChatInput
          disabled={false}
          placeholder={s.tapMicForVoice}
          voiceModeAvailable
          voiceModeEnabled={false}
          highlightVoiceToggle
          onToggleVoiceMode={noop}
          voiceVerbosityLabel={VOICE_PRESET_LABELS[settings.preset]}
          onOpenVoiceSettings={noop}
        />
      </div>
      <div className="rounded-2xl border border-dark-border bg-dark-light p-5">
        <VoiceVerbosityPanel
          settings={settings}
          onPresetChange={(preset) => setSettings({ preset, ...VOICE_VERBOSITY_PRESETS[preset] })}
          onCategoryChange={(category, mode) =>
            update({ categories: { ...settings.categories, [category]: mode }, smartSkip: settings.smartSkip })
          }
          onSmartSkipChange={(enabled) => update({ categories: settings.categories, smartSkip: enabled })}
          onClose={noop}
        />
      </div>
    </div>
  );
}
