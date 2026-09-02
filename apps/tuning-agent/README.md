# Tuning Agent

Dedicated workspace for implementing the external agent runtime.

This package holds the agent runtime that drives the host UI over the
WebSocket relay (`/agent/ws`). See
[`docs/external-agent-protocol.md`](../../docs/external-agent-protocol.md)
for the wire protocol.

## Structure

```text
src/
  runtime/
    relayClient.ts
    eventBus.ts
  core/
    perception.ts
    planner.ts
    executor.ts
    verifier.ts
    memory.ts
  policies/
    retryPolicy.ts
    safetyPolicy.ts
  types.ts
  index.ts
```

## Run

```bash
npm run dev --workspace=apps/tuning-agent
```

recommended (auto-loads repo-root `.env`):

```bash
npm run dev:agent
```

run backend+frontend+agent together:

```bash
npm run dev:stack:agent
```

Important:
- The relay `host` is created when the frontend page is actually open in a browser.
- If the agent starts first, it now waits and retries until the host is connected.
- Monitor API: `http://localhost:3500` (or your `AGENT_MONITOR_PORT`).
- Monitor dashboard (React app): `http://localhost:3501` (or your `AGENT_MONITOR_WEB_PORT`).
- Monitor `planner.decision` / `planner.no_action` events include `source` and `fallbackReason` for debugging.
- Set `AGENT_LLM_DEBUG=true` to print raw LLM request/response and error payloads in agent logs.

start mode (non-watch, uses compiled `dist`):

```bash
npm run build:agent
npm run start:agent
```

or

```bash
npm run build --workspace=apps/tuning-agent
npm run start --workspace=apps/tuning-agent
```

## Environment

Use a single repo-root `.env` file (recommended for this monorepo).

```bash
# <repo-root>/.env
AGENT_RELAY_URL=ws://localhost:3000/agent/ws
AGENT_SESSION_ID=default
AGENT_STUDY_ID=pilot-01
AGENT_PARTICIPANT_ID=P00-EXAMPLE
OPENAI_API_KEY=<your_api_key>
AGENT_OPENAI_MODEL=gpt-5.6-terra
AGENT_OPENAI_API_MODE=responses
AGENT_ENABLE_OPENAI=true
AGENT_LLM_DEBUG=false
AGENT_MONITOR_PORT=3500
AGENT_MONITOR_WEB_PORT=3501
```

## Protocol

This runtime follows:
- `docs/external-agent-protocol.md`
- `docs/external-agent-implementation-draft.md`

## MVP Behavior

- Connects to relay and starts a session automatically.
- Requests snapshot and keeps planning on `snapshot.state`, `state.updated`, and `user.message`.
- Runs with strict turn policy:
  - one user message -> one actionable tool execution (`select`, `next`, etc.)
  - `postMessage` can run multiple times to explain what the agent is doing
  - only one tool call is in flight at any time
- LLM-first planning for tool choice:
  - chooses one next tool from current `toolSchema` based on user intent and GUI state
  - prioritizes GUI adaptation tools (`filter/sort/highlight/augment/postMessage`) first to reconfirm intent
  - GUI execution tools (`select/next/prev`) require explicit user confirmation
- Deterministic fallback is used only when LLM is unavailable or planner output fails validation.
