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
AGENT_OPENAI_MODEL=gpt-5.4
AGENT_OPENAI_API_MODE=responses
AGENT_ENABLE_OPENAI=true
```

> **Note:** The user study reported in the paper was run with `gpt-5.4` (the default when `AGENT_OPENAI_MODEL` is unset). Use the same model to reproduce the paper's setup.

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
- Agent Monitor: http://localhost:5174 (when running with monitor)

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
# apps/frontend/.env
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
AGENT_OPENAI_MODEL=gpt-5.4
```

See [`.env.example`](./.env.example) for the full list.

## 🌍 Public Demo Mode

Demo mode runs the full TUNING experience as an open, anonymous demo — the same
agent, GUI adaptation, and voice features as the study conditions, without any
study bookkeeping.

- **No participant ID.** Visitors are not assigned or asked for one.
- **No logging of any kind.** Demo sessions write no interaction logs, no LLM
  traces, no survey files, and no relay session logs.
- **Bring your own OpenAI key.** Each visitor pastes their own key in the
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

### Required environment for a public deployment

| Variable | Value | Why |
|----------|-------|-----|
| `OPENAI_API_KEY` | **unset / empty** | Visitors supply their own key. An operator key would be spendable by anyone through the unauthenticated speech-preview route. |
| `AGENT_RELAY_LOG_ENABLED` | unset or `false` | Keeps relay session logs off. |
| `DEMO_MAX_CONCURRENT_SESSIONS` | `10` (default, overridable) | Caps simultaneous demo sessions. Demo sessions never evict each other; creation beyond the cap is rejected with a clear error. |

> **Note:** Real study and demo sessions are served by per-session agent
> processes that the backend spawns itself. The standalone `agent` service in
> `docker-compose.yml` is pinned to `AGENT_SESSION_ID=default` and does not
> serve them.

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

Note: monitor routes are localhost-only by default for security.

For full instructions, see `DEPLOYMENT.md`.

`AGENT_SESSION_ID` must match frontend `VITE_AGENT_SESSION_ID`.

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
npm run dev:stack:agent-monitor
```
2. Open the frontend (`http://localhost:5173`) and the monitor (`http://localhost:5174`).
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
3. Verify session ids match:
   - `apps/frontend/.env` -> `VITE_AGENT_SESSION_ID`
   - root `.env` -> `AGENT_SESSION_ID`
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
