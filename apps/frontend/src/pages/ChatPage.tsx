import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import {
  useChatStore,
  getNextStage,
  getPrevStage,
  STAGE_ORDER,
} from '../store/chatStore';
import type { AgentMessage as AgentMessageType } from '../store/chatStore';
import { useDevTools, type ToolApplyContext } from '../components/devToolsContextShared';
import {
  generateMovieSpec,
  generateTheaterSpec,
  generateDateSpec,
  generateTimeSpec,
  generateSeatSpec,
  generateConfirmSpec,
  generateBookingCompleteSpec,
  createDateItems,
  refreshVisibleItems,
  selectItem,
  selectItems,
  toggleItem,
  clearModification,
  clearHighlight,
  pruneFilters,
  isBookingCompleteMeta,
  type ConfirmMeta,
  type DataItem,
  type UISpec,
  type Stage,
  type WorkflowSelectionState,
} from '../spec';
import { MessageList, FullTuningSplitView, ChatInput } from '../components/chat';
import {
  AgentMemoryPanel,
  createMemoryPublisher,
  subscribeToMemoryCommands,
} from '../components/memory';
import type { MemoryCommand } from '../agent/protocol';
import {
  createProfileFromPreset,
  findPreferencePreset,
  toPreferenceProfilePayload,
  type PreferenceProfile,
} from '../study/preferenceProfile';
import type { AgentMemorySnapshot } from '../agent/protocol';
import { CompanionPairingCard } from '../components/companion/CompanionPairingCard';
import { DeviceRosterCard } from '../components/companion/DeviceRosterCard';
import { useDevicePresence } from '../hooks/useDevicePresence';
import { SettingsModal } from '../components/settings/SettingsModal';
import { verbosityPillLabel } from '../components/voice/verbosityFormat';
import {
  RECENT_UTTERANCE_WINDOW,
  decideVoiceOutput,
  defaultVerbosityFor,
  QUICK_CARD_VOICE_VERBOSITY,
  resolveUtterance,
} from '../voice';
import { createSpeechGuiSync, type SpeechGuiSync } from '../voice/speechGuiSync';
import { ScenarioBriefing } from '../components/scenario/ScenarioBriefing';
import { StageRenderer } from '../renderer';
import {
  useToolHandler,
  useAgentBridge,
  useStudyInteractionLogger,
  useRealtimeVoice,
  useVoiceVerbositySettings,
  usePlannerModelSetting,
} from '../hooks';
import type { VoiceSpeakItem } from '../hooks/useRealtimeVoice';
import { useVoiceCompanionHost, type VoiceOutputTarget } from '../hooks/useVoiceCompanionHost';
import { agentTools, type ToolDefinition } from '../agent/tools';
import {
  DEMO_STUDY_MODE,
  getStudyModeConfig,
  normalizeStudyMode,
  type StudyModeId,
} from './studyOptions';
import type { Movie, Theater, Showing, Booking } from '../types';
import { formatScenarioTitle, formatTime12Hour } from '../utils/displayFormats';
import { formatLocalDate, resolveScenarioToday } from '../utils/studyDate';
import { COMPACT_VIEWPORT_QUERY, isCompactViewport } from '../utils/viewport';
import {
  buildTranscriptionPrompt,
  collectStageHintLabels,
  getIgnoredVoiceTranscriptReason,
  useLanguage,
  type Language,
  type UiStrings,
} from '../i18n';
import type { StudySessionState } from '../study/sessionStorage';
import type { QuickDemoCard } from '../study/quickDemoCards';
import { getUnlockedVoiceAudioElement } from '../study/voiceAudioUnlock';
import {
  buildConflictSignalEvents,
  buildPreferenceExtractionEvents,
  type DerivedLogEvent,
  type InteractionLogSource,
} from '../study/loggingHeuristics';

interface StageContext {
  workflow?: WorkflowSelectionState;
  restoreSnapshot?: boolean;
}

type ViewMode = 'chat' | 'carousel';
interface ChatPageProps {
  studyModePreset?: StudyModeId;
  studySession?: StudySessionState | null;
  /**
   * Preference memory chosen on the setup screen, simulating a session that
   * inherited it. Null when the visitor picked nothing.
   */
  preferenceProfile?: PreferenceProfile | null;
  /** Phone-pairing token, minted once per session by App. */
  companionToken?: string | null;
  /** What the visitor chose on the pairing screen, before any phone existed. */
  voiceTargetPreference?: VoiceOutputTarget;
  /**
   * A scanned quick-demo card: land on its stage with everything before it
   * already chosen, instead of opening on the movie list.
   *
   * The card carries ids, not selections. They are resolved here rather than by
   * the page that read the QR, because turning an id into a workflow selection
   * means running the same generators `loadStageData` runs and reading the
   * scenario's own calendar clock — both of which live in this file. A card
   * whose ids have outlived the generated world surfaces the failure in the
   * page's own error slot.
   */
  quickStartCard?: QuickDemoCard | null;
  /**
   * Open with voice already on.
   *
   * Set by the quick-card route, where the visitor tapped "start" one screen
   * ago and the whole promise of the card is that they can just talk. Everywhere
   * else voice stays off until the mic button is pressed.
   */
  startWithVoice?: boolean;
}

const stageInteractionTools: Record<Stage, string[]> = {
  movie: ['select'],
  theater: ['select', 'prev'],
  date: ['select', 'prev'],
  time: ['select', 'prev'],
  seat: ['select', 'prev'],
  confirm: ['prev'],
};
const DEFAULT_CHAT_WIDTH_PX = 768;
const MIN_CHAT_WIDTH_PX = 360;
const CHAT_WIDTH_VIEWPORT_PADDING_PX = 48;
const DEFAULT_SCENARIO_PANEL_WIDTH_PX = 620;
const MIN_SCENARIO_PANEL_WIDTH_PX = 280;
const MAX_SCENARIO_PANEL_WIDTH_PX = 620;
const MIN_MAIN_CONTENT_WIDTH_PX = 700;
// Guards against a voice-activity blip that transcribes to a stray character.
// The threshold is in *speech* milliseconds: the realtime session reports the
// tight span between speech start and stop, where the old recorder-based
// pipeline reported the span plus its 1.4s trailing-silence hold. A real short
// answer ("C1", "7B") runs 350ms and up, so this has to stay well under that or
// it swallows seat labels.
// How many days the calendar offers from the scenario's "today" when the
// scenario does not say. This is the study worlds' window; the generated demo
// world carries its own (six days, Tue 3 Nov through Sun 8 Nov).
const DEFAULT_DATE_WINDOW_DAYS = 5;

const SHORT_VOICE_INPUT_MAX_DURATION_MS = 300;
/**
 * How long a GUI change waits for the sentence describing it to become
 * audible. See `speechGuiSync` for why there is a ceiling at all; the value is
 * here because it is a property of this screen's voice pipeline, not of the
 * rule.
 */
const AGENT_SPEECH_SYNC_TIMEOUT_MS = 2500;
const SHORT_VOICE_INPUT_MAX_CHARS = 2;
const guiAdaptationToolsByStage: Record<Stage, readonly string[]> = {
  movie: ['filter', 'sort', 'highlight', 'augment', 'clearModification'],
  theater: ['filter', 'sort', 'highlight', 'augment', 'clearModification'],
  date: ['highlight', 'clearModification'],
  time: ['filter', 'sort', 'highlight', 'augment', 'clearModification'],
  seat: ['highlight', 'clearModification'],
  confirm: [],
};
const AGENT_BRIDGE_ENABLED_STORAGE_KEY = 'tuning-movie-agent-bridge-enabled';
const PLANNER_CP_MEMORY_LIMIT_STORAGE_KEY = 'tuning-movie-planner-cp-memory-limit';
const GUI_ADAPTATION_ENABLED_STORAGE_KEY = 'tuning-movie-gui-adaptation-enabled';
const SCENARIO_PANEL_WIDTH_STORAGE_KEY = 'tuning-movie-scenario-panel-width';
// v2: the same flag now also opens a full-screen memory sheet on a phone, so a
// stored `true` from before this change would have covered the booking UI on
// arrival. A new key gives every device the viewport-appropriate default once.
const SCENARIO_BRIEFING_VISIBLE_STORAGE_KEY = 'tuning-movie-side-panel-visible-v2';
// The toolbar is collapsed by a button now, not dragged. Dragging it was a
// full-width band under the thumb on a phone, with a minimum height of zero and
// a value persisted per device — one accidental swipe hid Reset and Finish with
// no way to get them back.
const HEADER_COLLAPSED_STORAGE_KEY = 'tuning-movie-header-collapsed';
const HEADER_HEIGHT_PX = 44;
const MAX_STT_HINT_OPTIONS = 15;
const MAX_STT_HINT_TEXT_LENGTH = 300;
const RESTORED_SELECTION_META_KEY = 'selectionRestored';
const SCENARIO_BRIEFING_COPY_GUARD_ENABLED = import.meta.env.PROD;

const TTS_MONTH_ABBREVS: Record<string, string> = {
  Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April',
  Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September',
  Oct: 'October', Nov: 'November', Dec: 'December',
};
const TTS_DAY_ABBREVS: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
const TTS_ABBREV_PATTERN = new RegExp(
  `\\b(${Object.keys(TTS_MONTH_ABBREVS).join('|')}|${Object.keys(TTS_DAY_ABBREVS).join('|')})\\b`,
  'g'
);
function expandTtsAbbreviations(text: string): string {
  return text.replace(TTS_ABBREV_PATTERN, (match) => TTS_MONTH_ABBREVS[match] ?? TTS_DAY_ABBREVS[match] ?? match);
}

function preventDefault(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function readStorageValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write failures (private mode/quota)
  }
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const stored = readStorageValue(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

function readStoredNonNegativeInt(key: string, fallback: number): number {
  const stored = readStorageValue(key);
  if (stored === null) return fallback;
  const parsed = Number.parseInt(stored, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function getVoiceStatusLabel(params: {
  voiceModeEnabled: boolean;
  voiceInputSupported: boolean;
  voiceInputStatus: string;
  voiceOutputStatus: string;
  hasLiveAgentSession: boolean;
  ui: UiStrings;
}): string | null {
  const {
    voiceModeEnabled,
    voiceInputSupported,
    voiceInputStatus,
    voiceOutputStatus,
    hasLiveAgentSession,
    ui,
  } = params;

  if (!voiceModeEnabled) return null;
  if (!voiceInputSupported) return ui.voiceUnavailable;
  if (voiceOutputStatus === 'synthesizing') return ui.generatingVoice;
  if (voiceOutputStatus === 'playing') return ui.playingReply;

  switch (voiceInputStatus) {
    case 'requesting-permission':
      return ui.allowMicrophoneAccess;
    case 'capturing':
      return ui.listening;
    case 'transcribing':
      return ui.transcribing;
    case 'suspended':
      return hasLiveAgentSession ? ui.waitingForAgent : ui.waitingForSession;
    case 'listening':
      return hasLiveAgentSession ? ui.listening : ui.waitingForSession;
    case 'error':
      return ui.voiceError;
    case 'unsupported':
      return ui.voiceUnavailable;
    default:
      return hasLiveAgentSession ? ui.voiceReady : ui.waitingForSession;
  }
}

/**
 * The on-screen labels the transcriber is biased toward, in the order they are
 * listed to it. Split out from the prompt builder because the transcript gate
 * needs the same list: the model reads this list back as speech when it is
 * handed silence, and only the labels it was given can prove that.
 */
function collectVoiceTranscriptionHints(
  spec: UISpec | null,
  fallbackStage: Stage,
  language: Language
): string[] {
  if (!spec) return [];

  const rawLabels = Array.isArray(spec.visibleItems) ? spec.visibleItems : [];
  // date/calendar: displayText 그대로 유지 (사용자가 "Friday", "March 13" 등으로 말할 수 있음)
  // 나머지: augment된 visibleItems value 그대로 유지 (화면에 표시되는 텍스트)
  const rawValues = rawLabels.map((visibleItem) =>
    typeof visibleItem?.value === 'string' ? visibleItem.value : ''
  );

  return collectStageHintLabels(language, spec.stage ?? fallbackStage, rawValues, {
    maxOptions: MAX_STT_HINT_OPTIONS,
    maxTextLength: MAX_STT_HINT_TEXT_LENGTH,
  });
}

function buildVoiceTranscriptionPrompt(
  spec: UISpec | null,
  fallbackStage: Stage,
  language: Language
): string | undefined {
  if (!spec) return undefined;
  const hints = collectVoiceTranscriptionHints(spec, fallbackStage, language);
  if (hints.length === 0) return undefined;
  return buildTranscriptionPrompt(language, spec.stage ?? fallbackStage, hints.join(', '));
}

function canUseNextTool(spec: UISpec): boolean {
  switch (spec.stage) {
    case 'movie':
    case 'theater':
    case 'date':
    case 'time':
      return Boolean(spec.state.selected?.id);
    case 'seat':
      return (spec.state.selectedList?.length ?? 0) > 0;
    case 'confirm':
      return !isBookingCompleteMeta(spec.meta);
    default:
      return false;
  }
}

function buildToolSchemaForStage(
  spec: UISpec | null,
  fallbackStage: Stage,
  guiAdaptationEnabled: boolean
): ToolDefinition[] {
  if (!spec) {
    return agentTools.filter((tool) => tool.name === 'postMessage');
  }

  const stage = spec.stage ?? fallbackStage;
  const allowed = new Set<string>(stageInteractionTools[stage] ?? ['postMessage']);
  if (stage === 'seat') {
    allowed.add('selectMultiple');
  }
  allowed.add('postMessage');

  if (guiAdaptationEnabled) {
    for (const toolName of guiAdaptationToolsByStage[stage] ?? []) {
      allowed.add(toolName);
    }
  }

  if (!spec.visibleItems.some((item) => !item.isDisabled)) {
    allowed.delete('select');
    allowed.delete('selectMultiple');
  }

  if (canUseNextTool(spec)) {
    allowed.add('next');
  } else {
    allowed.delete('next');
  }

  return agentTools.filter((tool) => allowed.has(tool.name));
}

type LegacyWorkflowSelectionState = WorkflowSelectionState & {
  date?: WorkflowSelectionState['date'] | string;
  selectedSeats?: WorkflowSelectionState['seats'];
};

function normalizeLegacyWorkflow(legacyWorkflow: LegacyWorkflowSelectionState): WorkflowSelectionState {
  const normalizedDate =
    typeof legacyWorkflow.date === 'string'
      ? { id: legacyWorkflow.date, date: legacyWorkflow.date }
      : legacyWorkflow.date;

  const normalizedSeats = (legacyWorkflow.seats ?? legacyWorkflow.selectedSeats ?? [])
    .map((seat) => {
      if (!seat || typeof seat !== 'object') return null;
      const seatRecord = seat as unknown as {
        id?: unknown;
        label?: unknown;
        value?: unknown;
      };
      const seatId = typeof seatRecord.id === 'string' ? seatRecord.id.trim() : '';
      if (!seatId) return null;
      const seatLabel =
        typeof seatRecord.label === 'string' && seatRecord.label.trim()
          ? seatRecord.label.trim()
          : typeof seatRecord.value === 'string' && seatRecord.value.trim()
          ? seatRecord.value.trim()
          : undefined;

      return {
        id: seatId,
        ...(seatLabel ? { label: seatLabel } : {}),
      };
    })
    .filter((seat): seat is NonNullable<WorkflowSelectionState['seats']>[number] => Boolean(seat));

  return {
    ...legacyWorkflow,
    ...(normalizedDate ? { date: normalizedDate } : {}),
    ...(normalizedSeats.length > 0 ? { seats: normalizedSeats } : {}),
  };
}

function getWorkflowContext(spec: UISpec | null): WorkflowSelectionState {
  if (spec?.state.workflow) {
    return spec.state.workflow;
  }

  const legacyWorkflow = spec?.state.booking as LegacyWorkflowSelectionState | undefined;
  if (!legacyWorkflow) {
    return {};
  }

  return normalizeLegacyWorkflow(legacyWorkflow);
}

function withWorkflowContext<T>(spec: UISpec<T>, workflow: WorkflowSelectionState): UISpec<T> {
  const restState = { ...spec.state };
  delete restState.booking;
  return {
    ...spec,
    state: {
      ...restState,
      workflow,
    },
  };
}

function projectWorkflowForStage(
  stage: Stage,
  workflow: WorkflowSelectionState
): WorkflowSelectionState {
  switch (stage) {
    case 'movie':
      return {};
    case 'theater':
      return { movie: workflow.movie };
    case 'date':
      return {
        movie: workflow.movie,
        theater: workflow.theater,
      };
    case 'time':
      return {
        movie: workflow.movie,
        theater: workflow.theater,
        date: workflow.date,
      };
    case 'seat':
      return {
        movie: workflow.movie,
        theater: workflow.theater,
        date: workflow.date,
        showing: workflow.showing,
      };
    case 'confirm':
      return {
        movie: workflow.movie,
        theater: workflow.theater,
        date: workflow.date,
        showing: workflow.showing,
        seats: workflow.seats,
      };
    default:
      return {};
  }
}

function getStageContextKey(stage: Stage, workflow: WorkflowSelectionState): string {
  switch (stage) {
    case 'movie':
      return 'movie';
    case 'theater':
      return `movie:${workflow.movie?.id ?? ''}`;
    case 'date':
      return `movie:${workflow.movie?.id ?? ''}|theater:${workflow.theater?.id ?? ''}`;
    case 'time':
      return `movie:${workflow.movie?.id ?? ''}|theater:${workflow.theater?.id ?? ''}|date:${getWorkflowDateValue(workflow) ?? ''}`;
    case 'seat':
      return `movie:${workflow.movie?.id ?? ''}|theater:${workflow.theater?.id ?? ''}|date:${getWorkflowDateValue(workflow) ?? ''}|showing:${workflow.showing?.id ?? ''}`;
    case 'confirm':
      return `movie:${workflow.movie?.id ?? ''}|theater:${workflow.theater?.id ?? ''}|date:${getWorkflowDateValue(workflow) ?? ''}|showing:${workflow.showing?.id ?? ''}|seats:${(workflow.seats ?? []).map((seat) => seat.id).join(',')}`;
    default:
      return '';
  }
}

/**
 * Turn a quick-demo card's ids into the workflow selections the stage it lands
 * on expects.
 *
 * Built through the SAME generators `loadStageData` uses, rather than by hand.
 * A workflow selection is literally a spec item — `handleNext` stores whatever
 * `resolveSelectedItemFromSpec` returned — so going through the generators is
 * what makes a landed selection indistinguishable from a clicked one, down to
 * the fields the agent reads off the snapshot.
 *
 * Throws, with the offending id named, when the world no longer contains
 * something the card asked for. That is the intended behaviour: the Detroit
 * world is generated, a reseed changes every showing id, and a card that
 * silently landed with `showing: undefined` would put the visitor on a seat map
 * belonging to nothing.
 */
async function resolveQuickStartWorkflow(
  card: QuickDemoCard,
  clock: { todayIso?: string; dateWindowDays: number }
): Promise<WorkflowSelectionState> {
  const { movieId, theaterId, date, showingId } = card.prefill;
  if (!movieId) return {};

  const movieData = await api.getMovies();
  const movie = generateMovieSpec(movieData.movies).items.find((item) => item.id === movieId);
  if (!movie) throw new Error(`This card asks for a movie the listings no longer have (${movieId}).`);
  if (!theaterId) return { movie, seats: [] };

  const theaterData = await api.getTheatersByMovie(movie.id);
  const theater = generateTheaterSpec(theaterData.theaters, movie.id).items.find(
    (item) => item.id === theaterId
  );
  if (!theater) {
    throw new Error(`This card asks for a cinema that no longer shows that film (${theaterId}).`);
  }
  if (!date) return { movie, theater, seats: [] };

  const dateData = await api.getDates(movie.id, theater.id);
  const dateItem = createDateItems(
    resolveScenarioToday(clock.todayIso),
    clock.dateWindowDays,
    dateData.dates
  ).find((item) => item.id === date);
  if (!dateItem || !dateItem.available) {
    throw new Error(`This card asks for a date that is no longer on the calendar (${date}).`);
  }
  if (!showingId) return { movie, theater, date: dateItem, seats: [] };

  const timeData = await api.getTimes(movie.id, theater.id, dateItem.date);
  const showing = generateTimeSpec(
    timeData.showings,
    movie.id,
    theater.id,
    dateItem.date
  ).items.find((item) => item.id === showingId);
  if (!showing) {
    throw new Error(`This card asks for a showtime that is no longer scheduled (${showingId}).`);
  }
  return { movie, theater, date: dateItem, showing, seats: [] };
}

function getLatestStageSnapshot(stage: Stage): UISpec | null {
  const { stageSnapshots } = useChatStore.getState();
  return stageSnapshots[stage] ?? null;
}

function findItemById<T extends DataItem>(items: T[], itemId: string | undefined): T | null {
  if (!itemId) return null;
  return items.find((item) => item.id === itemId) ?? null;
}

function resolveSelectedItemFromSpec<T extends DataItem>(spec: UISpec<T>): T | null {
  const selectedId = spec.state.selected?.id;
  return findItemById(spec.items, selectedId);
}

function resolveSelectedItemsFromSpec<T extends DataItem>(spec: UISpec<T>): T[] {
  const selectedIds = new Set((spec.state.selectedList ?? []).map((item) => item.id));
  if (selectedIds.size === 0) return [];
  return spec.items.filter((item) => selectedIds.has(item.id));
}

function isBookingCompleteSpec(spec: UISpec | null): boolean {
  return spec?.stage === 'confirm' && isBookingCompleteMeta(spec.meta);
}

function getWorkflowDateValue(workflow: WorkflowSelectionState): string | null {
  return workflow.date?.date ?? workflow.date?.id ?? null;
}

function getWorkflowSeatLabel(seat: NonNullable<WorkflowSelectionState['seats']>[number]): string {
  const label = typeof seat.label === 'string' ? seat.label.trim() : '';
  return label || seat.id;
}

function setSelectionRestoredFlag<T extends UISpec>(
  spec: T,
  selectionRestored: boolean
): T {
  const meta = spec.meta ?? {};
  const current = meta[RESTORED_SELECTION_META_KEY] === true;
  if (current === selectionRestored) return spec;

  if (selectionRestored) {
    return {
      ...spec,
      meta: {
        ...meta,
        [RESTORED_SELECTION_META_KEY]: true,
      },
    };
  }

  const nextMeta = { ...meta };
  delete nextMeta[RESTORED_SELECTION_META_KEY];
  return {
    ...spec,
    meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
  };
}

function restoreStageSnapshot<T extends DataItem>(
  baseSpec: UISpec<T>,
  stage: Stage,
  workflow: WorkflowSelectionState,
  snapshot: UISpec | null
): UISpec<T> {
  let spec = withWorkflowContext(baseSpec, workflow);

  if (!snapshot || snapshot.stage !== stage) {
    return spec;
  }

  const snapshotWorkflow = getWorkflowContext(snapshot);
  if (getStageContextKey(stage, snapshotWorkflow) !== getStageContextKey(stage, workflow)) {
    return spec;
  }

  spec = refreshVisibleItems({
    ...spec,
    modification: snapshot.modification,
  });

  const selectedIds = snapshot.state.selectedList?.map((item) => item.id) ?? [];
  if (selectedIds.length > 0) {
    return setSelectionRestoredFlag(selectItems(spec, selectedIds), true);
  }

  const selectedId = snapshot.state.selected?.id;
  if (selectedId) {
    return setSelectionRestoredFlag(selectItem(spec, selectedId), true);
  }

  return spec;
}

export function ChatPage({
  studyModePreset,
  studySession,
  preferenceProfile = null,
  companionToken = null,
  voiceTargetPreference = 'kiosk',
  quickStartCard = null,
  startWithVoice = false,
}: ChatPageProps) {
  const navigate = useNavigate();

  const messages = useChatStore((s) => s.messages);
  const currentStage = useChatStore((s) => s.currentStage);
  const activeSpec = useChatStore((s) => s.activeSpec);
  const addSystemMessage = useChatStore((s) => s.addSystemMessage);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const addAgentMessage = useChatStore((s) => s.addAgentMessage);
  const annotateLastAgentMessage = useChatStore((s) => s.annotateLastAgentMessage);
  const messageSnapshots = useChatStore((s) => s.messageSnapshots);
  const updateActiveSpec = useChatStore((s) => s.updateActiveSpec);
  const transformSpecs = useChatStore((s) => s.transformSpecs);
  // Memoised so it is not a fresh object on every render: it feeds the bridge's
  // latestRef, and a new identity each pass would churn the snapshot payload.
  /*
    The profile this session is running with.

    Seeded from the setup screen's choice and then owned here, because the
    second screen can load a different preset mid-session and that has to
    survive a later reset — the agent re-seeds from whatever the next snapshot
    carries, so the snapshot has to carry the CURRENT one, not the original.
  */
  const [sessionProfile, setSessionProfile] = useState<PreferenceProfile | null>(
    preferenceProfile
  );
  const preferenceProfilePayload = useMemo(
    () => toPreferenceProfilePayload(sessionProfile),
    [sessionProfile]
  );
  const resetChat = useChatStore((s) => s.reset);

  const { setBackendData, setUiSpec, onToolApply } = useDevTools();

  const [movies, setMovies] = useState<Movie[]>([]);
  const [theaters, setTheaters] = useState<Theater[]>([]);
  const [showings, setShowings] = useState<Showing[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [viewMode] = useState<ViewMode>('chat');
  const [agentBridgeEnabled, setAgentBridgeEnabled] = useState<boolean>(() =>
    readStoredBoolean(AGENT_BRIDGE_ENABLED_STORAGE_KEY, false)
  );
  const [plannerCpMemoryLimit, setPlannerCpMemoryLimit] = useState<number>(() =>
    readStoredNonNegativeInt(PLANNER_CP_MEMORY_LIMIT_STORAGE_KEY, 10)
  );
  const [guiAdaptationEnabled, setGuiAdaptationEnabled] = useState<boolean>(() =>
    readStoredBoolean(GUI_ADAPTATION_ENABLED_STORAGE_KEY, true)
  );
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(startWithVoice);
  /*
    The planner is writing its spoken line for the ear this session, rather than
    writing for a reader and leaving the gate to cut it.

    Computed once because two places need exactly this condition and they must
    not drift: the verbosity default below, and the flag sent to the agent.

    Each clause is load-bearing. Voice, because with voice off `assistantMessage`
    is the only channel there is and shortening it would take information from a
    text-condition participant. Demo, because a study session's prompt must stay
    byte-identical — `npm run check:planner-prompt` pins it. Not a quick card,
    because a card asks for the opposite and `buildSystemPrompt` drops this
    anyway.
  */
  const plannerWritesForTheEar =
    voiceModeEnabled &&
    !quickStartCard &&
    normalizeStudyMode(studyModePreset) === DEMO_STUDY_MODE;
  const [voiceGateStats, setVoiceGateStats] = useState({ silenced: 0, shortened: 0 });
  /** Verbatim text of what was actually spoken, for the repeat rules. */
  const recentSpokenRef = useRef<string[]>([]);
  /** Agent utterances since the participant last said or did anything. */
  const consecutiveAgentUtterancesRef = useRef(0);
  const [carouselOffset, setCarouselOffset] = useState(0);
  const [carouselOpacity, setCarouselOpacity] = useState(1);
  const [chatWidthPx, setChatWidthPx] = useState(DEFAULT_CHAT_WIDTH_PX);
  const [isResizingChatWidth, setIsResizingChatWidth] = useState(false);
  const [scenarioPanelWidthPx, setScenarioPanelWidthPx] = useState(() =>
    readStoredNonNegativeInt(
      SCENARIO_PANEL_WIDTH_STORAGE_KEY,
      DEFAULT_SCENARIO_PANEL_WIDTH_PX
    )
  );
  // Open by default on a desktop, where it is a column beside the booking UI;
  // closed on a phone, where it is a sheet on top of it and would otherwise be
  // the first thing a visitor sees.
  const [scenarioBriefingVisible, setScenarioBriefingVisible] = useState<boolean>(() =>
    readStoredBoolean(SCENARIO_BRIEFING_VISIBLE_STORAGE_KEY, !isCompactViewport())
  );
  const [isResizingScenarioPanelWidth, setIsResizingScenarioPanelWidth] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(
    () => readStorageValue(HEADER_COLLAPSED_STORAGE_KEY) === 'true'
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [awaitingAgentResponse, setAwaitingAgentResponse] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [downloadingTrace, setDownloadingTrace] = useState(false);

  const initialized = useRef(false);
  const appliedStudyModePresetRef = useRef<StudyModeId | null>(null);
  const previousStageRef = useRef<Stage>(currentStage);
  const seenPreferenceMentionsRef = useRef<Map<string, string>>(new Map());
  const interactionScopeRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const chatResizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const scenarioPanelResizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(
    null
  );
  const agentStatusSupportedRef = useRef(false);
  const studyModeConfig = useMemo(
    () => (studyModePreset ? getStudyModeConfig(studyModePreset) : null),
    [studyModePreset]
  );
  const normalizedStudyModePreset = studyModePreset ? normalizeStudyMode(studyModePreset) : null;
  const isAgentInteractionEnabled = studyModeConfig?.agentEnabled ?? agentBridgeEnabled;
  const showBasicTuningTurnSnapshots =
    normalizedStudyModePreset === 'basic-tuning-voice-off' ||
    normalizedStudyModePreset === 'basic-tuning-voice-on';
  const usesSplitInterface =
    normalizedStudyModePreset === 'full-tuning-voice-off' ||
    normalizedStudyModePreset === 'full-tuning-voice-on' ||
    // Demo mirrors the Interface B (full tuning) experience.
    normalizedStudyModePreset === 'demo';
  // Preference memory and workflow navigation are surfaced in the demo only.
  // Study conditions C1-C4 must keep the interface the paper describes.
  const showMemoryPanel = normalizedStudyModePreset === 'demo';
  // The memory panel as a full-screen sheet, which is its form below `lg`.
  // Declared here rather than with the other side-panel derivations because the
  // effect that makes the header inert behind it sits above them.
  const memorySheetOpen = showMemoryPanel && scenarioBriefingVisible;
  const voiceModeAvailable = studyModeConfig?.voiceModeAvailable ?? false;

  const scenarioTitle = studySession?.scenario.title
    ? formatScenarioTitle(studySession.scenario.title)
    : 'Scenario';
  const scenarioBackground = studySession?.scenario.background ?? '';
  const scenarioStory = studySession?.scenario.story ?? '';
  const scenarioStepBriefs = studySession?.scenario.stepBriefs ?? {};
  const scenarioPreferenceTypes = studySession?.scenario.narratorPreferenceTypes ?? [];
  const scenarioSeatRows = studySession?.scenario.seatRows ?? [];
  const { language, s: ui } = useLanguage();
  const createRealtimeVoiceSessionForLanguage = useCallback(
    (sessionLanguage: string) => api.createRealtimeVoiceSession(sessionLanguage),
    []
  );
  const scenarioTodayIso = studySession?.scenario.todayIso;
  const scenarioDateWindowDays = studySession?.scenario.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  const {
    logEvent: logStudyEvent,
    logEventNow: logStudyEventNow,
    setStageTransitionIntent,
  } = useStudyInteractionLogger({
    studySession,
    messages,
    activeSpec,
    booking,
    error,
  });

  const {
    settings: voiceVerbosity,
    handlePresetChange: handleVerbosityPresetChange,
    handleCategoryChange: handleVerbosityCategoryChange,
    handleSmartSkipChange: handleVerbositySmartSkipChange,
  } = useVoiceVerbositySettings({
    /*
      A quick card is loud by default; everything else keeps its own default.

      Still a fallback and not an override, so a value the visitor stored wins —
      which is the right precedence even at a booth, because a quick card runs
      on the visitor's OWN phone. Storage is empty for all but the person who
      scanned two cards in a row and turned the volume down between them, and
      that person meant it.
    */
    fallback: quickStartCard
      ? QUICK_CARD_VOICE_VERBOSITY
      : defaultVerbosityFor(
          normalizeStudyMode(studyModePreset) === DEMO_STUDY_MODE,
          plannerWritesForTheEar
        ),
    onChange: (_next, detail) => logStudyEvent('chat.voice_verbosity.changed', detail),
  });
  /** Latest settings, for effects that must not re-run when they change. */
  const voiceVerbosityRef = useRef(voiceVerbosity);
  // Demo only: in a study condition the planner model is part of the condition.
  const plannerModelAvailable = normalizeStudyMode(studyModePreset) === DEMO_STUDY_MODE;
  /** Per-model planner latency over this session's messages, for the settings sheet. */
  const plannerTurnStats = useMemo(() => {
    const byModel = new Map<string, { turns: number; totalMs: number; lastMs: number }>();
    for (const message of messages) {
      if (message.type !== 'agent' || !message.timing) continue;
      const entry = byModel.get(message.timing.model) ?? { turns: 0, totalMs: 0, lastMs: 0 };
      entry.turns += 1;
      entry.totalMs += message.timing.plannerMs;
      entry.lastMs = message.timing.plannerMs;
      byModel.set(message.timing.model, entry);
    }
    return [...byModel.entries()].map(([model, entry]) => ({
      model,
      turns: entry.turns,
      avgMs: entry.totalMs / entry.turns,
      lastMs: entry.lastMs,
    }));
  }, [messages]);
  const plannerModelSetting = usePlannerModelSetting({
    onChange: (_model, detail) => logStudyEvent('chat.planner_model.changed', detail),
  });

  const logDerivedEvents = useCallback(
    (events: DerivedLogEvent[]) => {
      for (const event of events) {
        logStudyEvent(event.type, event.payload);
      }
    },
    [logStudyEvent]
  );

  const logGuiAction = useCallback(
    (
      action: string,
      options?: {
        source?: InteractionLogSource;
        stage?: Stage;
        itemId?: string;
        itemIds?: string[];
        extra?: Record<string, unknown>;
      }
    ) => {
      logStudyEvent('user.gui_action', {
        action,
        source: options?.source ?? 'participant',
        ...(options?.stage ? { stage: options.stage } : {}),
        ...(options?.itemId ? { itemId: options.itemId } : {}),
        ...(options?.itemIds?.length ? { itemIds: options.itemIds } : {}),
        ...(options?.extra ?? {}),
      });
    },
    [logStudyEvent]
  );

  /**
   * The participant reached past a filter to see what it was hiding.
   *
   * Selecting one of those items was already logged (reason
   * 'selected-filtered-out-item'); this records the look itself, which happens
   * first and more often. Together they say how far a stated preference sits
   * from the one the participant is actually shopping with — the reason the
   * agent narrowed the screen may simply have been wrong.
   */
  const handleRevealHidden = useCallback(
    (revealed: boolean, hiddenCount: number) => {
      logGuiAction(revealed ? 'reveal_filtered' : 'hide_filtered', {
        stage: currentStage,
        extra: { hiddenCount },
      });
    },
    [logGuiAction, currentStage]
  );

  const getMaxChatWidth = useCallback(() => {
    if (typeof window === 'undefined') return DEFAULT_CHAT_WIDTH_PX;
    return Math.max(
      MIN_CHAT_WIDTH_PX,
      window.innerWidth - CHAT_WIDTH_VIEWPORT_PADDING_PX
    );
  }, []);

  const clampChatWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, MIN_CHAT_WIDTH_PX), getMaxChatWidth()),
    [getMaxChatWidth]
  );

  const getMaxScenarioPanelWidth = useCallback(() => {
    if (typeof window === 'undefined') return DEFAULT_SCENARIO_PANEL_WIDTH_PX;
    return Math.max(
      MIN_SCENARIO_PANEL_WIDTH_PX,
      Math.min(
        MAX_SCENARIO_PANEL_WIDTH_PX,
        window.innerWidth - MIN_MAIN_CONTENT_WIDTH_PX
      )
    );
  }, []);

  const clampScenarioPanelWidth = useCallback(
    (width: number) =>
      Math.min(
        Math.max(width, MIN_SCENARIO_PANEL_WIDTH_PX),
        getMaxScenarioPanelWidth()
      ),
    [getMaxScenarioPanelWidth]
  );

  const stopChatWidthResize = useCallback(() => {
    chatResizeSessionRef.current = null;
    setIsResizingChatWidth(false);
    if (typeof document !== 'undefined') {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  const handleChatWidthResizeMove = useCallback(
    (event: PointerEvent) => {
      const session = chatResizeSessionRef.current;
      if (!session) return;
      const nextWidth = session.startWidth + (event.clientX - session.startX);
      setChatWidthPx(clampChatWidth(nextWidth));
    },
    [clampChatWidth]
  );

  const handleChatWidthResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      chatResizeSessionRef.current = {
        startX: event.clientX,
        startWidth: chatWidthPx,
      };
      setIsResizingChatWidth(true);
      if (typeof document !== 'undefined') {
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }
    },
    [chatWidthPx]
  );

  const stopScenarioPanelWidthResize = useCallback(() => {
    scenarioPanelResizeSessionRef.current = null;
    setIsResizingScenarioPanelWidth(false);
  }, []);

  const handleScenarioPanelWidthResizeMove = useCallback(
    (event: PointerEvent) => {
      const session = scenarioPanelResizeSessionRef.current;
      if (!session) return;
      const nextWidth = session.startWidth + (event.clientX - session.startX);
      setScenarioPanelWidthPx(clampScenarioPanelWidth(nextWidth));
    },
    [clampScenarioPanelWidth]
  );

  const handleScenarioPanelWidthResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      scenarioPanelResizeSessionRef.current = {
        startX: event.clientX,
        startWidth: scenarioPanelWidthPx,
      };
      setIsResizingScenarioPanelWidth(true);
    },
    [scenarioPanelWidthPx]
  );

  const loadStageData = useCallback(
    async (stage: typeof currentStage, ctx: StageContext = {}) => {
      setLoading(true);
      setError(null);

      const workflowCtx = ctx.workflow ?? getWorkflowContext(activeSpec);
      const shouldRestoreSnapshot = ctx.restoreSnapshot !== false;
      const buildStageSpec = <T extends DataItem>(
        nextStage: Stage,
        baseSpec: UISpec<T>,
        workflow: WorkflowSelectionState
      ) =>
        restoreStageSnapshot(
          baseSpec,
          nextStage,
          workflow,
          shouldRestoreSnapshot ? getLatestStageSnapshot(nextStage) : null
        );

      try {
        switch (stage) {
          case 'movie': {
            const data = await api.getMovies();
            setMovies(data.movies);
            setBackendData({ movies: data.movies });
            const spec = buildStageSpec('movie', generateMovieSpec(data.movies), {});
            addSystemMessage('movie', spec);
            setUiSpec(spec);
            break;
          }

          case 'theater': {
            if (!workflowCtx.movie) {
              setError('No movie selected');
              return;
            }
            const data = await api.getTheatersByMovie(workflowCtx.movie.id);
            setTheaters(data.theaters);
            setBackendData({ theaters: data.theaters });
            const spec = buildStageSpec(
              'theater',
              generateTheaterSpec(data.theaters, workflowCtx.movie.id),
              workflowCtx
            );
            addSystemMessage('theater', spec);
            setUiSpec(spec);
            break;
          }

          case 'date': {
            if (!workflowCtx.movie || !workflowCtx.theater) {
              setError('Missing movie or theater');
              return;
            }
            const data = await api.getDates(workflowCtx.movie.id, workflowCtx.theater.id);
            setBackendData({ dates: data.dates });
            const scenarioToday = resolveScenarioToday(scenarioTodayIso);
            const dateItems = createDateItems(scenarioToday, scenarioDateWindowDays, data.dates);
            const spec = buildStageSpec(
              'date',
              generateDateSpec(
                dateItems,
                workflowCtx.movie.id,
                workflowCtx.theater.id,
                formatLocalDate(scenarioToday)
              ),
              workflowCtx
            );
            addSystemMessage('date', spec);
            setUiSpec(spec);
            break;
          }

          case 'time': {
            if (!workflowCtx.movie || !workflowCtx.theater || !workflowCtx.date) {
              setError('Missing movie, theater, or date');
              return;
            }
            const workflowDate = getWorkflowDateValue(workflowCtx);
            if (!workflowDate) {
              setError('Missing date');
              return;
            }
            const data = await api.getTimes(
              workflowCtx.movie.id,
              workflowCtx.theater.id,
              workflowDate
            );
            setShowings(data.showings);
            setBackendData({ showings: data.showings });
            const spec = buildStageSpec(
              'time',
              generateTimeSpec(
                data.showings,
                workflowCtx.movie.id,
                workflowCtx.theater.id,
                workflowDate
              ),
              workflowCtx
            );
            addSystemMessage('time', spec);
            setUiSpec(spec);
            break;
          }

          case 'seat': {
            if (
              !workflowCtx.showing ||
              !workflowCtx.movie ||
              !workflowCtx.theater ||
              !workflowCtx.date
            ) {
              setError('Missing showing information');
              return;
            }
            const data = await api.getSeats(workflowCtx.showing.id);
            setBackendData({ seats: data.seats });
            const spec = buildStageSpec('seat', generateSeatSpec(data.seats), workflowCtx);
            addSystemMessage('seat', spec);
            setUiSpec(spec);
            break;
          }

          case 'confirm': {
            if (
              !workflowCtx.movie ||
              !workflowCtx.theater ||
              !workflowCtx.date ||
              !workflowCtx.showing
            ) {
              setError('Missing booking information');
              return;
            }

            const selectedSeats = workflowCtx.seats ?? [];
            if (selectedSeats.length === 0) {
              setError('Missing seats');
              return;
            }
            const seatData = await api.getSeats(workflowCtx.showing.id);
            const selectedSeatSet = new Set(selectedSeats.map((seat) => seat.id));
            const totalPrice = seatData.seats
              .filter((seat) => selectedSeatSet.has(seat.id))
              .reduce((sum, seat) => sum + seat.price, 0);

            const meta: ConfirmMeta = {
              movie: workflowCtx.movie,
              theater: workflowCtx.theater,
              date: getWorkflowDateValue(workflowCtx) ?? '',
              time: workflowCtx.showing.displayTime ?? formatTime12Hour(workflowCtx.showing.time),
              seats: selectedSeats.map(getWorkflowSeatLabel),
              totalPrice,
            };

            const spec = buildStageSpec('confirm', generateConfirmSpec(meta), workflowCtx);
            addSystemMessage('confirm', spec);
            setUiSpec(spec);
            break;
          }
        }
      } catch (err) {
        setAwaitingAgentResponse(false);
        setError(err instanceof Error ? err.message : ui.failedToLoadData);
      } finally {
        setLoading(false);
      }
    },
    [
      activeSpec,
      addSystemMessage,
      scenarioDateWindowDays,
      scenarioTodayIso,
      setBackendData,
      setUiSpec,
    ]
  );

  /*
    The one bootstrap, and the only place a session decides where it opens.

    No cancellation flag, deliberately. StrictMode unmounts and remounts this
    component while keeping its refs, so `initialized` stays true across the
    second pass and a cleanup that set `cancelled` would discard the ONE
    resolution that ever runs — leaving a card that loads forever. Nothing here
    needs cancelling instead: the ref already guarantees a single in-flight
    resolve, and its only effects are this page's own stage and error slots.
  */
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    if (!quickStartCard) {
      loadStageData('movie', { workflow: {}, restoreSnapshot: false });
      return;
    }

    setLoading(true);
    resolveQuickStartWorkflow(quickStartCard, {
      todayIso: scenarioTodayIso,
      dateWindowDays: scenarioDateWindowDays,
    })
      .then((workflow) =>
        loadStageData(quickStartCard.stage, { workflow, restoreSnapshot: false })
      )
      .catch((err) => {
        setLoading(false);
        setError(err instanceof Error ? err.message : ui.failedToLoadData);
      });
  }, [
    loadStageData,
    quickStartCard,
    scenarioDateWindowDays,
    scenarioTodayIso,
    ui.failedToLoadData,
  ]);

  useEffect(() => {
    if (studyModeConfig) return;
    api.getGuiAdaptationConfig().then((res) => setGuiAdaptationEnabled(res.enabled)).catch(() => {});
  }, [studyModeConfig]);

  useEffect(() => {
    writeStorageValue(AGENT_BRIDGE_ENABLED_STORAGE_KEY, String(agentBridgeEnabled));
  }, [agentBridgeEnabled]);

  useEffect(() => {
    writeStorageValue(PLANNER_CP_MEMORY_LIMIT_STORAGE_KEY, String(plannerCpMemoryLimit));
  }, [plannerCpMemoryLimit]);

  useEffect(() => {
    writeStorageValue(GUI_ADAPTATION_ENABLED_STORAGE_KEY, String(guiAdaptationEnabled));
  }, [guiAdaptationEnabled]);

  useEffect(() => {
    writeStorageValue(SCENARIO_PANEL_WIDTH_STORAGE_KEY, String(scenarioPanelWidthPx));
  }, [scenarioPanelWidthPx]);

  useEffect(() => {
    writeStorageValue(HEADER_COLLAPSED_STORAGE_KEY, String(headerCollapsed));
  }, [headerCollapsed]);

  useEffect(() => {
    writeStorageValue(
      SCENARIO_BRIEFING_VISIBLE_STORAGE_KEY,
      String(scenarioBriefingVisible)
    );
  }, [scenarioBriefingVisible]);

  const handleVoiceModeToggle = useCallback(() => {
    if (!voiceModeAvailable || isBookingCompleteSpec(activeSpec)) return;
    setVoiceModeEnabled((current) => {
      const nextEnabled = !current;
      logStudyEvent('chat.voice_mode.toggled', {
        enabled: nextEnabled,
      });
      return nextEnabled;
    });
  }, [activeSpec, logStudyEvent, voiceModeAvailable]);

  const handleScenarioBriefingToggle = useCallback(() => {
    setScenarioBriefingVisible((current) => {
      const nextVisible = !current;
      logStudyEvent('user.gui_action', {
        action: nextVisible ? 'showScenarioBriefing' : 'hideScenarioBriefing',
        source: 'participant',
        location: 'booking-header',
      });
      return nextVisible;
    });
  }, [logStudyEvent]);

  useEffect(() => {
    const handleWindowResize = () => {
      setChatWidthPx((current) => clampChatWidth(current));
      setScenarioPanelWidthPx((current) => clampScenarioPanelWidth(current));
    };
    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [clampChatWidth, clampScenarioPanelWidth]);

  useEffect(() => {
    if (!isResizingChatWidth) return;
    const handlePointerUp = () => {
      stopChatWidthResize();
    };
    window.addEventListener('pointermove', handleChatWidthResizeMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handleChatWidthResizeMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isResizingChatWidth, handleChatWidthResizeMove, stopChatWidthResize]);

  useEffect(() => {
    if (!isResizingScenarioPanelWidth) return;
    const handlePointerUp = () => {
      stopScenarioPanelWidthResize();
    };
    window.addEventListener('pointermove', handleScenarioPanelWidthResizeMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handleScenarioPanelWidthResizeMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    isResizingScenarioPanelWidth,
    handleScenarioPanelWidthResizeMove,
    stopScenarioPanelWidthResize,
  ]);

  useEffect(
    () => () => {
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    },
    []
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (!activeSpec) return;
      // The participant can reach a filtered-out item through "Show all".
      // Choosing one is an explicit request for an option the agent's filter
      // hid, so drop the filter rather than selecting something that is not
      // visible — previously this was the dead end that left 495 stage states
      // showing one option or none with no way back but a full session reset.
      const isHidden = !activeSpec.visibleItems.some((item) => item.id === id);
      const baseSpec = isHidden ? clearModification(activeSpec, 'filter') : activeSpec;
      if (isHidden) {
        logGuiAction('clearFilter', {
          source: 'participant',
          stage: activeSpec.stage,
          itemId: id,
          extra: { reason: 'selected-filtered-out-item' },
        });
      }
      logGuiAction('select', {
        source: 'participant',
        stage: activeSpec.stage,
        itemId: id,
      });
      // Clicking an option is the participant taking a turn, but it adds no
      // user message until the stage is committed, so the monologue cap has to
      // be reset here as well as by the user-message effect.
      consecutiveAgentUtterancesRef.current = 0;
      logStudyEvent('chat.selection.changed', {
        stage: activeSpec.stage,
        interaction: 'select',
        itemId: id,
        ...(isHidden ? { clearedFilter: true } : {}),
      });
      const newSpec = setSelectionRestoredFlag(selectItem(baseSpec, id), false);
      updateActiveSpec(newSpec);
      setUiSpec(newSpec);
    },
    [activeSpec, logGuiAction, logStudyEvent, updateActiveSpec, setUiSpec]
  );

  const handleToggle = useCallback(
    (id: string) => {
      if (!activeSpec) return;
      logGuiAction('toggle', {
        source: 'participant',
        stage: activeSpec.stage,
        itemId: id,
      });
      consecutiveAgentUtterancesRef.current = 0;
      logStudyEvent('chat.selection.changed', {
        stage: activeSpec.stage,
        interaction: 'toggle',
        itemId: id,
      });
      const newSpec = setSelectionRestoredFlag(toggleItem(activeSpec, id), false);
      updateActiveSpec(newSpec);
      setUiSpec(newSpec);
    },
    [activeSpec, logGuiAction, logStudyEvent, updateActiveSpec, setUiSpec]
  );

  const handleConfirm = useCallback(async (context?: ToolApplyContext) => {
    if (!activeSpec) return;
    const workflowCtx = getWorkflowContext(activeSpec);
    const selectedSeats = workflowCtx.seats ?? [];
    const actionSource: InteractionLogSource =
      context?.source === 'devtools' ? 'devtools' : context?.source === 'agent' ? 'agent' : 'participant';
    logGuiAction('confirm', {
      source: actionSource,
      stage: activeSpec.stage,
      itemIds: selectedSeats.map((seat) => seat.id),
      extra: {
        showingId: workflowCtx.showing?.id ?? null,
      },
    });
    logStudyEvent('workflow.selection.committed', {
      stage: activeSpec.stage,
      source: actionSource,
      itemIds: selectedSeats.map((seat) => seat.id),
      showingId: workflowCtx.showing?.id ?? null,
      movieId: workflowCtx.movie?.id ?? null,
      theaterId: workflowCtx.theater?.id ?? null,
      dateId: workflowCtx.date?.id ?? null,
    });

    if (!workflowCtx.showing || selectedSeats.length === 0) {
      setError('Missing booking information');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.createBooking({
        showingId: workflowCtx.showing.id,
        seats: selectedSeats.map((seat) => seat.id),
        customerName: 'Guest',
        customerEmail: 'guest@example.com',
      });

      setBooking(result.booking);
      if (!context) {
        addUserMessage('confirm', 'select', 'Booking Confirmed!', activeSpec);
      }
      const confirmMeta = activeSpec.meta as ConfirmMeta | undefined;
      if (confirmMeta) {
        const completionSpec = withWorkflowContext(
          generateBookingCompleteSpec({
            ...confirmMeta,
            status: 'completed',
            bookingId: result.booking.id,
          }),
          workflowCtx
        );
        addSystemMessage('confirm', completionSpec);
        setUiSpec(completionSpec);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : ui.bookingFailed);
    } finally {
      setLoading(false);
    }
  }, [activeSpec, addSystemMessage, addUserMessage, logGuiAction, logStudyEvent, setUiSpec]);

  const handleNext = useCallback(async (context?: ToolApplyContext, specOverride?: UISpec | null) => {
    const spec = specOverride ?? activeSpec;
    if (!spec) return;

    const stage = spec.stage ?? currentStage;
    const actionSource: InteractionLogSource =
      context?.source === 'devtools' ? 'devtools' : context?.source === 'agent' ? 'agent' : 'participant';
    let selectionLabel = '';
    let selectedItemId: string | undefined;
    let selectedItemIds: string[] | undefined;
    const currentWorkflow = getWorkflowContext(spec);
    let nextWorkflow: WorkflowSelectionState = currentWorkflow;

    switch (stage) {
      case 'movie': {
        const selectedMovie = resolveSelectedItemFromSpec(spec) as WorkflowSelectionState['movie'] | null;
        if (!selectedMovie) return;

        selectionLabel = selectedMovie.title;
        selectedItemId = selectedMovie.id;
        nextWorkflow = {
          movie: selectedMovie,
          seats: [],
        };
        break;
      }

      case 'theater': {
        const selectedTheater = resolveSelectedItemFromSpec(spec) as WorkflowSelectionState['theater'] | null;
        if (!selectedTheater) return;

        selectionLabel = selectedTheater.name;
        selectedItemId = selectedTheater.id;
        nextWorkflow = {
          ...currentWorkflow,
          theater: selectedTheater,
          date: undefined,
          showing: undefined,
          seats: [],
        };
        break;
      }

      case 'date': {
        const selectedDate = resolveSelectedItemFromSpec(spec) as WorkflowSelectionState['date'] | null;
        if (!selectedDate) return;

        selectionLabel =
          typeof selectedDate.displayText === 'string' && selectedDate.displayText.trim()
            ? selectedDate.displayText
            : selectedDate.date;
        selectedItemId = selectedDate.id;
        nextWorkflow = {
          ...currentWorkflow,
          date: selectedDate,
          showing: undefined,
          seats: [],
        };
        break;
      }

      case 'time': {
        const selectedShowing = resolveSelectedItemFromSpec(spec) as WorkflowSelectionState['showing'] | null;
        if (!selectedShowing) return;

        selectionLabel =
          spec.state.selected?.value ??
          selectedShowing.displayTime ??
          formatTime12Hour(selectedShowing.time);
        selectedItemId = selectedShowing.id;
        nextWorkflow = {
          ...currentWorkflow,
          showing: selectedShowing,
          seats: [],
        };
        break;
      }

      case 'seat': {
        const selectedSeats = resolveSelectedItemsFromSpec(spec) as NonNullable<
          WorkflowSelectionState['seats']
        >;
        if (selectedSeats.length === 0) return;

        selectionLabel = `${selectedSeats.length} seat(s) selected`;
        selectedItemIds = selectedSeats.map((seat) => seat.id);
        nextWorkflow = {
          ...currentWorkflow,
          seats: selectedSeats,
        };
        break;
      }

      case 'confirm': {
        await handleConfirm(context);
        return;
      }
    }

    const transitionReason =
      typeof context?.reason === 'string' && context.reason.trim()
        ? context.reason.trim()
        : 'Move to the next stage because the current stage is ready.';

    logGuiAction('next', {
      source: actionSource,
      stage,
      itemId: selectedItemId,
      itemIds: selectedItemIds,
      extra: {
        selectionLabel,
      },
    });
    logStudyEvent('workflow.selection.committed', {
      stage,
      source: actionSource,
      ...(selectedItemId ? { itemId: selectedItemId } : {}),
      ...(selectedItemIds?.length ? { itemIds: selectedItemIds } : {}),
      selectionLabel,
    });

    if (!context) {
      addUserMessage(stage, 'select', selectionLabel, spec);
    }

    const nextStage = getNextStage(stage);
    if (nextStage) {
      setStageTransitionIntent({
        action: 'next',
        source: actionSource,
        reason: transitionReason,
        triggerStage: stage,
        itemId: selectedItemId,
        itemIds: selectedItemIds,
      });
      if (context) {
        annotateLastAgentMessage(stage, {
          toolName: 'next',
          source: context?.source === 'devtools' ? 'devtools' : 'agent',
          reason: transitionReason,
        });
      }
      setAwaitingAgentResponse(true);
      loadStageData(nextStage, {
        workflow: projectWorkflowForStage(nextStage, nextWorkflow),
      });
    }
  }, [
    activeSpec,
    currentStage,
    movies,
    theaters,
    showings,
    addUserMessage,
    annotateLastAgentMessage,
    logGuiAction,
    logStudyEvent,
    loadStageData,
    handleConfirm,
    setStageTransitionIntent,
  ]);

  const handleBack = useCallback(async (context?: ToolApplyContext) => {
    if (!activeSpec) return;

    const prevStage = getPrevStage(currentStage);
    if (!prevStage) return;
    const actionSource: InteractionLogSource =
      context?.source === 'devtools' ? 'devtools' : context?.source === 'agent' ? 'agent' : 'participant';

    logGuiAction('back', {
      source: actionSource,
      stage: currentStage,
    });

    if (!context) {
      addUserMessage(currentStage, 'back', 'Back', activeSpec);
    }

    const currentWorkflow = getWorkflowContext(activeSpec);
    const transitionReason =
      typeof context?.reason === 'string' && context.reason.trim()
        ? context.reason.trim()
        : 'Return to the previous stage to update an earlier choice.';
    setStageTransitionIntent({
      action: 'back',
      source: actionSource,
      reason: transitionReason,
      triggerStage: currentStage,
    });
    if (actionSource !== 'participant') {
      logDerivedEvents(
        buildConflictSignalEvents({
          stage: currentStage,
          source: actionSource,
          toolName: 'prev',
          reason: transitionReason,
          targetStage: prevStage,
        })
      );
    }
    if (context) {
      annotateLastAgentMessage(currentStage, {
        toolName: 'prev',
        source: context?.source === 'devtools' ? 'devtools' : 'agent',
        reason: transitionReason,
      });
    }
    setAwaitingAgentResponse(true);
    loadStageData(prevStage, {
      workflow: projectWorkflowForStage(prevStage, currentWorkflow),
    });
  }, [
    activeSpec,
    currentStage,
    addUserMessage,
    annotateLastAgentMessage,
    loadStageData,
    logDerivedEvents,
    logGuiAction,
    setStageTransitionIntent,
  ]);

  const handleSetSpec = useCallback(
    (
      newSpec: typeof activeSpec,
      options?: {
        appendAsSystemMessage?: boolean;
        modificationMeta?: {
          toolName: string;
          reason: string;
          source: 'agent' | 'devtools';
        };
        interactionMeta?: {
          action: string;
          source: 'agent' | 'devtools';
          itemId?: string;
          itemIds?: string[];
        };
      }
    ) => {
      if (!newSpec) return;
      if (options?.interactionMeta) {
        logGuiAction(options.interactionMeta.action, {
          source: options.interactionMeta.source,
          stage: newSpec.stage,
          itemId: options.interactionMeta.itemId,
          itemIds: options.interactionMeta.itemIds,
        });
      }
      if (options?.modificationMeta) {
        logDerivedEvents(
          buildConflictSignalEvents({
            stage: newSpec.stage,
            source: options.modificationMeta.source,
            toolName: options.modificationMeta.toolName,
            reason: options.modificationMeta.reason,
          })
        );
      }
      if (options?.appendAsSystemMessage) {
        addSystemMessage(newSpec.stage, newSpec, options.modificationMeta
          ? {
              kind: 'tool-modification',
              ...options.modificationMeta,
            }
          : undefined);
      } else {
        updateActiveSpec(newSpec);
      }
      setUiSpec(newSpec);
    },
    [addSystemMessage, logDerivedEvents, logGuiAction, updateActiveSpec, setUiSpec]
  );

  const handleSessionReset = useCallback(() => {
    resetChat();
    setBooking(null);
    setError(null);
    setAwaitingAgentResponse(false);
    // Repeat history is per-session; carrying it over would silence the first
    // turns of the next task.
    recentSpokenRef.current = [];
    consecutiveAgentUtterancesRef.current = 0;
    setVoiceGateStats({ silenced: 0, shortened: 0 });
    initialized.current = true;
    if (movies.length > 0) {
      const spec = withWorkflowContext(generateMovieSpec(movies), {});
      addSystemMessage('movie', spec);
      setUiSpec(spec);
      return;
    }
    loadStageData('movie', { workflow: {} });
  }, [resetChat, movies, addSystemMessage, setUiSpec, loadStageData]);

  const agentToolSchema = useMemo(
    () => buildToolSchemaForStage(activeSpec, currentStage, guiAdaptationEnabled),
    [activeSpec, currentStage, guiAdaptationEnabled]
  );

  /*
    Landing a GUI change on the sentence that describes it.

    The agent already sends its narration BEFORE the tool call that changes the
    view (index.ts, "if (action.type !== 'agent.message')"), so the wire order
    is right. What is wrong is the latency either side of it: applying a tool
    takes a millisecond, and starting speech takes a realtime round trip plus
    audio buffering — most of a second. The screen therefore moves, and then
    the explanation arrives.

    On the kiosk that is invisible, because the transcript prints the sentence
    the instant it arrives and the two channels agree. On a phone with the
    conversation collapsed — which is every quick card — audio is the ONLY
    channel, so the visitor watches a list rearrange itself in silence and then
    hears why. They have ninety seconds, and that gap is most of what they take
    away.

    So the host holds the tool call until the audio for that sentence actually
    starts. It costs the turn nothing: the agent waits for playback to COMPLETE
    before it plans again (speechBarrier), so the wait comes out of time it was
    going to spend waiting anyway.

    The rule, the timeout and the ways a hold can end live in `speechGuiSync`;
    what stays here is when to arm it and what counts as "audible".
  */
  const speechSyncRef = useRef<SpeechGuiSync | null>(null);
  if (!speechSyncRef.current) {
    speechSyncRef.current = createSpeechGuiSync({ timeoutMs: AGENT_SPEECH_SYNC_TIMEOUT_MS });
  }

  const releasePendingSpeech = useCallback((reason: string) => {
    speechSyncRef.current?.release(reason);
  }, []);

  /*
    Whether the gate is armed at all. Written from below, where
    `voiceOutputTarget` exists; a ref because `armPendingSpeech` is called from
    the relay's envelope handler rather than from a render.
  */
  const speechSyncEnabledRef = useRef(false);

  const armPendingSpeech = useCallback((messageId: string) => {
    if (!speechSyncEnabledRef.current) return;
    speechSyncRef.current?.arm(messageId);
  }, []);

  const waitForSpeechStart = useCallback(
    () => speechSyncRef.current?.wait() ?? null,
    []
  );

  useEffect(() => () => speechSyncRef.current?.release('unmount'), []);

  const handleAgentToolCall = useCallback(async (
    toolName: string,
    params: Record<string, unknown>,
    context?: ToolApplyContext
  ) => {
    if (!agentStatusSupportedRef.current) {
      setAwaitingAgentResponse(false);
    }
    /*
      `postMessage` is excluded: it changes nothing on screen and is itself a
      speech act, so holding it would delay the very channel this is
      synchronising to. Every other tool moves something the visitor can see.
    */
    if (toolName !== 'postMessage') {
      await waitForSpeechStart();
    }
    return onToolApply(toolName, params, context);
  }, [onToolApply, waitForSpeechStart]);

  // The voice session is declared further down, once the relay state it needs
  // exists. These stable shims let the callbacks above reach it.
  const voiceSpeakRef = useRef<((item: VoiceSpeakItem) => void) | null>(null);
  const voiceStopRef = useRef<(() => void) | null>(null);
  const speakAgentMessage = useCallback((item: VoiceSpeakItem) => {
    voiceSpeakRef.current?.(item);
  }, []);
  /**
   * The one utterance the host speaks on its own account: the question already
   * on screen, read back when voice is switched on. Held so its playback
   * completion can be kept away from the agent's turn barrier.
   */
  const voiceReplayMessageIdRef = useRef<string | null>(null);
  const stopAgentSpeech = useCallback(() => {
    voiceStopRef.current?.();
  }, []);

  /**
   * Where the visitor wants voice: this kiosk's own headset, or a paired phone.
   *
   * A latch, deliberately. It moves only when a person moves it — never in
   * response to the relay noticing or losing the phone. See rule 1 in
   * `useVoiceCompanionHost`. Defaults to the kiosk, so a session that never
   * pairs behaves exactly as it does today.
   */
  const [voiceOutputTarget, setVoiceOutputTarget] = useState<VoiceOutputTarget>('kiosk');

  /*
    Arm the speech/GUI sync only where a change could actually be seen before it
    is heard: a quick card (the one surface with no visible transcript), with
    voice on, and with this device holding the audio. A paired phone reports
    only that playback FINISHED, never that it started, so gating on it would
    always fall through to the timeout — slower, and no better synchronised.
  */
  const speechSyncEnabled =
    Boolean(quickStartCard) &&
    voiceModeEnabled &&
    isAgentInteractionEnabled &&
    voiceOutputTarget !== 'companion';
  useEffect(() => {
    speechSyncEnabledRef.current = speechSyncEnabled;
    // Turning voice off, or handing it to a phone, must not leave the screen
    // held by an utterance that will now never be spoken here.
    if (!speechSyncEnabled) releasePendingSpeech('voice-unavailable');
  }, [speechSyncEnabled, releasePendingSpeech]);

  // Minted once per session in App and passed down. It cannot be fetched here:
  // this page renders the pairing card TWICE at the same time — desktop rail and
  // phone sheet, separated only by a CSS breakpoint, so both really mount — and
  // minting rotates the pairing's revocation handle.

  // Same shim rationale as the voice refs above: the companion host hook needs
  // the bridge's senders, and the bridge needs the hook's handlers.
  const companionTranscriptRef = useRef<
    ((payload: { text: string; durationMs: number }) => void) | null
  >(null);
  const companionPlaybackRef = useRef<
    ((payload: { id: string | null; interrupted: boolean }) => void) | null
  >(null);
  const companionHelloRef = useRef<(() => void) | null>(null);
  const handleCompanionTranscriptEnvelope = useCallback(
    (payload: { text: string; durationMs: number }) => companionTranscriptRef.current?.(payload),
    []
  );
  const handleCompanionPlaybackEnvelope = useCallback(
    (payload: { id: string | null; interrupted: boolean }) => companionPlaybackRef.current?.(payload),
    []
  );
  const handleCompanionHelloEnvelope = useCallback(() => companionHelloRef.current?.(), []);
  const companionClaimRef = useRef<((claimed: boolean) => void) | null>(null);
  const handleCompanionClaimEnvelope = useCallback(
    (claimed: boolean) => companionClaimRef.current?.(claimed),
    []
  );

  /**
   * `sendTtsPlaybackComplete` comes out of `useAgentBridge`, which is declared
   * below — same shim rationale as the voice refs above.
   */
  const ttsCompleteRef = useRef<
    ((info: { interrupted?: boolean; messageId?: string | null }) => void) | null
  >(null);

  /**
   * Not speaking an utterance does not make it free.
   *
   * The agent counts every `agent.message` the host accepts and will not plan
   * its next move until a matching `tts.playback.complete` comes back, or 15
   * seconds elapse (`speechBarrier.ts`, `TTS_PLAYBACK_TIMEOUT_MS`). Silence
   * that skips this call turns "the agent talks too much" into "the agent
   * freezes for 15 seconds", which is worse.
   *
   * The barrier counts credits rather than matching ids, so releasing a skipped
   * message while an earlier one is still playing is safe: the count only
   * reaches zero when the real audio also finishes. The id is passed so the
   * barrier's duplicate guard has something to work with — a missing id makes
   * it read `null` and skip that check entirely.
   */
  const releaseSpeechBarrierForSkip = useCallback((messageId: string) => {
    ttsCompleteRef.current?.({ interrupted: true, messageId });
  }, []);

  /**
   * The one place an agent utterance turns into sound.
   *
   * Exactly one of `speakAgentMessage` / `releaseSpeechBarrierForSkip` runs per
   * accepted message. Both relay paths (`agent.message` and the `postMessage`
   * tool) come through here so neither can drift.
   */
  const deliverAgentMessage = useCallback(
    (
      text: string,
      agentCategory: string | null,
      options: {
        clearAwaiting: boolean;
        barrierArmed: boolean;
        /** Planner latency for this sentence; stored only in the demo. */
        timing?: { model: string; plannerMs: number } | null;
      }
    ) => {
      const normalizedText = text.trim();
      if (!normalizedText) return;
      if (options.clearAwaiting) setAwaitingAgentResponse(false);
      const stage = activeSpec?.stage ?? currentStage;
      const timing = options.timing ?? null;

      // Text mode: the agent never armed a barrier for this utterance
      // (`noteAgentSpeechSent` no-ops with voice off), so there is nothing to
      // gate and nothing to release. Behave exactly as before the feature.
      if (!voiceModeEnabled || !isAgentInteractionEnabled) {
        const id = addAgentMessage(stage, normalizedText, activeSpec, undefined, timing);
        speakAgentMessage({ id, text: expandTtsAbbreviations(normalizedText) });
        return;
      }

      const classification = resolveUtterance(agentCategory, normalizedText);
      const decision = decideVoiceOutput({
        text: normalizedText,
        classification,
        settings: voiceVerbosity,
        // The spec the participant is looking at while this sentence plays:
        // the agent sends its narration before the tool that changes the view.
        visibleLabels: (activeSpec?.visibleItems ?? []).map((item) => String(item.value)),
        screenTitle: activeSpec?.title ?? null,
        recentSpoken: recentSpokenRef.current,
        consecutiveCount: consecutiveAgentUtterancesRef.current,
      });

      const messageId = addAgentMessage(
        stage,
        normalizedText,
        activeSpec,
        {
          spoken: decision.mode !== 'silent',
          category: decision.category,
          mode: decision.mode,
          rule: decision.rule,
          ...(decision.mode !== 'silent' ? { spokenText: decision.spokenText } : {}),
        },
        timing
      );

      const consecutiveBefore = consecutiveAgentUtterancesRef.current;
      if (decision.mode === 'silent') {
        // Only pay back a credit that was actually issued. The agent counts
        // `agent.message` envelopes (`noteAgentSpeechSent`, index.ts:1033 and
        // :1316) and nothing else — a `postMessage` *tool* call arrives as a
        // `tool.call`, so releasing for it would consume some other utterance's
        // credit and let the agent act while it is still speaking.
        if (options.barrierArmed) releaseSpeechBarrierForSkip(messageId);
        setVoiceGateStats((previous) => ({ ...previous, silenced: previous.silenced + 1 }));
      } else {
        // The transcript keeps the original wording; only the spoken copy gets
        // shortened and its abbreviations expanded.
        speakAgentMessage({ id: messageId, text: expandTtsAbbreviations(decision.spokenText) });
        /*
          Hold the next GUI change for this sentence. Only here, in the audible
          branch: a silenced utterance produces no audio and therefore no start
          event, so arming there would freeze the screen until the timeout for
          a sentence nobody was ever going to hear.
        */
        armPendingSpeech(messageId);
        // Compare against originals, not the shortened copies: two utterances
        // that say the same thing are duplicates however they were trimmed.
        recentSpokenRef.current = [...recentSpokenRef.current, normalizedText].slice(
          -RECENT_UTTERANCE_WINDOW
        );
        // The monologue cap is about how long the participant has been listening
        // without a turn, so only audible utterances count toward it.
        consecutiveAgentUtterancesRef.current += 1;
        if (decision.spokenText !== normalizedText) {
          setVoiceGateStats((previous) => ({ ...previous, shortened: previous.shortened + 1 }));
        }
      }

      logStudyEvent('chat.voice_output.gated', {
        messageId,
        stage,
        category: decision.category,
        categorySource: classification.source,
        heuristicRule: classification.matchedRule,
        settingMode: decision.settingMode,
        mode: decision.mode,
        rule: decision.rule,
        preset: voiceVerbosity.preset,
        smartSkip: voiceVerbosity.smartSkip,
        hasQuestion: classification.hasQuestion,
        textLength: normalizedText.length,
        spokenLength: decision.spokenText.length,
        consecutiveCount: consecutiveBefore,
        visibleItemCount: activeSpec?.visibleItems?.length ?? 0,
      });
    },
    [
      activeSpec,
      addAgentMessage,
      armPendingSpeech,
      currentStage,
      isAgentInteractionEnabled,
      logStudyEvent,
      releaseSpeechBarrierForSkip,
      speakAgentMessage,
      voiceModeEnabled,
      voiceVerbosity,
    ]
  );

  const handleAgentMessage = useCallback(
    (text: string, category?: string | null, timing?: { model: string; plannerMs: number } | null) => {
      deliverAgentMessage(text, category ?? null, {
        clearAwaiting: true,
        barrierArmed: true,
        // Only where the visitor can switch models; a study participant is not
        // shown timings and the condition should not record them differently.
        timing: plannerModelAvailable ? timing ?? null : null,
      });
    },
    [deliverAgentMessage]
  );

  /*
    Forward declaration through a ref.

    The dispatcher is built out of the bridge's own senders, so it cannot exist
    before the bridge does — but the bridge needs a handler at construction. The
    ref is filled in immediately below the bridge call.
  */
  const memoryCommandRef = useRef<((command: MemoryCommand) => void) | null>(null);
  const dispatchMemoryCommand = useCallback((command: MemoryCommand) => {
    memoryCommandRef.current?.(command);
  }, []);

  const {
    sendUserMessageToAgent,
    sendSessionResetToAgent,
    sendVoiceModeChange,
    sendConversationLanguage,
    sendPlannerModel,
    sendPreferenceDelete,
    sendPreferenceRestore,
    sendPreferenceClear,
    sendPreferenceProfileLoad,
    sendTtsPlaybackComplete,
    sendCompanionSpeak,
    sendCompanionConfig,
    companionActive,
    isConnected: isAgentBridgeConnected,
    isJoined: isAgentBridgeJoined,
    connectedAgents,
    agentActivityPhase,
    agentStatusSupported,
    agentMemory,
    deviceRoster,
  } = useAgentBridge({
    uiSpec: activeSpec,
    messageHistory: messages,
    toolSchema: agentToolSchema,
    guiAdaptationEnabled,
    plannerCpMemoryLimit,
    // Pushed by the bridge on join, before `session.started`, so the planner's
    // first request already carries them. The effects below handle changes.
    conversationLanguage: language,
    voiceModeEnabled,
    plannerModel: plannerModelAvailable ? plannerModelSetting.model : null,
    /*
      A quick card asks the planner to describe what it does to the screen.

      Unmuting the frontend gate is only half of it: the GUI adaptation rules
      tell the planner to write a brief cue and NOT restate what is on screen,
      so without this the card just says a deliberately stripped sentence
      louder. Off for every other session, including the full demo, where a
      visitor is minutes into a booking and narration is the noise the rule
      exists to prevent.
    */
    narrateAdaptations: Boolean(quickStartCard),
    /*
      And the mirror image of it, for a voice session that is NOT a card.

      The frontend gate cuts the sentence after the planner has written it,
      which is the wrong layer: a regex produces fragments, it cannot read a
      language it has no corpus for, and it never knows what the sentence was
      for. Asking for a short sentence gets a short sentence.

      Three conditions, and each one is load-bearing. Voice, because with voice
      off `assistantMessage` is the only channel there is and shortening it
      would take information away from a text-condition participant. Demo,
      because a study session's prompt must stay byte-identical —
      `npm run check:planner-prompt` pins it. Not a card, because a card asks
      for the opposite and `buildSystemPrompt` would drop this anyway.
    */
    spokenBrevity: plannerWritesForTheEar,
    preferenceProfile: showMemoryPanel ? preferenceProfilePayload : null,
    sessionId: studySession?.relaySessionId,
    studyToken: studySession?.studyToken,
    enabled: isAgentInteractionEnabled && Boolean(studySession),
    onToolCall: handleAgentToolCall,
    onAgentMessage: handleAgentMessage,
    onSessionEnd: handleSessionReset,
    onCompanionTranscript: handleCompanionTranscriptEnvelope,
    onCompanionPlaybackComplete: handleCompanionPlaybackEnvelope,
    onCompanionHello: handleCompanionHelloEnvelope,
    onCompanionClaim: handleCompanionClaimEnvelope,
    onCompanionMemoryCommand: dispatchMemoryCommand,
  });

  useEffect(() => {
    agentStatusSupportedRef.current = agentStatusSupported;
  }, [agentStatusSupported]);

  /*
    Whether the visitor's phone is still there.

    `isAgentBridgeJoined`, not `isConnected`: an open socket that has not been
    admitted to the session yet receives no rosters, and treating that as "I can
    see" would report a perfectly healthy phone as gone for the length of every
    reconnect.
  */
  const phonePresence = useDevicePresence({
    pairable: showMemoryPanel && Boolean(companionToken),
    linked: isAgentBridgeJoined,
    endedMessage: null,
    roster: deviceRoster?.roster ?? null,
    rosterAtMs: deviceRoster?.atMs ?? null,
  });

  // Mirror memory to the booth's second screen. Only the demo opens that window,
  // so publishing is scoped to it rather than running in every study session.
  const memoryPublisherRef = useRef<ReturnType<typeof createMemoryPublisher> | null>(null);
  useEffect(() => {
    if (!showMemoryPanel) return;
    const publisher = createMemoryPublisher();
    memoryPublisherRef.current = publisher;
    return () => {
      memoryPublisherRef.current = null;
      publisher.close();
    };
  }, [showMemoryPanel]);
  useEffect(() => {
    memoryPublisherRef.current?.publish(agentMemory, currentStage ?? null);
  }, [agentMemory, currentStage]);

  /*
    Removing a preference the agent got wrong.

    Nothing here mutates the preference list locally. The second screen mirrors
    the RAW snapshot published above, so an optimistic removal would leave the
    rail and the projected screen disagreeing for the whole round trip — and
    indefinitely if the frame were dropped. A rail and a mirror showing
    different memory is worse than one round trip of latency, so the only local
    state is a cosmetic pending style; the chip leaves on the agent's echo.
  */
  const [pendingPreferenceIds, setPendingPreferenceIds] = useState<Set<string>>(
    () => new Set()
  );

  useEffect(() => {
    if (!agentMemory) return;
    // The agent force-publishes after every removal and restore, no-ops
    // included, so any snapshot is proof the instruction was handled.
    setPendingPreferenceIds((current) => (current.size === 0 ? current : new Set()));
  }, [agentMemory]);

  const markPreferencePending = useCallback((preferenceId: string, sent: boolean) => {
    setPendingPreferenceIds((current) => {
      const next = new Set(current);
      if (sent) next.add(preferenceId);
      else next.delete(preferenceId);
      return next;
    });
  }, []);

  const handlePreferenceDelete = useCallback(
    (preferenceId: string) => {
      markPreferencePending(preferenceId, sendPreferenceDelete(preferenceId));
    },
    [markPreferencePending, sendPreferenceDelete]
  );

  const handlePreferenceRestore = useCallback(
    (preferenceId: string) => {
      markPreferencePending(preferenceId, sendPreferenceRestore(preferenceId));
    },
    [markPreferencePending, sendPreferenceRestore]
  );

  /**
   * Load a preset over whatever the session is holding.
   *
   * The revision counts up from the profile in hand rather than from a counter,
   * so re-loading the SAME preset still lands — which is the operator's "re-arm
   * this for the next visitor" gesture, and would otherwise be swallowed by the
   * agent's revision guard.
   */
  const handlePreferenceClearAll = useCallback(() => {
    sendPreferenceClear();
  }, [sendPreferenceClear]);

  const handleProfileLoad = useCallback(
    (presetId: string) => {
      const preset = findPreferencePreset(presetId);
      if (!preset) return;
      setSessionProfile((current) => {
        const next = createProfileFromPreset(preset, (current?.revision ?? 0) + 1);
        const payload = toPreferenceProfilePayload(next);
        if (payload) sendPreferenceProfileLoad(payload);
        return next;
      });
    },
    [sendPreferenceProfileLoad]
  );

  /*
    The booth's second screen, asking this window to act for it.

    It has no socket of its own and is never given one: the write leaves from
    here, the only place that was ever allowed to write. Scoped to the demo, and
    to the BroadcastChannel mirror specifically — the cross-device mirror reached
    by scanning the QR joins the relay as a read-only viewer and stays that way.
  */
  const handleMemoryCommand = useCallback(
    (command: MemoryCommand) => {
      switch (command.kind) {
        case 'preference.delete':
          handlePreferenceDelete(command.preferenceId);
          return;
        case 'preference.restore':
          handlePreferenceRestore(command.preferenceId);
          return;
        case 'preference.clear':
          handlePreferenceClearAll();
          return;
        case 'profile.load':
          handleProfileLoad(command.presetId);
          return;
      }
    },
    [handlePreferenceDelete, handlePreferenceRestore, handlePreferenceClearAll, handleProfileLoad]
  );

  memoryCommandRef.current = handleMemoryCommand;

  useEffect(() => {
    if (!showMemoryPanel) return;
    return subscribeToMemoryCommands(handleMemoryCommand);
  }, [showMemoryPanel, handleMemoryCommand]);

  /*
    Un-apply the GUI adaptations the agent just withdrew.

    Applied when the snapshot ARRIVES rather than before the frame is sent: a
    send can fail while the socket is reconnecting, and un-narrowing the screen
    for a removal the agent never received would leave no way back.

    Matched on stage plus the filter triple, never on a parent-context key. The
    agent's key for the movie stage is 'root' while the host's is the literal
    'movie', so key matching would no-op on exactly the stage where a visitor is
    most likely to remove something.
  */
  // Keyed on the snapshot object, not its timestamp: two removals inside the
  // same millisecond share an `updatedAt`, and the second one's revocation
  // would be silently skipped — leaving that filter on screen for good.
  const appliedRevocationRef = useRef<AgentMemorySnapshot | null>(null);
  useEffect(() => {
    const revoked = agentMemory?.revokedAdaptations ?? [];
    if (revoked.length === 0) return;
    if (appliedRevocationRef.current === agentMemory) return;
    appliedRevocationRef.current = agentMemory;

    transformSpecs((spec) => {
      let next = spec;
      for (const entry of revoked) {
        if (entry.stage !== spec.stage) continue;
        if (entry.filters.length > 0) {
          next = pruneFilters(next, (filter) =>
            entry.filters.some(
              (target) =>
                target.field === filter.field &&
                target.operator === filter.operator &&
                JSON.stringify(target.value ?? null) === JSON.stringify(filter.value ?? null)
            )
          );
        }
        if (entry.clearHighlight) next = clearHighlight(next);
      }
      return next;
    });
  }, [agentMemory, transformSpecs]);

  // On change only. The mount-time run of each of these fires before the relay
  // socket is open and is dropped by `sendEnvelope`; the bridge re-sends both
  // values itself when it joins, which is what the agent actually starts from.
  useEffect(() => {
    sendVoiceModeChange(voiceModeEnabled);
  }, [voiceModeEnabled, sendVoiceModeChange]);

  useEffect(() => {
    sendConversationLanguage(language);
  }, [language, sendConversationLanguage]);

  useEffect(() => {
    sendPlannerModel(plannerModelAvailable ? plannerModelSetting.model : null);
  }, [plannerModelAvailable, plannerModelSetting.model, sendPlannerModel]);

  // The setting persists across sessions, so without this the log shows gating
  // decisions with no record of what was configured when voice was switched on.
  useEffect(() => {
    if (!voiceModeEnabled) return;
    logStudyEvent('chat.voice_verbosity.active', {
      preset: voiceVerbosityRef.current.preset,
      smartSkip: voiceVerbosityRef.current.smartSkip,
      categories: voiceVerbosityRef.current.categories,
    });
    // Intentionally keyed on the voice toggle alone: this records the setting
    // in force when speaking starts, and `chat.voice_verbosity.changed` covers
    // everything after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceModeEnabled, logStudyEvent]);

  const submitChatInput = useCallback(
    (text: string, source: 'text' | 'voice' = 'text') => {
      const trimmed = text.trim();
      if (!trimmed || !isAgentInteractionEnabled) return;

      stopAgentSpeech();
      logDerivedEvents(
        buildPreferenceExtractionEvents({
          stage: currentStage,
          text: trimmed,
          source,
          preferenceTypes: scenarioPreferenceTypes,
          seatRows: scenarioSeatRows,
          seenMentions: seenPreferenceMentionsRef.current,
        })
      );
      addUserMessage(currentStage, 'input', trimmed, activeSpec, source);
      setAwaitingAgentResponse(true);
      sendUserMessageToAgent(trimmed, currentStage);
    },
    [
      addUserMessage,
      currentStage,
      isAgentInteractionEnabled,
      logDerivedEvents,
      logStudyEvent,
      scenarioPreferenceTypes,
      scenarioSeatRows,
      sendUserMessageToAgent,
      stopAgentSpeech,
    ]
  );

  // The voice session is declared after this, but its transcript callback needs
  // to reach it.
  const submitChatInputRef = useRef(submitChatInput);
  useEffect(() => {
    submitChatInputRef.current = submitChatInput;
  }, [submitChatInput]);

  const handleChatInputSubmit = useCallback(
    (text: string) => {
      submitChatInput(text, 'text');
    },
    [submitChatInput]
  );

  const handlePostedAgentMessage = useCallback((text: string) => {
    const normalizedText = text.trim();
    if (!normalizedText) return;

    logDerivedEvents(
      buildConflictSignalEvents({
        stage: activeSpec?.stage ?? currentStage,
        source: 'agent',
        messageText: normalizedText,
      })
    );
    // The `postMessage` tool is a bare "say this" — its text can be anything,
    // so it goes through the classifier like an untagged message rather than
    // being assumed to be conversation. It arrives as a `tool.call`, so the
    // agent never armed a speech barrier for it.
    deliverAgentMessage(normalizedText, null, { clearAwaiting: false, barrierArmed: false });
  }, [activeSpec, currentStage, deliverAgentMessage, logDerivedEvents]);

  useToolHandler({
    spec: activeSpec,
    setSpec: handleSetSpec,
    onNext: handleNext,
    onBack: handleBack,
    onPostMessage: handlePostedAgentMessage,
    multiSelect: currentStage === 'seat',
  });

  const handleManualReset = useCallback(() => {
    if (loading) return;
    const confirmed = window.confirm(
      'Reset this task and clear the current chat and booking progress?'
    );
    if (!confirmed) return;
    stopAgentSpeech();
    logStudyEvent('study.control.reset_requested', {
      source: 'participant',
    });
    sendSessionResetToAgent('host-manual-reset');
    handleSessionReset();
  }, [handleSessionReset, loading, logStudyEvent, sendSessionResetToAgent, stopAgentSpeech]);

  const handleFinishStudy = useCallback(async () => {
    if (loading) return;

    stopAgentSpeech();
    resetChat();
    setBooking(null);
    setError(null);
    setAwaitingAgentResponse(false);
    setUiSpec(null);
    sendSessionResetToAgent('host-finish-study');
    navigate('/end', { replace: true });

    void logStudyEventNow('study.control.finish_requested', {
      source: 'participant',
    }).catch(() => {
      // Best-effort logging only; do not block the end screen.
    });

    // Local teardown already proceeded, so a failure here must not block the end
    // screen — but it must not be invisible either. A silently swallowed failure
    // is how every finish request in the study ended up leaving its session
    // `active` until the 4h TTL reaped it, with no trace in the logs.
    void api
      .finishStudySession()
      .then((result) => {
        void logStudyEventNow('study.session.finished', {
          source: 'participant',
          status: result.status,
          finishedAt: result.finishedAt,
        }).catch(() => {});
      })
      .catch((error: unknown) => {
        void logStudyEventNow('study.session.finish_failed', {
          source: 'participant',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      });
  }, [
    loading,
    logStudyEventNow,
    navigate,
    resetChat,
    sendSessionResetToAgent,
    setUiSpec,
    stopAgentSpeech,
  ]);

  useEffect(() => {
    if (!studyModePreset || !studyModeConfig) return;
    if (appliedStudyModePresetRef.current === studyModePreset) return;
    appliedStudyModePresetRef.current = studyModePreset;

    setAgentBridgeEnabled(studyModeConfig.agentEnabled);
    setGuiAdaptationEnabled(studyModeConfig.guiAdaptationEnabled);
    setPlannerCpMemoryLimit(studyModeConfig.cpMemoryWindow);

    api.setGuiAdaptationConfig(studyModeConfig.guiAdaptationEnabled).catch(() => {});
  }, [studyModePreset, studyModeConfig]);

  useEffect(() => {
    if (voiceModeAvailable) return;
    setVoiceModeEnabled(false);
  }, [voiceModeAvailable]);

  useEffect(() => {
    if (!voiceModeEnabled || !isBookingCompleteSpec(activeSpec)) return;
    logStudyEvent('chat.voice_mode.auto_disabled', {
      reason: 'finish_task_step',
      stage: activeSpec?.stage ?? currentStage,
    });
    setVoiceModeEnabled(false);
  }, [activeSpec, currentStage, logStudyEvent, voiceModeEnabled]);

  const currentStep = STAGE_ORDER.indexOf(currentStage) + 1;
  const previousStage = getPrevStage(currentStage);
  const nextStage = getNextStage(currentStage);
  const isFinishTaskStep = isBookingCompleteSpec(activeSpec);
  const hasConnectedAgent = connectedAgents.length > 0;
  const hasLiveAgentSession =
    isAgentInteractionEnabled &&
    isAgentBridgeConnected &&
    isAgentBridgeJoined &&
    hasConnectedAgent;
  const effectiveAgentActivityPhase =
    agentActivityPhase !== 'idle'
      ? agentActivityPhase
      : awaitingAgentResponse && hasLiveAgentSession
      ? 'planning'
      : 'idle';
  const isAgentTyping = hasLiveAgentSession && effectiveAgentActivityPhase !== 'idle';
  const interactionLocked = loading || isAgentTyping;

  useEffect(() => {
    if (!hasLiveAgentSession) {
      setAwaitingAgentResponse(false);
      return;
    }
    if (agentStatusSupported && agentActivityPhase !== 'idle') {
      setAwaitingAgentResponse(false);
    }
  }, [agentActivityPhase, agentStatusSupported, hasLiveAgentSession]);

  useEffect(() => {
    const scope = interactionScopeRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (!scope) return;
    if (usesSplitInterface) {
      scope.inert = false;
      return () => {
        scope.inert = false;
      };
    }
    scope.inert = interactionLocked;
    return () => {
      scope.inert = false;
    };
  }, [interactionLocked, usesSplitInterface]);

  /*
    The sheet is `lg:hidden`: it only ever covers the header on a phone. Making
    the header inert whenever the panel was open therefore killed every header
    button on a desktop — where the panel is a column beside the booking UI and
    opens by default, so Settings, Reset, Finish and even the Memory toggle that
    would have closed it were all dead from first paint. Follow the breakpoint,
    and keep following it: the sheet appears and disappears on resize with no
    React state change to notice it.
  */
  useEffect(() => {
    const header = headerRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (!header) return;
    if (!memorySheetOpen || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      header.inert = false;
      return;
    }
    const compact = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const syncInert = () => {
      header.inert = compact.matches;
    };
    syncInert();
    compact.addEventListener('change', syncInert);
    return () => {
      compact.removeEventListener('change', syncInert);
      header.inert = false;
    };
  }, [memorySheetOpen]);

  useEffect(() => {
    if (!interactionLocked || typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, [interactionLocked]);

  const inputDisabled =
    interactionLocked ||
    !isAgentInteractionEnabled ||
    !isAgentBridgeConnected ||
    !isAgentBridgeJoined ||
    !hasConnectedAgent;
  const interactionLockLabel = loading
    ? ui.loadingNextStage
    : 'Waiting for the next agent message...';
  const chatInputPlaceholder =
    interactionLocked
      ? interactionLockLabel
      : !isAgentBridgeConnected
      ? ui.waitingForRelay
      : !isAgentBridgeJoined
      ? ui.joiningAgentSession
      : !hasConnectedAgent
      ? ui.waitingForExternalAgent
      : ui.sendAMessage;
  /**
   * The on-screen options fed to the transcriber to bias recognition. Computed
   * once and shared: the phone gets this string rather than the spec itself, so
   * the booking UI's contents never leave the kiosk.
   */
  const companionTranscriptionPrompt = useMemo(
    () => buildVoiceTranscriptionPrompt(activeSpec, currentStage, language) ?? null,
    [activeSpec, currentStage, language]
  );
  /**
   * The same labels as a list, for the gate: a transcript made of nothing but
   * these is the transcription model quoting its own prompt back.
   */
  const voiceTranscriptionHints = useMemo(
    () => collectVoiceTranscriptionHints(activeSpec, currentStage, language),
    [activeSpec, currentStage, language]
  );
  const voiceTranscriptionHintsRef = useRef(voiceTranscriptionHints);
  voiceTranscriptionHintsRef.current = voiceTranscriptionHints;

  /**
   * Every transcript enters here, whichever device heard it. The filter, the
   * `voice` source tag and the ignored-input logging must happen exactly once,
   * so the phone sends raw text up and this is the only funnel.
   */
  const handleVoiceTranscript = useCallback(
    ({ text, durationMs }: { text: string; durationMs: number }) => {
      const normalizedTranscript = text.trim();
      if (!normalizedTranscript) return;

      const ignoredReason = getIgnoredVoiceTranscriptReason(normalizedTranscript, durationMs, {
        language,
        shortInputMaxDurationMs: SHORT_VOICE_INPUT_MAX_DURATION_MS,
        shortInputMaxChars: SHORT_VOICE_INPUT_MAX_CHARS,
        hintLabels: voiceTranscriptionHintsRef.current,
      });
      if (ignoredReason) {
        logStudyEvent('chat.voice_input.ignored', {
          language,
          durationMs,
          reason: ignoredReason,
          text: normalizedTranscript,
        });
        return;
      }

      submitChatInputRef.current?.(normalizedTranscript, 'voice');
    },
    [language, logStudyEvent]
  );

  /**
   * Every playback completion enters here for the same reason: the replay rule
   * below and the single `tts.playback.complete` the agent's barrier counts must
   * not be duplicated per device.
   */
  const handleVoicePlaybackResolved = useCallback(
    (item: VoiceSpeakItem, { interrupted }: { interrupted: boolean }) => {
      /*
        An utterance can finish without ever having started — a barge-in cuts
        it off before the first audio buffer, and the queue reports it complete.
        Nothing will start it now, so anything held for it must be let through
        here rather than waiting out the timeout. Releasing on a normal
        completion is a no-op: the start already did it.
      */
      releasePendingSpeech('playback-complete');
      // A replay is the host's own doing: the agent issued no `agent.message`
      // for it and armed no barrier credit, so reporting a completion here
      // would spend a credit belonging to some other utterance and let the
      // agent act while that one is still playing.
      if (item.id && item.id === voiceReplayMessageIdRef.current) {
        voiceReplayMessageIdRef.current = null;
        return;
      }
      ttsCompleteRef.current?.({ interrupted, messageId: item.id });
    },
    [releasePendingSpeech]
  );

  const {
    supported: voiceInputSupported,
    inputStatus: voiceInputStatus,
    outputStatus: voiceOutputStatus,
    error: voiceSessionError,
    speak: speakOverVoiceSession,
    stop: stopVoiceSession,
  } = useRealtimeVoice({
    // The third conjunct is the whole of the kiosk's side of phone voice: while
    // the visitor has chosen the phone, this hook is disabled and tears its own
    // WebRTC session down, so the two devices can never both hold a live mic.
    // `voiceOutputTarget` is 'kiosk' unless a person changed it, so in every
    // study condition this expression is `voiceModeEnabled &&
    // isAgentInteractionEnabled && true` — identical to what it was.
    enabled: voiceModeEnabled && isAgentInteractionEnabled && voiceOutputTarget !== 'companion',
    // Only session liveness gates delivery. Suspending while the agent is busy
    // would drop exactly the transcripts barge-in exists to capture, and the
    // agent already defers a replan when a message arrives mid-turn.
    suspended: !hasLiveAgentSession,
    transcriptionPrompt: companionTranscriptionPrompt,
    language,
    createSession: createRealtimeVoiceSessionForLanguage,
    onTranscript: handleVoiceTranscript,
    onSpeakingItemChange: (item) => {
      setSpeakingMessageId(item?.id ?? null);
      /*
        The sync point. This fires on `output_audio_buffer.started`, so it is
        the moment sound actually reaches the visitor rather than the moment
        the utterance was queued.

        Released for ANY item that starts, not only the one being waited on: if
        a different sentence got to the speaker first, the one we were holding
        for is never going to start, and the screen should follow what is
        audible now.
      */
      if (item) releasePendingSpeech('playback-started');
    },
    onPlaybackComplete: handleVoicePlaybackResolved,
    onLogEvent: logStudyEvent,
    /*
      Normally null, and then the hook makes its own element — which is right
      everywhere the session opens from the visitor's click on the mic button.
      It is NOT right on a scanned quick-demo card: there the session opens on
      arrival, one route after the tap that started it, and iOS Safari would
      refuse to play through a freshly created element. See the module.
    */
    audioSink: getUnlockedVoiceAudioElement,
  });

  /**
   * The paired phone, when there is one. Demo-only: `showMemoryPanel` is the
   * existing demo gate, so in C1-C4 `owns` is false, no companion envelope is
   * ever sent, and every expression below collapses to what it was.
   */
  const {
    owns: companionOwnsVoice,
    speakOnCompanion,
    stopOnCompanion,
    handleCompanionHello,
    handleCompanionPlaybackComplete,
  } = useVoiceCompanionHost({
    enabled: showMemoryPanel && voiceModeAvailable,
    target: voiceOutputTarget,
    language,
    transcriptionPrompt: companionTranscriptionPrompt,
    listening: voiceModeEnabled && isAgentInteractionEnabled,
    sendCompanionSpeak,
    sendCompanionConfig,
    onPlaybackResolved: handleVoicePlaybackResolved,
  });

  /**
   * The phone taking voice, or handing it back.
   *
   * Claiming turns voice mode ON as well as moving the target. Someone who picks
   * up the phone and presses its microphone has said everything they mean to
   * say; making them also find the mic button on the kiosk would be the same
   * two-device dance this feature exists to remove.
   *
   * Releasing does not turn voice mode off — it just comes home to the kiosk, so
   * the headset keeps working.
   */
  const handleCompanionClaim = useCallback(
    (claimed: boolean) => {
      if (!voiceModeAvailable) return;
      setVoiceOutputTarget(claimed ? 'companion' : 'kiosk');
      if (claimed) setVoiceModeEnabled(true);
      logStudyEvent('chat.voice_target.changed', {
        target: claimed ? 'companion' : 'kiosk',
        source: 'companion',
      });
    },
    [logStudyEvent, voiceModeAvailable]
  );

  /**
   * A phone announcing itself, plus the choice made before it existed.
   *
   * If the visitor already asked for phone audio on the pairing screen, a
   * `hello` is the first moment that request can be honoured — so it is honoured
   * then, rather than asking them to tap "use this phone" for something they
   * have already said. `handleCompanionClaim` is what moves voice AND turns the
   * microphone on, which is why this routes through it rather than setting the
   * target directly.
   *
   * Applied on hello and never withdrawn on its absence: `companionActive` is
   * unavailable during a host reconnect, and reading that gap as "the phone
   * left" would yank voice back to the kiosk mid-sentence.
   */
  const handleCompanionHelloWithPreference = useCallback(() => {
    handleCompanionHello();
    if (voiceTargetPreference === 'companion') handleCompanionClaim(true);
  }, [handleCompanionHello, handleCompanionClaim, voiceTargetPreference]);

  useEffect(() => {
    companionTranscriptRef.current = handleVoiceTranscript;
    companionPlaybackRef.current = handleCompanionPlaybackComplete;
    companionHelloRef.current = handleCompanionHelloWithPreference;
    companionClaimRef.current = handleCompanionClaim;
  }, [
    handleVoiceTranscript,
    handleCompanionPlaybackComplete,
    handleCompanionHelloWithPreference,
    handleCompanionClaim,
  ]);

  useEffect(() => {
    // The fork. `speakAgentMessage` and `stopAgentSpeech` are declared far above
    // and reach the live session through these refs, so routing to the phone is
    // a matter of what the refs point at — no call site changes.
    voiceSpeakRef.current = companionOwnsVoice ? speakOnCompanion : speakOverVoiceSession;
    voiceStopRef.current = companionOwnsVoice ? stopOnCompanion : stopVoiceSession;
  }, [
    companionOwnsVoice,
    speakOnCompanion,
    stopOnCompanion,
    speakOverVoiceSession,
    stopVoiceSession,
  ]);

  useEffect(() => {
    ttsCompleteRef.current = sendTtsPlaybackComplete;
  }, [sendTtsPlaybackComplete]);

  /*
    Turning voice on reads back the question already on screen.

    The agent greets on the first snapshot, so a visitor who then reaches for
    the mic has already been asked something — in writing, because voice was
    off. Without this, switching voice on answers with silence and the first
    thing they hear is whatever comes after they have spoken first, which is the
    wrong way round for a booth where the mic is the invitation.

    It replays the agent's own words rather than a sentence composed here: no
    model round trip at the one moment the visitor is waiting to hear something,
    and nothing said out loud that is not also on screen.
  */
  const voiceOnReplayResolvedRef = useRef(false);
  useEffect(() => {
    if (!voiceModeEnabled) {
      // Armed again for the next time voice is switched on.
      voiceOnReplayResolvedRef.current = false;
      return;
    }
    if (voiceOnReplayResolvedRef.current) return;
    // Not the toggle: the session has to be up, or the utterance is queued
    // against a channel that may never open. 'listening' is the hook's word for
    // connected, mic live, and the agent relay alive with it.
    if (voiceInputStatus !== 'listening' && voiceInputStatus !== 'capturing') return;

    // Resolved exactly once per switch-on, whether or not there is anything to
    // replay. Leaving it open would catch the *next* agent message — which the
    // voice pipeline is already speaking live — and say it twice.
    voiceOnReplayResolvedRef.current = true;

    let latestAgentMessage: AgentMessageType | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.type === 'agent' && message.text.trim()) {
        latestAgentMessage = message;
        break;
      }
    }
    if (!latestAgentMessage) return;
    // `voice` is stamped by the verbosity gate, so its presence means this
    // utterance already went through the voice pipeline — either spoken, or
    // deliberately silenced by the visitor's own setting. Replaying it would
    // repeat what they just heard, or overrule what they asked not to hear.
    if (latestAgentMessage.voice) return;

    voiceReplayMessageIdRef.current = latestAgentMessage.id;
    speakAgentMessage({
      id: latestAgentMessage.id,
      text: expandTtsAbbreviations(latestAgentMessage.text),
    });
    logStudyEvent('chat.voice_mode.replayed_message', {
      messageId: latestAgentMessage.id,
      stage: latestAgentMessage.stage,
      text: latestAgentMessage.text,
    });
  }, [logStudyEvent, messages, speakAgentMessage, voiceInputStatus, voiceModeEnabled]);

  // The monologue rule counts agent utterances since the participant last did
  // anything. Keying off the user-message count catches every route in —
  // typing, speaking, and clicking an option in the GUI.
  const userTurnCount = useMemo(
    () => messages.reduce((count, message) => count + (message.type === 'user' ? 1 : 0), 0),
    [messages]
  );
  useEffect(() => {
    consecutiveAgentUtterancesRef.current = 0;
  }, [userTurnCount]);

  useEffect(() => {
    voiceVerbosityRef.current = voiceVerbosity;
  }, [voiceVerbosity]);

  const handleOpenVoiceSettings = useCallback(() => setSettingsOpen(true), []);
  const voiceVerbosityLabel = verbosityPillLabel(voiceVerbosity.preset);

  const voiceStatusLabel = getVoiceStatusLabel({
    voiceModeEnabled,
    voiceInputSupported,
    voiceInputStatus,
    voiceOutputStatus,
    hasLiveAgentSession,
    ui,
  });
  const voiceError = voiceModeEnabled ? voiceSessionError : null;
  const voiceModeButtonDisabled = !voiceInputSupported || isFinishTaskStep;
  const effectiveChatInputPlaceholder =
    isFinishTaskStep
      ? 'Voice off on finish step'
      : voiceModeEnabled && (voiceError || voiceStatusLabel)
      ? (voiceError ?? voiceStatusLabel)!
      : interactionLocked
      ? interactionLockLabel
      : voiceModeAvailable && !voiceInputSupported
      ? ui.voiceUnavailable
      : voiceModeAvailable && !voiceModeEnabled
      ? ui.tapMicForVoice
      : voiceModeEnabled && hasLiveAgentSession
      ? ui.speakNow
      : voiceModeEnabled
      ? ui.waitingForSession
      : chatInputPlaceholder;
  const highlightVoiceToggle =
    voiceModeAvailable && !voiceModeEnabled && effectiveChatInputPlaceholder === ui.tapMicForVoice;

  const stageSpecMap = useMemo(() => {
    const map = new Map<Stage, UISpec>();
    for (const message of messages) {
      if (message.type === 'system') {
        map.set(message.stage, message.spec);
      }
    }
    if (activeSpec) {
      map.set(currentStage, activeSpec);
    }
    return map;
  }, [messages, activeSpec, currentStage]);

  const previousSpec = previousStage ? stageSpecMap.get(previousStage) ?? null : null;
  const nextSpec = nextStage ? stageSpecMap.get(nextStage) ?? null : null;

  useEffect(() => {
    if (viewMode !== 'carousel') {
      previousStageRef.current = currentStage;
      return;
    }

    const prevStage = previousStageRef.current;
    if (prevStage === currentStage) return;

    const prevIndex = STAGE_ORDER.indexOf(prevStage);
    const currentIndex = STAGE_ORDER.indexOf(currentStage);
    const direction = currentIndex >= prevIndex ? 1 : -1;

    setCarouselOffset(direction * 120);
    setCarouselOpacity(0.86);

    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setCarouselOffset(0);
        setCarouselOpacity(1);
      });
    });

    previousStageRef.current = currentStage;
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [currentStage, viewMode]);

  const carouselTransition =
    'transform 860ms cubic-bezier(0.22, 1, 0.36, 1), opacity 760ms cubic-bezier(0.22, 1, 0.36, 1)';
  const hasScenarioBriefing = scenarioStory.length > 0 || scenarioPreferenceTypes.length > 0;
  // In the demo the side slot is not a briefing: the visitor's scenario is on
  // paper in their hand. The panel shows what the agent has understood instead,
  // which is the half of the system that is otherwise invisible.
  const sidePanelAvailable = showMemoryPanel || hasScenarioBriefing;
  const sidePanelVisible = sidePanelAvailable && scenarioBriefingVisible;
  const showScenarioBriefing = !showMemoryPanel && sidePanelVisible;
  const copyGuarded = SCENARIO_BRIEFING_COPY_GUARD_ENABLED && !showMemoryPanel;
  // Demo shows the memory panel here and everything else shows the task
  // briefing, so the label and its tooltip have to branch the same way. They did
  // not: the label said "Show Scenario" in C1-C4 while the tooltip promised a
  // preference-memory panel that does not exist in those conditions.
  const sidePanelToggleLabel = showMemoryPanel
    ? ui.memory
    : sidePanelVisible
      ? 'Hide Scenario'
      : 'Show Scenario';
  const sidePanelToggleTitle = showMemoryPanel
    ? sidePanelVisible
      ? ui.hideMemory
      : ui.showMemory
    : sidePanelToggleLabel;

  // Not `interactionLogFile`: a study session can have a trace without one, and
  // this button is about the trace.
  const canDownloadTrace = Boolean(studySession?.hasLlmTrace);

  const handleDownloadTrace = useCallback(async () => {
    if (!studySession?.studyToken || !canDownloadTrace || downloadingTrace) return;

    setDownloadingTrace(true);
    setError(null);

    await logStudyEventNow('study.control.llm_trace_download_requested', {
      source: 'participant',
    });

    try {
      const result = await api.downloadStudyLlmTrace(studySession.studyToken);
      const downloadUrl = window.URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download =
        result.fileName ??
        `${studySession.interactionLogFile?.split('/').pop()?.replace(/\.jsonl$/i, '') ?? 'study-interaction-log'}.llm-trace.jsonl`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download LLM trace');
    } finally {
      setDownloadingTrace(false);
    }
  }, [canDownloadTrace, downloadingTrace, logStudyEventNow, studySession]);

  return (
    /*
      `h-full`, not `app-viewport`: the shell in `App.tsx` already sets the
      viewport height and the safe-area padding for the whole app. Repeating
      `app-viewport` here made this page 100dvh tall *inside* a parent that was
      100dvh minus the bottom inset, and then padded it by that inset a second
      time — so on a tablet with the app installed to the home screen the
      booking UI ran off the bottom of a parent that clips its overflow.
    */
    <div className="relative h-full bg-dark">
      <div className="flex h-full min-h-0">
      {sidePanelVisible && (
        <aside
          className="relative hidden shrink-0 border-r border-dark-border bg-dark-light lg:block"
          style={{ width: scenarioPanelWidthPx }}
        >
          <div
            className={`relative h-full overflow-y-auto p-4 ${copyGuarded ? 'select-none' : ''}`}
            style={
              copyGuarded
                ? {
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                  }
                : undefined
            }
            onCopyCapture={copyGuarded ? preventDefault : undefined}
            onCutCapture={copyGuarded ? preventDefault : undefined}
            onContextMenu={copyGuarded ? preventDefault : undefined}
            onDragStart={copyGuarded ? preventDefault : undefined}
          >
            {showMemoryPanel ? (
              <>
                {/*
                  Only the desktop rail is editable. The phone sheet below lives
                  inside `interactionScopeRef`, which goes inert while the agent
                  holds a turn — its controls would die mid-turn while these
                  stayed live, which is a worse experience than not offering
                  them there at all.
                */}
                <AgentMemoryPanel
                  snapshot={agentMemory}
                  currentStage={currentStage}
                  onPreferenceDelete={handlePreferenceDelete}
                  onPreferenceRestore={handlePreferenceRestore}
                  onPreferenceClearAll={handlePreferenceClearAll}
                  pendingPreferenceIds={pendingPreferenceIds}
                />
                {studySession?.viewToken ? (
                  <div className="mt-4 space-y-4">
                    <DeviceRosterCard roster={deviceRoster?.roster ?? null} phone={phonePresence} />
                    <CompanionPairingCard
                      companionToken={companionToken}
                      target={voiceOutputTarget}
                      onTargetChange={setVoiceOutputTarget}
                      companionActive={companionActive}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <ScenarioBriefing
                title={scenarioTitle}
                background={scenarioBackground}
                story={scenarioStory}
                stepBriefs={scenarioStepBriefs}
                narratorPreferenceTypes={scenarioPreferenceTypes}
                seatRows={scenarioSeatRows}
              />
            )}
            {copyGuarded ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-10 bg-transparent"
              />
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Resize scenario panel width"
            title="Drag to resize scenario panel"
            onPointerDown={handleScenarioPanelWidthResizeStart}
            className="absolute right-0 top-0 flex h-full w-4 translate-x-1/2 cursor-ew-resize"
          >
            <span
              className={`absolute left-1/2 top-1/2 h-14 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                isResizingScenarioPanelWidth
                  ? 'bg-primary'
                  : 'bg-dark-border hover:bg-dark-lighter'
              }`}
            />
          </button>
        </aside>
      )}

	      <div className="relative flex min-w-0 min-h-0 flex-1 flex-col">
        {/*
          Collapsed, the toolbar leaves a single small chevron floating over the
          top-right of the booking UI. The goal on a phone is that the stage owns
          the screen, and a strip of buttons that is only needed occasionally
          should not be permanently parked above it.
        */}
        {headerCollapsed ? (
          <button
            type="button"
            onClick={() => setHeaderCollapsed(false)}
            aria-label={ui.expandHeader}
            title={ui.expandHeader}
            className="absolute left-2 top-2 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-dark-border bg-dark-light/95 text-fg shadow-lg backdrop-blur hover:border-primary hover:text-fg-strong"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
        <header
          ref={headerRef}
          className={`relative shrink-0 border-b border-dark-border bg-dark px-4 overflow-hidden ${
            headerCollapsed ? 'hidden' : ''
          }`}
          style={{ height: `${HEADER_HEIGHT_PX}px` }}
        >
          <div className="mx-auto flex h-full w-full items-center justify-end gap-2 overflow-x-auto whitespace-nowrap [&>*]:shrink-0">
            {sidePanelAvailable ? (
              <button
                type="button"
                onClick={handleScenarioBriefingToggle}
                aria-pressed={sidePanelVisible}
                title={sidePanelToggleTitle}
                className={`rounded border px-3 py-1 text-xs transition-colors ${
                  sidePanelVisible
                    ? 'border-primary bg-primary/12 text-primary-text'
                    : 'border-dark-border text-fg hover:border-primary hover:text-fg-strong'
                }`}
              >
                {sidePanelToggleLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded border border-dark-border px-3 py-1 text-xs text-fg hover:border-primary hover:text-fg-strong"
            >
              {ui.settings}
            </button>
            {/*
              One download, not two. The interaction log and the LLM trace
              overlapped enough that two buttons in a strip this narrow was
              noise; the trace is the one that is actually used for tuning, and
              the interaction log is still downloadable from the end page.
            */}
            <button
              type="button"
              onClick={handleDownloadTrace}
              disabled={!canDownloadTrace || downloadingTrace}
              title={canDownloadTrace ? 'Download the current JSONL LLM trace log' : ui.traceUnavailable}
              className="rounded border border-dark-border px-3 py-1 text-xs text-fg hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingTrace ? ui.downloadingTrace : ui.trace}
            </button>
            <button
              type="button"
              onClick={handleManualReset}
              disabled={loading}
              className="rounded border border-dark-border px-3 py-1 text-xs text-fg hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ui.reset}
            </button>
            <button
              type="button"
              onClick={handleFinishStudy}
              disabled={loading}
              className="rounded border border-primary/70 px-3 py-1 text-xs text-primary-text hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ui.finish}
            </button>
            <button
              type="button"
              onClick={() => setHeaderCollapsed(true)}
              aria-label={ui.collapseHeader}
              title={ui.collapseHeader}
              className="flex h-7 w-7 items-center justify-center rounded border border-dark-border text-fg hover:border-primary hover:text-fg-strong"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </header>

        {/*
          The inert scope starts BELOW the header on purpose. It used to wrap the
          whole layout, so every agent turn — 8,678 of them, median 2.8s — also
          disabled Reset and Finish Task and blurred the focused element. The
          participant's only escape hatches were locked exactly while they might
          have needed them.
        */}
        <div ref={interactionScopeRef} className="flex min-h-0 flex-1 flex-col">
        {/*
          On a phone this is a sheet over the booking UI, opened from the header's
          Memory button — the same state that shows the desktop side panel. It
          used to be an always-present `<details>` strip above the stage, which
          cost height on every screen whether or not it was open.
        */}
        {memorySheetOpen && (
          <div
            className="absolute inset-0 z-50 flex flex-col bg-dark/95 backdrop-blur lg:hidden"
            role="dialog"
            aria-label={ui.memory}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-dark-border px-4 py-3">
              <span className="text-sm font-semibold text-fg-strong">{ui.memory}</span>
              <button
                type="button"
                onClick={handleScenarioBriefingToggle}
                className="rounded-lg border border-dark-border px-3 py-1.5 text-xs font-medium text-fg hover:border-primary hover:text-fg-strong"
              >
                {ui.close}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
              <AgentMemoryPanel
                snapshot={agentMemory}
                currentStage={currentStage}
                showHeading={false}
              />
              {studySession?.viewToken ? (
                <div className="mt-4 space-y-4">
                  <DeviceRosterCard roster={deviceRoster?.roster ?? null} phone={phonePresence} compact />
                  <CompanionPairingCard
                    companionToken={companionToken}
                    target={voiceOutputTarget}
                    onTargetChange={setVoiceOutputTarget}
                    companionActive={companionActive}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
        {showScenarioBriefing && (
          <div className="shrink-0 border-b border-dark-border bg-dark-light px-4 py-3 lg:hidden">
            <ScenarioBriefing
              title={scenarioTitle}
              background={scenarioBackground}
              story={scenarioStory}
              stepBriefs={scenarioStepBriefs}
              narratorPreferenceTypes={scenarioPreferenceTypes}
              seatRows={scenarioSeatRows}
              compact
            />
          </div>
        )}

        {usesSplitInterface ? (
          <FullTuningSplitView
              messages={messages}
              activeSpec={activeSpec}
              isAgentTyping={isAgentTyping}
              showAgentElapsed={plannerModelAvailable}
              interactionLocked={interactionLocked}
              speakingMessageId={speakingMessageId}
              inputDisabled={inputDisabled}
              inputPlaceholder={effectiveChatInputPlaceholder}
              onSubmitInput={isAgentInteractionEnabled ? handleChatInputSubmit : undefined}
              voiceModeAvailable={voiceModeAvailable}
              voiceModeEnabled={voiceModeEnabled}
              voiceStatusLabel={voiceStatusLabel}
              voiceOutputStatus={voiceOutputStatus}
              voiceInputStatus={voiceInputStatus}
              voiceError={voiceError}
              compactLayoutEnabled={normalizedStudyModePreset === 'demo'}
              highlightVoiceToggle={highlightVoiceToggle}
              voiceToggleDisabled={voiceModeButtonDisabled}
              onToggleVoiceMode={handleVoiceModeToggle}
              voiceVerbosityLabel={voiceVerbosityLabel}
              onOpenVoiceSettings={handleOpenVoiceSettings}
              onSelect={handleSelect}
              onToggle={handleToggle}
              onRevealHidden={handleRevealHidden}
              onNext={handleNext}
              onFinishTask={handleFinishStudy}
              onBack={handleBack}
              onConfirm={handleConfirm}
            />
        ) : viewMode === 'chat' ? (
          <MessageList
            messages={messages}
            activeSpec={activeSpec}
            messageSnapshots={messageSnapshots}
            isAgentTyping={isAgentTyping}
            showAgentElapsed={plannerModelAvailable}
            speakingMessageId={speakingMessageId}
            onSelect={handleSelect}
            onToggle={handleToggle}
            onRevealHidden={handleRevealHidden}
            onNext={handleNext}
            onFinishTask={handleFinishStudy}
            onBack={handleBack}
            onConfirm={handleConfirm}
            chatWidthPx={chatWidthPx}
            isResizingWidth={isResizingChatWidth}
            onResizeStart={handleChatWidthResizeStart}
            showTurnSnapshots={showBasicTuningTurnSnapshots}
            interactionLocked={interactionLocked}
          />
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="max-w-7xl mx-auto space-y-4">
              <div className="flex flex-wrap justify-center gap-2">
                {STAGE_ORDER.map((stage, index) => {
                  const isCurrent = stage === currentStage;
                  const isPassed = index < currentStep - 1;
                  return (
                    <span
                      key={stage}
                      className={`px-2 py-1 rounded text-xs capitalize ${
                        isCurrent
                          ? 'bg-primary text-primary-fg font-semibold'
                          : isPassed
                          ? 'bg-dark-light text-fg'
                          : 'bg-dark-light text-fg-muted'
                      }`}
                    >
                      {stage}
                    </span>
                  );
                })}
              </div>

              <div className="relative h-[680px] overflow-hidden rounded-3xl border border-dark-border bg-dark-light/60">
                <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-dark-light/95 to-transparent" />
                <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-dark-light/95 to-transparent" />

                <div className="h-full w-full p-5">
                  <div
                    className="grid h-full grid-cols-3 gap-5"
                    style={{
                      transform: `translateX(${carouselOffset}px)`,
                      opacity: carouselOpacity,
                      transition: carouselTransition,
                    }}
                  >
                    <div className="h-full overflow-hidden rounded-2xl border border-dark-border bg-dark-light pointer-events-none">
                      <div className="px-4 pt-4 text-center text-xs uppercase tracking-[0.12em] text-fg-muted">
                        {previousStage ? `Previous · ${previousStage}` : 'Previous'}
                      </div>
                      {previousSpec ? (
                        <div className="h-full overflow-y-auto px-4 pb-5 pt-3 opacity-75">
                          <StageRenderer
                            spec={previousSpec}
                            onSelect={() => {}}
                            onToggle={() => {}}
                            onNext={() => {}}
                            onBack={() => {}}
                            onConfirm={() => {}}
                          />
                        </div>
                      ) : (
                        <div className="px-4 py-10 text-center text-sm text-fg-faint">{ui.noPreviousStage}</div>
                      )}
                    </div>

                    <div className="h-full overflow-hidden rounded-2xl border border-primary/45 bg-dark-light">
                      <div className="px-4 pt-4 text-center text-xs uppercase tracking-[0.12em] text-primary-text">
                        Current · {currentStage}
                      </div>
                      {activeSpec ? (
                        <div className="h-full overflow-y-auto px-4 pb-5 pt-3">
                          <StageRenderer
                            spec={activeSpec}
                            onSelect={handleSelect}
                            onToggle={handleToggle}
                            onRevealHidden={handleRevealHidden}
                            onNext={() => {
                              if (isBookingCompleteSpec(activeSpec)) {
                                void handleFinishStudy();
                                return;
                              }
                              void handleNext();
                            }}
                            onBack={handleBack}
                            onConfirm={handleConfirm}
                          />
                        </div>
                      ) : (
                        <div className="py-8 text-center text-fg-muted">{ui.loading}</div>
                      )}
                    </div>

                    <div className="h-full overflow-hidden rounded-2xl border border-dark-border bg-dark-light pointer-events-none">
                      <div className="px-4 pt-4 text-center text-xs uppercase tracking-[0.12em] text-fg-muted">
                        {nextStage ? `Next · ${nextStage}` : 'Next'}
                      </div>
                      {nextSpec ? (
                        <div className="h-full overflow-y-auto px-4 pb-5 pt-3 opacity-75">
                          <StageRenderer
                            spec={nextSpec}
                            onSelect={() => {}}
                            onToggle={() => {}}
                            onNext={() => {}}
                            onBack={() => {}}
                            onConfirm={() => {}}
                          />
                        </div>
                      ) : (
                        <div className="px-4 py-10 text-center text-sm text-fg-faint">{ui.noNextStageYet}</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="shrink-0 px-4 py-2 text-center text-fg-muted text-sm">{ui.loading}</div>
        )}

        {error && (
          <div className="shrink-0 px-4 py-2 text-center text-primary-text text-sm">Error: {error}</div>
        )}

        {isAgentInteractionEnabled && !usesSplitInterface && (
          <ChatInput
            chatWidthPx={chatWidthPx}
            disabled={inputDisabled}
            onSubmit={handleChatInputSubmit}
            voiceModeAvailable={voiceModeAvailable}
            voiceModeEnabled={voiceModeEnabled}
            voiceStatusLabel={voiceStatusLabel}
            highlightVoiceToggle={highlightVoiceToggle}
            voiceToggleDisabled={voiceModeButtonDisabled}
            onToggleVoiceMode={handleVoiceModeToggle}
            voiceVerbosityLabel={voiceVerbosityLabel}
            onOpenVoiceSettings={handleOpenVoiceSettings}
            placeholder={
              viewMode === 'chat'
                ? effectiveChatInputPlaceholder
                : 'Carousel mode: input is available here as well'
            }
          />
        )}
        </div>
      </div>
      </div>

      {settingsOpen ? (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          voiceSettingsAvailable={voiceModeAvailable}
          voiceVerbosity={voiceVerbosity}
          onPresetChange={handleVerbosityPresetChange}
          onCategoryChange={handleVerbosityCategoryChange}
          onSmartSkipChange={handleVerbositySmartSkipChange}
          voiceGateStats={voiceGateStats}
          plannerModelAvailable={plannerModelAvailable}
          plannerModel={plannerModelSetting.model}
          onPlannerModelChange={plannerModelSetting.handleChange}
          plannerTurnStats={plannerTurnStats}
        />
      ) : null}
    </div>
  );
}
