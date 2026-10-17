/**
 * The screen's own words, in both languages.
 *
 * Scope is the booking surface a booth visitor actually touches: the stages,
 * the action bar, the breadcrumb, the chat input and the status line. The study
 * operator's surfaces — session setup, dev tools, the surveys — stay English on
 * purpose. The surveys in particular are a measurement instrument; translating
 * them would make their responses incomparable to the recorded English ones.
 *
 * `Record<Language, UiStrings>` rather than a partial ko overlay, so adding a
 * key is a type error until both languages have it. A half-translated screen is
 * worse at a booth than an English one.
 */

import type { Language } from './language';

/** Sun-first, matching the calendar grid's column order. */
export type WeekdayNames = readonly [string, string, string, string, string, string, string];

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
    'Your key stays in this browser tab and is used only for this session. Voice mode is available from the mic button once the booking task starts.',

  consentTitle: 'Research recording',
  consentCheckboxLabel: 'Yes, record this session for research.',
  consentBody:
    'We are studying how people work with this agent. If you agree, this session keeps the conversation, the text of what you say, what you do on screen, and the decisions the agent makes. No name, no account, and no audio file. Nothing identifies you.',
  consentOptOutNote:
    'Optional. Leave it unticked and nothing at all is recorded — the demo works exactly the same either way.',

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
    '입력한 키는 이 브라우저 탭에만 남고 이번 세션에서만 사용됩니다. 예매가 시작되면 마이크 버튼으로 음성 모드를 켤 수 있습니다.',

  consentTitle: '연구 기록 동의',
  consentCheckboxLabel: '네, 이 세션을 연구 목적으로 기록해도 좋습니다.',
  consentBody:
    '저희는 사람들이 이 에이전트와 어떻게 함께 일하는지 연구하고 있습니다. 동의하시면 이번 세션의 대화, 말씀하신 내용의 텍스트, 화면에서 하신 조작, 에이전트의 판단이 연구용으로 저장됩니다. 이름과 계정 정보는 저장하지 않고, 음성 파일도 남기지 않으며, 개인을 식별할 수 있는 정보는 기록되지 않습니다.',
  consentOptOutNote:
    '선택 사항입니다. 체크하지 않으면 아무것도 기록되지 않으며, 데모는 어느 쪽이든 똑같이 이용하실 수 있습니다.',

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

  locale: 'ko-KR',
};

export const UI_STRINGS: Record<Language, UiStrings> = { en: EN, ko: KO };

export function stringsFor(language: Language): UiStrings {
  return UI_STRINGS[language] ?? EN;
}
