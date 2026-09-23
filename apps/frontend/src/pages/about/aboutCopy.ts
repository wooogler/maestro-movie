/**
 * Every word on /about, in both booth languages.
 *
 * `**bold**` marks a label exactly as the app prints it, the way the page it is
 * modelled on (swag.cs.vt.edu/about) quotes its UI. That makes each bold span a
 * claim about the interface, so two rules hold throughout:
 *
 *   - The Korean copy quotes what a KOREAN session shows. Several demo surfaces
 *     stay English in Korean mode — the memory panel's headings and banners,
 *     the "Agent is …" card headers, the preset names, the whole voice-verbosity
 *     panel, the Code/Key switch — and those are quoted in English here, because
 *     that is what a Korean visitor will see.
 *   - Behaviour is stated only where the code was read to confirm it. Anything
 *     the agent writes at run time (its sentences, its augmented labels) is
 *     illustrative on this page and is captioned as such.
 *
 * Not in strings.ts on purpose: that table is scoped to the booking surface,
 * and check:language requires Hangul in every Korean value, which proper nouns
 * like "MAESTRO" and "UIST 2026" cannot satisfy.
 */

import type { Language } from '../../i18n/language';

export interface AboutCopy {
  documentTitle: string;
  eyebrow: string;
  headline: string;
  intro: string;
  ctaTry: string;
  ctaSource: string;
  languageLabel: string;
  replay: string;
  heroCaption: string;
  /** What the agent asks before the visitor speaks. Illustrative. */
  heroQuestion: string;
  /** The agent's line for each hero step after the first, in order. */
  heroSentences: [augment: string, filterDistance: string, filterParking: string, sort: string];
  conversationLabel: string;

  howTitle: string;
  howSteps: Array<{ title: string; body: string }>;

  adaptTitle: string;
  adaptLead: string;
  adaptCards: {
    augment: FigureText;
    filter: FigureText;
    sort: FigureText;
    highlight: FigureText;
  };
  adaptNote: string;
  adaptBullets: string[];

  memoryTitle: string;
  memoryLead: string;
  memoryBullets: string[];
  memoryFigureCaption: string;
  memoryFigureNote: string;

  navTitle: string;
  navLead: string;
  navBullets: string[];
  navFigureCaption: string;

  voiceTitle: string;
  voiceLead: string;
  voiceBullets: string[];
  voiceFigureCaption: string;

  cardsTitle: string;
  cardsLead: string;

  worldTitle: string;
  worldLead: string;
  worldFilmsHeading: string;
  worldCinemasHeading: string;
  worldFilmColumns: [title: string, rating: string, runtime: string, formats: string];
  worldCinemaColumns: [name: string, miles: string, notes: string];
  worldGeneratedNote: string;
  worldNote: string;
  /** Keyed by theater id. */
  cinemaNotes: Record<string, string>;

  privacyTitle: string;
  privacyBlocks: Array<{ title: string; body: string }>;

  hoodTitle: string;
  hoodBullets: string[];
  paperLabel: string;

  glossaryTitle: string;
  glossary: Array<{ term: string; definition: string }>;

  footerLine: string;
}

export interface FigureText {
  title: string;
  body: string;
  caption: string;
  /** The agent's line on the card for each step after the first. Illustrative. */
  sentences: string[];
}

export const PAPER_TITLE =
  'MAESTRO: Adapting GUIs and Guiding Navigation with User Preferences in Conversational Agents with GUIs';

export const SOURCE_URL = 'https://github.com/wooogler/maestro-movie';

const en: AboutCopy = {
  documentTitle: 'About MAESTRO',
  eyebrow: 'UIST 2026 · Demo',
  headline: 'Say what matters. The screen rearranges around it.',
  intro:
    'MAESTRO is a conversational agent that books movie tickets on the same screen you are looking at. Tell it what matters — nothing scary, no more than 15 miles, out by eleven — and it does more than answer. It relabels, hides, reorders and marks the options in front of you, keeps every requirement in a memory you can read and edit, and when nothing can satisfy them all, it says so and offers to take you back to a step where something can still change. The demo books in Detroit on Tuesday, 3 November 2026: five real films at five real cinemas.',
  ctaTry: 'Try the demo',
  ctaSource: 'Source code',
  languageLabel: 'Language',
  replay: 'Play again',
  heroCaption:
    'Quick card 2, played out: one sentence, four moves, one per turn. The agent’s sentences here are illustrative — in the demo it writes its own.',
  heroQuestion: 'Klara and the Sun is on at all five cinemas. Anything that matters for where you see it?',
  heroSentences: [
    'Adding each cinema’s distance and parking, so you can compare.',
    'MJR Troy is 20.4 miles out, so I’ve hidden it.',
    'Cinema Detroit charges for parking — hidden too.',
    'Three fit. Nearest first: **Bel Air** is 9 miles away.',
  ],
  conversationLabel: 'Conversation',

  howTitle: 'How it works',
  howSteps: [
    {
      title: 'Get in',
      body: 'Type the presenter’s access code into **Code** on **Demo Setup**, or switch to **Key** and paste your own OpenAI API key. Press **Start Demo**, then **Start booking**.',
    },
    {
      title: 'Say what matters',
      body: 'Turn voice on with the round mic button and just talk. Tap the options on screen whenever that is quicker.',
    },
    {
      title: 'Watch the screen adapt',
      body: 'The agent relabels, filters, sorts or highlights the options in place — one move at a time — and says what it did.',
    },
    {
      title: 'Book, or go back',
      body: 'If your requirements rule everything out, it tells you why and suggests where to go back. **Confirm Booking** ends it; nothing real is booked.',
    },
  ],

  adaptTitle: 'The screen changes, not just the chat',
  adaptLead:
    'What the agent learns from you shows up on the booking screen itself. It has four moves, and it makes one per turn.',
  adaptCards: {
    augment: {
      title: 'Augment',
      body: 'Rewrites an option’s label to surface the detail you asked about. By default a movie shows only its title, a cinema only its name, a showtime only its start; augment adds the rating, the miles or the end time. There is no badge — the words change, with a brief gold glow.',
      caption: '“Nothing scary.” The age rating appears on every title.',
      sentences: ['The ratings are on each title now: **Wildwood** and **The Legend of Aang** are PG.'],
    },
    filter: {
      title: 'Filter',
      body: 'Hides the options that fail a requirement; they fold out of the list. A **Show all** pill at the top right brings them back, dimmed, and **Show less** hides them again. Tapping a hidden one clears that step’s filters and selects it.',
      caption: '“Nothing before 8, and I need to be out by 11.” Sixteen shows become three.',
      sentences: [
        'Adding when each show ends.',
        'Hiding everything that starts before 8 PM.',
        'Three are out by 11: **8:10 PM** in IMAX or 3D, or **8:45 PM**.',
      ],
    },
    sort: {
      title: 'Sort',
      body: 'Reorders without hiding anything. There is no arrow and no “sorted by” label — the buttons slide to their new places — which is why the agent adds the miles before it sorts by them.',
      caption: 'Nearest first, once the distances are on the labels.',
      sentences: ['Nearest first — **Cinema Detroit** is 2.5 miles away.'],
    },
    highlight: {
      title: 'Highlight',
      body: 'Marks up to three choices with a gold border and a single pulse, without selecting them. On the seat map, a block of adjacent seats counts as one choice.',
      caption: '“Two together, in the middle of row E.” One pair fits.',
      sentences: ['**E5** and **E6** are the pair together in the middle of row E.'],
    },
  },
  adaptNote:
    'These are the real booking components, running on this page with data from the demo. **Play again** replays a figure; **Show all** works too.',
  adaptBullets: [
    'The movie, cinema and showtime lists take all four moves. The calendar and the seat map take a highlight only, and **Confirm Booking** takes none.',
    'The move follows from the preference. A hard requirement filters. A soft one about something ordered — time, distance, price, rating — sorts. A soft one about a category, such as genre or format, highlights. If the deciding detail is not on screen yet, the agent augments first.',
    'A filter that would leave nothing is refused, and the agent explains instead.',
    'Every move arrives as a new card headed **Agent is updating labels**, **Agent is filtering**, **Agent is sorting** or **Agent is highlighting**, carrying the sentence the agent said with it. The arrows above the card page back through earlier screens, which are read-only.',
    'While the agent works, the card’s frame turns gold, the options cannot be tapped, and **Agent working** appears in the conversation.',
  ],

  memoryTitle: 'It remembers — and you can take it back',
  memoryLead:
    'Everything you say passes through an extractor that turns it into preferences. They are shared: the agent plans with them, and you can see and edit them.',
  memoryBullets: [
    '**Memory** in the header opens **What the agent remembers**: a rail beside the booking on a wide screen, a full-screen sheet on a phone. The sheet is read-only; editing happens on the rail.',
    '**Preferences** lists each one as the agent wrote it, tagged **Hard** or **Soft**, with six dots — M, T, D, S, St, C — for the steps it applies to. A new one flashes gold as it arrives.',
    'Hard or soft comes down to one question: if nothing left met it, would you rather hear that there is no match, or see the options anyway? A concrete value you state — a cutoff time, a format, a seat count — counts as hard. “Prefer” and “ideally” make it soft.',
    '**Forget** turns into **Confirm?**; a second tap within four seconds removes the preference. Every filter and highlight it justified comes off the screen, and it waits under **Forgotten** until you press **Restore** — saying it again will not bring it back by itself. **Forget everything** clears the list the same way.',
    '**Demo Setup** can start the agent as if it remembered you. Under **Preference memory**, pick **Start empty** or one of six presets: **Family matinee**, **Date night**, **Big screen**, **Late show**, **Budget** or **Easy trip**. **Big screen** starts in conflict on purpose.',
  ],
  memoryFigureCaption:
    'A **Late show** visitor — 9 PM or later, within 15 miles — who chose the historic Redford. Its last Tuesday showing of Klara and the Sun starts at 7:35 PM.',
  memoryFigureNote:
    'A live copy of the panel. Try **Forget** and **Restore**, and open **Workflow** — but there is no agent behind this one, so nothing replans.',

  navTitle: 'When what you want does not exist',
  navLead:
    'Booking is a path through six steps — Movie, Theater, Date, Showtime, Seat, Confirm — and a choice made early can close off a later one. MAESTRO notices, says so, and remembers where it happened.',
  navBullets: [
    '**Conflict detected** appears above the tabs when the agent finds that nothing at this step — counting options a filter is hiding — can meet a hard preference. It explains in plain words and suggests going back to the nearest earlier step that still has alternatives.',
    'Agree, and it walks back one step at a time under **Backtracking** — for example, **Going back to the Theater step**.',
    'Going back turns the conflict into a **Dead end** in the **Workflow** tab: a red branch with the reason and what caused it. From then on the agent will not recommend that option again. The screen does not grey it out; only the agent’s advice changes.',
    'At **Confirm Booking** the agent checks every hard preference against the whole booking once more, and asks before letting one slide.',
    'Forgetting a preference also deletes the dead ends it caused.',
  ],
  navFigureCaption:
    'After the visitor agreed to go back: Redford’s showtime step is recorded as a dead end, and the agent is on its way back to the theater step.',

  voiceTitle: 'Talk to it',
  voiceLead:
    'The demo is built to be spoken to. The planner writes every sentence; a separate voice model only listens, and reads those sentences aloud word for word.',
  voiceBullets: [
    'Voice starts off. Turn it on with the round mic button (**Turn on voice mode**). The composer is voice-only in the demo: its box shows **Tap mic for voice** and then the voice status — **Listening...**, **Transcribing...**, **Playing reply...** — and there is no Send button. Tapping the screen always works.',
    'Interrupt any time: when you start talking, the agent’s voice stops mid-sentence.',
    'The pill beside the mic sets how much is said aloud: **Everything**, **Balanced** or **Minimal**, or your own mix, shown as **Custom**, plus **Skip smartly**. Anything not spoken still appears in the chat, marked **not spoken** or **shortened**.',
    '**Settings** → **Language** switches between English and 한국어. Speech recognition, what the agent says and most of the booking screen’s controls change; film titles, cinema names and prices stay as listed.',
    'Your phone can be the microphone. **Ready to start** shows **USE MY PHONE AS THE MIC** with a QR code: scan it, press **Use this phone**, and the phone listens and speaks while the big screen keeps the booking. **Back to the headset** hands voice back. The phone only ever talks to the booking screen, never to the agent.',
  ],
  voiceFigureCaption:
    'The real controls. Pick a preset or change a row, and the badge turns **Custom**.',

  cardsTitle: 'At the booth: one card, one sentence',
  cardsLead:
    'Five printed cards, one per step. Each QR code opens that step with the earlier choices already made — press **Start and talk** and say the line. Voice is on from the start, and nothing from a card session is recorded.',

  worldTitle: 'The world it books in',
  worldLead:
    'Detroit, from Tuesday 3 November 2026 — the evening of the UIST demo reception — through Sunday 8 November. The films, the cinemas, their distances from the Renaissance Center and their amenities are real. Runtimes, age ratings, showtimes, prices and which seats are taken are generated, so every showtime is simulated.',
  worldFilmsHeading: 'Films',
  worldCinemasHeading: 'Cinemas',
  worldFilmColumns: ['Title', 'Rating*', 'Runtime*', 'Formats*'],
  worldCinemaColumns: ['Cinema', 'Miles', 'Notes'],
  worldGeneratedNote: '* generated for the demo',
  worldNote:
    '679 showings over six days. Every session books into its own copy of this world, so one visitor’s seats never disappear for the next.',
  cinemaNotes: {
    t1: '2 screens · café · paid parking',
    t2: '10 screens · recliners · free parking',
    t3: 'a single screen · historic organ · free parking',
    t4: 'recliners · Dolby Atmos · bar · free parking',
    t5: 'the region’s only IMAX · recliners · free parking',
  },

  privacyTitle: 'What is recorded, and where your key goes',
  privacyBlocks: [
    {
      title: 'Nothing, unless you tick the box',
      body: '**Yes, record this session for research.** on **Demo Setup** starts unticked and is asked of every visitor. Leave it unticked and the session writes no log of any kind. The web server still keeps its ordinary access log of page requests, which holds no conversation. Quick-card sessions are never recorded.',
    },
    {
      title: 'If you tick it',
      body: 'The session keeps the conversation, the text of what you said, what you tapped and each screen you saw, and the agent’s prompts and decisions — three files on the demo server. No audio, no name, no account, no IP address, and never your key. They are kept after the session ends. While the session runs, **Trace** in the header downloads the agent’s log.',
    },
    {
      title: 'Your voice',
      body: 'Audio never reaches the demo server. In voice mode your browser streams the microphone straight to OpenAI’s Realtime API, using a short-lived credential the server mints for your session. Only the transcript text comes back into the conversation.',
    },
    {
      title: 'Your key',
      body: 'A pasted OpenAI key stays in this tab’s session storage until you close the tab. It is sent to the demo server once, held in memory for the session, used for the agent’s calls to OpenAI and to mint voice credentials, and never written to a log. Those calls carry the conversation, since the agent plans from it. An access code does the same with the presenter’s key, which never reaches your browser.',
    },
    {
      title: 'Limits',
      body: 'A session lasts up to 60 minutes and ends after 15 idle minutes; up to 10 run at once. **Confirm Booking** asks for no name and no payment and books nothing real, and when the session ends, its booking is deleted.',
    },
  ],

  hoodTitle: 'Under the hood',
  hoodBullets: [
    'Three model roles. An extractor turns what you say into preferences. A planner chooses the next single move — augment, filter, sort, highlight, select, next or back, among others — and writes the sentence that goes with it. OpenAI Realtime only listens and speaks; it never answers on its own.',
    'Your browser draws the GUI. Each move is applied to a declarative spec of the screen, so the component that renders your booking also renders every figure on this page.',
    'The panel that shows the memory is new for the demo. In the paper’s user study, the same memory worked out of sight.',
  ],
  paperLabel: 'Paper',

  glossaryTitle: 'The words the app uses',
  glossary: [
    { term: 'Access code', definition: 'Six characters from the presenter, typed into **Code**. It lends your session the presenter’s OpenAI key without ever showing it to you.' },
    { term: 'Preference', definition: 'One requirement the agent took from what you said, in its own words. **Hard** means only matching options will do; **Soft** means a leaning.' },
    { term: 'Augment, Filter, Sort, Highlight', definition: 'The four ways the agent changes the options on screen: relabel, hide, reorder, mark.' },
    { term: 'Show all', definition: 'The pill that brings filtered-out options back, dimmed.' },
    { term: 'Card', definition: 'One state of the booking screen. Each move adds a new card headed with what the agent did; the arrows above it page back.' },
    { term: 'Conflict detected', definition: 'No option at this step can meet a hard preference. The agent says why and suggests where to go back.' },
    { term: 'Dead end', definition: 'A conflict you went back from, remembered with its reason. The agent will not recommend that option again.' },
    { term: 'Backtracking', definition: 'The agent walking back to an earlier step you agreed to.' },
    { term: 'Forget, Restore', definition: 'Take a preference out of the agent’s memory, or put it back.' },
    { term: 'Voice verbosity', definition: 'How much the agent says aloud — **Everything**, **Balanced**, **Minimal** or **Custom**. The chat always has the full text.' },
    { term: 'Phone voice', definition: 'Your phone as the session’s microphone and speaker, paired from the QR code on **Ready to start**.' },
    { term: 'Research recording', definition: 'The opt-in box on **Demo Setup**. Leave it unticked and nothing is logged.' },
  ],

  footerLine: 'MAESTRO · UIST 2026 · Detroit',
};

const ko: AboutCopy = {
  documentTitle: 'MAESTRO 소개',
  eyebrow: 'UIST 2026 · 데모',
  headline: '원하는 것을 말하면, 화면이 그에 맞춰 바뀝니다.',
  intro:
    'MAESTRO는 지금 보고 있는 바로 그 화면에서 영화표를 함께 예매하는 대화형 에이전트입니다. 무서운 건 빼고, 15마일 이내로, 11시 전에는 끝나게 — 원하는 조건을 말하면 대답만 하지 않습니다. 눈앞의 선택지에 정보를 덧붙이고, 숨기고, 다시 정렬하고, 표시해 줍니다. 말한 조건은 직접 읽고 고칠 수 있는 메모리에 남고, 모든 조건을 만족하는 선택지가 없으면 그렇다고 알려 주며 아직 바꿀 수 있는 단계로 돌아가자고 제안합니다. 데모의 무대는 2026년 11월 3일 화요일의 디트로이트, 실제 영화 다섯 편과 실제 영화관 다섯 곳입니다.',
  ctaTry: '데모 해보기',
  ctaSource: '소스 코드',
  languageLabel: '언어',
  replay: '다시 재생',
  heroCaption:
    '퀵 카드 2번을 재생한 모습입니다. 문장 하나에 동작 네 번, 한 턴에 하나씩. 여기 나오는 에이전트의 문장은 예시이며, 실제 데모에서는 에이전트가 직접 씁니다.',
  heroQuestion: 'Klara and the Sun은 다섯 영화관 모두에서 상영해요. 영화관을 고를 때 중요한 게 있을까요?',
  heroSentences: [
    '비교하실 수 있게 각 영화관의 거리와 주차 정보를 붙였어요.',
    'MJR Troy는 20.4마일 떨어져 있어서 숨겼어요.',
    'Cinema Detroit는 주차가 유료라 함께 숨겼어요.',
    '세 곳이 맞아요. 가까운 순으로 보면 **Bel Air**가 9마일로 가장 가깝습니다.',
  ],
  conversationLabel: 'Conversation',

  howTitle: '이렇게 동작합니다',
  howSteps: [
    {
      title: '들어가기',
      body: '**데모 설정**의 **코드** 칸에 발표자에게 받은 접속 코드를 입력하거나, **Key**로 바꿔 본인의 OpenAI API 키를 붙여넣으세요. **데모 시작**, 이어서 **예매 시작하기**를 누르면 됩니다.',
    },
    {
      title: '원하는 것 말하기',
      body: '둥근 마이크 버튼으로 음성을 켜고 그냥 말하세요. 화면을 직접 누르는 게 빠를 땐 언제든 눌러도 됩니다.',
    },
    {
      title: '화면이 바뀌는 것 보기',
      body: '에이전트가 선택지에 정보를 덧붙이고, 걸러내고, 정렬하고, 강조합니다. 한 번에 한 동작씩, 무엇을 했는지 말하면서요.',
    },
    {
      title: '예매하거나, 되돌아가기',
      body: '조건 때문에 고를 것이 없어지면 이유를 설명하고 어디로 돌아갈지 제안합니다. **예매 확정**을 누르면 끝나며, 실제로 예매되는 것은 없습니다.',
    },
  ],

  adaptTitle: '대화만이 아니라 화면이 바뀝니다',
  adaptLead:
    '에이전트가 알게 된 것은 모두 예매 화면 위에 그대로 나타납니다. 동작은 네 가지이고, 한 턴에 하나씩 합니다.',
  adaptCards: {
    augment: {
      title: '덧붙이기 (Augment)',
      body: '선택지의 라벨을 고쳐 써서 물어본 정보를 드러냅니다. 기본적으로 영화는 제목만, 영화관은 이름만, 상영 시간은 시작 시각만 보이는데, 여기에 등급이나 거리, 종료 시각을 더합니다. 배지가 붙는 게 아니라 글자 자체가 바뀌고, 잠깐 금색으로 빛납니다.',
      caption: '“무서운 건 안 돼요.” 모든 제목 옆에 연령 등급이 나타납니다.',
      sentences: ['제목마다 등급을 붙였어요. **Wildwood**와 **The Legend of Aang**이 PG예요.'],
    },
    filter: {
      title: '걸러내기 (Filter)',
      body: '조건에 맞지 않는 선택지를 숨깁니다. 목록에서 접히듯 사라지고, 오른쪽 위의 **전체 보기**를 누르면 흐리게 다시 보이며 **간략히 보기**로 다시 숨깁니다. 숨겨진 항목을 누르면 그 단계의 필터가 해제되고 그 항목이 선택됩니다.',
      caption: '“8시 전은 안 되고, 11시까지는 나와야 해요.” 상영 열여섯 개가 세 개로 줄어듭니다.',
      sentences: [
        '상영마다 끝나는 시각을 붙였어요.',
        '오후 8시 전에 시작하는 상영은 숨겼어요.',
        '11시 전에 끝나는 건 세 개예요. **8:10 PM** IMAX나 3D, 또는 **8:45 PM**.',
      ],
    },
    sort: {
      title: '정렬 (Sort)',
      body: '아무것도 숨기지 않고 순서만 바꿉니다. 화살표나 ‘정렬 기준’ 표시는 없고 버튼이 새 자리로 미끄러져 갈 뿐이라, 에이전트는 거리순으로 정렬하기 전에 먼저 거리를 라벨에 붙입니다.',
      caption: '거리가 라벨에 붙은 뒤, 가까운 순으로.',
      sentences: ['가까운 순으로 정렬했어요. **Cinema Detroit**가 2.5마일로 가장 가까워요.'],
    },
    highlight: {
      title: '강조 (Highlight)',
      body: '최대 세 개의 선택지를 금색 테두리와 한 번의 파동으로 표시합니다. 선택까지 하지는 않습니다. 좌석표에서는 붙어 있는 좌석 한 묶음을 선택지 하나로 셉니다.',
      caption: '“E열 가운데에 두 자리 붙어서요.” 맞는 쌍은 하나뿐입니다.',
      sentences: ['E열 가운데에서 붙어 있는 자리는 **E5**와 **E6**이에요.'],
    },
  },
  adaptNote:
    '위의 그림은 이 페이지 안에서 데모 데이터로 돌아가는 실제 예매 컴포넌트입니다. **다시 재생**으로 다시 볼 수 있고, **전체 보기**도 실제로 동작합니다.',
  adaptBullets: [
    '영화, 영화관, 상영 시간 목록은 네 가지 동작을 모두 받습니다. 달력과 좌석표는 강조만, **예매 확정** 화면은 아무것도 받지 않습니다.',
    '어떤 동작을 할지는 선호에서 정해집니다. 꼭 지켜야 하는 조건(Hard)이면 걸러내고, 시간·거리·가격·평점처럼 순서가 있는 것에 대한 가벼운 선호(Soft)면 정렬하고, 장르나 포맷 같은 범주에 대한 가벼운 선호면 강조합니다. 판단에 필요한 정보가 아직 화면에 없으면 먼저 덧붙입니다.',
    '아무것도 남지 않게 만드는 필터는 거부되고, 에이전트가 대신 설명합니다.',
    '동작마다 **Agent is updating labels**, **Agent is filtering**, **Agent is sorting**, **Agent is highlighting** 같은 제목이 붙은 새 카드가 생기고, 에이전트가 그때 한 말이 함께 담깁니다. 카드 위의 화살표로 이전 화면을 넘겨 볼 수 있으며, 이전 화면은 보기만 가능합니다.',
    '에이전트가 작업하는 동안에는 카드 테두리가 금색으로 바뀌고 선택지를 누를 수 없으며, 대화에 **에이전트 작업 중**이 표시됩니다.',
  ],

  memoryTitle: '기억하고, 되돌릴 수도 있습니다',
  memoryLead:
    '말한 내용은 모두 추출기를 거쳐 선호로 바뀝니다. 이 선호는 공유됩니다. 에이전트는 이것으로 계획을 세우고, 사용자는 이것을 보고 고칠 수 있습니다.',
  memoryBullets: [
    '상단의 **기억** 버튼을 누르면 **What the agent remembers**가 열립니다. 넓은 화면에서는 예매 화면 옆 패널로, 휴대폰에서는 전체 화면 시트로 뜹니다. 시트는 보기 전용이고, 편집은 옆 패널에서 합니다.',
    '**Preferences** 탭에는 에이전트가 쓴 문장 그대로 선호가 나열되고, **Hard** 또는 **Soft** 표시와 함께 적용되는 단계를 여섯 개의 점(M, T, D, S, St, C)으로 보여 줍니다. 새 선호가 들어오면 금색으로 한 번 반짝입니다.',
    'Hard와 Soft를 가르는 질문은 하나입니다. 남은 선택지 중 이 조건을 만족하는 것이 하나도 없다면, 맞는 게 없다는 말을 듣고 싶은지(Hard), 그래도 선택지를 보고 싶은지(Soft). 마감 시각, 포맷, 좌석 수처럼 구체적인 값을 말하면 Hard로, ‘되도록’, ‘가능하면’ 같은 말이 붙으면 Soft로 봅니다.',
    '**지우기**를 누르면 **정말?**로 바뀌고, 4초 안에 한 번 더 누르면 지워집니다. 그 선호를 근거로 한 필터와 강조는 화면에서 사라지고, 선호는 **Forgotten** 아래에 남아 **되돌리기**를 누를 때까지 기다립니다. 같은 말을 다시 해도 저절로 돌아오지는 않습니다. **전체 지우기**도 같은 방식으로 목록 전체를 비웁니다.',
    '**데모 설정**에서 에이전트가 이미 나를 기억하는 것처럼 시작할 수도 있습니다. **선호 메모리** 아래에서 **Start empty** 또는 여섯 개 프리셋 **Family matinee**, **Date night**, **Big screen**, **Late show**, **Budget**, **Easy trip** 중 하나를 고르세요. **Big screen**은 일부러 충돌 상태로 시작합니다.',
  ],
  memoryFigureCaption:
    '**Late show** 프리셋(밤 9시 이후, 15마일 이내)으로 시작한 방문자가 역사 깊은 Redford를 골랐습니다. 화요일 Klara and the Sun의 마지막 상영은 오후 7:35입니다.',
  memoryFigureNote:
    '예매 도중의 메모리 패널을 그대로 옮겨 온 것입니다. **지우기**와 **되돌리기**를 눌러 보고 **Workflow** 탭도 열어 보세요. 다만 뒤에 에이전트가 없어서 다시 계획을 세우지는 않습니다.',

  navTitle: '원하는 것이 없을 때',
  navLead:
    '예매는 영화, 극장, 날짜, 시간, 좌석, 확정의 여섯 단계를 지나는 길이고, 앞에서 한 선택이 뒤의 선택지를 막을 수 있습니다. MAESTRO는 이를 알아차리고, 알려 주고, 어디서 막혔는지 기억합니다.',
  navBullets: [
    '지금 단계의 선택지 중 — 필터로 숨겨진 것까지 포함해 — 어느 것도 Hard 선호를 만족하지 못하면 탭 위에 **Conflict detected**가 뜹니다. 에이전트는 쉬운 말로 이유를 설명하고, 아직 다른 선택지가 있는 가장 가까운 이전 단계로 돌아가자고 제안합니다.',
    '동의하면 **Backtracking** 표시와 함께 한 단계씩 되돌아갑니다. 예를 들면 **Going back to the Theater step**.',
    '되돌아가면 그 충돌은 **Workflow** 탭에 **Dead end**로 남습니다. 이유와 원인이 적힌 빨간 가지입니다. 그 뒤로 에이전트는 그 선택지를 다시 추천하지 않습니다. 화면에서 회색으로 막히는 것은 아니고, 에이전트의 추천만 달라집니다.',
    '**예매 확정** 단계에서 에이전트는 모든 Hard 선호를 완성된 예매 전체와 한 번 더 대조하고, 어긋나는 것이 있으면 그대로 진행할지 먼저 묻습니다.',
    '선호를 지우면 그 선호 때문에 생긴 막다른 길도 함께 지워집니다.',
  ],
  navFigureCaption:
    '되돌아가기에 동의한 뒤의 모습입니다. Redford의 상영 시간 단계는 막다른 길로 기록되고, 에이전트는 극장 단계로 돌아가는 중입니다.',

  voiceTitle: '말로 하세요',
  voiceLead:
    '이 데모는 말로 쓰도록 만들어졌습니다. 모든 문장은 플래너가 쓰고, 별도의 음성 모델은 듣는 일과 그 문장을 한 글자도 바꾸지 않고 읽어 주는 일만 합니다.',
  voiceBullets: [
    '음성은 꺼진 채로 시작합니다. 둥근 마이크 버튼(**음성 모드 켜기**)으로 켜세요. 데모의 입력창은 음성 전용이라 칸에는 **마이크를 눌러 말하세요**와 이어지는 상태 — **듣는 중...**, **받아쓰는 중...**, **답변을 재생하는 중...** — 가 표시되고, 보내기 버튼은 없습니다. 화면을 직접 누르는 것은 언제나 됩니다.',
    '언제든 끼어들어도 됩니다. 말을 시작하면 에이전트의 음성이 문장 중간에서 멈춥니다.',
    '마이크 옆 버튼으로 소리 내어 말하는 양을 정합니다. **Everything**, **Balanced**, **Minimal** 중 하나를 고르거나 직접 조합하면 **Custom**으로 표시되고, **Skip smartly**도 켜고 끌 수 있습니다. 말하지 않은 내용도 대화창에는 그대로 남고 **not spoken**이나 **shortened**로 표시됩니다.',
    '**설정** → **언어**에서 English와 한국어를 바꿀 수 있습니다. 음성 인식, 에이전트가 하는 말, 예매 화면 버튼의 대부분이 바뀌고, 영화 제목·영화관 이름·가격은 목록 그대로 둡니다.',
    '휴대폰을 마이크로 쓸 수도 있습니다. **시작 준비가 되었습니다** 화면의 **폰을 마이크로 사용** 카드에 QR 코드가 있습니다. 스캔하고 **이 폰으로 듣기**를 누르면 큰 화면은 예매를 계속 보여 주고 휴대폰이 듣고 말합니다. **헤드셋으로 되돌리기**를 누르면 음성이 돌아갑니다. 휴대폰은 예매 화면과만 통신하고, 에이전트와 직접 이야기하지 않습니다.',
  ],
  voiceFigureCaption:
    '실제 컨트롤입니다. 프리셋을 고르거나 줄 하나를 바꿔 보면 표시가 **Custom**으로 바뀝니다.',

  cardsTitle: '부스에서: 카드 한 장, 문장 하나',
  cardsLead:
    '단계마다 한 장씩, 다섯 장의 카드가 있습니다. QR 코드를 찍으면 앞 단계가 이미 골라진 채로 그 단계가 열립니다. **시작하고 말하기**를 누르고 카드의 문장을 말하세요. 음성은 처음부터 켜져 있고, 카드로 시작한 세션은 아무것도 기록하지 않습니다.',

  worldTitle: '예매하는 세계',
  worldLead:
    'UIST 데모 리셉션이 열리는 2026년 11월 3일 화요일부터 11월 8일 일요일까지의 디트로이트입니다. 영화, 영화관, 르네상스 센터로부터의 거리, 편의시설은 실제입니다. 러닝타임, 연령 등급, 상영 시간, 가격, 판매된 좌석은 생성된 값이라 모든 상영 시간은 가상입니다.',
  worldFilmsHeading: '영화',
  worldCinemasHeading: '영화관',
  worldFilmColumns: ['제목', '등급*', '러닝타임*', '포맷*'],
  worldCinemaColumns: ['영화관', '마일', '특징'],
  worldGeneratedNote: '* 데모를 위해 생성한 값',
  worldNote:
    '6일 동안 679회 상영합니다. 세션마다 이 세계의 복사본에 예매하므로, 한 방문자가 고른 좌석이 다음 방문자에게서 사라지지 않습니다.',
  cinemaNotes: {
    t1: '상영관 2개 · 카페 · 유료 주차',
    t2: '상영관 10개 · 리클라이너 · 무료 주차',
    t3: '단관 · 역사적인 파이프 오르간 · 무료 주차',
    t4: '리클라이너 · Dolby Atmos · 바 · 무료 주차',
    t5: '이 지역 유일의 IMAX · 리클라이너 · 무료 주차',
  },

  privacyTitle: '무엇이 기록되고, 키는 어디로 가나요',
  privacyBlocks: [
    {
      title: '체크하지 않으면 아무것도 남지 않습니다',
      body: '**데모 설정**의 **네, 이 세션을 연구 목적으로 기록해도 좋습니다.**는 체크되지 않은 채로 시작하며 방문자마다 새로 묻습니다. 체크하지 않으면 세션은 어떤 로그도 남기지 않습니다. 웹 서버는 평소처럼 페이지 요청 접속 기록만 남기며, 여기에 대화 내용은 들어가지 않습니다. 퀵 카드로 시작한 세션은 언제나 기록하지 않습니다.',
    },
    {
      title: '체크하면',
      body: '대화, 말한 내용의 텍스트, 화면에서 누른 것과 본 화면, 에이전트의 프롬프트와 판단이 데모 서버에 파일 세 개로 남습니다. 음성, 이름, 계정, IP 주소, 그리고 키는 들어가지 않습니다. 이 파일은 세션이 끝나도 남습니다. 세션 중에는 상단의 **트레이스** 버튼으로 에이전트 로그를 내려받을 수 있습니다.',
    },
    {
      title: '음성',
      body: '음성은 데모 서버로 가지 않습니다. 음성 모드에서는 서버가 이 세션용으로 발급한 짧은 수명의 자격 증명으로, 브라우저가 마이크 소리를 OpenAI Realtime API에 직접 보냅니다. 대화로 돌아오는 것은 받아쓴 텍스트뿐입니다.',
    },
    {
      title: '키',
      body: '붙여넣은 OpenAI 키는 탭을 닫을 때까지 이 탭의 세션 저장소에 남습니다. 데모 서버에는 한 번 보내지고, 세션 동안 메모리에만 보관되며, 에이전트가 OpenAI를 호출하고 음성 자격 증명을 발급하는 데 쓰이고, 로그에는 절대 기록되지 않습니다. 에이전트는 대화를 보고 계획하므로 이 호출에는 대화 내용이 담깁니다. 접속 코드를 쓰면 발표자의 키가 같은 방식으로 쓰이며, 그 키는 브라우저에 전달되지 않습니다.',
    },
    {
      title: '한도',
      body: '세션은 최대 60분이고, 15분 동안 아무 활동이 없으면 끝나며, 동시에 최대 10개까지 열립니다. **예매 확정**은 이름도 결제도 묻지 않고 실제로 예매하지 않으며, 세션이 끝나면 그 예매도 삭제됩니다.',
    },
  ],

  hoodTitle: '안쪽에서는',
  hoodBullets: [
    '모델의 역할은 셋입니다. 추출기는 말한 내용을 선호로 바꿉니다. 플래너는 덧붙이기, 걸러내기, 정렬, 강조, 선택, 다음, 뒤로 같은 동작 중 다음 하나를 고르고 함께 할 말을 씁니다. OpenAI Realtime은 듣고 말하는 일만 하며 스스로 대답하지 않습니다.',
    'GUI는 브라우저가 그립니다. 동작은 화면을 선언적으로 기술한 스펙에 적용되므로, 예매 화면을 그리는 컴포넌트가 이 페이지의 그림도 그대로 그립니다.',
    '메모리를 보여 주는 패널은 데모를 위해 새로 만든 것입니다. 논문의 사용자 연구에서는 같은 메모리가 보이지 않는 곳에서 작동했습니다.',
  ],
  paperLabel: '논문',

  glossaryTitle: '앱에서 쓰는 말',
  glossary: [
    { term: '접속 코드', definition: '발표자에게 받는 여섯 글자로, **코드** 칸에 입력합니다. 키를 보여 주지 않은 채 발표자의 OpenAI 키를 내 세션에 빌려줍니다.' },
    { term: '선호', definition: '말한 내용에서 에이전트가 뽑아낸 조건 하나로, 에이전트 자신의 문장으로 적힙니다. **Hard**는 맞는 선택지만 된다는 뜻이고, **Soft**는 되도록 그랬으면 하는 정도입니다.' },
    { term: '덧붙이기 · 걸러내기 · 정렬 · 강조', definition: '에이전트가 화면의 선택지를 바꾸는 네 가지 방법: 라벨 고쳐 쓰기, 숨기기, 순서 바꾸기, 표시하기.' },
    { term: '전체 보기', definition: '걸러진 선택지를 흐리게 다시 보여 주는 버튼.' },
    { term: '카드', definition: '예매 화면의 한 상태. 동작마다 에이전트가 한 일을 제목으로 단 새 카드가 생기고, 위의 화살표로 이전 카드를 넘겨 봅니다.' },
    { term: 'Conflict detected', definition: '지금 단계의 어떤 선택지도 Hard 선호를 만족하지 못하는 상태. 에이전트가 이유를 말하고 돌아갈 곳을 제안합니다.' },
    { term: 'Dead end', definition: '되돌아 나온 충돌을 이유와 함께 기억해 둔 것. 에이전트는 그 선택지를 다시 추천하지 않습니다.' },
    { term: 'Backtracking', definition: '동의한 이전 단계로 에이전트가 되돌아가는 중인 상태.' },
    { term: '지우기 · 되돌리기', definition: '에이전트의 메모리에서 선호를 빼거나 다시 넣는 것.' },
    { term: '음성 상세도', definition: '에이전트가 소리 내어 말하는 양: **Everything**, **Balanced**, **Minimal**, **Custom**. 대화창에는 항상 전체 문장이 남습니다.' },
    { term: '폰 음성', definition: '**시작 준비가 되었습니다** 화면의 QR 코드로 연결해, 휴대폰을 세션의 마이크와 스피커로 쓰는 것.' },
    { term: '연구 기록 동의', definition: '**데모 설정**의 선택 체크 상자. 체크하지 않으면 아무 로그도 남지 않습니다.' },
  ],

  footerLine: 'MAESTRO · UIST 2026 · 디트로이트',
};

export const ABOUT_COPY: Record<Language, AboutCopy> = { en, ko };
