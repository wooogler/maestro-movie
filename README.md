# 🎬 MAESTRO (Movie)

**MAESTRO: Adapting GUIs and Guiding Navigation with User Preferences in Conversational Agents with GUIs** — the research system from the UIST 2026 paper, instantiated here as a movie-ticketing Conversational Agent with GUI (CAG). (`maestro-movie` is the movie-booking instantiation of MAESTRO.)

## 📋 Overview

MAESTRO extends a GUI-based conversational agent from execution to decision support. It maintains a shared **preference memory** and adds two mechanisms grounded in it: **Preference-Grounded GUI Adaptation** (augment, sort, filter, highlight applied in place) and **Preference-Guided Workflow Navigation** (conflict detection, backtracking suggestions, and dead-end tracking). This repository is the full-stack movie-ticketing system used in the user study.

### Key Features

- Browse movie listings
- Select theaters
- Choose showtimes
- Pick seats
- Select ticket types (Adult, Youth, Senior)
- Manage and confirm bookings

### Tech Stack

**Frontend**
- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- Zustand (state management)
- React Router DOM

**Backend**
- Fastify
- TypeScript
- Drizzle ORM
- SQLite

## 🚀 Quick Start

### Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/) 18 or higher
- npm (comes with Node.js)

### Installation and Setup

#### 1. Clone the Repository

```bash
git clone <repository-url>
cd tuning-movie
```

#### 2. Install Dependencies

```bash
npm install
```

This command will automatically install all dependencies for the root and app workspaces (frontend, backend, tuning-agent, agent-monitor).

#### 3. Initialize the Database

Initialize the backend database and create sample data:

```bash
npm run dev:backend
```

The database will be created automatically on first run.
Once the server starts successfully, press `Ctrl+C` to stop it and proceed to the next step.

To add sample data:

```bash
cd apps/backend
npm run db:seed
cd ../..
```

#### 4. Configure LLM

Copy and edit the root `.env` file. Set your OpenAI API key:

```bash
# OpenAI
OPENAI_API_KEY=sk-...
AGENT_OPENAI_MODEL=gpt-5.6-terra
AGENT_OPENAI_API_MODE=responses
AGENT_ENABLE_OPENAI=true
```

> **Note:** The user study reported in the paper was run with `gpt-5.4`, which is no longer the default — set `AGENT_OPENAI_MODEL=gpt-5.4` to reproduce the paper's setup. The default is now `gpt-5.6-terra` at `reasoning.effort: none`, the effort gpt-5.4 used when the field was omitted; replayed against the study's own planner traces it matched gpt-5.4's tool choice 42/46, within gpt-5.4's own 43–44/46 run-to-run spread.

#### 5. Start Development Servers

The project uses an orchestrator that starts services in the right order (backend first, then the rest after health check passes). Logs are prefixed with service labels (`[backend]`, `[frontend]`, etc.).

| Command | Services | Use case |
|---------|----------|----------|
| `npm run dev` | backend + frontend | **Default** &mdash; host UI/API development |
| `npm run dev:stack:agent` | backend + frontend + agent | Standalone agent runtime (no monitor) |
| `npm run dev:stack:agent-monitor` | backend + frontend + monitor | Host sessions + monitor dashboard |
| `npm run dev:stack:system` | backend + frontend | Alias of default host UI/API mode |
| `npm run dev:stack:all` | backend + frontend + agent + monitor | Everything at once |

You can also run any service individually:

```bash
npm run dev:backend      # Backend only
npm run dev:frontend     # Frontend only
npm run dev:agent        # Agent only
npm run dev:monitor      # Monitor dashboard only
```

#### 6. Open in Browser

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- Agent Monitor: http://localhost:3501 (when running with monitor)

## 📁 Project Structure

```
tuning-movie/
├── apps/
│   ├── frontend/                  # React chat-style booking UI
│   ├── backend/                   # Fastify REST API + SQLite + WebSocket relay
│   ├── tuning-agent/              # AI agent runtime (LLM planner + prompts)
│   └── agent-monitor/             # Real-time agent monitoring dashboard
├── scripts/
│   ├── dev-orchestrator.mjs       # Multi-service dev runner
│   └── run-tuning-agent.sh
├── docs/                          # Project documentation
├── .env                           # Shared environment config
├── package.json                   # Monorepo root
└── README.md
```

## 🛠️ Development

### Available Scripts

**Root Level**
```bash
# Dev stacks (orchestrated)
npm run dev                      # Default: backend + frontend
npm run dev:stack:system         # backend + frontend only (same as `dev`)
npm run dev:stack:agent          # backend + frontend + standalone agent
npm run dev:stack:agent-monitor  # backend + frontend + monitor
npm run dev:stack:all            # backend + frontend + agent + monitor

# Individual services
npm run dev:backend              # Backend only
npm run dev:frontend             # Frontend only
npm run dev:agent                # Agent only
npm run dev:monitor              # Monitor dashboard only

# Build
npm run build                    # Build all workspaces
npm run build:backend
npm run build:frontend
npm run build:agent              # Build agent
npm run build:monitor

# Checks (no test runner — each of these is a plain executable spec)
npm run typecheck                # All four tsconfigs
npm run check                    # Everything below, in one go
npm run check:barrier            # Agent speech barrier
npm run check:voice              # Voice verbosity gate
npm run check:language           # Language option — asserts English is unchanged
npm run check:planner-language   # The planner's language directive
npm run check:logpaths           # Trace path agreement, and demo/study separation
npm run check:layout             # Full-tuning split: phone overlay vs desktop columns
npm run voice:validate           # Replay the study corpus through the classifier
                                 # (needs logs/trace, which is gitignored)
```

**Backend (apps/backend)**
```bash
npm run dev              # Start dev server (hot reload)
npm run build            # Compile TypeScript
npm run start            # Start production server
npm run db:generate      # Generate Drizzle migrations
npm run db:push          # Push database schema
npm run db:seed          # Seed sample data
npm run db:studio        # Run Drizzle Studio
```

**Frontend (apps/frontend)**
```bash
npm run dev              # Start dev server
npm run build            # Production build
npm run preview          # Preview production build
npm run lint             # Run ESLint
```

### Database Management

To visually manage and inspect the database schema:

```bash
cd apps/backend
npm run db:studio
```

Drizzle Studio will automatically open in your browser.

## 🌐 API Endpoints

### Movies
- `GET /movies` - Get all movies
- `GET /movies/:id` - Get a specific movie

### Theaters
- `GET /theaters` - Get all theaters
- `GET /theaters/movie/:movieId` - Get theaters showing a specific movie
- `GET /theaters/:id` - Get a specific theater

### Showings
- `GET /showings?movieId=&theaterId=&date=` - Get showings
- `GET /showings/dates?movieId=&theaterId=` - Get available dates for showings
- `GET /showings/times?movieId=&theaterId=&date=` - Get showings for a specific movie, theater, and date
- `GET /showings/:id` - Get a specific showing

### Seats
- `GET /seats/:showingId` - Get seats for a specific showing

### Ticket Types
- `GET /ticket-types` - Get available ticket types

### Bookings
- `POST /bookings` - Create a booking
- `GET /bookings/:id` - Get a booking
- `DELETE /bookings/:id` - Cancel a booking

## 🔧 Environment Variables

### Frontend

To change the API URL for the frontend, create a `.env` file:

```bash
# .env at the repo root — apps/frontend/vite.config.ts sets envDir: '../..',
# so a per-app apps/frontend/.env is never read. (Same for apps/agent-monitor.)
# None of these reach a container build either; see DEPLOYMENT.md "Known caveats".
VITE_API_URL=http://localhost:3000
VITE_AGENT_WS_URL=ws://localhost:3000/agent/ws
VITE_AGENT_SESSION_ID=default
```

Use the same session id as the agent runtime (`AGENT_SESSION_ID` in the root `.env`).
For isolated runs, use a unique value (example: `sync-dev-1`) instead of `default`.

### Backend

To configure backend runtime settings:

```bash
# apps/backend/.env
PORT=3000
DATABASE_URL=tuning-movie.db
AGENT_RELAY_LOG_ENABLED=false
```

The backend loads `apps/backend/.env` automatically at startup and maps keys into `process.env`.

```bash
PORT=3000 DATABASE_URL=tuning-movie.db npm run dev:backend
```

### Agent Runtime

The agent runtime reads its settings from the root `.env`:

```bash
# .env (repo root)
AGENT_RELAY_URL=ws://localhost:3000/agent/ws
AGENT_SESSION_ID=default
AGENT_OPENAI_MODEL=gpt-5.6-terra
```

See [`.env.example`](./.env.example) for the full list.

## 🌍 Public Demo Mode

Demo mode runs the full TUNING experience as an open, anonymous demo — the same
agent, GUI adaptation, and voice features as the study conditions, without any
study bookkeeping.

- **No participant ID.** Visitors are not assigned or asked for one.
- **Nothing is recorded unless the visitor says yes.** The setup screen carries
  one unticked checkbox: *record this session for research*. Leave it alone and
  the session writes no interaction log, no LLM trace, no survey file and no
  relay session log — exactly as the demo behaved before consent existed.

  Tick it and the session keeps the pair a study session keeps: an interaction
  log (which also switches on the frontend event logger and the agent runtime
  log) and the planner trace, pulled from the header's **Download Trace**
  button. Both go under `logs/demo/`, never `logs/interaction/` or
  `logs/trace/`, which is what the study corpus tools glob — so a booth visitor
  can never end up in a participant dataset. Both file names carry the session
  id, because demo visitors run concurrently and a timestamp alone would have
  two of them appending to one file. Neither carries a participant id, because
  the demo never asks for one. `npm run check:logpaths` asserts all of that.

  There is no environment variable that turns demo recording on or off. There
  used to be one (`DEMO_TRACE_ENABLED`); a switch that could record someone who
  had just been asked and answered no would make the question a lie, so consent
  is now the only thing that decides.

  Demo logs are **not** swept when the session ends; collecting them is the
  point. They are yours to delete. `logs/demo/` and `logs/agent-runtime/` are
  bind-mounted in `docker-compose.yml` so they live on the host — without those
  mounts a redeploy would destroy them, which is what used to happen.
- **A single-use access code, or your own OpenAI key.** When
  `DEMO_ACCESS_CODES_ENABLED=true` (what the booth runs) the setup screen offers
  a six-character code printed on a card: redeeming it attaches the *operator's*
  key to that one session, server-side, and the visitor never sees it. The
  key field is the alternative, and the only option when codes are off.
  Each visitor who brings a key pastes it in the
  browser. It is kept in `sessionStorage` for that browser session only (so it
  is not re-entered on every page), sent to the backend when the session is
  created, and held **in server memory only** for the lifetime of that session —
  it backs the voice session (the backend mints short-lived OpenAI Realtime
  client secrets from it) and is passed to that session's agent process.
  It is never written to disk, never logged, never returned in an API response,
  and never sent over the relay. It is dropped when the session ends.

### Running it

Locally, start the usual dev stack:

```bash
npm run dev
```

Then enter demo mode either by visiting the `/demo` route (which turns demo mode
on and redirects to the start screen) or by using the **Demo Mode** toggle on the
start screen. In demo mode the participant-ID field is replaced by an OpenAI API
key field, and the condition picker and survey steps are hidden.

For a deployment, build and run the compose stack as usual (see
`DEPLOYMENT.md`); the production image now ships the compiled tuning-agent, so
the backend can spawn a per-session agent process for each visitor.

### Quick cards: one stage, one sentence

The full demo above is a whole booking — five stages, several turns, a couple of
minutes. Plenty of people at a reception do not have that, and the part they came
to see is small and specific: they say something, and the GUI in front of them
rearranges itself to match.

The quick cards are that part on its own. There are five, one per selection
stage, and each is a printed card carrying a QR and one line to say. Scanning it
opens `/demo/card`, which starts a demo session and drops the visitor's own phone
**directly onto that stage** with everything before it already chosen, voice
already on. They say the line, the screen adapts, and they can keep going into
the full booking or hand the phone back.

| Card | Lands on | The line | What adapts |
|---|---|---|---|
| 1 | Movies | "I've got my eight-year-old niece with me, so nothing scary." | filter + augment: 5 films → 2, age ratings appear |
| 2 | Cinemas | "I'm not driving more than 15 miles, and I don't want to pay for parking." | filter + sort: 5 cinemas → 3, reordered by distance |
| 3 | Dates | "It has to be the weekend." | filter: 6 days → 2 |
| 4 | Showtimes | "Nothing before 8, and I need to be out by 11." | filter + augment: 16 showtimes → 3, end times appear |
| 5 | Seats | "Two seats together, toward the back — not the front rows." | highlight: the pairs that fit, in place on the map |

Between them the five cover all four adaptation operations, which is the point of
having five rather than one: the adaptation is a property of the whole workflow,
not a trick that works on one screen.

Print a sheet for an event — the QR embeds that event's access code, so `--code`
is required and a sheet is good for one code:

```bash
python3 scripts/build-demo-cards.py --set quick --code AB12CD --base-url https://maestro.cs.vt.edu
```

`/demo/cards` shows the same five as QR codes on screen, for the presenter's own
tablet or a booth that has run out of paper; the code is typed there rather than
baked in.

#### It talks, because otherwise nothing seems to happen

A quick card runs louder than the rest of the demo, on both sides of the spoken
channel, and it has to be both or it is neither.

The **frontend gate** (`QUICK_CARD_VOICE_VERBOSITY`) starts a card with every
category spoken and the smart rules off, where the full demo starts at
`balanced`. Replaying the 8,355 recorded study utterances through that gate says
why: `balanced` never speaks `nav` or `select` at all (23.7% of everything the
agent says), trims `view` — filter, sort, highlight, augment, the mechanism the
card exists to show — to a brief, and then its monologue cap silences 96.1% of
adaptation narration from the third utterance of a turn onward. A quick card's
one exchange is usually three or four utterances long, so the visitor hears the
setup and not the payoff. Those three rules exist to spare someone ten minutes
into a booking; nobody on a quick card is, and the failure mode here is not
fatigue but walking away unsure anything happened. It is still only a default —
Settings turns it down, and a value the visitor stored wins.

The **planner** gets a `narrateAdaptations` flag on the snapshot, which appends
one section to its system prompt. Without it, unmuting achieves less than it
looks: the GUI adaptation rules tell the planner to write a brief cue and *not
restate what is already on screen*, so the gate would only say a deliberately
stripped sentence louder. Replaying real study turns through the planner with
and without the flag (`adaptationNarration.regress.ts`, real API calls):

| | today | with the flag |
|---|---|---|
| sort | "Putting the closer theater first while keeping both options available." | "I sorted **both theaters** by distance **because you prefer a closer option** while keeping comfort in play." |
| highlight | "The PG kid-friendly movies are highlighted." | "I highlighted **two of the four** movies **because they match your PG-or-G kid-friendly preference**." |
| augment | "I've added distance and parking information so both preferences are visible." | "I added distance and parking details to **all three theaters** **because you want one that is both close and has free parking**." |

Four of four name the change and quote its scale; none of them chose a different
tool, which is the control — this touches the spoken channel and nothing else.

The study prompt is **byte-identical** with the flag off, and
`npm run check:planner-prompt` asserts exactly that, along with the cache key
that keeps one session's prompt out of the next.

#### And the screen waits for it

Making the agent talk exposed a second problem underneath: the GUI changed
before the sentence describing it was audible.

The wire order was never wrong — the agent sends its narration *before* the tool
call. The latency either side of it is: applying a tool takes a millisecond,
starting speech takes a realtime round trip plus audio buffering. On the kiosk
that is invisible, because the transcript prints the sentence the instant it
arrives. On a phone with the conversation collapsed — every quick card — audio
is the only channel, so the visitor watches the list rearrange itself in silence
and hears why afterwards.

So on a quick card the host holds the tool call until audio for that sentence
actually starts (`speechGuiSync`, released on `output_audio_buffer.started`).
Measured on a real session, driving the fake microphone with a spoken WAV and
reading the agent's own output stream through a Web Audio analyser, so the
timestamps are when sound was genuinely audible rather than when a flag flipped:

| first adaptation of a turn | GUI vs audio |
|---|---|
| gate off | **642 ms before** any sound |
| gate on | 41 ms / 44 ms (two runs) — within the probe's own 50 ms sampling lag |

Later adaptations in the same turn already followed audio, because they pipeline
behind speech that is still playing; it is the first one that ran ahead, which is
the one a ninety-second visitor sees.

This costs a turn nothing. The agent waits for playback to *complete* before it
plans again, so the hold comes out of time it was going to spend waiting anyway.
A hold always ends: audio starting, the utterance finishing without ever
starting (a barge-in), a newer sentence superseding it, or a 2.5 s timeout well
under the agent's 12 s request timeout. Those paths are where a visitor ends up
staring at a frozen screen, so they are checked rather than eyeballed —
`npm run check:speech-sync`, with time injected.

Two things a quick card deliberately does **not** do. It never asks for research
consent and never records anything — the visitor has ninety seconds, and a
consent question someone skims is worse than no recording at all, so anyone who
wants to contribute data goes through `/demo` instead. And the card it was opened
by is not persisted, so reloading `/booking` drops back to the movie list rather
than landing the next stranger mid-workflow in a scene they never chose.

The numbers in the table above are properties of a *generated* world. Reseeding
the Detroit dataset renumbers every showing and reshuffles every seat, so
`npm run check:cards` replays each card's sentence against the dataset and
asserts both that the prefill still resolves and that the change the card
promises is real and partial — a card that empties the screen or changes nothing
fails the build. The print script cross-checks the copy on paper against the copy
in the app for the same reason: a card is printed once and handed to strangers
for two days.

### Required environment for a public deployment

There are two credentialing modes, and they want opposite settings for
`OPENAI_API_KEY`. Pick one deliberately.

| Variable | Bring-your-own-key | Access codes (what the booth runs) |
|---|---|---|
| `OPENAI_API_KEY` | **unset / empty** — every visitor pastes their own key | **set** — a key minted for the demo alone, in its own OpenAI project with a hard budget limit in the dashboard. That project cap is the only ceiling that survives a bug in this application. |
| `DEMO_ACCESS_CODES_ENABLED` | `false` | `true` |

⚠️ Clearing `OPENAI_API_KEY` while codes are in circulation takes the booth's
front door down: redeeming a code then returns `503 OPERATOR_KEY_UNAVAILABLE`.

Either mode:

| Variable | Value | Why |
|----------|-------|-----|
| `SPEECH_PREVIEW_ALLOW_ENV_KEY` | unset or `false` | It would let the unauthenticated `/speech/synthesize-preview` route spend the operator key. |
| `ALLOW_OPERATOR_KEY_FALLBACK` | unset or `false` | `POST /study/sessions` is unauthenticated and only *demo* sessions require a key, so with the fallback on anyone could create a non-demo session and spend the operator key. |
| `AGENT_RELAY_LOG_ENABLED` | unset or `false` | Keeps relay session logs off. |
| `DEMO_MAX_CONCURRENT_SESSIONS` | `10` (default, overridable) | Caps simultaneous demo sessions. Demo sessions never evict each other; creation beyond the cap is rejected with a clear error. |

`docker-compose.yml` pins the two guard rails to `false` for the container, so a
`.env` that says otherwise (a local lab setting, say) cannot leak into a
deployment.

> **Note:** Real study and demo sessions are served by per-session agent
> processes that the backend spawns itself. The standalone `agent` service in
> `docker-compose.yml` is pinned to `AGENT_SESSION_ID=default` and does not
> serve them.

## 🔊 Voice Verbosity

Study participants reported the agent talked too much in voice mode — not
because of how it phrased things, but because they had to wait through it:

> *"the narrator has to read the script which I do not need"* — P04
> *"hearing the AI keep talking back to me when not needed is disturbing"* — P21
> *"I often had to wait for the chatbot to finish speaking before performing
> actions like moving back to change a selection"* — P51

Across the 132 voice-on sessions, **2,255 of 4,749 agent utterances describe a
GUI action the participant can already see** — 38.5% of all spoken words, about
66 seconds per session. Full analysis in
[`.notes/voice-verbosity-analysis.md`](./.notes/voice-verbosity-analysis.md).

The composer has a **verbosity pill** next to the mic. It opens a panel with a
three-way setting (Speak / Brief / Silent) for each kind of utterance:

| | Everything | **Balanced** (default) | Minimal |
|---|---|---|---|
| Questions and answers | speak | speak | brief |
| Moving between steps | speak | silent | silent |
| Picking an option | speak | silent | silent |
| Changing what is on screen | speak | brief | silent |
| Errors | speak | speak | speak |
| Smart skip | off | on | on |

**Smart skip** adds rules on top: drop a sentence that repeats one just spoken,
drop narration whose every word is already on screen, shorten a read-back of
options the participant is looking at, and cap a monologue at two utterances
without a participant turn.

Three things hold however it is configured: **nothing is lost** — unspoken text
still appears in the chat, marked `not spoken`; **a question is never silenced**,
whatever rule fires; and **the smart rules never silence conversation**, only
shorten it — which matters because the agent's failure notices repeat verbatim
precisely when something has gone wrong, and carry no question to fall back on.
Only an explicit `Silent` on *Questions and answers* quietens conversation, and
errors are spoken even then.

`Everything` reproduces the study build exactly, so it remains a clean control
condition. Replayed over the recorded corpus, `Balanced` removes 25% of spoken
words and 28% of the waits; `Minimal` removes 67% and 46%.

The gate is host-side and the agent's planning cannot see or be affected by it.
The host classifies an utterance from its text at 97.1% accuracy
(`npm run voice:validate`); the bundled agent additionally tags each
`agent.message` with `payload.category`, which the host prefers when present.
The tag is what makes the feature work outside English — see
[Language](#-language) below and
[`docs/external-agent-protocol.md`](./docs/external-agent-protocol.md#voice-verbosity).

## 🌍 Language

The composer carries an **English / 한국어** switch next to the verbosity pill.
It is a booth option, not a study condition: English is the default and every
language-dependent path is written so that `en` produces exactly what it
produced before the switch existed — same transcription prompt, same planner
prompt, same strings. `npm run check:language` and
`npm run check:planner-language` assert that against the original literals.

Choosing 한국어 changes four things at once:

| | English | 한국어 |
|---|---|---|
| Speech recognition | `language: en` | `language: ko`, with a Korean prompt |
| The agent's replies | its own wording | Korean (해요체), via a prompt section added only for `ko` |
| Spoken output | read verbatim | read verbatim, Korean as Korean and Latin labels as written |
| Screen chrome | English | Korean |

**The catalogue itself stays as it is.** Film titles, cinema names, formats,
seat ids and prices are the Detroit world's data and the vocabulary the planner
names in tool calls — an agent that translated them would select nothing. So the
agent says "Street Fighter를 IMAX로 예매할게요", and the button still reads
*Street Fighter*.

Two things worth knowing before relying on it:

- **The Korean classifier is unmeasured.** The 97.1% above comes from replaying
  4,749 recorded English utterances; there is no Korean corpus. The Korean rules
  are deliberately narrow and anything they miss is treated as conversation and
  spoken in full — so the failure mode is a chattier agent, never a silent one.
  This matters much less than it sounds, because the bundled agent tags its
  messages and the tag wins.
- **Switching mid-session restarts the voice session.** The transcription
  language is fixed when the Realtime session is minted, so the switch tears it
  down and opens a new one. Text mode changes immediately.

Study operator surfaces — session setup, the dev console, the per-trial and
post-study surveys — stay English. The surveys are a measurement instrument and
translating them would make their responses incomparable to the recorded ones.

## 📱 On a Phone

The booth is usable from a phone, which took three fixes worth knowing about.

**The booking UI gets the whole screen.** Below the `lg` breakpoint the
conversation is not laid out at all — it is a floating cluster over the
bottom-right of the stage, and its transcript opens as a sheet *over* the
booking UI rather than beside it. It starts closed on a phone and open on a
desktop. This matters because `guiScale` fits a stage into whatever height it is
handed: a booking UI squeezed into half a 430×932 screen was being scaled to
roughly half size, which is what made it unreadable. The desktop two-column
split is untouched; `npm run check:layout` asserts both arrangements.

**The mic rides on the floating cluster.** Folding the whole conversation behind
one button would otherwise put voice — the thing the demo is about — behind a
tap and a scroll, because the composer that holds the mic lives inside the
sheet.

**The toolbar collapses to a chevron**, and everything occasional moved off it:
language and voice verbosity are behind a single **Settings** button, "what the
agent remembers" is a toggle that opens the desktop side panel or a phone sheet,
"Finish Task" is now "Finish", and the two downloads became one. The interaction
log overlapped the trace enough that two buttons in a strip this narrow was
noise; the trace is what tuning actually uses, and the interaction log is still
on the end page.

**Two things used to make the UI stop responding.** The composer was only
rendered while the conversation was open, so collapsing it — the one thing a
phone visitor has to do to see the booking UI — removed the only way to talk to
the agent. And the effect that advances the GUI to the newest snapshot began
`if (conversationCollapsed) return`, so with the conversation closed the GUI kept
rendering the *previous* stage; `activeSnapshot.isLatest` went false and the card
was therefore `pointer-events-none`, swallowing every tap on Continue. The UI
looked completely normal and simply did nothing.

**`100vh` is not the visible height on iOS Safari** — it is the height the page
would have with the toolbars hidden, so the bottom ~130px of the shell sat under
them. Every ancestor here is `overflow-hidden` with `min-h-0` so the panes scroll
internally, which means there was no page scroll to recover it. The shell now
uses `.app-viewport` (`100dvh`, falling back to `100vh`).

Two things that are *not* fixed in code:

- **Voice needs a secure origin.** `navigator.mediaDevices` is undefined over
  plain http, so voice reports itself unsupported. The production nginx stack
  serves HTTPS and is fine; a phone pointed at a bare `vite dev` over the LAN is
  not.
- **The header's drag-to-resize handle is gone**, replaced by the collapse
  button. It was a full-width band under the thumb with a minimum height of zero
  and a value persisted per device — one accidental swipe hid Reset and Finish
  with no way back.

## 🪞 Second Screen, and Installing on a Tablet

**Watching the agent's memory on another device.** The booking window renders a
QR beside the memory panel; scanning it opens `/demo/memory#<viewToken>` on a
phone, which joins the relay as a read-only `viewer` and follows along.

The token in that URL is **not** the study token. That one authorises the host
role, the trace download and finishing the session, so a second device gets a
separate token scoped `view` — signed with the same secret but rejected anywhere
a study token is required. It rides in the URL fragment, which is never sent to
the server.

One session, one host, many viewers — *not* a session per device. Each session
spawns its own agent process and its own database copy, so a phone that started
its own session would be watching a different agent remember a different
booking. See [Viewer connections](./docs/external-agent-protocol.md).

The older same-machine path is still there and still the more robust one for the
booth's laptop-plus-HDMI setup: open `/demo/memory` with no token and it mirrors
over `BroadcastChannel`, needing no backend, no token and no network.

**Installing it.** The app ships a web manifest and is installable: on an iPad,
Share → Add to Home Screen launches it without browser chrome. The service worker
(`public/sw.js`) deliberately **caches nothing** — it exists only to satisfy the
installability criteria. A caching worker would be actively harmful here, since
the booth is redeployed between sessions and a tablet holding a stale bundle
would keep running the previous build with no visible symptom.

## 🚢 Server Deployment (Podman)

This repository now includes production deployment files matching your existing server pattern (`npm run dev` equivalent runtime):

- `docker-compose.yml`
- `deploy/nginx/*`
- `deploy/scripts/setup-podman.sh`
- `deploy/scripts/deploy-podman.sh`
- `DEPLOYMENT.md`

Deployed services:
- `backend` (Fastify + SQLite + main frontend)
- `agent` (`apps/tuning-agent`)
- `nginx` (public routing + `/agent-monitor/` + `/monitor-api/*`)

Note: monitor routes carry an nginx `allow 127.0.0.1; deny all` guard which,
under rootless podman, matches nothing — not even the host's own loopback, since
the published-port forwarder rewrites the source address. It fails closed; reach
the monitor with `podman exec` instead. See `DEPLOYMENT.md` -> Known caveats.

For full instructions, see `DEPLOYMENT.md`.

`AGENT_SESSION_ID`/`VITE_AGENT_SESSION_ID` matter only to the legacy
single-session flow (`npm run dev:agent`). Study and demo sessions get their
session id from the backend, and no `VITE_*` value reaches a container build at
all.

## 🤖 External Agent (Study MVP)

The prototype supports an external agent server through a WebSocket protocol.

- Transport: single WebSocket endpoint (`/agent/ws`)
- Read scope: `uiSpec`, `messageHistory`, `toolSchema`
- Write scope: `tool.call`, `agent.message`
- `toolSchema` is filtered by current stage/state (e.g. no `prev` at first stage)
- User chat input is forwarded to the agent via `user.message`
- Excluded from external snapshots: `backendData`
- Session end behavior: reset state (study logs are optional and off by default)

See the canonical spec: [`docs/external-agent-protocol.md`](./docs/external-agent-protocol.md)

### Running the Agent (Recommended Flow)

1. Start backend, frontend, agent, and monitor:
```bash
npm run dev:stack:all
```
(`dev:stack:agent-monitor` starts backend + frontend + monitor and **no agent**.)
2. Open the frontend (`http://localhost:5173`) and the monitor (`http://localhost:3501`).
3. In the frontend, wait until a stage UI is visible (movie list).
4. In the monitor, verify the session is connected and a `uiSpec` snapshot has arrived.
5. Send a chat message; the agent plans and issues `tool.call` against the current stage.

Sync behavior:
- `state.updated` is the authoritative push update for external sync.
- `tool.result` may include an immediate `uiSpec` for state-changing tools.
- For tools that do not immediately return a spec (for example `next`, `prev`, `postMessage`), rely on the next `state.updated`.

## 📚 Additional Documentation

For detailed implementation information, see the [docs](./docs/) directory:

- [Implementation Summary](./docs/implementation-summary.md)
- [Rendering Engine Design](./docs/rendering-engine-design.md)
- [External Agent Protocol (MVP)](./docs/external-agent-protocol.md)
- [Voice verbosity: what the study logs showed](./.notes/voice-verbosity-analysis.md)

## 🐛 Troubleshooting

### Port Already in Use

**Backend (Port 3000)**
```bash
# macOS/Linux
lsof -ti:3000 | xargs kill -9

# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

**Frontend (Port 5173)**
```bash
# macOS/Linux
lsof -ti:5173 | xargs kill -9

# Windows
netstat -ano | findstr :5173
taskkill /PID <PID> /F
```

### External Agent Timeout / Desync

If the agent reports `Request timeout (tool.call, id=...)`:

1. Ensure only one backend/frontend/agent set is running.
2. Ensure only one active frontend tab is connected to `/agent/ws`.
3. Session ids: per-session agents get theirs from the backend, so there is
   nothing to match in a deployment. `VITE_AGENT_SESSION_ID` (root `.env`, not
   `apps/frontend/.env`) is only a last-resort fallback for the legacy
   single-session `npm run dev:agent` flow.
4. Check relay status in the agent monitor (`connected`, `joined`, `hasSnapshot`).
5. Enable relay logs for diagnosis:
```bash
# apps/backend/.env
AGENT_RELAY_LOG_ENABLED=true
```
Then inspect:
```bash
tail -n 120 logs/study/<sessionId>.jsonl
```

### Reset Database

To completely reset the database:

```bash
cd apps/backend
rm -rf drizzle
rm tuning-movie.db
npm run db:push
npm run db:seed
```

## 📖 Citation

If you use this system in your research, please cite our UIST paper:

```bibtex
% TODO: replace with the final UIST '26 BibTeX entry
@inproceedings{tuning-movie-uist26,
  title     = {TODO: paper title},
  author    = {Lee, Sangwook and others},
  booktitle = {Proceedings of the ACM Symposium on User Interface Software and Technology (UIST)},
  year      = {2026}
}
```

## 📄 License

MIT — see [LICENSE](./LICENSE).

## 🤝 Contributing

Contributions are always welcome! Please feel free to submit issues or pull requests.
