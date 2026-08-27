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
  isBookingCompleteMeta,
  type ConfirmMeta,
  type DataItem,
  type UISpec,
  type Stage,
  type WorkflowSelectionState,
} from '../spec';
import { MessageList, FullTuningSplitView, ChatInput } from '../components/chat';
import { AgentMemoryPanel, createMemoryPublisher } from '../components/memory';
import { ScenarioBriefing } from '../components/scenario/ScenarioBriefing';
import { StageRenderer } from '../renderer';
import {
  useToolHandler,
  useAgentBridge,
  useStudyInteractionLogger,
  useRealtimeVoice,
} from '../hooks';
import type { VoiceSpeakItem } from '../hooks/useRealtimeVoice';
import { agentTools, type ToolDefinition } from '../agent/tools';
import { getStudyModeConfig, normalizeStudyMode, type StudyModeId } from './studyOptions';
import type { Movie, Theater, Showing, Booking } from '../types';
import { formatScenarioTitle, formatTime12Hour } from '../utils/displayFormats';
import { getFixedCurrentDate } from '../utils/studyDate';
import type { StudySessionState } from '../study/sessionStorage';
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
type SupportedSttLanguage = 'en';
interface ChatPageProps {
  studyModePreset?: StudyModeId;
  studySession?: StudySessionState | null;
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
const SHORT_VOICE_INPUT_MAX_DURATION_MS = 300;
const SHORT_VOICE_INPUT_MAX_CHARS = 2;
const MEANINGFUL_SHORT_VOICE_TOKENS = new Set(['no', 'ok']);
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
const SCENARIO_BRIEFING_VISIBLE_STORAGE_KEY = 'tuning-movie-scenario-briefing-visible';
const HEADER_HEIGHT_STORAGE_KEY = 'tuning-movie-header-height';
const DEFAULT_HEADER_HEIGHT_PX = 44;
const MIN_HEADER_HEIGHT_PX = 0;
const MAX_HEADER_HEIGHT_PX = 80;
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

function normalizeVoiceTranscriptToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^a-z0-9\u3131-\u318e\uac00-\ud7a3]+|[^a-z0-9\u3131-\u318e\uac00-\ud7a3]+$/gi, '')
    .trim();
}

function isLikelyFillerToken(token: string): boolean {
  if (!token) return false;

  return (
    /^u+h+$/.test(token) ||
    /^u+m+$/.test(token) ||
    /^e+r+m+$/.test(token) ||
    /^h+m+$/.test(token) ||
    /^m+m+$/.test(token) ||
    /^a+h+$/.test(token)
  );
}

function containsHangul(text: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/.test(text);
}

function getNormalizedVoiceTranscriptTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeVoiceTranscriptToken)
    .filter(Boolean);
}

function getIgnoredVoiceTranscriptReason(
  text: string,
  durationMs: number
): 'non_english' | 'filler_only' | 'too_short' | null {
  if (containsHangul(text)) return 'non_english';

  const normalizedTokens = getNormalizedVoiceTranscriptTokens(text);
  if (normalizedTokens.length === 0) return 'too_short';
  if (normalizedTokens.every((token) => isLikelyFillerToken(token))) {
    return 'filler_only';
  }

  if (
    durationMs <= SHORT_VOICE_INPUT_MAX_DURATION_MS &&
    normalizedTokens.length === 1 &&
    normalizedTokens[0].length <= SHORT_VOICE_INPUT_MAX_CHARS &&
    !MEANINGFUL_SHORT_VOICE_TOKENS.has(normalizedTokens[0])
  ) {
    return 'too_short';
  }

  return null;
}

function getVoiceStatusLabel(params: {
  voiceModeEnabled: boolean;
  voiceInputSupported: boolean;
  voiceInputStatus: string;
  voiceOutputStatus: string;
  hasLiveAgentSession: boolean;
}): string | null {
  const {
    voiceModeEnabled,
    voiceInputSupported,
    voiceInputStatus,
    voiceOutputStatus,
    hasLiveAgentSession,
  } = params;

  if (!voiceModeEnabled) return null;
  if (!voiceInputSupported) return 'Voice unavailable';
  if (voiceOutputStatus === 'synthesizing') return 'Generating voice...';
  if (voiceOutputStatus === 'playing') return 'Playing reply...';

  switch (voiceInputStatus) {
    case 'requesting-permission':
      return 'Allow microphone access...';
    case 'capturing':
      return 'Listening...';
    case 'transcribing':
      return 'Transcribing...';
    case 'suspended':
      return hasLiveAgentSession
        ? 'Waiting for agent...'
        : 'Waiting for session...';
    case 'listening':
      return hasLiveAgentSession ? 'Listening...' : 'Waiting for session...';
    case 'error':
      return 'Voice error';
    case 'unsupported':
      return 'Voice unavailable';
    default:
      return hasLiveAgentSession ? 'Voice ready' : 'Waiting for session...';
  }
}


function buildVoiceTranscriptionPrompt(
  spec: UISpec | null,
  fallbackStage: Stage
): string | undefined {
  if (!spec) return undefined;

  const stage = spec.stage ?? fallbackStage;
  const rawLabels = Array.isArray(spec.visibleItems) ? spec.visibleItems : [];
  const hints = Array.from(
    new Set(
      rawLabels
        .map((visibleItem) => {
          const raw = typeof visibleItem?.value === 'string' ? visibleItem.value.trim() : '';
          if (!raw) return null;
          if (stage === 'seat') {
            // "C1 - Standard - $14.00" → "C1"
            return raw.split(/\s*-\s*/)[0].trim() || null;
          }
          // date/calendar: displayText 그대로 유지 (사용자가 "Friday", "March 13" 등으로 말할 수 있음)
          // 나머지: augment된 visibleItems value 그대로 유지 (화면에 표시되는 텍스트)
          return raw;
        })
        .filter((entry): entry is string => Boolean(entry))
    )
  );

  if (hints.length === 0) return undefined;

  const limitedHints: string[] = [];
  let totalLength = 0;
  for (const hint of hints.slice(0, MAX_STT_HINT_OPTIONS)) {
    const nextLength = totalLength + hint.length + (limitedHints.length > 0 ? 2 : 0);
    if (nextLength > MAX_STT_HINT_TEXT_LENGTH) break;
    limitedHints.push(hint);
    totalLength = nextLength;
  }

  if (limitedHints.length === 0) return undefined;

  const hintList = limitedHints.join(', ');

  const base = 'Transcribe only what is actually spoken. Do not add words that are not in the audio. If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. If the speech is unclear, transcribe the closest recognizable words only. The user may reply with short conversational responses like "yes", "no", "sure", "go back", "that one", or "sounds good" — transcribe these as-is without forcing a match to the options below.';

  if (stage === 'seat') {
    return `${base} The user is choosing a seat. Preserve letter-number labels like A1, B5, F6 exactly. Possible labels: ${hintList}.`;
  }

  const stageContext: Record<string, string> = {
    movie: 'The user is choosing a movie',
    theater: 'The user is choosing a theater',
    date: 'The user is choosing a date',
    time: 'The user is choosing a showtime',
    confirm: 'The user is confirming a booking',
  };
  const context = stageContext[stage] ?? 'The user is choosing an option';

  return `${base} ${context}. Possible options on screen: ${hintList}.`;
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
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
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
  const [scenarioBriefingVisible, setScenarioBriefingVisible] = useState<boolean>(() =>
    readStoredBoolean(SCENARIO_BRIEFING_VISIBLE_STORAGE_KEY, true)
  );
  const [isResizingScenarioPanelWidth, setIsResizingScenarioPanelWidth] = useState(false);
  const [headerHeightPx, setHeaderHeightPx] = useState(() =>
    readStoredNonNegativeInt(HEADER_HEIGHT_STORAGE_KEY, DEFAULT_HEADER_HEIGHT_PX)
  );
  const [isResizingHeaderHeight, setIsResizingHeaderHeight] = useState(false);
  const [awaitingAgentResponse, setAwaitingAgentResponse] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [downloadingLog, setDownloadingLog] = useState(false);
  const [downloadingTrace, setDownloadingTrace] = useState(false);

  const initialized = useRef(false);
  const appliedStudyModePresetRef = useRef<StudyModeId | null>(null);
  const previousStageRef = useRef<Stage>(currentStage);
  const seenPreferenceMentionsRef = useRef<Map<string, string>>(new Map());
  const interactionScopeRef = useRef<HTMLDivElement | null>(null);
  const chatResizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const scenarioPanelResizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(
    null
  );
  const headerResizeSessionRef = useRef<{ startY: number; startHeight: number } | null>(null);
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
  const voiceModeAvailable = studyModeConfig?.voiceModeAvailable ?? false;
  const sttLanguage: SupportedSttLanguage = 'en';
  const scenarioTitle = studySession?.scenario.title
    ? formatScenarioTitle(studySession.scenario.title)
    : 'Scenario';
  const scenarioBackground = studySession?.scenario.background ?? '';
  const scenarioStory = studySession?.scenario.story ?? '';
  const scenarioStepBriefs = studySession?.scenario.stepBriefs ?? {};
  const scenarioPreferenceTypes = studySession?.scenario.narratorPreferenceTypes ?? [];
  const scenarioSeatRows = studySession?.scenario.seatRows ?? [];
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

  const stopHeaderHeightResize = useCallback(() => {
    headerResizeSessionRef.current = null;
    setIsResizingHeaderHeight(false);
    if (typeof document !== 'undefined') {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  const handleHeaderHeightResizeMove = useCallback(
    (event: PointerEvent) => {
      const session = headerResizeSessionRef.current;
      if (!session) return;
      const nextHeight = session.startHeight + (event.clientY - session.startY);
      setHeaderHeightPx(Math.min(Math.max(nextHeight, MIN_HEADER_HEIGHT_PX), MAX_HEADER_HEIGHT_PX));
    },
    []
  );

  const handleHeaderHeightResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      headerResizeSessionRef.current = {
        startY: event.clientY,
        startHeight: headerHeightPx,
      };
      setIsResizingHeaderHeight(true);
      if (typeof document !== 'undefined') {
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
      }
    },
    [headerHeightPx]
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
            const dateItems = createDateItems(getFixedCurrentDate(), 5, data.dates);
            const spec = buildStageSpec(
              'date',
              generateDateSpec(dateItems, workflowCtx.movie.id, workflowCtx.theater.id),
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
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    },
    [activeSpec, addSystemMessage, setBackendData, setUiSpec]
  );

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      loadStageData('movie', { workflow: {}, restoreSnapshot: false });
    }
  }, [loadStageData]);

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
    writeStorageValue(HEADER_HEIGHT_STORAGE_KEY, String(headerHeightPx));
  }, [headerHeightPx]);

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

  useEffect(() => {
    if (!isResizingHeaderHeight) return;
    const handlePointerUp = () => {
      stopHeaderHeightResize();
    };
    window.addEventListener('pointermove', handleHeaderHeightResizeMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handleHeaderHeightResizeMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isResizingHeaderHeight, handleHeaderHeightResizeMove, stopHeaderHeightResize]);

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
      setError(err instanceof Error ? err.message : 'Booking failed');
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

  const handleAgentToolCall = useCallback((
    toolName: string,
    params: Record<string, unknown>,
    context?: ToolApplyContext
  ) => {
    if (!agentStatusSupportedRef.current) {
      setAwaitingAgentResponse(false);
    }
    return onToolApply(toolName, params, context);
  }, [onToolApply]);

  // The voice session is declared further down, once the relay state it needs
  // exists. These stable shims let the callbacks above reach it.
  const voiceSpeakRef = useRef<((item: VoiceSpeakItem) => void) | null>(null);
  const voiceStopRef = useRef<(() => void) | null>(null);
  const speakAgentMessage = useCallback((item: VoiceSpeakItem) => {
    voiceSpeakRef.current?.(item);
  }, []);
  const stopAgentSpeech = useCallback(() => {
    voiceStopRef.current?.();
  }, []);

  const handleAgentMessage = useCallback((text: string) => {
    const normalizedText = text.trim();
    if (!normalizedText) return;
    setAwaitingAgentResponse(false);
    const stage = activeSpec?.stage ?? currentStage;
    const messageId = addAgentMessage(stage, normalizedText, activeSpec);
    // The transcript keeps the original wording; only the spoken copy gets
    // abbreviations expanded.
    speakAgentMessage({ id: messageId, text: expandTtsAbbreviations(normalizedText) });
  }, [activeSpec, currentStage, addAgentMessage, speakAgentMessage]);

  const {
    sendUserMessageToAgent,
    sendSessionResetToAgent,
    sendVoiceModeChange,
    sendTtsPlaybackComplete,
    isConnected: isAgentBridgeConnected,
    isJoined: isAgentBridgeJoined,
    connectedAgents,
    agentActivityPhase,
    agentStatusSupported,
    agentMemory,
  } = useAgentBridge({
    uiSpec: activeSpec,
    messageHistory: messages,
    toolSchema: agentToolSchema,
    guiAdaptationEnabled,
    plannerCpMemoryLimit,
    sessionId: studySession?.relaySessionId,
    studyToken: studySession?.studyToken,
    enabled: isAgentInteractionEnabled && Boolean(studySession),
    onToolCall: handleAgentToolCall,
    onAgentMessage: handleAgentMessage,
    onSessionEnd: handleSessionReset,
  });

  useEffect(() => {
    agentStatusSupportedRef.current = agentStatusSupported;
  }, [agentStatusSupported]);

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

  useEffect(() => {
    sendVoiceModeChange(voiceModeEnabled);
  }, [voiceModeEnabled, sendVoiceModeChange]);

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

    const stage = activeSpec?.stage ?? currentStage;
    logDerivedEvents(
      buildConflictSignalEvents({
        stage,
        source: 'agent',
        messageText: normalizedText,
      })
    );
    const messageId = addAgentMessage(stage, normalizedText, activeSpec);
    speakAgentMessage({ id: messageId, text: expandTtsAbbreviations(normalizedText) });
  }, [activeSpec, currentStage, addAgentMessage, logDerivedEvents, speakAgentMessage]);

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
    ? 'Loading the next stage...'
    : 'Waiting for the next agent message...';
  const chatInputPlaceholder =
    interactionLocked
      ? interactionLockLabel
      : !isAgentBridgeConnected
      ? 'Waiting for agent relay connection...'
      : !isAgentBridgeJoined
      ? 'Joining agent session...'
      : !hasConnectedAgent
      ? 'Waiting for an external agent to connect...'
      : 'Send a message...';
  const {
    supported: voiceInputSupported,
    inputStatus: voiceInputStatus,
    outputStatus: voiceOutputStatus,
    error: voiceSessionError,
    speak: speakOverVoiceSession,
    stop: stopVoiceSession,
  } = useRealtimeVoice({
    enabled: voiceModeEnabled && isAgentInteractionEnabled,
    // Only session liveness gates delivery. Suspending while the agent is busy
    // would drop exactly the transcripts barge-in exists to capture, and the
    // agent already defers a replan when a message arrives mid-turn.
    suspended: !hasLiveAgentSession,
    transcriptionPrompt: buildVoiceTranscriptionPrompt(activeSpec, currentStage) ?? null,
    createSession: api.createRealtimeVoiceSession,
    onTranscript: ({ text, durationMs }) => {
      const normalizedTranscript = text.trim();
      if (!normalizedTranscript) return;

      const ignoredReason = getIgnoredVoiceTranscriptReason(normalizedTranscript, durationMs);
      if (ignoredReason) {
        logStudyEvent('chat.voice_input.ignored', {
          language: sttLanguage,
          durationMs,
          reason: ignoredReason,
          text: normalizedTranscript,
        });
        return;
      }

      submitChatInputRef.current?.(normalizedTranscript, 'voice');
    },
    onSpeakingItemChange: (item) => {
      setSpeakingMessageId(item?.id ?? null);
    },
    onPlaybackComplete: (item, { interrupted }) => {
      sendTtsPlaybackComplete({ interrupted, messageId: item.id });
    },
    onLogEvent: logStudyEvent,
  });

  useEffect(() => {
    voiceSpeakRef.current = speakOverVoiceSession;
    voiceStopRef.current = stopVoiceSession;
  }, [speakOverVoiceSession, stopVoiceSession]);

  const voiceStatusLabel = getVoiceStatusLabel({
    voiceModeEnabled,
    voiceInputSupported,
    voiceInputStatus,
    voiceOutputStatus,
    hasLiveAgentSession,
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
      ? 'Voice unavailable'
      : voiceModeAvailable && !voiceModeEnabled
      ? 'Tap mic for voice'
      : voiceModeEnabled && hasLiveAgentSession
      ? 'Speak now...'
      : voiceModeEnabled
      ? 'Waiting for session...'
      : chatInputPlaceholder;
  const highlightVoiceToggle =
    voiceModeAvailable && !voiceModeEnabled && effectiveChatInputPlaceholder === 'Tap mic for voice';

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
  const showScenarioBriefing = hasScenarioBriefing && scenarioBriefingVisible;
  const canDownloadLog = Boolean(studySession?.interactionLogFile);
  const canDownloadTrace = Boolean(studySession?.interactionLogFile);

  const handleDownloadLog = useCallback(async () => {
    if (!studySession?.studyToken || !canDownloadLog || downloadingLog) return;

    setDownloadingLog(true);
    setError(null);

    await logStudyEventNow('study.control.log_download_requested', {
      source: 'participant',
    });

    try {
      const result = await api.downloadStudyLog(studySession.studyToken);
      const downloadUrl = window.URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download =
        result.fileName ??
        studySession.interactionLogFile?.split('/').pop() ??
        'study-interaction-log.jsonl';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download interaction log');
    } finally {
      setDownloadingLog(false);
    }
  }, [canDownloadLog, downloadingLog, logStudyEventNow, studySession]);

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
    <div className="relative h-screen bg-dark">
      <div className="flex h-full min-h-0">
      {showScenarioBriefing && (
        <aside
          className="relative hidden shrink-0 border-r border-dark-border bg-dark-light lg:block"
          style={{ width: scenarioPanelWidthPx }}
        >
          <div
            className={`relative h-full overflow-y-auto p-4 ${
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? 'select-none' : ''
            }`}
            style={
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED
                ? {
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                  }
                : undefined
            }
            onCopyCapture={
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? preventDefault : undefined
            }
            onCutCapture={
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? preventDefault : undefined
            }
            onContextMenu={
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? preventDefault : undefined
            }
            onDragStart={
              SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? preventDefault : undefined
            }
          >
            <ScenarioBriefing
              title={scenarioTitle}
              background={scenarioBackground}
              story={scenarioStory}
              stepBriefs={scenarioStepBriefs}
              narratorPreferenceTypes={scenarioPreferenceTypes}
              seatRows={scenarioSeatRows}
            />
            {SCENARIO_BRIEFING_COPY_GUARD_ENABLED ? (
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

	      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <header
          className="relative shrink-0 border-b border-dark-border bg-dark px-4 overflow-hidden"
          style={{ height: `${headerHeightPx}px` }}
        >
          <div className="mx-auto flex h-full w-full items-center justify-end gap-2 overflow-x-auto whitespace-nowrap [&>*]:shrink-0">
            <button
              type="button"
              onClick={handleManualReset}
              disabled={loading}
              className="px-3 py-1 text-xs rounded border border-dark-border text-fg hover:text-fg-strong hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset
            </button>
            {hasScenarioBriefing ? (
              <button
                type="button"
                onClick={handleScenarioBriefingToggle}
                className="px-3 py-1 text-xs rounded border border-dark-border text-fg hover:text-fg-strong hover:border-primary"
              >
                {showScenarioBriefing ? 'Hide Scenario' : 'Show Scenario'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleDownloadLog}
              disabled={!canDownloadLog || downloadingLog}
              title={
                canDownloadLog
                  ? 'Download the current JSONL interaction log'
                  : 'Interaction log is unavailable for this session'
              }
              className="px-3 py-1 text-xs rounded border border-dark-border text-fg hover:text-fg-strong hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingLog ? 'Downloading...' : 'Download Log'}
            </button>
            <button
              type="button"
              onClick={handleDownloadTrace}
              disabled={!canDownloadTrace || downloadingTrace}
              title={
                canDownloadTrace
                  ? 'Download the current JSONL LLM trace log'
                  : 'LLM trace log is unavailable for this session'
              }
              className="px-3 py-1 text-xs rounded border border-dark-border text-fg hover:text-fg-strong hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingTrace ? 'Downloading Trace...' : 'Download Trace'}
            </button>
            <button
              type="button"
              onClick={handleFinishStudy}
              disabled={loading}
              className="px-3 py-1 text-xs rounded border border-primary/70 text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Finish Task
            </button>
          </div>
          <button
            type="button"
            aria-label="Resize header height"
            title="Drag to resize header height"
            onPointerDown={handleHeaderHeightResizeStart}
            className="absolute bottom-0 left-0 flex w-full h-3 translate-y-1/2 cursor-ns-resize z-10"
          >
            <span
              className={`absolute top-1/2 left-1/2 w-10 h-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                isResizingHeaderHeight
                  ? 'bg-primary'
                  : 'bg-dark-border hover:bg-dark-lighter'
              }`}
            />
          </button>
        </header>

        {/*
          The inert scope starts BELOW the header on purpose. It used to wrap the
          whole layout, so every agent turn — 8,678 of them, median 2.8s — also
          disabled Reset and Finish Task and blurred the focused element. The
          participant's only escape hatches were locked exactly while they might
          have needed them.
        */}
        <div ref={interactionScopeRef} className="flex min-h-0 flex-1 flex-col">
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
          <div className={showMemoryPanel ? 'flex min-h-0 flex-1' : 'contents'}>
            <FullTuningSplitView
              messages={messages}
              activeSpec={activeSpec}
              isAgentTyping={isAgentTyping}
              interactionLocked={interactionLocked}
              speakingMessageId={speakingMessageId}
              inputDisabled={inputDisabled}
              inputPlaceholder={effectiveChatInputPlaceholder}
              onSubmitInput={isAgentInteractionEnabled ? handleChatInputSubmit : undefined}
              voiceModeAvailable={voiceModeAvailable}
              voiceModeEnabled={voiceModeEnabled}
              voiceStatusLabel={voiceStatusLabel}
              highlightVoiceToggle={highlightVoiceToggle}
              voiceToggleDisabled={voiceModeButtonDisabled}
              onToggleVoiceMode={handleVoiceModeToggle}
              onSelect={handleSelect}
              onToggle={handleToggle}
              onNext={handleNext}
              onFinishTask={handleFinishStudy}
              onBack={handleBack}
              onConfirm={handleConfirm}
            />
            {showMemoryPanel && (
              <aside className="hidden w-[21rem] shrink-0 overflow-y-auto border-l border-dark-border bg-dark px-4 py-4 xl:block">
                <AgentMemoryPanel snapshot={agentMemory} currentStage={currentStage} />
              </aside>
            )}
          </div>
        ) : viewMode === 'chat' ? (
          <MessageList
            messages={messages}
            activeSpec={activeSpec}
            messageSnapshots={messageSnapshots}
            isAgentTyping={isAgentTyping}
            speakingMessageId={speakingMessageId}
            onSelect={handleSelect}
            onToggle={handleToggle}
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
                          : 'bg-dark-border text-fg-faint'
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
                        <div className="px-4 py-10 text-center text-sm text-fg-faint">No previous stage</div>
                      )}
                    </div>

                    <div className="h-full overflow-hidden rounded-2xl border border-primary/45 bg-dark-light">
                      <div className="px-4 pt-4 text-center text-xs uppercase tracking-[0.12em] text-primary">
                        Current · {currentStage}
                      </div>
                      {activeSpec ? (
                        <div className="h-full overflow-y-auto px-4 pb-5 pt-3">
                          <StageRenderer
                            spec={activeSpec}
                            onSelect={handleSelect}
                            onToggle={handleToggle}
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
                        <div className="py-8 text-center text-fg-muted">Loading...</div>
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
                        <div className="px-4 py-10 text-center text-sm text-fg-faint">No next stage yet</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="shrink-0 px-4 py-2 text-center text-fg-muted text-sm">Loading...</div>
        )}

        {error && (
          <div className="shrink-0 px-4 py-2 text-center text-primary text-sm">Error: {error}</div>
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
    </div>
  );
}
