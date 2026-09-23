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
 *     illustrative on this page and is captioned as such; bold inside those
 *     sentences is the agent's own emphasis, as it writes it in the chat.
 *
 * A label is quoted in its source casing. Several are drawn with CSS
 * `uppercase` (Show all, Hard/Soft, Forget, Forgotten …), so the app shows them
 * in capitals.
 *
 * Every sentence here was fact-checked against the code on 2026-09-23. If you
 * change what the page describes, change the page with it.
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
  heroSentences: [augment: string, filterDistance: string, filterParking: string];
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
    'MAESTRO is a conversational agent that books movie tickets on the same screen you are looking at. Tell it what matters — nothing scary, no more than 15 miles, out by eleven — and it does more than answer. It relabels, hides, reorders and marks the options in front of you, and keeps every requirement where you can read it and take it back. When nothing left can meet one of your must-haves, it says so and offers to take you back to a step where something can still change. The demo is set in Detroit on Tuesday, 3 November 2026, and books any day from then through Sunday the 8th: five real films at five real cinemas.',
  ctaTry: 'Try the demo',
  ctaSource: 'Source code',
  languageLabel: 'Language',
  replay: 'Play again',
  heroCaption:
    'Quick card 2, played out: one sentence, three moves, one at a time. The agent’s sentences here are illustrative — in the demo it writes its own.',
  heroQuestion: 'Klara and the Sun is on at all five cinemas. Anything that matters for where you see it?',
  heroSentences: [
    'Adding each cinema’s distance and parking, so you can compare.',
    'MJR Troy is 20.4 miles out, so I’ve hidden it.',
    'Cinema Detroit charges for parking, so I’ve hidden it too — three are left.',
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
      body: 'The agent relabels, filters, sorts or highlights the options in place, one move at a time.',
    },
    {
      title: 'Book, or go back',
      body: 'If your requirements rule everything out, it tells you why and, when an earlier step still has options, suggests going back to it. **Confirm Booking** completes the booking and **Finish Task** closes the session; nothing real is booked.',
    },
  ],

  adaptTitle: 'The screen changes, not just the chat',
  adaptLead:
    'What the agent learns from you shows up on the booking screen itself, not just in the chat. It has four moves, and it makes them one at a time.',
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
      caption: '“The closer, the better.” Nearest first, once the distances are on the labels.',
      sentences: ['Nearest first — **Cinema Detroit** is 2.5 miles away.'],
    },
    highlight: {
      title: 'Highlight',
      body: 'Marks a few choices with a gold border and a single pulse, without selecting them — the agent is told never to mark more than three. On the seat map, a block of adjacent seats for your party counts as one choice.',
      caption: '“Two together, in the middle of row E.” One pair fits.',
      sentences: ['**E5** and **E6** are the pair together in the middle of row E.'],
    },
  },
  adaptNote:
    'These are the real booking components, running on this page with data from the demo. **Play again** replays a figure, and the options respond to taps — try **Show all** on the showtimes.',
  adaptBullets: [
    'The movie, cinema and showtime lists take all four moves. The calendar and the seat map take a highlight only, and the final Confirm step takes none.',
    'The move follows from the preference. On the three lists, a hard requirement filters; a soft one about something ordered — time, distance, rating — sorts; and a soft one about a category, such as genre or format, highlights. If the deciding detail is not on screen yet, the agent augments first. The calendar and the seat map can only highlight, so there the agent marks what fits when that leaves three or fewer, and otherwise says what fits and asks a question that narrows it.',
    'The agent is told not to filter when nothing would match, and to say why instead. If it filters anyway, the screen refuses the filter, and the agent follows up with “None of the options match that filter. Let me try a different approach.”',
    'Every move arrives as a new card headed **Agent is updating labels**, **Agent is filtering**, **Agent is sorting** or **Agent is highlighting** — or **Agent is clearing modifications** when it undoes its own changes — carrying the sentence the agent said with it. When it moves without saying anything, which with voice on it does on purpose for a step that leads straight into another, the card shows the agent’s own short note of why instead, in English. The chevrons above and below the card page through earlier screens, which are read-only.',
    'While the agent works, the card’s frame turns gold, the options cannot be tapped, and **Agent working** appears in the conversation.',
  ],

  memoryTitle: 'It remembers — and you can take it back',
  memoryLead:
    'Everything you say passes through an extractor that pulls preferences out of it. They are shared: the agent plans with them, and you can see them, change them by saying so, and forget any of them.',
  memoryBullets: [
    '**Memory** in the header shows or hides what the agent remembers. On a screen 1024 px wide or more it is a rail beside the booking, headed **What the agent remembers** and open from the start. On anything narrower, such as a phone or an upright tablet, it is a full-screen sheet headed **Memory**. The sheet is read-only: forget and restore on the rail, or on a phone paired through **USE MY PHONE AS THE MIC**.',
    '**Preferences** lists each one in the words it was stored in — the agent’s, or the preset’s — tagged **Hard** or **Soft**, with six dots — M, T, D, S, St, C — for the steps it applies to. A new one flashes gold as it arrives.',
    'Hard or soft comes down to one question: if nothing left met it, would you rather hear that there is no match, or see the options anyway? A concrete value you state — a cutoff time, a format, a seat count — counts as hard by default, however you phrase it. “Prefer” and “ideally” make a taste soft, not a concrete value.',
    '**Forget** turns into **Confirm?**; a second tap within four seconds removes the preference. Every filter and highlight it justified comes off the screen, and it waits under **Forgotten** until you press **Restore**, which puts that same entry back. While it waits, the agent cannot write that exact sentence back into memory — but if you say it again and the agent words it differently, it comes back as a new preference. **Forget everything** clears the whole list the same way, arming as **Confirm — forget all?**',
    '**Demo Setup** can start the agent as if it remembered you. Under **Preference memory**, pick **Start empty** or one of six presets: **Family matinee**, **Date night**, **Big screen**, **Late show**, **Budget** or **Easy trip**. **Big screen** is built to fail: it wants IMAX within 15 miles, and the only IMAX screen of the five is at MJR Troy, 20.4 miles away. Nothing is flagged at the start; the conflict comes up later, usually at the showtime step.',
  ],
  memoryFigureCaption:
    'A **Late show** visitor — 9 PM or later, within 15 miles — who chose the historic Redford for Clayface on Friday. Redford shows Clayface only that day, and its last showing starts at 7:25 PM.',
  memoryFigureNote:
    'The real memory panel on sample data. Try **Forget** and **Restore**, and open **Workflow** — but there is no agent behind this one, so nothing replans.',

  navTitle: 'When what you want does not exist',
  navLead:
    'Booking is a path through six steps — Movie, Theater, Date, Showtime, Seat, Confirm — and a choice made early can close off a later one. MAESTRO notices, says so, and remembers where it happened.',
  navBullets: [
    '**Conflict detected** appears above the tabs when the agent finds that nothing at this step — counting options a filter is hiding — can meet a hard preference. It explains in plain words and suggests going back to the nearest earlier step that still has other options; if none does, it names the requirement in the way and asks which one to revisit.',
    'Agree, and it goes back. When the step it named is more than one step away, it walks back one step at a time under **Backtracking** — for example, **Going back to the Theater step**. If you speak along the way, the walk stops and the agent answers what you said.',
    'Going back while the conflict still stands turns it into a **Dead end** in the **Workflow** tab: a red branch with the reason and what caused it. From then on the agent sees that dead end every time it plans and is told to treat it as unavailable; a showtime whose seats fell through is also named outright, with an instruction never to pick or suggest it. The screen does not grey anything out — going back even leaves the earlier choice outlined as selected — only the agent’s advice changes.',
    'At the final Confirm step the agent checks every hard preference against the whole booking once more, and asks before letting one slide.',
    'Forgetting a preference also deletes the dead ends it caused.',
  ],
  navFigureCaption:
    'After the visitor agreed to go back: Friday’s showtime step at Redford is recorded as a dead end, and because Redford has no other day for Clayface, the agent is passing back through the date step on its way to the theater step.',

  voiceTitle: 'Talk to it',
  voiceLead:
    'The demo is built to be spoken to. The planner writes every sentence; a separate voice model only listens, and is told to read aloud, word for word, whatever of those sentences the voice setting lets through.',
  voiceBullets: [
    'Voice starts off. Turn it on with the round mic button (labelled **Turn on voice mode**). The composer is voice-only in the demo: its box shows **Tap mic for voice**, then the voice status — **Listening...**, **Transcribing...**, **Playing reply...** — and there is no Send button. While the agent works it reads **Waiting for the next agent message...**, and voice turns itself off on the last step. Instead of speaking you can answer by tapping the card, except while the agent is working or the next step is loading: until then the card is locked.',
    'Interrupt any time: when you start talking, the agent’s voice stops mid-sentence.',
    'The pill beside the mic shows how much is said aloud and opens the setting: **Everything**, **Balanced** or **Minimal**, or any other mix, shown as **Custom**, plus **Skip smartly**. Until you choose, it reads **Balanced** while voice is off and turns **Custom** by itself when voice comes on (every row at **Speak**, **Skip smartly** on), because the agent then writes its spoken lines short itself. Anything this setting keeps from being spoken still appears in the chat, marked **not spoken** or **shortened**. With voice on, though, the agent also stops narrating steps you can watch happen, so those lines are missing from the chat too, whichever preset is picked.',
    '**Settings** → **Language** switches between English and 한국어. Speech recognition, what the agent says and most of the booking screen’s controls change; film titles, cinema names and prices stay as listed.',
    'Your phone can be the microphone. **Ready to start** shows **USE MY PHONE AS THE MIC** with a QR code. Scan it, press **Start booking** on the big screen, then **Use this phone** on the phone — until the booking starts, the phone reads **Waiting for the kiosk to start the booking.** From then on the phone listens and speaks while the big screen keeps the booking, and it shows what the agent remembers, where you can forget or restore a preference. **Back to the headset** hands voice back. The phone never sends anything to the agent: what you say, and what you forget or restore there, goes through the booking screen, and the phone speaks only what the booking screen hands it. Its microphone audio, like the big screen’s, streams straight to OpenAI.',
  ],
  voiceFigureCaption:
    'The real controls. Pick a preset and the pill shows its name; change a row or flip **Skip smartly** and it reads **Custom**.',

  cardsTitle: 'At the booth: one card, one sentence',
  cardsLead:
    'Five printed cards, one per selection step. Each QR code opens that step with the earlier choices already made, and the card screen has an English / 한국어 switch. Press **Start and talk** and say the line. Voice is on from the start, and a card session is never recorded for research.',

  worldTitle: 'The world it books in',
  worldLead:
    'Detroit, from Tuesday 3 November 2026 — the evening of the UIST demo reception — through Sunday 8 November. The films, the cinemas, their distances from the Renaissance Center and their amenities are real. Runtimes, age ratings, critic scores, seat maps, prices, showtimes and which seats are taken are generated, so every showtime is simulated.',
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
    t5: 'the only IMAX of the five · recliners · free parking',
  },

  privacyTitle: 'What is recorded, and where your key goes',
  privacyBlocks: [
    {
      title: 'No research recording unless you tick the box',
      body: '**Yes, record this session for research.** on **Demo Setup** starts unticked and is asked of every visitor. Leave it unticked and no research file is written. The servers still keep their ordinary operational logs: each page and API request with its time, the address it came from, the page before it and the browser (so the booking screen’s requests show which film, cinema and date it loaded), status lines from the session’s agent process, and, if you used an access code, that code’s use count and last use. None of them holds the conversation. Quick-card sessions are never recorded for research.',
    },
    {
      title: 'If you tick it',
      body: 'The session keeps the conversation, the text of what you said, what you tapped and each screen you saw, and the agent’s prompts and decisions — three files on the demo server. No audio, no name, no account, no IP address and never your key, but what you say is kept word for word. The files stay after the session ends, and the booking you made stays in them. While the session runs, **Trace** in the header downloads one of the three: the agent’s prompts and the model’s replies. The other two cannot be downloaded.',
    },
    {
      title: 'Your voice',
      body: 'Audio never reaches the demo server. In voice mode your browser streams the microphone straight to OpenAI’s Realtime API, using a short-lived credential the server mints for your session. Only the transcript text comes back into the conversation.',
    },
    {
      title: 'Your key',
      body: 'A pasted OpenAI key stays in this tab’s session storage until you close the tab. Finishing the demo does not clear it, and the next session in this tab starts with it, so close the tab on a shared screen. The key goes to the demo server each time you start a session, and each time you press **Play Sample** in **Mic Check**. The server checks it with OpenAI, holds it in memory for the session, uses it for the agent’s calls to OpenAI, to mint voice credentials and to play that sample, and never writes it to a log. Those calls carry the conversation, since the agent plans from it. An access code does the same with the presenter’s key, which never reaches your browser.',
    },
    {
      title: 'Limits',
      body: 'A session lasts up to 60 minutes and ends after 15 idle minutes; up to 10 run at once. **Confirm Booking** asks for no name and no payment and books nothing real, and when the session ends, its booking is deleted from the demo’s database.',
    },
  ],

  hoodTitle: 'Under the hood',
  hoodBullets: [
    'Three model roles. An extractor pulls preferences out of what you say. A planner chooses the next single move — augment, filter, sort, highlight, select, next or back, among others — and, when you need to hear something, writes the sentence that goes with it. OpenAI Realtime only listens and speaks; it never answers on its own.',
    'Your browser draws the GUI. Each move is applied to a declarative spec of the screen. The renderer that draws your booking from that spec also draws the booking screens in this page’s figures, from scripted specs. The memory, workflow and voice figures use the app’s own memory panel, workflow graph and voice controls on sample data. The card and window frames, the transcript dividers and the Backtracking banner are drawn by this page, modelled on the app’s.',
    'The panel that shows the memory is new for the demo. In the paper’s user study the memory worked out of sight, and only for participants who had MAESTRO’s full interface. It has changed since then: it decides hard or soft differently, it records and applies dead ends the study build lost, and Forget, Restore and the preset memories are new.',
  ],
  paperLabel: 'Paper',

  glossaryTitle: 'The words the app uses',
  glossary: [
    { term: 'Access code', definition: 'Six characters from the presenter, typed into **Code**. It lends your session the presenter’s OpenAI key without ever showing it to you.' },
    { term: 'Preference', definition: 'One requirement taken from what you said, or from a preset, in words you can read. **Hard** means only matching options will do; **Soft** means a leaning.' },
    { term: 'Augment, Filter, Sort, Highlight', definition: 'The four ways the agent changes the options on screen: relabel, hide, reorder, mark.' },
    { term: 'Show all', definition: 'The pill that brings filtered-out options back, dimmed.' },
    { term: 'Card', definition: 'One state of the booking screen. Each move — the agent’s, or your tap — adds a new card headed with what happened; the chevrons page back and forth.' },
    { term: 'Conflict detected', definition: 'No option at this step can meet a hard preference. The agent says why and suggests where to go back, or asks which requirement to change.' },
    { term: 'Dead end', definition: 'A conflict you went back from, remembered with its reason. While the preference behind it stands, the agent is told to treat it as unavailable.' },
    { term: 'Backtracking', definition: 'The agent walking back, one step at a time, to an earlier step you agreed to.' },
    { term: 'Forget, Restore', definition: 'Take a preference out of the agent’s memory, or put it back.' },
    { term: 'Voice verbosity', definition: 'How much the agent says aloud — **Everything**, **Balanced**, **Minimal** or **Custom**.' },
    { term: 'Phone voice', definition: 'Your phone as the session’s microphone and speaker, paired from the QR code on **Ready to start** or under the memory panel.' },
    { term: 'Research recording', definition: 'The opt-in box on **Demo Setup**. Leave it unticked and no research file is written; the servers keep only routine request logs, which hold no conversation.' },
  ],

  footerLine: 'MAESTRO · UIST 2026 · Detroit',
};

const ko: AboutCopy = {
  documentTitle: 'MAESTRO 소개',
  eyebrow: 'UIST 2026 · 데모',
  headline: '원하는 것을 말하면, 화면이 그에 맞춰 바뀝니다.',
  intro:
    'MAESTRO는 지금 보고 있는 바로 그 화면에서 영화표를 함께 예매하는 대화형 에이전트입니다. 무서운 건 빼고, 15마일 이내로, 11시 전에는 끝나게 — 이렇게 원하는 조건을 말하면, 말로 대답하는 데서 그치지 않습니다. 눈앞의 선택지에 정보를 덧붙이고, 숨기고, 다시 정렬하고, 표시해 주며, 말한 조건은 직접 읽고 지울 수 있는 메모리에 남습니다. 꼭 지켜야 할 조건을 만족하는 선택지가 없으면 그렇다고 알려 주고, 아직 바꿀 수 있는 단계로 돌아가자고 제안합니다. 데모의 무대는 2026년 11월 3일 화요일부터 8일 일요일까지의 디트로이트, 실제 영화 다섯 편과 실제 영화관 다섯 곳입니다.',
  ctaTry: '데모 해보기',
  ctaSource: '소스 코드',
  languageLabel: '언어',
  replay: '다시 재생',
  heroCaption:
    '퀵 카드 2번을 재생한 모습입니다. 문장 하나에 동작 세 번, 하나씩 차례로. 여기 나오는 에이전트의 문장은 예시이며, 실제 데모에서는 에이전트가 직접 씁니다.',
  heroQuestion: 'Klara and the Sun은 다섯 영화관 모두에서 상영해요. 영화관을 고를 때 중요한 게 있을까요?',
  heroSentences: [
    '비교하실 수 있게 각 영화관의 거리와 주차 정보를 붙였어요.',
    'MJR Troy는 20.4마일 떨어져 있어서 숨겼어요.',
    'Cinema Detroit는 주차가 유료라서 이곳도 숨겼어요. 세 곳이 남았어요.',
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
      body: '에이전트가 선택지에 정보를 덧붙이고, 걸러내고, 정렬하고, 강조합니다. 한 번에 한 동작씩입니다.',
    },
    {
      title: '예매하거나, 되돌아가기',
      body: '조건 때문에 고를 것이 없어지면 이유를 설명하고, 아직 다른 선택지가 있는 이전 단계가 있으면 그리로 돌아가자고 제안합니다. **예매 확정**으로 예매가 끝나고 **완료**를 누르면 세션이 닫히며, 실제로 예매되는 것은 없습니다.',
    },
  ],

  adaptTitle: '대화만이 아니라 화면이 바뀝니다',
  adaptLead:
    '에이전트가 알게 된 것은 대화창에만 머물지 않고 예매 화면 자체에도 나타납니다. 동작은 네 가지이고, 한 번에 하나씩 합니다.',
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
        '11시까지 끝나는 건 세 개예요. **8:10 PM** IMAX나 3D, 아니면 **8:45 PM**이에요.',
      ],
    },
    sort: {
      title: '정렬 (Sort)',
      body: '아무것도 숨기지 않고 순서만 바꿉니다. 화살표나 ‘정렬 기준’ 표시는 없고 버튼이 새 자리로 미끄러져 갈 뿐이라, 에이전트는 거리순으로 정렬하기 전에 먼저 거리를 라벨에 붙입니다.',
      caption: '“가까울수록 좋아요.” 거리가 라벨에 붙은 뒤, 가까운 순으로.',
      sentences: ['가까운 순으로 정렬했어요. **Cinema Detroit**가 2.5마일로 가장 가까워요.'],
    },
    highlight: {
      title: '강조 (Highlight)',
      body: '선택지 몇 개를 금색 테두리로 감싸고 한 번 깜빡이게 해서 표시합니다. 선택까지 하지는 않으며, 에이전트는 세 개를 넘겨 표시하지 않도록 되어 있습니다. 좌석표에서는 일행 수만큼 붙어 있는 좌석 한 묶음을 선택지 하나로 셉니다.',
      caption: '“E열 가운데에 두 자리 붙어서요.” 맞는 쌍은 하나뿐입니다.',
      sentences: ['E열 가운데에서 붙어 있는 자리는 **E5**와 **E6**이에요.'],
    },
  },
  adaptNote:
    '위의 그림은 이 페이지 안에서 데모 데이터로 돌아가는 실제 예매 컴포넌트입니다. **다시 재생**으로 다시 볼 수 있고, 선택지도 실제로 눌립니다. 상영 시간 그림에서 **전체 보기**를 눌러 보세요.',
  adaptBullets: [
    '영화, 영화관, 상영 시간 목록에는 네 가지 동작이 모두 적용됩니다. 달력과 좌석표에는 강조만 적용되고, 마지막 확정 단계에는 아무 동작도 적용되지 않습니다.',
    '어떤 동작을 할지는 선호에서 정해집니다. 세 목록에서는 꼭 지켜야 하는 조건(Hard)이면 걸러내고, 시간·거리·평점처럼 순서가 있는 것에 대한 가벼운 선호(Soft)면 정렬하고, 장르나 포맷 같은 범주에 대한 가벼운 선호면 강조합니다. 판단에 필요한 정보가 아직 화면에 없으면 먼저 덧붙입니다. 강조만 할 수 있는 달력과 좌석표에서는 맞는 것이 세 개 이하로 좁혀질 때만 표시하고, 그보다 많으면 무엇이 맞는지 말한 뒤 범위를 좁히는 질문을 합니다.',
    '에이전트는 아무것도 남지 않을 때는 필터를 쓰지 말고 이유를 설명하도록 되어 있습니다. 그래도 필터를 쓰면 화면이 필터를 거부하고, 에이전트가 영어로 “None of the options match that filter. Let me try a different approach.”라고 이어 말합니다.',
    '동작마다 **Agent is updating labels**, **Agent is filtering**, **Agent is sorting**, **Agent is highlighting** 같은 제목이 붙은 새 카드가 생기고(자신이 바꾼 것을 되돌릴 때는 **Agent is clearing modifications**), 에이전트가 그때 한 말이 함께 담깁니다. 말없이 바꾼 경우에는 — 음성 모드에서는 곧바로 다음 동작으로 이어지는 중간 단계에서 일부러 말하지 않습니다 — 대신 에이전트가 내부적으로 적은 판단 근거가 영어로 표시됩니다. 카드 위아래의 화살표로 이전 화면을 넘겨 볼 수 있으며, 이전 화면은 보기만 가능합니다.',
    '에이전트가 작업하는 동안에는 카드 테두리가 금색으로 바뀌고 선택지를 누를 수 없으며, 대화에 **에이전트 작업 중**이 표시됩니다.',
  ],

  memoryTitle: '기억하고, 지울 수도 있습니다',
  memoryLead:
    '말한 내용은 모두 추출기를 거치고, 추출기는 거기서 선호를 뽑아냅니다. 이 선호는 공유됩니다. 에이전트는 이것으로 계획을 세우고, 사용자는 이것을 보고, 말로 바꾸고, 지울 수 있습니다.',
  memoryBullets: [
    '상단의 **기억** 버튼으로 에이전트가 기억하는 내용을 열고 닫습니다. 폭 1024px 이상 화면에서는 예매 화면 옆에 **What the agent remembers** 패널이 처음부터 열려 있고, 그보다 좁은 화면(휴대폰, 세로로 든 태블릿)에서는 **기억**이라는 제목의 전체 화면 시트로 뜹니다. 시트는 보기 전용이며, 지우기와 되돌리기는 옆 패널이나 **폰을 마이크로 사용**으로 연결한 휴대폰에서 할 수 있습니다.',
    '**Preferences** 탭에는 에이전트(또는 프리셋)가 쓴 문장 그대로 선호가 나열되고, **Hard** 또는 **Soft** 표시와 함께 적용되는 단계를 여섯 개의 점(M, T, D, S, St, C)으로 보여 줍니다. 새 선호가 들어오면 금색으로 한 번 반짝입니다.',
    'Hard와 Soft를 가르는 질문은 하나입니다. 남은 선택지 중 이 조건을 만족하는 것이 하나도 없다면, 맞는 게 없다는 말을 듣고 싶은지(Hard), 그래도 선택지를 보고 싶은지(Soft). 마감 시각, 포맷, 좌석 수처럼 구체적인 값을 말하면 어떻게 표현하든 기본적으로 Hard로 봅니다. ‘되도록’, ‘가능하면’ 같은 말은 취향을 말할 때만 Soft로 만들고, 구체적인 값을 Soft로 바꾸지는 않습니다.',
    '**지우기**를 누르면 **정말?**로 바뀌고, 4초 안에 한 번 더 누르면 지워집니다. 그 선호를 근거로 한 필터와 강조는 화면에서 사라지고, 선호는 **Forgotten** 아래에 남아 **되돌리기**를 누를 때까지 기다립니다. 되돌리면 같은 항목이 그대로 돌아옵니다. 그동안 에이전트가 똑같은 문장을 다시 적으면 막히지만, 다시 말했을 때 에이전트가 다른 말로 적으면 새 선호로 다시 들어옵니다. **전체 지우기**도 같은 방식으로, **전체를 정말 지울까요?**로 바뀐 뒤 목록 전체를 비웁니다.',
    '**데모 설정**에서 에이전트가 이미 나를 기억하는 것처럼 시작할 수도 있습니다. **선호 메모리** 아래에서 **Start empty** 또는 여섯 개 프리셋 **Family matinee**, **Date night**, **Big screen**, **Late show**, **Budget**, **Easy trip** 중 하나를 고르세요. **Big screen**은 일부러 만족할 수 없게 만든 프리셋입니다. 15마일 이내의 IMAX를 원하지만, 다섯 곳 중 IMAX 상영관은 20.4마일 떨어진 MJR Troy 한 곳뿐입니다. 처음부터 충돌이 표시되지는 않고, 보통 시간 단계에 이르러서야 드러납니다.',
  ],
  memoryFigureCaption:
    '**Late show** 프리셋(밤 9시 이후, 15마일 이내)으로 시작한 방문자가 금요일 Clayface를 보려고 역사 깊은 Redford를 골랐습니다. Redford는 Clayface를 그날만 상영하고, 마지막 상영은 오후 7:25에 시작합니다.',
  memoryFigureNote:
    '실제 메모리 패널에 예시 데이터를 넣어 띄운 것입니다. **지우기**와 **되돌리기**를 눌러 보고 **Workflow** 탭도 열어 보세요. 다만 뒤에 에이전트가 없어서 다시 계획을 세우지는 않습니다.',

  navTitle: '원하는 것이 없을 때',
  navLead:
    '예매는 영화 → 극장 → 날짜 → 시간 → 좌석 → 확정(화면 위 단계 표시의 이름)의 여섯 단계를 지나는 길이고, 앞에서 한 선택이 뒤의 선택지를 막을 수 있습니다. MAESTRO는 이를 알아차리고, 알려 주고, 어디서 막혔는지 기억합니다.',
  navBullets: [
    '지금 단계의 선택지 중 — 필터로 숨겨진 것까지 포함해 — 어느 것도 Hard 선호를 만족하지 못하면 탭 위에 **Conflict detected**가 뜹니다. 에이전트는 쉬운 말로 이유를 설명하고, 아직 다른 선택지가 남은 가장 가까운 이전 단계로 돌아가자고 제안합니다. 그런 단계가 없으면 무엇이 막고 있는지 말하고 어떤 조건을 바꿀지 묻습니다.',
    '동의하면 되돌아갑니다. 제안한 단계가 두 단계 이상 앞이면 **Backtracking** 표시와 함께 한 단계씩 되돌아갑니다(예: **Going back to the Theater step**). 도중에 말을 하면 되돌아가기가 멈추고, 에이전트는 방금 한 말에 답합니다.',
    '충돌이 남아 있는 동안 되돌아가면 그 충돌은 **Workflow** 탭에 **Dead end**(막다른 길)로 남습니다. 이유와 원인이 적힌 빨간 가지입니다. 그 뒤로 에이전트는 계획할 때마다 이 막다른 길을 전달받고, 그 길은 쓸 수 없는 것으로 취급하라는 지시를 받습니다. 좌석 단계에서 막힌 상영 시간은 따로 지목되어, 고르지도 추천하지도 말라는 지시가 붙습니다. 화면에서 회색으로 막히지는 않고, 되돌아가면 오히려 이전에 고른 것이 테두리로 선택된 채 남습니다. 달라지는 것은 에이전트의 추천뿐입니다.',
    '마지막 확정 단계에서 에이전트는 모든 Hard 선호를 완성된 예매 전체와 한 번 더 대조하고, 어긋나는 것이 있으면 그대로 진행할지 먼저 묻습니다.',
    '선호를 지우면 그 선호 때문에 생긴 막다른 길도 함께 지워집니다.',
  ],
  navFigureCaption:
    '되돌아가기에 동의한 뒤의 모습입니다. Redford의 금요일 시간 단계가 막다른 길로 기록되고, Redford에는 Clayface를 볼 다른 날이 없으므로 에이전트는 날짜 단계를 거쳐 극장 단계로 돌아가는 중입니다.',

  voiceTitle: '말로 하세요',
  voiceLead:
    '이 데모는 말로 조작하도록 만들어졌습니다. 모든 문장은 플래너가 쓰고, 별도의 음성 모델은 듣는 일과, 음성 설정이 통과시킨 문장을 바꾸지 말고 그대로 읽으라는 지시를 따르는 일만 합니다.',
  voiceBullets: [
    '음성은 꺼진 채로 시작합니다. 둥근 마이크 버튼(**음성 모드 켜기**)으로 켜세요. 데모의 입력창은 음성 전용이라, 칸에는 처음에 **마이크를 눌러 말하세요**가, 음성을 켠 뒤에는 **듣는 중...**, **받아쓰는 중...**, **답변을 재생하는 중...** 같은 음성 상태가 표시되고, 보내기 버튼은 없습니다. 에이전트가 작업하는 동안에는 영어로 **Waiting for the next agent message...**가 표시되고, 마지막 단계에서는 음성이 자동으로 꺼집니다. 말하는 대신 카드를 눌러 답할 수도 있습니다. 다만 에이전트가 작업하는 동안과 다음 단계를 불러오는 동안에는 카드가 잠겨 있습니다.',
    '언제든 끼어들어도 됩니다. 말을 시작하면 에이전트의 음성이 문장 중간에서 멈춥니다.',
    '마이크 옆 버튼은 에이전트가 소리 내어 말하는 양을 보여 주고, 누르면 설정이 열립니다. **Everything**, **Balanced**, **Minimal** 중 하나를 고르거나 항목별로 직접 조합할 수 있고, 세 프리셋 어느 것과도 맞지 않는 조합은 **Custom**으로 표시됩니다. **Skip smartly**도 켜고 끌 수 있습니다. 아직 아무것도 고르지 않았다면 음성이 꺼져 있을 때는 **Balanced**이고, 음성을 켜면 저절로 **Custom**(모든 줄이 **Speak**, **Skip smartly** 켜짐)으로 바뀝니다. 음성을 켜면 에이전트가 말할 문장을 스스로 짧게 쓰기 때문입니다. 이 설정 때문에 소리 내지 않은 문장은 대화창에 남고 **not spoken**이나 **shortened**로 표시됩니다. 다만 음성을 켜면 에이전트가 눈앞에서 바뀌는 단계를 설명하지 않으므로, 어떤 프리셋을 골라도 그 문장은 대화창에도 나오지 않습니다.',
    '**설정** → **언어**에서 English와 한국어 중 하나를 고를 수 있습니다. 음성 인식, 에이전트가 하는 말, 예매 화면 버튼 대부분이 바뀌고, 영화 제목·영화관 이름·가격은 원래 표기 그대로 남습니다.',
    '휴대폰을 마이크로 쓸 수도 있습니다. **시작 준비가 되었습니다** 화면의 **폰을 마이크로 사용** 카드에 QR 코드가 있습니다. 스캔한 뒤 큰 화면에서 **예매 시작하기**를 누르고, 휴대폰에서 **Use this phone**을 누르세요. 예매가 시작되기 전에는 휴대폰에 **Waiting for the kiosk to start the booking.**이 표시됩니다. 휴대폰 화면은 키오스크의 언어를 따르지 않고 그 휴대폰 브라우저에 저장된 언어로 나오므로 보통은 영어이지만, 듣고 말하는 언어는 키오스크 설정을 따릅니다. 그 뒤로는 큰 화면이 예매를 계속 보여 주고 휴대폰이 듣고 말하며, 휴대폰에는 에이전트가 기억하는 내용도 표시되어 거기서 선호를 지우거나 되돌릴 수 있습니다. **Back to the headset**을 누르면 음성이 헤드셋으로 돌아갑니다. 휴대폰은 에이전트에게 직접 아무것도 보내지 않습니다. 말한 내용과 휴대폰에서 지우거나 되돌린 선호는 모두 예매 화면을 거쳐 가고, 휴대폰은 예매 화면이 넘겨준 문장만 말합니다. 마이크 소리는 큰 화면과 마찬가지로 OpenAI로 바로 전송됩니다.',
  ],
  voiceFigureCaption:
    '실제 컨트롤입니다. 프리셋을 고르면 버튼에 그 이름이 표시되고, 줄 하나를 바꾸거나 **Skip smartly**를 켜고 끄면 **Custom**으로 바뀝니다.',

  cardsTitle: '부스에서: 카드 한 장, 문장 하나',
  cardsLead:
    '선택 단계(영화·영화관·날짜·상영 시간·좌석)마다 한 장씩, 모두 다섯 장의 카드가 있습니다. QR 코드를 찍으면 앞 단계가 이미 골라진 채로 그 단계가 열리고, 카드 화면 위쪽에서 **한국어**를 고르면 문장과 버튼이 한국어로 바뀝니다. **시작하고 말하기**를 누르고 화면의 문장을 말하세요. 음성은 처음부터 켜져 있고, 카드로 시작한 세션은 연구용으로 기록되지 않습니다.',

  worldTitle: '예매하는 세계',
  worldLead:
    'UIST 데모 리셉션이 열리는 2026년 11월 3일 화요일부터 11월 8일 일요일까지의 디트로이트입니다. 영화, 영화관, 르네상스 센터로부터의 거리, 편의시설은 실제입니다. 러닝타임, 연령 등급, 평점, 좌석 배치, 가격, 상영 시간, 판매된 좌석은 생성된 값이라 모든 상영 시간은 가상입니다.',
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
    t5: '다섯 곳 중 유일한 IMAX · 리클라이너 · 무료 주차',
  },

  privacyTitle: '무엇이 기록되고, 키는 어디로 가나요',
  privacyBlocks: [
    {
      title: '체크하지 않으면 연구용 기록은 남지 않습니다',
      body: '**데모 설정**의 체크 상자 ‘**네, 이 세션을 연구 목적으로 기록해도 좋습니다.**’는 체크되지 않은 채로 시작하며 방문자마다 새로 묻습니다. 체크하지 않으면 연구용 파일은 만들어지지 않습니다. 다만 서버는 평소처럼 운영 기록을 남깁니다. 모든 페이지·API 요청의 시각, 접속 주소, 이전 페이지, 브라우저 정보(그래서 예매 화면이 어떤 영화·영화관·날짜를 불러왔는지 드러납니다), 세션 에이전트 프로세스의 상태 메시지, 그리고 접속 코드를 썼다면 그 코드의 사용 횟수와 마지막 사용 시각입니다. 어디에도 대화 내용은 들어가지 않습니다. 퀵 카드로 시작한 세션은 어떤 경우에도 연구용으로 기록되지 않습니다.',
    },
    {
      title: '체크하면',
      body: '대화, 말한 내용의 텍스트, 화면에서 누른 것과 본 화면, 에이전트의 프롬프트와 판단이 데모 서버에 파일 세 개로 남습니다. 음성, 이름, 계정, IP 주소, 그리고 키는 들어가지 않지만, 말한 내용은 글자 그대로 저장됩니다. 이 파일은 세션이 끝나도 남고, 만든 예매도 그 안에 남습니다. 세션 중에는 상단의 **트레이스** 버튼으로 세 파일 중 하나인 에이전트의 프롬프트와 모델의 응답을 내려받을 수 있습니다. 나머지 두 파일은 내려받을 수 없습니다.',
    },
    {
      title: '음성',
      body: '음성은 데모 서버로 가지 않습니다. 음성 모드에서는 서버가 이 세션용으로 발급한 짧은 수명의 자격 증명으로, 브라우저가 마이크 소리를 OpenAI Realtime API에 직접 보냅니다. 대화로 돌아오는 것은 받아쓴 텍스트뿐입니다.',
    },
    {
      title: '키',
      body: '붙여넣은 OpenAI 키는 탭을 닫을 때까지 이 탭의 세션 저장소에 남습니다. 데모를 마쳐도 지워지지 않고 이 탭에서 시작하는 다음 세션이 그대로 쓰므로, 여럿이 쓰는 화면이라면 탭을 닫으세요. 키는 세션을 시작할 때마다, 그리고 **마이크 점검**에서 **Play Sample**을 누를 때마다 데모 서버로 전송됩니다. 서버는 이 키가 유효한지 OpenAI에 확인하고, 세션 동안 서버 메모리(RAM)에만 보관하며, 에이전트의 OpenAI 호출, 서버의 음성 자격 증명 발급, 그 샘플 재생에 쓰고, 로그에는 절대 기록하지 않습니다. 에이전트는 대화를 보고 계획하므로 이 호출에는 대화 내용이 담깁니다. 접속 코드를 쓰면 발표자의 키가 같은 방식으로 쓰이며, 그 키는 브라우저에 전달되지 않습니다.',
    },
    {
      title: '한도',
      body: '세션은 최대 60분이고, 15분 동안 아무 활동이 없으면 끝나며, 동시에 최대 10개까지 열립니다. **예매 확정**은 이름도 결제도 묻지 않고 실제로 예매하지 않으며, 세션이 끝나면 그 예매도 데모 데이터베이스에서 삭제됩니다.',
    },
  ],

  hoodTitle: '작동 원리',
  hoodBullets: [
    '모델의 역할은 셋입니다. 추출기는 말한 내용에서 선호를 뽑아냅니다. 플래너는 덧붙이기, 걸러내기, 정렬, 강조, 선택, 다음, 뒤로 등의 동작 가운데 이번에 할 하나를 고르고, 들려줄 말이 있을 때 그와 함께 할 말을 씁니다. OpenAI Realtime은 듣고 말하는 일만 하며 스스로 대답하지 않습니다.',
    'GUI는 브라우저가 그립니다. 동작은 화면을 선언적으로 기술한 스펙에 적용되며, 그 스펙으로 예매 화면을 그리는 렌더러가 이 페이지 그림 속의 예매 화면도 미리 짠 스펙으로 그립니다. 메모리·워크플로·음성 그림은 앱의 메모리 패널, 워크플로 그래프, 음성 컨트롤에 예시 데이터를 넣어 띄운 것입니다. 카드와 창 테두리, 대화 구분선, Backtracking 배너는 앱의 것을 본떠 이 페이지에서 따로 그렸습니다.',
    '메모리를 보여 주는 패널은 데모를 위해 새로 만든 것입니다. 논문의 사용자 연구에서는 메모리가 보이지 않는 곳에서 작동했고, 그것도 MAESTRO의 전체 인터페이스를 쓴 참가자에게만 있었습니다. 그 뒤로 메모리도 달라졌습니다. Hard와 Soft를 가르는 기준이 바뀌었고, 연구 당시 빌드가 놓치던 막다른 길을 이제 기록해 적용하며, 지우기·되돌리기와 프리셋 메모리는 새로 생긴 기능입니다.',
  ],
  paperLabel: '논문',

  glossaryTitle: '앱에서 쓰는 말',
  glossary: [
    { term: '접속 코드', definition: '발표자에게 받는 여섯 글자로, **코드** 칸에 입력합니다. 키를 보여 주지 않은 채 발표자의 OpenAI 키를 내 세션에 빌려줍니다.' },
    { term: '선호', definition: '말한 내용이나 프리셋에서 가져온 조건 하나로, 읽을 수 있는 문장으로 적힙니다. **Hard**는 맞는 선택지만 된다는 뜻이고, **Soft**는 되도록 그랬으면 하는 정도입니다.' },
    { term: '덧붙이기 · 걸러내기 · 정렬 · 강조', definition: '에이전트가 화면의 선택지를 바꾸는 네 가지 방법: 라벨 고쳐 쓰기, 숨기기, 순서 바꾸기, 표시하기.' },
    { term: '전체 보기', definition: '걸러진 선택지를 흐리게 다시 보여 주는 버튼.' },
    { term: '카드', definition: '예매 화면의 한 상태. 에이전트의 동작이나 내가 누른 것마다 무슨 일이 있었는지를 제목으로 단 새 카드가 생기고, 화살표로 앞뒤 카드를 넘겨 봅니다.' },
    { term: 'Conflict detected', definition: '지금 단계의 어떤 선택지도 Hard 선호를 만족하지 못하는 상태. 에이전트가 이유를 말하고 돌아갈 곳을 제안하거나, 어떤 조건을 바꿀지 묻습니다.' },
    { term: 'Dead end', definition: '되돌아 나온 충돌을 이유와 함께 기억해 둔 것. 원인이 된 선호가 남아 있는 동안 에이전트는 그 길을 쓸 수 없는 것으로 취급하라는 지시를 받습니다.' },
    { term: 'Backtracking', definition: '동의한 이전 단계로 에이전트가 한 단계씩 되돌아가는 중인 상태.' },
    { term: '지우기 · 되돌리기', definition: '에이전트의 메모리에서 선호를 빼거나 다시 넣는 것.' },
    { term: '음성 상세도', definition: '에이전트가 소리 내어 말하는 양: **Everything**, **Balanced**, **Minimal**, **Custom**.' },
    { term: '폰 음성', definition: '**시작 준비가 되었습니다** 화면이나 메모리 패널 아래의 QR 코드로 연결해, 휴대폰을 세션의 마이크와 스피커로 쓰는 것.' },
    { term: '연구 기록 동의', definition: '**데모 설정**에 있는, 원할 때만 체크하는 동의 상자. 체크하지 않으면 연구용 파일은 만들어지지 않고, 서버에는 대화 내용이 없는 일상적인 요청 기록만 남습니다.' },
  ],

  footerLine: 'MAESTRO · UIST 2026 · 디트로이트',
};

export const ABOUT_COPY: Record<Language, AboutCopy> = { en, ko };
