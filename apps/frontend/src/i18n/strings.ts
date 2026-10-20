/**
 * The screen's own words, in every language the booth offers.
 *
 * Scope is the booking surface a booth visitor actually touches: the stages,
 * the action bar, the breadcrumb, the chat input and the status line. The study
 * operator's surfaces — session setup, dev tools, the surveys — stay English on
 * purpose. The surveys in particular are a measurement instrument; translating
 * them would make their responses incomparable to the recorded English ones.
 *
 * English and Korean are complete `UiStrings` tables, so adding a key is a type
 * error until both have it — those are the two the recorded study ran in.
 *
 * Every other language is an overlay: `{ ...EN, ...overrides }`, where the
 * overrides are a `Partial<UiStrings>` holding only what has been translated.
 * Anything not in an overlay reads in English. Filling in a translation is
 * therefore adding a key to that language's `*_OVERRIDES` table and nothing
 * else; `language.check.ts` checks each override's script, not the merged
 * table, so the English fallback is never mistaken for a translation.
 */

import type { Language } from './language';

/** Sun-first, matching the calendar grid's column order. */
export type WeekdayNames = readonly [string, string, string, string, string, string, string];

/**
 * GUI tools the agent can be seen applying, plus the two stage moves and a
 * catch-all for a tool the UI has no phrase for.
 */
export type AgentStepKey =
  | 'select'
  | 'selectMultiple'
  | 'filter'
  | 'sort'
  | 'highlight'
  | 'augment'
  | 'clearModification'
  | 'next'
  | 'prev'
  | 'movedNext'
  | 'movedBack'
  | 'updatedGui'
  | 'other';

export interface UiStrings {
  // Action bar and stage chrome
  back: string;
  continue: string;
  confirmBooking: string;
  finishTask: string;
  bookingComplete: string;
  bookingConfirmed: string;
  noPreviousStage: string;
  noNextStageYet: string;

  // Confirm-stage summary rows
  summaryMovie: string;
  summaryTheater: string;
  summaryDateTime: string;
  summarySeats: string;
  summaryTotal: string;

  // Calendar and seat-map legends
  weekdayShort: WeekdayNames;
  legendAvailable: string;
  legendSelected: string;
  legendUnavailable: string;
  legendOccupied: string;
  legendPremium: string;
  legendStandard: string;

  // Breadcrumb
  stepMovie: string;
  stepTheater: string;
  stepDate: string;
  stepTime: string;
  stepSeat: string;
  stepConfirm: string;

  // Chat input
  inputPlaceholder: string;
  voice: string;
  turnOnVoice: string;
  turnOffVoice: string;
  /**
   * The label over a GUI step in the demo's split view and its timeline
   * markers: who did it and what. One full phrase per tool rather than an
   * actor + verb pair, because Korean puts the actor particle and the verb
   * ending where English puts neither.
   */
  agentStepLabels: Record<AgentStepKey, string>;
  voiceSettingsTitle: string;
  voiceSettingsHint: string;

  // Filtered-list controls
  showAll: string;
  showLess: string;
  hideFilteredOut: string;
  /** `{count}` is replaced with how many items the filter is hiding. */
  filteredItemsHidden: string;
  hiddenByFilter: string;

  // Status line
  allowMicrophoneAccess: string;
  listening: string;
  speakNow: string;
  transcribing: string;
  generatingVoice: string;
  playingReply: string;
  voiceReady: string;
  voiceError: string;
  voiceUnavailable: string;
  tapMicForVoice: string;
  waitingForAgent: string;
  waitingForSession: string;
  waitingForRelay: string;
  waitingForExternalAgent: string;
  sendAMessage: string;
  joiningAgentSession: string;
  loadingNextStage: string;
  agentWorking: string;
  loading: string;

  // Errors the visitor can actually hit
  failedToLoadData: string;
  bookingFailed: string;

  // Header controls and the settings modal
  languageLabel: string;
  plannerModelLabel: string;
  plannerModelDefault: string;
  plannerModelHint: string;
  plannerModelDefaultHint: string;
  plannerModelStatsTitle: string;
  /** `{seconds}` and `{turns}` are replaced. */
  plannerModelStatsAvg: string;
  /** `{seconds}` is replaced. */
  plannerModelStatsLast: string;
  settings: string;
  settingsTitle: string;
  close: string;
  memory: string;
  showMemory: string;
  hideMemory: string;
  trace: string;
  downloadingTrace: string;
  traceUnavailable: string;
  reset: string;
  finish: string;
  collapseHeader: string;
  expandHeader: string;
  openConversation: string;
  pairPhoneTitle: string;
  pairPhoneHint: string;
  mirrorWaiting: string;
  mirrorEnded: string;
  mirrorTitle: string;
  companionTitle: string;
  companionTakeVoice: string;
  companionHandBack: string;
  /** Paired, but the kiosk has not reached the booking screen yet. */
  companionWaitingHost: string;
  companionMemoryWaiting: string;

  // Who is attached to this session
  memoryForget: string;
  memoryForgetConfirm: string;
  memoryRestore: string;
  memoryForgetAll: string;
  memoryForgetAllConfirm: string;
  // The memory panel's own copy (chips, tabs, banners)
  memoryEmpty: string;
  memoryConflict: string;
  memoryBacktracking: string;
  /** `{stage}` is replaced with the stage name. */
  memoryBacktrackTo: string;
  memoryTabPreferences: string;
  memoryTabWorkflow: string;
  memoryNoPreferences: string;
  memoryForgotten: string;
  memoryHard: string;
  memorySoft: string;
  /** `{stages}` is replaced with the stage names. */
  memoryAppliesTo: string;
  // The preset picker on the setup screen
  presetStartEmpty: string;
  presetStartEmptyBlurb: string;
  presetPreviewTitle: string;
  presetPreviewNote: string;
  // The briefing card the booking screen opens with when memory is preloaded
  briefingTitle: string;
  briefingBody: string;
  briefingStart: string;
  briefingStartEmpty: string;
  briefingNothingLeft: string;
  /** Label on the chips that name the memory behind a GUI adaptation. */
  adaptationFromMemory: string;
  /** Same chip row, for a preference the visitor stated in this conversation. */
  adaptationFromConversation: string;
  devicesTitle: string;
  deviceKiosk: string;
  devicePhone: string;
  deviceAgent: string;
  deviceScreens: string;
  deviceConnected: string;
  deviceNotConnected: string;
  deviceWaiting: string;
  deviceChecking: string;
  deviceDropped: string;
  deviceDroppedSilent: string;
  deviceSwapped: string;
  companionTapToStart: string;
  companionConnecting: string;
  companionUnpaired: string;
  companionNoToken: string;
  companionUnsupported: string;
  companionOnKiosk: string;
  companionListening: string;
  companionHearing: string;
  companionSpeaking: string;
  companionMicPermission: string;
  companionReady: string;
  pairVoiceTitle: string;
  pairVoiceHint: string;
  voiceTargetKiosk: string;
  voiceTargetCompanion: string;
  voiceTargetLabel: string;
  voiceTargetPhoneWaiting: string;

  // Demo setup, the first screen a booth visitor sees
  demoSetupTitle: string;
  demoSetupSubtitle: string;
  /** Link from the setup screen to /about. */
  aboutDemoLink: string;
  demoModeOn: string;
  accessCodeLabel: string;
  apiKeyLabel: string;
  /** The credential chip on the setup screen and the dialog behind it. */
  credentialMissing: string;
  credentialReadyCode: string;
  credentialReadyKey: string;
  credentialChange: string;
  credentialDialogTitle: string;
  credentialSavedCode: string;
  credentialSavedKey: string;
  credentialUse: string;
  credentialRemove: string;
  micCheck: string;
  watchTutorial: string;
  startDemo: string;
  demoPrivacyNote: string;

  // Research-recording consent, asked once on that first screen
  consentTitle: string;
  consentCheckboxLabel: string;
  consentBody: string;
  consentOptOutNote: string;

  // Preference memory the demo session opens with
  preferenceMemoryTitle: string;
  preferenceMemoryBody: string;

  // The scanned quick-demo card: one stage, one sentence, no setup
  quickCardKicker: string;
  quickCardSayThis: string;
  quickCardWatchFor: string;
  quickCardStart: string;
  quickCardPreparing: string;
  quickCardMicNote: string;
  quickCardNoRecording: string;
  quickCardUnknownLink: string;
  quickCardCodePrompt: string;
  quickCardFailed: string;
  quickCardFullDemoLink: string;
  quickCardGalleryTitle: string;
  quickCardGalleryHint: string;

  // The pairing screen between "start" and the booking UI
  pairReadyTitle: string;
  preparingDemo: string;
  startBooking: string;
  pairingLanguageLabel: string;
  pairingLanguageHint: string;

  /**
   * BCP-47 tag for `toLocaleString`. The calendar's month heading is formatted
   * rather than translated, so it needs a locale and not a string.
   */
  locale: string;
}

const EN: UiStrings = {
  back: 'Back',
  continue: 'Continue',
  confirmBooking: 'Confirm Booking',
  finishTask: 'Finish Task',
  bookingComplete: 'Booking Complete',
  bookingConfirmed: 'Booking Confirmed!',
  noPreviousStage: 'No previous stage',
  noNextStageYet: 'No next stage yet',

  summaryMovie: 'Movie',
  summaryTheater: 'Theater',
  summaryDateTime: 'Date & Time',
  summarySeats: 'Seats',
  summaryTotal: 'Total',

  weekdayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  legendAvailable: 'Available',
  legendSelected: 'Selected',
  legendUnavailable: 'Unavailable',
  legendOccupied: 'Occupied',
  legendPremium: 'Premium',
  legendStandard: 'Standard',

  stepMovie: 'Movie',
  stepTheater: 'Theater',
  stepDate: 'Date',
  stepTime: 'ShowTime',
  stepSeat: 'Seat',
  stepConfirm: 'Confirm',

  inputPlaceholder: 'Type a message...',
  voice: 'Voice',
  turnOnVoice: 'Turn on voice mode',
  turnOffVoice: 'Turn off voice mode',
  agentStepLabels: {
    select: 'Agent is selecting',
    selectMultiple: 'Agent is selecting multiple seats',
    filter: 'Agent is filtering',
    sort: 'Agent is sorting',
    highlight: 'Agent is highlighting',
    augment: 'Agent is updating labels',
    clearModification: 'Agent is clearing modifications',
    next: 'Agent is moving to the next stage',
    prev: 'Agent is going back',
    movedNext: 'Agent moved to the next stage',
    movedBack: 'Agent went back',
    updatedGui: 'Agent updated the GUI',
    other: 'Agent is applying a change',
  },
  voiceSettingsTitle: 'Voice verbosity settings',
  voiceSettingsHint: 'Choose how much the agent says out loud',

  showAll: 'Show all',
  showLess: 'Show less',
  hideFilteredOut: 'Hide filtered-out items',
  filteredItemsHidden: '{count} filtered item(s) hidden. Show all items.',
  hiddenByFilter: 'Hidden by a filter. Selecting it will clear that filter.',

  allowMicrophoneAccess: 'Allow microphone access...',
  listening: 'Listening...',
  speakNow: 'Speak now...',
  transcribing: 'Transcribing...',
  generatingVoice: 'Generating voice...',
  playingReply: 'Playing reply...',
  voiceReady: 'Voice ready',
  voiceError: 'Voice error',
  voiceUnavailable: 'Voice unavailable',
  tapMicForVoice: 'Tap mic for voice',
  waitingForAgent: 'Waiting for agent...',
  waitingForSession: 'Waiting for session...',
  waitingForRelay: 'Waiting for agent relay connection...',
  waitingForExternalAgent: 'Waiting for an external agent to connect...',
  sendAMessage: 'Send a message...',
  joiningAgentSession: 'Joining agent session...',
  loadingNextStage: 'Loading the next stage...',
  agentWorking: 'Agent working',
  loading: 'Loading...',

  failedToLoadData: 'Failed to load data',
  bookingFailed: 'Booking failed',

  languageLabel: 'Language',
  plannerModelLabel: 'Planner model',
  plannerModelDefault: 'Server default',
  plannerModelHint:
    'The model that decides what the agent does and says. Takes effect from the next turn; the voice itself is unaffected.',
  plannerModelDefaultHint: 'Whatever this deployment is configured with. Pick a model to compare it.',
  plannerModelStatsTitle: 'This session',
  plannerModelStatsAvg: '{seconds}s avg · {turns} turn(s)',
  plannerModelStatsLast: 'last {seconds}s',
  settings: 'Settings',
  settingsTitle: 'Settings',
  close: 'Close',
  memory: 'Memory',
  showMemory: 'Show what the agent remembers',
  hideMemory: 'Hide what the agent remembers',
  trace: 'Trace',
  downloadingTrace: 'Downloading...',
  traceUnavailable: 'No trace is being recorded for this session',
  reset: 'Reset',
  finish: 'Finish',
  collapseHeader: 'Hide the toolbar',
  expandHeader: 'Show the toolbar',
  openConversation: 'Open the conversation',
  pairPhoneTitle: 'Watch on your phone',
  pairPhoneHint: 'Scan to follow what the agent remembers on a second device. It is read-only — the booking stays here.',
  mirrorWaiting: 'Waiting for the session. This screen will follow along.',
  mirrorEnded: 'The session this screen was mirroring has ended.',
  mirrorTitle: 'What the agent remembers',
  companionTitle: 'Phone voice',
  companionTakeVoice: 'Use this phone',
  companionHandBack: 'Back to the headset',
  companionWaitingHost: 'Waiting for the kiosk to start the booking.',
  companionMemoryWaiting: 'What the agent remembers will appear here.',

  memoryForget: 'Forget',
  memoryForgetConfirm: 'Confirm?',
  memoryRestore: 'Restore',
  memoryForgetAll: 'Forget everything',
  memoryForgetAllConfirm: 'Confirm \u2014 forget all?',
  memoryEmpty: 'Nothing yet \u2014 say what you are looking for and it will appear here.',
  memoryConflict: 'Conflict detected',
  memoryBacktracking: 'Backtracking',
  memoryBacktrackTo: 'Going back to the {stage} step',
  memoryTabPreferences: 'Preferences',
  memoryTabWorkflow: 'Workflow',
  memoryNoPreferences: 'No preferences extracted yet.',
  memoryForgotten: 'Forgotten',
  memoryHard: 'Hard',
  memorySoft: 'Soft',
  memoryAppliesTo: 'Applies to: {stages}',
  presetStartEmpty: 'Start empty',
  presetStartEmptyBlurb: 'The agent begins knowing nothing, as it does today.',
  presetPreviewTitle: 'The agent will start with',
  presetPreviewNote: 'Anything here can be removed from the memory panel once the session starts.',
  briefingTitle: 'The agent remembers you',
  briefingBody:
    'From a previous visit, it already knows the preferences below. Remove anything that is not true today, then start.',
  briefingStart: 'Start with these',
  briefingStartEmpty: 'Start with nothing',
  briefingNothingLeft: 'Nothing left \u2014 the agent will start knowing nothing.',
  adaptationFromMemory: 'From memory',
  adaptationFromConversation: 'From what you said',
  devicesTitle: 'Devices',
  deviceKiosk: 'Booking screen',
  devicePhone: 'Visitor phone',
  deviceAgent: 'Assistant',
  deviceScreens: 'Watching screens',
  deviceConnected: 'Connected',
  deviceNotConnected: 'Not connected',
  deviceWaiting: 'Not scanned yet',
  deviceChecking: 'Checking\u2026',
  deviceDropped: 'Disconnected',
  deviceDroppedSilent: 'Stopped responding',
  deviceSwapped: 'Reconnected',
  companionTapToStart: 'Tap the microphone to let this phone speak and listen.',
  companionConnecting: 'Connecting to the session...',
  companionUnpaired: 'This pairing is no longer valid. Scan the code again.',
  companionNoToken: 'This link is missing its pairing code. Scan the QR again.',
  companionUnsupported: 'This browser cannot use the microphone.',
  companionOnKiosk: 'Voice is on the main screen right now.',
  companionListening: 'Listening.',
  companionHearing: 'Hearing you...',
  companionSpeaking: 'Speaking.',
  companionMicPermission: 'Allow microphone access to continue.',
  companionReady: 'Ready.',
  pairVoiceTitle: 'USE MY PHONE AS THE MIC',
  pairVoiceHint: 'Scan to speak and listen through your phone instead of the headset.',
  voiceTargetKiosk: 'Headset',
  voiceTargetCompanion: 'My phone',
  voiceTargetLabel: 'Voice in and out',
  voiceTargetPhoneWaiting: 'Scan the code with your phone first.',

  demoSetupTitle: 'Demo Setup',
  demoSetupSubtitle:
    'Enter the access code from the presenter, or paste your own OpenAI API key.',
  aboutDemoLink: 'What is this demo?',
  demoModeOn: 'Demo Mode: On',
  accessCodeLabel: 'Code',
  apiKeyLabel: 'API Key',
  credentialMissing: 'Enter code or key',
  credentialReadyCode: 'Code ready',
  credentialReadyKey: 'API key ready',
  credentialChange: 'Change',
  credentialDialogTitle: 'Authorize this demo',
  credentialSavedCode: 'A code is already saved. Enter a new one to replace it.',
  credentialSavedKey: 'A key is already saved. Enter a new one to replace it.',
  credentialUse: 'Use',
  credentialRemove: 'Remove',
  micCheck: 'Mic Check',
  watchTutorial: 'Watch Tutorial Video',
  startDemo: 'Start Demo',
  demoPrivacyNote:
    'Your key stays in this browser tab and is used only for this session. Voice starts as soon as the booking opens; the mic button turns it off.',

  consentTitle: 'Research recording',
  consentCheckboxLabel: 'Yes, record this session for research.',
  consentBody:
    'We are studying how people work with this agent. If you agree, this session keeps the conversation, the text of what you say, what you do on screen, and the decisions the agent makes. No name, no account, and no audio file. Nothing identifies you.',
  consentOptOutNote:
    'Recording is on by default. Untick the box if you would rather not be recorded; nothing at all is recorded then, and the demo works the same either way.',

  preferenceMemoryTitle: 'Preference memory',
  preferenceMemoryBody:
    'Start the agent with preferences it already knows, as if it remembered you from a previous visit. You can remove any of them once the session is running.',

  quickCardKicker: 'One step. One sentence.',
  quickCardSayThis: 'Say this',
  quickCardWatchFor: 'Watch for',
  quickCardStart: 'Start and talk',
  quickCardPreparing: 'Setting the scene...',
  quickCardMicNote: 'Your phone will ask for the microphone. You can type instead if the room is loud.',
  quickCardNoRecording: 'Nothing from this demo is recorded.',
  quickCardUnknownLink: 'This link does not name a demo card.',
  quickCardCodePrompt: 'Enter the access code from the presenter.',
  quickCardFailed: 'Could not start the demo',
  quickCardFullDemoLink: 'Run the full demo instead',
  quickCardGalleryTitle: 'Quick demo cards',
  quickCardGalleryHint: 'Scan any one. It drops your phone straight onto that step, ready to be spoken to.',

  pairReadyTitle: 'Ready to start',
  preparingDemo: 'Starting the demo...',
  startBooking: 'Start booking',
  pairingLanguageLabel: 'Language',
  pairingLanguageHint: 'Pick the language you want to speak with the agent.',

  locale: 'en-US',
};

const KO: UiStrings = {
  back: '뒤로',
  continue: '다음',
  confirmBooking: '예매 확정',
  finishTask: '완료',
  bookingComplete: '예매 완료',
  bookingConfirmed: '예매가 확정되었습니다!',
  noPreviousStage: '이전 단계가 없습니다',
  noNextStageYet: '아직 다음 단계가 없습니다',

  summaryMovie: '영화',
  summaryTheater: '극장',
  summaryDateTime: '날짜 · 시간',
  summarySeats: '좌석',
  summaryTotal: '합계',

  weekdayShort: ['일', '월', '화', '수', '목', '금', '토'],
  legendAvailable: '예매 가능',
  legendSelected: '선택함',
  legendUnavailable: '예매 불가',
  legendOccupied: '판매 완료',
  legendPremium: '프리미엄',
  legendStandard: '일반',

  stepMovie: '영화',
  stepTheater: '극장',
  stepDate: '날짜',
  stepTime: '시간',
  stepSeat: '좌석',
  stepConfirm: '확정',

  inputPlaceholder: '메시지를 입력하세요...',
  voice: '음성',
  turnOnVoice: '음성 모드 켜기',
  turnOffVoice: '음성 모드 끄기',
  agentStepLabels: {
    select: '에이전트가 선택하는 중',
    selectMultiple: '에이전트가 좌석 여러 개를 선택하는 중',
    filter: '에이전트가 걸러내는 중',
    sort: '에이전트가 정렬하는 중',
    highlight: '에이전트가 강조하는 중',
    augment: '에이전트가 정보를 덧붙이는 중',
    clearModification: '에이전트가 변경을 되돌리는 중',
    next: '에이전트가 다음 단계로 넘어가는 중',
    prev: '에이전트가 이전 단계로 돌아가는 중',
    movedNext: '에이전트가 다음 단계로 넘어감',
    movedBack: '에이전트가 이전 단계로 돌아감',
    updatedGui: '에이전트가 화면을 바꿈',
    other: '에이전트가 화면을 조정하는 중',
  },
  voiceSettingsTitle: '음성 상세도 설정',
  voiceSettingsHint: '에이전트가 소리 내어 말하는 양을 고릅니다',

  showAll: '전체 보기',
  showLess: '간략히 보기',
  hideFilteredOut: '걸러진 항목 숨기기',
  filteredItemsHidden: '필터로 {count}개 항목이 숨겨져 있습니다. 전체를 보려면 누르세요.',
  hiddenByFilter: '필터로 숨겨진 항목입니다. 선택하면 필터가 해제됩니다.',

  allowMicrophoneAccess: '마이크 권한을 허용해 주세요...',
  listening: '듣는 중...',
  speakNow: '말씀하세요...',
  transcribing: '받아쓰는 중...',
  generatingVoice: '음성을 만드는 중...',
  playingReply: '답변을 재생하는 중...',
  voiceReady: '음성 준비됨',
  voiceError: '음성 오류',
  voiceUnavailable: '음성을 쓸 수 없음',
  tapMicForVoice: '마이크를 눌러 말하세요',
  waitingForAgent: '에이전트를 기다리는 중...',
  waitingForSession: '세션을 기다리는 중...',
  waitingForRelay: '에이전트 릴레이 연결을 기다리는 중...',
  waitingForExternalAgent: '외부 에이전트 연결을 기다리는 중...',
  sendAMessage: '메시지를 보내세요...',
  joiningAgentSession: '에이전트 세션에 접속하는 중...',
  loadingNextStage: '다음 단계를 불러오는 중...',
  agentWorking: '에이전트 작업 중',
  loading: '불러오는 중...',

  failedToLoadData: '데이터를 불러오지 못했습니다',
  bookingFailed: '예매에 실패했습니다',

  languageLabel: '언어',
  plannerModelLabel: '플래너 모델',
  plannerModelDefault: '서버 기본값',
  plannerModelHint:
    '에이전트가 무엇을 하고 말할지 결정하는 모델입니다. 다음 턴부터 적용되며, 음성 자체에는 영향이 없습니다.',
  plannerModelDefaultHint: '이 배포에 설정된 모델을 그대로 씁니다. 비교해 보려면 모델을 고르세요.',
  plannerModelStatsTitle: '이번 세션',
  plannerModelStatsAvg: '평균 {seconds}초 · {turns}턴',
  plannerModelStatsLast: '마지막 {seconds}초',
  settings: '설정',
  settingsTitle: '설정',
  close: '닫기',
  memory: '기억',
  showMemory: '에이전트가 기억하는 것 보기',
  hideMemory: '에이전트가 기억하는 것 숨기기',
  trace: '트레이스',
  downloadingTrace: '내려받는 중...',
  traceUnavailable: '이 세션은 트레이스를 기록하지 않습니다',
  reset: '초기화',
  finish: '완료',
  collapseHeader: '도구 모음 숨기기',
  expandHeader: '도구 모음 보기',
  openConversation: '대화 열기',
  pairPhoneTitle: '휴대폰으로 보기',
  pairPhoneHint: '스캔하면 에이전트가 기억하는 것을 다른 기기에서 따라볼 수 있습니다. 보기 전용이고, 예매는 이 화면에서 계속됩니다.',
  mirrorWaiting: '세션을 기다리는 중입니다. 연결되면 이 화면이 따라갑니다.',
  mirrorEnded: '이 화면이 따라보던 세션이 종료되었습니다.',
  mirrorTitle: '에이전트가 기억하는 것',
  companionTitle: '폰 음성',
  companionTakeVoice: '이 폰으로 듣기',
  companionHandBack: '헤드셋으로 되돌리기',
  companionWaitingHost: '키오스크에서 예매가 시작되기를 기다리는 중입니다.',
  companionMemoryWaiting: '에이전트가 기억하는 내용이 여기에 표시됩니다.',

  memoryForget: '지우기',
  memoryForgetConfirm: '정말?',
  memoryRestore: '되돌리기',
  memoryForgetAll: '전체 지우기',
  memoryForgetAllConfirm: '전체를 정말 지울까요?',
  memoryEmpty: '아직 없습니다. 원하는 것을 말하면 여기에 나타납니다.',
  memoryConflict: '충돌 감지',
  memoryBacktracking: '되돌아가는 중',
  memoryBacktrackTo: '{stage} 단계로 돌아갑니다',
  memoryTabPreferences: '선호',
  memoryTabWorkflow: '진행 흐름',
  memoryNoPreferences: '아직 추출된 선호가 없습니다.',
  memoryForgotten: '잊은 항목',
  memoryHard: '필수',
  memorySoft: '선호',
  memoryAppliesTo: '적용 단계: {stages}',
  presetStartEmpty: '빈 상태로 시작',
  presetStartEmptyBlurb: '에이전트가 아무것도 모르는 채로 시작합니다. 지금과 같습니다.',
  presetPreviewTitle: '에이전트는 이 선호를 알고 시작합니다',
  presetPreviewNote: '세션이 시작된 뒤 메모리 패널에서 어느 것이든 지울 수 있습니다.',
  briefingTitle: '에이전트가 기억하고 있는 것',
  briefingBody: '이전 방문에서 기억한 선호입니다. 오늘과 맞지 않는 것은 지우고 시작하세요.',
  briefingStart: '이대로 시작',
  briefingStartEmpty: '아무것도 없이 시작',
  briefingNothingLeft: '남은 것이 없습니다. 에이전트는 아무것도 모르는 채로 시작합니다.',
  adaptationFromMemory: '기억한 선호',
  adaptationFromConversation: '말씀하신 선호',
  devicesTitle: '연결된 기기',
  deviceKiosk: '예매 화면',
  devicePhone: '방문자 폰',
  deviceAgent: '어시스턴트',
  deviceScreens: '보고 있는 화면',
  deviceConnected: '연결됨',
  deviceNotConnected: '연결 안 됨',
  deviceWaiting: '아직 스캔 전',
  deviceChecking: '확인 중\u2026',
  deviceDropped: '연결 끊김',
  deviceDroppedSilent: '응답 없음',
  deviceSwapped: '다시 연결됨',
  companionTapToStart: '마이크를 눌러 이 폰이 듣고 말하도록 하세요.',
  companionConnecting: '세션에 연결하는 중...',
  companionUnpaired: '이 페어링은 더 이상 유효하지 않습니다. 코드를 다시 스캔하세요.',
  companionNoToken: '이 링크에 페어링 코드가 없습니다. QR을 다시 스캔하세요.',
  companionUnsupported: '이 브라우저는 마이크를 사용할 수 없습니다.',
  companionOnKiosk: '지금은 메인 화면에서 음성을 사용합니다.',
  companionListening: '듣고 있습니다.',
  companionHearing: '말씀하시는 중...',
  companionSpeaking: '말하는 중입니다.',
  companionMicPermission: '계속하려면 마이크 권한을 허용하세요.',
  companionReady: '준비되었습니다.',
  pairVoiceTitle: '폰을 마이크로 사용',
  pairVoiceHint: '헤드셋 대신 폰으로 말하고 듣습니다. 스캔하세요.',
  voiceTargetKiosk: '헤드셋',
  voiceTargetCompanion: '내 폰',
  voiceTargetLabel: '음성 입출력',
  voiceTargetPhoneWaiting: '먼저 폰으로 코드를 스캔하세요.',

  demoSetupTitle: '데모 설정',
  demoSetupSubtitle:
    '발표자에게 받은 접속 코드를 입력하거나, 본인의 OpenAI API 키를 붙여넣으세요.',
  aboutDemoLink: '이 데모는 무엇인가요?',
  demoModeOn: '데모 모드: 켜짐',
  accessCodeLabel: '코드',
  apiKeyLabel: 'API 키',
  credentialMissing: '코드 또는 키 입력',
  credentialReadyCode: '코드 사용 가능',
  credentialReadyKey: 'API 키 사용 가능',
  credentialChange: '변경',
  credentialDialogTitle: '데모 인증',
  credentialSavedCode: '코드가 이미 저장되어 있습니다. 새 코드를 입력하면 교체됩니다.',
  credentialSavedKey: '키가 이미 저장되어 있습니다. 새 키를 입력하면 교체됩니다.',
  credentialUse: '사용',
  credentialRemove: '삭제',
  micCheck: '마이크 점검',
  watchTutorial: '튜토리얼 영상 보기',
  startDemo: '데모 시작',
  demoPrivacyNote:
    '입력한 키는 이 브라우저 탭에만 남고 이번 세션에서만 사용됩니다. 예매가 시작되면 음성 모드가 바로 켜지며, 마이크 버튼으로 끌 수 있습니다.',

  consentTitle: '연구 기록 동의',
  consentCheckboxLabel: '네, 이 세션을 연구 목적으로 기록해도 좋습니다.',
  consentBody:
    '저희는 사람들이 이 에이전트와 어떻게 함께 일하는지 연구하고 있습니다. 동의하시면 이번 세션의 대화, 말씀하신 내용의 텍스트, 화면에서 하신 조작, 에이전트의 판단이 연구용으로 저장됩니다. 이름과 계정 정보는 저장하지 않고, 음성 파일도 남기지 않으며, 개인을 식별할 수 있는 정보는 기록되지 않습니다.',
  consentOptOutNote:
    '기록은 기본으로 켜져 있습니다. 원치 않으시면 체크를 해제하세요. 해제하면 아무것도 기록되지 않으며, 데모는 어느 쪽이든 똑같이 이용하실 수 있습니다.',

  preferenceMemoryTitle: '선호 메모리',
  preferenceMemoryBody:
    '에이전트가 이미 알고 있는 선호를 가진 상태로 시작합니다. 이전 방문을 기억하고 있는 것처럼요. 세션이 시작된 뒤에는 언제든 지울 수 있습니다.',

  quickCardKicker: '한 단계, 한 문장.',
  quickCardSayThis: '이렇게 말해보세요',
  quickCardWatchFor: '이걸 지켜보세요',
  quickCardStart: '시작하고 말하기',
  quickCardPreparing: '화면을 준비하는 중...',
  quickCardMicNote: '휴대폰이 마이크 권한을 물어봅니다. 주변이 시끄러우면 타이핑으로 하셔도 됩니다.',
  quickCardNoRecording: '이 데모에서는 아무것도 기록되지 않습니다.',
  quickCardUnknownLink: '이 링크에는 데모 카드가 지정되어 있지 않습니다.',
  quickCardCodePrompt: '발표자에게 받은 접속 코드를 입력하세요.',
  quickCardFailed: '데모를 시작하지 못했습니다',
  quickCardFullDemoLink: '전체 데모로 시작하기',
  quickCardGalleryTitle: '퀵 데모 카드',
  quickCardGalleryHint: '아무거나 하나 스캔하세요. 그 단계로 바로 이동해, 바로 말을 걸 수 있습니다.',

  pairReadyTitle: '시작 준비가 되었습니다',
  preparingDemo: '데모를 준비하는 중...',
  startBooking: '예매 시작하기',
  pairingLanguageLabel: '언어',
  pairingLanguageHint: '에이전트와 대화할 언어를 고르세요.',

  locale: 'ko-KR',
};

/*
  The overlays. Japanese and both Chinese packs translate every key, so their
  screen reads entirely in the language; German, French and Spanish are
  voice-first packs whose screen stays English, calendar included, and only the
  switch's own label is translated (in language.ts).

  Kept as overlays rather than complete tables so that a key added to
  `UiStrings` later falls back to English in these languages instead of being a
  type error that blocks the build — English and Korean are the two that must
  stay complete.
*/

/*
  MACHINE-DRAFTED — needs native review before it is shown as final copy.
  Japanese, polite です・ます form, modelled on the Korean table's tone: short
  and booth-friendly. Product terms (IMAX, 3D, QR, OpenAI, API) stay Latin.
*/
const JA_OVERRIDES: Partial<UiStrings> = {
  back: '戻る',
  continue: '次へ',
  confirmBooking: '予約を確定',
  finishTask: '完了',
  bookingComplete: '予約完了',
  bookingConfirmed: '予約が確定しました！',
  noPreviousStage: '前のステップはありません',
  noNextStageYet: '次のステップはまだありません',

  summaryMovie: '映画',
  summaryTheater: '映画館',
  summaryDateTime: '日時',
  summarySeats: '座席',
  summaryTotal: '合計',

  weekdayShort: ['日', '月', '火', '水', '木', '金', '土'],
  legendAvailable: '選択可能',
  legendSelected: '選択中',
  legendUnavailable: '選択不可',
  legendOccupied: '販売済み',
  legendPremium: 'プレミアム',
  legendStandard: 'スタンダード',

  stepMovie: '映画',
  stepTheater: '映画館',
  stepDate: '日付',
  stepTime: '上映時間',
  stepSeat: '座席',
  stepConfirm: '確定',

  inputPlaceholder: 'メッセージを入力...',
  voice: '音声',
  turnOnVoice: '音声モードをオンにする',
  turnOffVoice: '音声モードをオフにする',
  agentStepLabels: {
    select: 'エージェントが選択しています',
    selectMultiple: 'エージェントが複数の座席を選択しています',
    filter: 'エージェントが絞り込んでいます',
    sort: 'エージェントが並べ替えています',
    highlight: 'エージェントが強調表示しています',
    augment: 'エージェントが情報を追加しています',
    clearModification: 'エージェントが変更を元に戻しています',
    next: 'エージェントが次のステップに進んでいます',
    prev: 'エージェントが前のステップに戻っています',
    movedNext: 'エージェントが次のステップに進みました',
    movedBack: 'エージェントが前のステップに戻りました',
    updatedGui: 'エージェントが画面を更新しました',
    other: 'エージェントが画面を調整しています',
  },
  voiceSettingsTitle: '音声の詳しさの設定',
  voiceSettingsHint: 'エージェントが声に出して話す量を選びます',

  showAll: 'すべて表示',
  showLess: '折りたたむ',
  hideFilteredOut: '絞り込まれた項目を隠す',
  filteredItemsHidden: '絞り込みで{count}件が非表示です。タップするとすべて表示します。',
  hiddenByFilter: '絞り込みで非表示の項目です。選択すると絞り込みが解除されます。',

  allowMicrophoneAccess: 'マイクへのアクセスを許可してください...',
  listening: '聞いています...',
  speakNow: 'お話しください...',
  transcribing: '文字起こし中...',
  generatingVoice: '音声を生成中...',
  playingReply: '返答を再生中...',
  voiceReady: '音声の準備完了',
  voiceError: '音声エラー',
  voiceUnavailable: '音声を利用できません',
  tapMicForVoice: 'マイクをタップして話してください',
  waitingForAgent: 'エージェントを待っています...',
  waitingForSession: 'セッションを待っています...',
  waitingForRelay: 'エージェントのリレー接続を待っています...',
  waitingForExternalAgent: '外部エージェントの接続を待っています...',
  sendAMessage: 'メッセージを送信...',
  joiningAgentSession: 'エージェントのセッションに接続中...',
  loadingNextStage: '次のステップを読み込み中...',
  agentWorking: 'エージェントが作業中',
  loading: '読み込み中...',

  failedToLoadData: 'データを読み込めませんでした',
  bookingFailed: '予約に失敗しました',

  languageLabel: '言語',
  plannerModelLabel: 'プランナーモデル',
  plannerModelDefault: 'サーバーの既定値',
  plannerModelHint:
    'エージェントが何をして何を話すかを決めるモデルです。次のターンから反映され、音声そのものには影響しません。',
  plannerModelDefaultHint: 'このデプロイで設定されているモデルを使います。比較するにはモデルを選んでください。',
  plannerModelStatsTitle: 'このセッション',
  plannerModelStatsAvg: '平均 {seconds}秒 · {turns}ターン',
  plannerModelStatsLast: '直近 {seconds}秒',
  settings: '設定',
  settingsTitle: '設定',
  close: '閉じる',
  memory: '記憶',
  showMemory: 'エージェントの記憶を表示',
  hideMemory: 'エージェントの記憶を隠す',
  trace: 'トレース',
  downloadingTrace: 'ダウンロード中...',
  traceUnavailable: 'このセッションではトレースを記録していません',
  reset: 'リセット',
  finish: '終了',
  collapseHeader: 'ツールバーを隠す',
  expandHeader: 'ツールバーを表示',
  openConversation: '会話を開く',
  pairPhoneTitle: 'スマホで見る',
  pairPhoneHint: 'スキャンすると、エージェントの記憶を別の端末で確認できます。閲覧専用で、予約はこの画面で続けます。',
  mirrorWaiting: 'セッションを待っています。始まるとこの画面が連動します。',
  mirrorEnded: 'この画面が表示していたセッションは終了しました。',
  mirrorTitle: 'エージェントが覚えていること',
  companionTitle: 'スマホの音声',
  companionTakeVoice: 'このスマホを使う',
  companionHandBack: 'ヘッドセットに戻す',
  companionWaitingHost: 'キオスクで予約が始まるのを待っています。',
  companionMemoryWaiting: 'エージェントが覚えていることがここに表示されます。',

  memoryForget: '削除',
  memoryForgetConfirm: 'よろしいですか？',
  memoryRestore: '元に戻す',
  memoryForgetAll: 'すべて削除',
  memoryForgetAllConfirm: 'すべて削除しますか？',
  memoryEmpty: 'まだありません。探しているものを話すと、ここに表示されます。',
  memoryConflict: '競合を検出',
  memoryBacktracking: '前に戻っています',
  memoryBacktrackTo: '{stage}のステップに戻ります',
  memoryTabPreferences: '希望条件',
  memoryTabWorkflow: '進行状況',
  memoryNoPreferences: 'まだ希望条件は抽出されていません。',
  memoryForgotten: '削除した項目',
  memoryHard: '必須',
  memorySoft: '希望',
  memoryAppliesTo: '対象: {stages}',
  presetStartEmpty: '空の状態で開始',
  presetStartEmptyBlurb: 'エージェントは何も知らない状態で始めます。通常と同じです。',
  presetPreviewTitle: 'エージェントはこの希望条件を知った状態で始めます',
  presetPreviewNote: 'セッション開始後、記憶パネルからどれでも削除できます。',
  briefingTitle: 'エージェントはあなたを覚えています',
  briefingBody: '前回の来場で覚えた希望条件です。今日は当てはまらないものを削除してから始めてください。',
  briefingStart: 'この内容で開始',
  briefingStartEmpty: '何もなしで開始',
  briefingNothingLeft: '何も残っていません。エージェントは何も知らない状態で始めます。',
  adaptationFromMemory: '記憶から',
  adaptationFromConversation: 'お話の内容から',
  devicesTitle: '接続中の端末',
  deviceKiosk: '予約画面',
  devicePhone: '来場者のスマホ',
  deviceAgent: 'アシスタント',
  deviceScreens: '閲覧中の画面',
  deviceConnected: '接続済み',
  deviceNotConnected: '未接続',
  deviceWaiting: '未スキャン',
  deviceChecking: '確認中…',
  deviceDropped: '切断されました',
  deviceDroppedSilent: '応答なし',
  deviceSwapped: '再接続しました',
  companionTapToStart: 'マイクをタップすると、このスマホで話したり聞いたりできます。',
  companionConnecting: 'セッションに接続中...',
  companionUnpaired: 'このペアリングは無効になりました。コードをもう一度スキャンしてください。',
  companionNoToken: 'このリンクにはペアリングコードがありません。QRコードをもう一度スキャンしてください。',
  companionUnsupported: 'このブラウザではマイクを使用できません。',
  companionOnKiosk: '現在、音声はメイン画面で使われています。',
  companionListening: '聞いています。',
  companionHearing: '聞き取り中...',
  companionSpeaking: '話しています。',
  companionMicPermission: '続けるにはマイクへのアクセスを許可してください。',
  companionReady: '準備ができました。',
  pairVoiceTitle: 'スマホをマイクとして使う',
  pairVoiceHint: 'スキャンすると、ヘッドセットの代わりにスマホで話したり聞いたりできます。',
  voiceTargetKiosk: 'ヘッドセット',
  voiceTargetCompanion: '自分のスマホ',
  voiceTargetLabel: '音声の入出力',
  voiceTargetPhoneWaiting: '先にスマホでコードをスキャンしてください。',

  demoSetupTitle: 'デモの設定',
  demoSetupSubtitle:
    '発表者から受け取ったアクセスコードを入力するか、ご自身の OpenAI API キーを貼り付けてください。',
  aboutDemoLink: 'このデモについて',
  demoModeOn: 'デモモード: オン',
  accessCodeLabel: 'コード',
  apiKeyLabel: 'API キー',
  credentialMissing: 'コードまたはキーを入力',
  credentialReadyCode: 'コード準備完了',
  credentialReadyKey: 'API キー準備完了',
  credentialChange: '変更',
  credentialDialogTitle: 'デモの認証',
  credentialSavedCode: 'コードはすでに保存されています。新しいコードを入力すると置き換わります。',
  credentialSavedKey: 'キーはすでに保存されています。新しいキーを入力すると置き換わります。',
  credentialUse: '使用',
  credentialRemove: '削除',
  micCheck: 'マイクチェック',
  watchTutorial: 'チュートリアル動画を見る',
  startDemo: 'デモを開始',
  demoPrivacyNote:
    '入力したキーはこのブラウザのタブにのみ保存され、このセッションでのみ使用されます。予約画面が開くとすぐに音声が始まり、マイクボタンでオフにできます。',

  consentTitle: '研究用の記録',
  consentCheckboxLabel: 'はい、研究のためにこのセッションを記録してかまいません。',
  consentBody:
    '私たちは、人がこのエージェントとどのように協働するかを研究しています。同意いただける場合、このセッションの会話、お話しになった内容のテキスト、画面上での操作、エージェントの判断を記録します。お名前やアカウントは記録せず、音声ファイルも残しません。個人を特定できる情報は含まれません。',
  consentOptOutNote:
    '記録は初期設定でオンになっています。記録を望まない場合はチェックを外してください。その場合は一切記録されず、デモはどちらでも同じようにご利用いただけます。',

  preferenceMemoryTitle: '希望条件の記憶',
  preferenceMemoryBody:
    '前回の来場を覚えているかのように、エージェントが希望条件をすでに知った状態で始めます。セッション開始後はいつでも削除できます。',

  quickCardKicker: '1ステップ、1文。',
  quickCardSayThis: 'こう話してください',
  quickCardWatchFor: 'ここに注目',
  quickCardStart: '開始して話す',
  quickCardPreparing: '画面を準備中...',
  quickCardMicNote: 'スマホがマイクの許可を求めます。周りがうるさい場合は文字入力もできます。',
  quickCardNoRecording: 'このデモでは何も記録されません。',
  quickCardUnknownLink: 'このリンクにはデモカードが指定されていません。',
  quickCardCodePrompt: '発表者から受け取ったアクセスコードを入力してください。',
  quickCardFailed: 'デモを開始できませんでした',
  quickCardFullDemoLink: 'フルデモを始める',
  quickCardGalleryTitle: 'クイックデモカード',
  quickCardGalleryHint: 'どれか1枚をスキャンしてください。そのステップに直接移動し、すぐに話しかけられます。',

  pairReadyTitle: '開始の準備ができました',
  preparingDemo: 'デモを準備中...',
  startBooking: '予約を開始',
  pairingLanguageLabel: '言語',
  pairingLanguageHint: 'エージェントと話す言語を選んでください。',

  locale: 'ja-JP',
};

/*
  MACHINE-DRAFTED — needs native review before it is shown as final copy.
  Simplified Chinese, mainland usage: 您 throughout, 影院 / 场次 / 座位,
  "agent" as 智能体, "session" as 会话, "demo" as 演示. Product terms (IMAX, 3D,
  QR, OpenAI, API) stay Latin, as the Korean table keeps them.
*/
const ZH_HANS_OVERRIDES: Partial<UiStrings> = {
  back: '返回',
  continue: '继续',
  confirmBooking: '确认订票',
  finishTask: '完成',
  bookingComplete: '订票完成',
  bookingConfirmed: '订票已确认！',
  noPreviousStage: '没有上一步',
  noNextStageYet: '暂无下一步',

  summaryMovie: '电影',
  summaryTheater: '影院',
  summaryDateTime: '日期与时间',
  summarySeats: '座位',
  summaryTotal: '合计',

  weekdayShort: ['日', '一', '二', '三', '四', '五', '六'],
  legendAvailable: '可选',
  legendSelected: '已选',
  legendUnavailable: '不可选',
  legendOccupied: '已售',
  legendPremium: '高级座',
  legendStandard: '普通座',

  stepMovie: '电影',
  stepTheater: '影院',
  stepDate: '日期',
  stepTime: '场次',
  stepSeat: '座位',
  stepConfirm: '确认',

  inputPlaceholder: '输入消息...',
  voice: '语音',
  turnOnVoice: '开启语音模式',
  turnOffVoice: '关闭语音模式',
  agentStepLabels: {
    select: '智能体正在选择',
    selectMultiple: '智能体正在选择多个座位',
    filter: '智能体正在筛选',
    sort: '智能体正在排序',
    highlight: '智能体正在高亮显示',
    augment: '智能体正在补充信息',
    clearModification: '智能体正在撤销更改',
    next: '智能体正在进入下一步',
    prev: '智能体正在返回上一步',
    movedNext: '智能体已进入下一步',
    movedBack: '智能体已返回上一步',
    updatedGui: '智能体已更新界面',
    other: '智能体正在调整界面',
  },
  voiceSettingsTitle: '语音详略设置',
  voiceSettingsHint: '选择智能体出声说话的详略程度',

  showAll: '显示全部',
  showLess: '收起',
  hideFilteredOut: '隐藏已筛除的项目',
  filteredItemsHidden: '已按筛选条件隐藏 {count} 项。点击显示全部。',
  hiddenByFilter: '此项已被筛选隐藏。选择后将清除该筛选条件。',

  allowMicrophoneAccess: '请允许使用麦克风...',
  listening: '正在聆听...',
  speakNow: '请说话...',
  transcribing: '正在转写...',
  generatingVoice: '正在生成语音...',
  playingReply: '正在播放回复...',
  voiceReady: '语音已就绪',
  voiceError: '语音出错',
  voiceUnavailable: '语音不可用',
  tapMicForVoice: '点击麦克风说话',
  waitingForAgent: '正在等待智能体...',
  waitingForSession: '正在等待会话...',
  waitingForRelay: '正在等待智能体中继连接...',
  waitingForExternalAgent: '正在等待外部智能体连接...',
  sendAMessage: '发送消息...',
  joiningAgentSession: '正在加入智能体会话...',
  loadingNextStage: '正在加载下一步...',
  agentWorking: '智能体处理中',
  loading: '加载中...',

  failedToLoadData: '数据加载失败',
  bookingFailed: '订票失败',

  languageLabel: '语言',
  plannerModelLabel: '规划模型',
  plannerModelDefault: '服务器默认',
  plannerModelHint: '决定智能体做什么、说什么的模型。从下一轮开始生效，不影响语音本身。',
  plannerModelDefaultHint: '使用此部署配置的模型。选择一个模型即可对比。',
  plannerModelStatsTitle: '本次会话',
  plannerModelStatsAvg: '平均 {seconds} 秒 · {turns} 轮',
  plannerModelStatsLast: '最近一次 {seconds} 秒',
  settings: '设置',
  settingsTitle: '设置',
  close: '关闭',
  memory: '记忆',
  showMemory: '显示智能体记住的内容',
  hideMemory: '隐藏智能体记住的内容',
  trace: '追踪记录',
  downloadingTrace: '正在下载...',
  traceUnavailable: '本次会话未记录追踪',
  reset: '重置',
  finish: '结束',
  collapseHeader: '隐藏工具栏',
  expandHeader: '显示工具栏',
  openConversation: '打开对话',
  pairPhoneTitle: '在手机上查看',
  pairPhoneHint: '扫码即可在另一台设备上查看智能体记住的内容。仅供查看，订票仍在此屏幕上进行。',
  mirrorWaiting: '正在等待会话。连接后此屏幕会同步显示。',
  mirrorEnded: '此屏幕同步的会话已结束。',
  mirrorTitle: '智能体记住的内容',
  companionTitle: '手机语音',
  companionTakeVoice: '使用这部手机',
  companionHandBack: '切回耳机',
  companionWaitingHost: '正在等待订票屏幕开始订票。',
  companionMemoryWaiting: '智能体记住的内容会显示在这里。',

  memoryForget: '删除',
  memoryForgetConfirm: '确定吗？',
  memoryRestore: '恢复',
  memoryForgetAll: '全部删除',
  memoryForgetAllConfirm: '确定全部删除吗？',
  memoryEmpty: '暂无内容。说出您想要的，它就会显示在这里。',
  memoryConflict: '检测到冲突',
  memoryBacktracking: '正在返回',
  memoryBacktrackTo: '正在返回“{stage}”这一步',
  memoryTabPreferences: '偏好',
  memoryTabWorkflow: '流程',
  memoryNoPreferences: '尚未提取到偏好。',
  memoryForgotten: '已删除',
  memoryHard: '必须',
  memorySoft: '偏好',
  memoryAppliesTo: '适用于：{stages}',
  presetStartEmpty: '从空白开始',
  presetStartEmptyBlurb: '智能体从一无所知开始，和平时一样。',
  presetPreviewTitle: '智能体将带着这些偏好开始',
  presetPreviewNote: '会话开始后，可在记忆面板中删除其中任意一项。',
  briefingTitle: '智能体记得您',
  briefingBody: '这是上次来访时记住的偏好。请删除今天不适用的内容，然后开始。',
  briefingStart: '按这些开始',
  briefingStartEmpty: '不带任何偏好开始',
  briefingNothingLeft: '已全部删除。智能体将从一无所知开始。',
  adaptationFromMemory: '来自记忆',
  adaptationFromConversation: '来自您说的话',
  devicesTitle: '已连接设备',
  deviceKiosk: '订票屏幕',
  devicePhone: '访客手机',
  deviceAgent: '助手',
  deviceScreens: '观看中的屏幕',
  deviceConnected: '已连接',
  deviceNotConnected: '未连接',
  deviceWaiting: '尚未扫码',
  deviceChecking: '检查中…',
  deviceDropped: '已断开',
  deviceDroppedSilent: '无响应',
  deviceSwapped: '已重新连接',
  companionTapToStart: '点击麦克风，让这部手机来听和说。',
  companionConnecting: '正在连接会话...',
  companionUnpaired: '此配对已失效。请重新扫码。',
  companionNoToken: '此链接缺少配对码。请重新扫描 QR 码。',
  companionUnsupported: '此浏览器无法使用麦克风。',
  companionOnKiosk: '目前语音在主屏幕上使用。',
  companionListening: '正在聆听。',
  companionHearing: '正在听您说...',
  companionSpeaking: '正在说话。',
  companionMicPermission: '请允许使用麦克风以继续。',
  companionReady: '已就绪。',
  pairVoiceTitle: '用手机当麦克风',
  pairVoiceHint: '扫码后用手机代替耳机来说和听。',
  voiceTargetKiosk: '耳机',
  voiceTargetCompanion: '我的手机',
  voiceTargetLabel: '语音输入与输出',
  voiceTargetPhoneWaiting: '请先用手机扫码。',

  demoSetupTitle: '演示设置',
  demoSetupSubtitle: '请输入演示者提供的访问码，或粘贴您自己的 OpenAI API 密钥。',
  aboutDemoLink: '这是什么演示？',
  demoModeOn: '演示模式：开',
  accessCodeLabel: '访问码',
  apiKeyLabel: 'API 密钥',
  credentialMissing: '输入访问码或密钥',
  credentialReadyCode: '访问码已就绪',
  credentialReadyKey: 'API 密钥已就绪',
  credentialChange: '更改',
  credentialDialogTitle: '授权本次演示',
  credentialSavedCode: '已保存一个访问码。输入新的即可替换。',
  credentialSavedKey: '已保存一个密钥。输入新的即可替换。',
  credentialUse: '使用',
  credentialRemove: '删除',
  micCheck: '麦克风测试',
  watchTutorial: '观看教程视频',
  startDemo: '开始演示',
  demoPrivacyNote:
    '您的密钥只保存在此浏览器标签页中，且仅用于本次会话。订票界面打开后语音会立即开启，可用麦克风按钮关闭。',

  consentTitle: '研究记录',
  consentCheckboxLabel: '是的，同意为研究记录本次会话。',
  consentBody:
    '我们正在研究人们如何与这个智能体协作。如果您同意，本次会话将保存对话内容、您所说内容的文字、您在屏幕上的操作，以及智能体做出的决定。不记录姓名和账号，也不保存音频文件。没有任何信息能识别您的身份。',
  consentOptOutNote:
    '默认开启记录。如果您不希望被记录，请取消勾选；取消后不会记录任何内容，演示的体验完全相同。',

  preferenceMemoryTitle: '偏好记忆',
  preferenceMemoryBody:
    '让智能体带着已知的偏好开始，就像它记得您上次来访一样。会话开始后，可随时删除其中任何一项。',

  quickCardKicker: '一个步骤，一句话。',
  quickCardSayThis: '请这样说',
  quickCardWatchFor: '请留意',
  quickCardStart: '开始并说话',
  quickCardPreparing: '正在准备场景...',
  quickCardMicNote: '手机会请求使用麦克风。如果周围很吵，也可以打字。',
  quickCardNoRecording: '本演示不会记录任何内容。',
  quickCardUnknownLink: '此链接未指定演示卡片。',
  quickCardCodePrompt: '请输入演示者提供的访问码。',
  quickCardFailed: '无法开始演示',
  quickCardFullDemoLink: '改为体验完整演示',
  quickCardGalleryTitle: '快速演示卡片',
  quickCardGalleryHint: '任选一张扫码，手机会直接进入那一步，马上就能开口。',

  pairReadyTitle: '准备就绪',
  preparingDemo: '正在启动演示...',
  startBooking: '开始订票',
  pairingLanguageLabel: '语言',
  pairingLanguageHint: '请选择您想与智能体对话的语言。',

  locale: 'zh-CN',
};

/*
  MACHINE-DRAFTED — needs native review before it is shown as final copy.
  Traditional Chinese, Taiwan usage rather than a character conversion of the
  Simplified table: 戲院 / 場次 / 座位 / 選取, 資訊, 影片, 連線, 預設, 存取碼,
  金鑰, "agent" as 代理程式, "session" as 工作階段, "demo" as 示範. Product terms
  (IMAX, 3D, QR, OpenAI, API) stay Latin, as the Korean table keeps them.
*/
const ZH_HANT_OVERRIDES: Partial<UiStrings> = {
  back: '返回',
  continue: '繼續',
  confirmBooking: '確認訂票',
  finishTask: '完成',
  bookingComplete: '訂票完成',
  bookingConfirmed: '訂票成功！',
  noPreviousStage: '沒有上一步',
  noNextStageYet: '還沒有下一步',

  summaryMovie: '電影',
  summaryTheater: '戲院',
  summaryDateTime: '日期與時間',
  summarySeats: '座位',
  summaryTotal: '總計',

  weekdayShort: ['日', '一', '二', '三', '四', '五', '六'],
  legendAvailable: '可選取',
  legendSelected: '已選取',
  legendUnavailable: '無法選取',
  legendOccupied: '已售出',
  legendPremium: '高級座位',
  legendStandard: '一般座位',

  stepMovie: '電影',
  stepTheater: '戲院',
  stepDate: '日期',
  stepTime: '場次',
  stepSeat: '座位',
  stepConfirm: '確認',

  inputPlaceholder: '輸入訊息...',
  voice: '語音',
  turnOnVoice: '開啟語音模式',
  turnOffVoice: '關閉語音模式',
  agentStepLabels: {
    select: '代理程式正在選取',
    selectMultiple: '代理程式正在選取多個座位',
    filter: '代理程式正在篩選',
    sort: '代理程式正在排序',
    highlight: '代理程式正在醒目標示',
    augment: '代理程式正在補充資訊',
    clearModification: '代理程式正在復原變更',
    next: '代理程式正在前往下一步',
    prev: '代理程式正在返回上一步',
    movedNext: '代理程式已前往下一步',
    movedBack: '代理程式已返回上一步',
    updatedGui: '代理程式已更新畫面',
    other: '代理程式正在調整畫面',
  },
  voiceSettingsTitle: '語音詳細程度設定',
  voiceSettingsHint: '選擇代理程式要說出多少內容',

  showAll: '顯示全部',
  showLess: '收合',
  hideFilteredOut: '隱藏已篩除的項目',
  filteredItemsHidden: '已依篩選條件隱藏 {count} 個項目。點一下即可顯示全部。',
  hiddenByFilter: '此項目已被篩選隱藏。選取後會清除該篩選條件。',

  allowMicrophoneAccess: '請允許存取麥克風...',
  listening: '聆聽中...',
  speakNow: '請說話...',
  transcribing: '語音轉文字中...',
  generatingVoice: '正在產生語音...',
  playingReply: '正在播放回覆...',
  voiceReady: '語音已就緒',
  voiceError: '語音錯誤',
  voiceUnavailable: '無法使用語音',
  tapMicForVoice: '點一下麥克風說話',
  waitingForAgent: '正在等待代理程式...',
  waitingForSession: '正在等待工作階段...',
  waitingForRelay: '正在等待代理程式中繼連線...',
  waitingForExternalAgent: '正在等待外部代理程式連線...',
  sendAMessage: '傳送訊息...',
  joiningAgentSession: '正在加入代理程式工作階段...',
  loadingNextStage: '正在載入下一步...',
  agentWorking: '代理程式處理中',
  loading: '載入中...',

  failedToLoadData: '無法載入資料',
  bookingFailed: '訂票失敗',

  languageLabel: '語言',
  plannerModelLabel: '規劃模型',
  plannerModelDefault: '伺服器預設',
  plannerModelHint: '決定代理程式要做什麼、說什麼的模型。從下一輪開始生效，不影響語音本身。',
  plannerModelDefaultHint: '使用此部署所設定的模型。選擇模型即可比較。',
  plannerModelStatsTitle: '本次工作階段',
  plannerModelStatsAvg: '平均 {seconds} 秒 · {turns} 輪',
  plannerModelStatsLast: '最近一次 {seconds} 秒',
  settings: '設定',
  settingsTitle: '設定',
  close: '關閉',
  memory: '記憶',
  showMemory: '顯示代理程式記得的內容',
  hideMemory: '隱藏代理程式記得的內容',
  trace: '追蹤紀錄',
  downloadingTrace: '下載中...',
  traceUnavailable: '本次工作階段未記錄追蹤資料',
  reset: '重設',
  finish: '結束',
  collapseHeader: '隱藏工具列',
  expandHeader: '顯示工具列',
  openConversation: '開啟對話',
  pairPhoneTitle: '在手機上查看',
  pairPhoneHint: '掃描後即可在另一部裝置上查看代理程式記得的內容。僅供檢視，訂票仍在此畫面進行。',
  mirrorWaiting: '正在等待工作階段。連線後此畫面會同步顯示。',
  mirrorEnded: '此畫面同步的工作階段已結束。',
  mirrorTitle: '代理程式記得的內容',
  companionTitle: '手機語音',
  companionTakeVoice: '使用這支手機',
  companionHandBack: '切回耳機',
  companionWaitingHost: '正在等待訂票畫面開始訂票。',
  companionMemoryWaiting: '代理程式記得的內容會顯示在這裡。',

  memoryForget: '刪除',
  memoryForgetConfirm: '確定嗎？',
  memoryRestore: '還原',
  memoryForgetAll: '全部刪除',
  memoryForgetAllConfirm: '確定要全部刪除嗎？',
  memoryEmpty: '目前還沒有。說出您想找的，就會顯示在這裡。',
  memoryConflict: '偵測到衝突',
  memoryBacktracking: '正在返回',
  memoryBacktrackTo: '正在返回「{stage}」步驟',
  memoryTabPreferences: '偏好',
  memoryTabWorkflow: '流程',
  memoryNoPreferences: '尚未擷取到任何偏好。',
  memoryForgotten: '已刪除',
  memoryHard: '必要',
  memorySoft: '偏好',
  memoryAppliesTo: '適用於：{stages}',
  presetStartEmpty: '從空白開始',
  presetStartEmptyBlurb: '代理程式一開始什麼都不知道，和平常一樣。',
  presetPreviewTitle: '代理程式會帶著這些偏好開始',
  presetPreviewNote: '工作階段開始後，可以在記憶面板中刪除任何一項。',
  briefingTitle: '代理程式記得您',
  briefingBody: '這是上次來訪時記下的偏好。請刪除今天不適用的項目，然後開始。',
  briefingStart: '就用這些開始',
  briefingStartEmpty: '不帶任何偏好開始',
  briefingNothingLeft: '已全部刪除。代理程式會從什麼都不知道開始。',
  adaptationFromMemory: '來自記憶',
  adaptationFromConversation: '來自您說的話',
  devicesTitle: '已連線裝置',
  deviceKiosk: '訂票畫面',
  devicePhone: '訪客手機',
  deviceAgent: '助理',
  deviceScreens: '觀看中的畫面',
  deviceConnected: '已連線',
  deviceNotConnected: '未連線',
  deviceWaiting: '尚未掃描',
  deviceChecking: '檢查中…',
  deviceDropped: '已中斷連線',
  deviceDroppedSilent: '沒有回應',
  deviceSwapped: '已重新連線',
  companionTapToStart: '點一下麥克風，讓這支手機負責聽和說。',
  companionConnecting: '正在連線至工作階段...',
  companionUnpaired: '此配對已失效。請重新掃描 QR 碼。',
  companionNoToken: '此連結缺少配對碼。請重新掃描 QR 碼。',
  companionUnsupported: '此瀏覽器無法使用麥克風。',
  companionOnKiosk: '目前語音由主畫面使用中。',
  companionListening: '聆聽中。',
  companionHearing: '正在聽您說...',
  companionSpeaking: '說話中。',
  companionMicPermission: '請允許存取麥克風以繼續。',
  companionReady: '已就緒。',
  pairVoiceTitle: '把手機當麥克風',
  pairVoiceHint: '掃描後改用手機代替耳機來說和聽。',
  voiceTargetKiosk: '耳機',
  voiceTargetCompanion: '我的手機',
  voiceTargetLabel: '語音輸入與輸出',
  voiceTargetPhoneWaiting: '請先用手機掃描 QR 碼。',

  demoSetupTitle: '示範設定',
  demoSetupSubtitle: '請輸入講者提供的存取碼，或貼上您自己的 OpenAI API 金鑰。',
  aboutDemoLink: '這是什麼示範？',
  demoModeOn: '示範模式：開啟',
  accessCodeLabel: '存取碼',
  apiKeyLabel: 'API 金鑰',
  credentialMissing: '輸入存取碼或金鑰',
  credentialReadyCode: '存取碼已就緒',
  credentialReadyKey: 'API 金鑰已就緒',
  credentialChange: '變更',
  credentialDialogTitle: '授權此示範',
  credentialSavedCode: '已儲存存取碼。輸入新的即可取代。',
  credentialSavedKey: '已儲存金鑰。輸入新的即可取代。',
  credentialUse: '使用',
  credentialRemove: '移除',
  micCheck: '麥克風測試',
  watchTutorial: '觀看教學影片',
  startDemo: '開始示範',
  demoPrivacyNote:
    '您的金鑰只會保留在此瀏覽器分頁中，且僅用於本次工作階段。訂票畫面開啟後語音會立即啟動，可用麥克風按鈕關閉。',

  consentTitle: '研究紀錄',
  consentCheckboxLabel: '是的，同意為研究記錄本次工作階段。',
  consentBody:
    '我們正在研究人們如何與這個代理程式協作。如果您同意，本次工作階段會保存對話、您所說內容的文字、您在畫面上的操作，以及代理程式所做的決定。不會記錄姓名或帳號，也不會保存錄音檔，沒有任何資訊能識別您的身分。',
  consentOptOutNote:
    '預設會進行記錄。若您不想被記錄，請取消勾選；取消後完全不會記錄任何內容，示範的體驗也完全相同。',

  preferenceMemoryTitle: '偏好記憶',
  preferenceMemoryBody:
    '讓代理程式帶著已知的偏好開始，就像它記得您上次來訪一樣。工作階段開始後，可隨時刪除任何一項。',

  quickCardKicker: '一個步驟，一句話。',
  quickCardSayThis: '請這樣說',
  quickCardWatchFor: '請留意',
  quickCardStart: '開始並說話',
  quickCardPreparing: '正在準備畫面...',
  quickCardMicNote: '手機會要求使用麥克風。如果周圍很吵，也可以改用打字。',
  quickCardNoRecording: '此示範不會記錄任何內容。',
  quickCardUnknownLink: '此連結沒有指定示範卡片。',
  quickCardCodePrompt: '請輸入講者提供的存取碼。',
  quickCardFailed: '無法開始示範',
  quickCardFullDemoLink: '改為體驗完整示範',
  quickCardGalleryTitle: '快速示範卡片',
  quickCardGalleryHint: '任選一張掃描，手機會直接進入那個步驟，馬上就能開口說話。',

  pairReadyTitle: '準備就緒',
  preparingDemo: '正在啟動示範...',
  startBooking: '開始訂票',
  pairingLanguageLabel: '語言',
  pairingLanguageHint: '請選擇您想與代理程式對話的語言。',

  locale: 'zh-TW',
};

/**
 * What each overlay language has translated so far. English and Korean are not
 * here: they are complete tables, not overlays.
 */
export const UI_STRING_OVERRIDES: Readonly<Partial<Record<Language, Partial<UiStrings>>>> = {
  ja: JA_OVERRIDES,
  'zh-Hans': ZH_HANS_OVERRIDES,
  'zh-Hant': ZH_HANT_OVERRIDES,
  de: {},
  fr: {},
  es: {},
};

function overlay(language: Language): UiStrings {
  const overrides = UI_STRING_OVERRIDES[language] ?? {};
  return {
    ...EN,
    ...overrides,
    // A partial nested record would otherwise replace the English one whole.
    agentStepLabels: { ...EN.agentStepLabels, ...(overrides.agentStepLabels ?? {}) },
  };
}

export const UI_STRINGS: Record<Language, UiStrings> = {
  en: EN,
  ko: KO,
  ja: overlay('ja'),
  'zh-Hans': overlay('zh-Hans'),
  'zh-Hant': overlay('zh-Hant'),
  de: overlay('de'),
  fr: overlay('fr'),
  es: overlay('es'),
};

export function stringsFor(language: Language): UiStrings {
  return UI_STRINGS[language] ?? EN;
}
