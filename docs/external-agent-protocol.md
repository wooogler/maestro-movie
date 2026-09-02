# External Agent Protocol (MVP v0.2)

Status: Canonical specification for the study prototype.

This document defines how an external agent server connects to the host UI system and interacts with the movie-booking workflow.

## 1. Prototype Scope

### In scope
- Single participant session at a time.
- External agent can read:
  - `uiSpec`
  - `messageHistory`
  - `toolSchema`
- External agent can perform:
  - `tool.call`
  - `agent.message` (display/log only)
- External agent receives participant input through `user.message`.
- Host saves session logs, then resets state when the session ends.

### Out of scope
- Multi-user concurrency control.
- Revision locking.
- Code editing.
- Direct access to backend raw payloads (`backendData`).

## 2. Transport

- One WebSocket connection.
- Endpoint: `/agent/ws`.
- All packets are JSON with a common envelope.

## 3. Envelope

```json
{
  "v": "mvp-0.2",
  "type": "tool.call",
  "id": "req-003",
  "payload": {}
}
```

Fields:
- `v` (string): protocol version, always `mvp-0.2`.
- `type` (string): message type.
- `id` (string, optional): request identifier from sender.
- `replyTo` (string, optional): request id being answered.
- `payload` (object): type-specific body.

## 4. Message Types

### 4.0 Connection Handshake

Both host (frontend) and external agent must join a relay session first.

#### `relay.join`

An agent names its session through a signed, session-scoped token — never a raw
session id:

```json
{
  "v": "mvp-0.2",
  "type": "relay.join",
  "id": "join-001",
  "payload": {
    "role": "agent",
    "agentToken": "<agent-scoped token>",
    "agentName": "my-agent"
  }
}
```

**This replaced an unauthenticated join, and the reason is worth stating.** The
agent role is the most powerful one on this relay: it can drive the booking GUI
with `tool.call`, speak through the kiosk with `agent.message`, and end the
session. It previously required nothing but a `relaySessionId` — and
`relay.joined` handed that id back to *every* joiner, including a read-only
viewer. So a photographed booth QR was enough to join as a viewer, read the
session id out of the join reply, and reconnect as an agent with full authority
over someone else's live session.

Two things changed together, and neither is sufficient alone:

- an agent join presents an `agent`-scoped token, and
- `relay.joined` returns `sessionId` **only to the host**.

The token is minted per session by the backend that spawns the agent and handed
over in the `AGENT_RELAY_TOKEN` environment variable. It is scoped so narrowly
that it resolves nothing but the relay session to attach to: it cannot open a
session context, read the session's API key, download the trace, finish the
session, or stand in for a view token. `apps/backend/src/study/relayTokenScopes.check.ts`
asserts each of those, and runs as part of `npm run check`.

> **Operators running a third-party agent:** the agent token is what you hand
> your agent instead of a session id. Today it is produced only where the
> backend spawns its own agent, so an out-of-process agent has no supported way
> to obtain one yet. That is a known gap, not a decision — it needs a deliberate
> hand-off route rather than a bare mint endpoint, since anything that issues
> this token issues authority over a live session.

#### `relay.joined`

```json
{
  "v": "mvp-0.2",
  "type": "relay.joined",
  "replyTo": "join-001",
  "payload": {
    "role": "agent",
    "clientName": "my-agent"
  }
}
```

`sessionId` appears in this reply for the host role only. An agent already knows
which session it was started for, and a viewer never needed it.

### 4.1 Client -> Host

#### `session.start`
Starts a study session.

```json
{
  "v": "mvp-0.2",
  "type": "session.start",
  "id": "req-001",
  "payload": {
    "studyId": "pilot-01",
    "participantId": "P00-EXAMPLE"
  }
}
```

#### `snapshot.get`
Requests the current visible state.

```json
{
  "v": "mvp-0.2",
  "type": "snapshot.get",
  "id": "req-002",
  "payload": {}
}
```

#### `tool.call`
Executes one UI tool. `reason` is required.

```json
{
  "v": "mvp-0.2",
  "type": "tool.call",
  "id": "req-003",
  "payload": {
    "toolName": "select",
    "params": { "itemId": "m1" },
    "reason": "Pick the first available movie option to continue the flow."
  }
}
```

#### `agent.message`
Posts an agent-visible explanation to the host chat timeline. This is not a tool call.

```json
{
  "v": "mvp-0.2",
  "type": "agent.message",
  "id": "req-004",
  "payload": {
    "text": "I will choose a date next to narrow available showtimes."
  }
}
```

`payload.category` is optional. In voice mode the host decides how much of each
message to speak aloud, and it groups messages by what the agent was doing when
it produced them (see [Voice verbosity](#voice-verbosity)). Sending the name of
the tool the message narrates — `next`, `prev`, `select`, `selectMultiple`,
`filter`, `sort`, `highlight`, `augment`, `clearModification`, `respond`, or
`system` — lets the host skip its text classifier and route the message exactly.

The bundled agent sends it on every message. Send it if you can: the host's
fallback classifier is English regex measured against an English corpus, and in
any other language it recognises almost nothing and routes everything to
`respond`. That is safe — `respond` is never silenced — but it switches the
verbosity feature off in all but name.

```json
{
  "v": "mvp-0.2",
  "type": "agent.message",
  "id": "req-005",
  "payload": {
    "text": "I'm highlighting the PG options.",
    "category": "highlight"
  }
}
```

The field is advisory and additive. Omit it and the host classifies the text
itself; send an unrecognised value and the host falls back to the same
classifier. No agent has to change to work with a verbosity-aware host.

#### `agent.memory`
Publishes the agent's preference memory and workflow-navigation state. Fire-and-forget: the host never replies, and an agent that is never listened to loses nothing by sending it.

Sent whenever the content changes — after preference extraction, when a conflict is raised or cleared, when a dead end is recorded, at the end of each planner cycle, and once whenever a host joins (a host that just connected holds no snapshot yet). Identical consecutive snapshots are suppressed at the source.

The host renders this as the demo's memory panel; study conditions receive it and ignore it.

```json
{
  "v": "mvp-0.2",
  "type": "agent.memory",
  "payload": {
    "updatedAt": "2026-11-03T19:20:31.004Z",
    "reason": "dead-end-recorded",
    "stage": "theater",
    "preferences": [
      {
        "id": "pref_imax_required_1a2b3c4d5e",
        "description": "The showing must be IMAX",
        "strength": "hard",
        "relevantStages": ["time"]
      }
    ],
    "deadEnds": [
      {
        "id": "dead_9f8e7d6c5b",
        "preferenceIds": ["pref_imax_required_1a2b3c4d5e"],
        "scope": { "stage": "theater", "movie": "Street Fighter" },
        "reason": "No IMAX showing within 15 miles",
        "createdAt": "2026-11-03T19:20:31.004Z",
        "lastSeenAt": "2026-11-03T19:20:31.004Z",
        "count": 1
      }
    ],
    "attemptedBranches": [],
    "committedWorkflow": { "movie": { "title": "Street Fighter" } },
    "pendingConflict": null,
    "backtrackContinuation": { "targetStage": "theater" },
    "stageBindings": [
      {
        "stage": "movie",
        "parentContextKey": "root",
        "filters": [
          {
            "field": "ageRating",
            "operator": "in",
            "value": ["G", "PG"],
            "preferenceIds": ["pref_pg_or_below_0a1b2c3d4e"]
          }
        ],
        "highlight": null,
        "updatedAt": "2026-11-03T19:18:02.551Z"
      }
    ]
  }
}
```

`stageBindings` is what links memory to the GUI: each filter and highlight carries the preference ids that justified it, so a viewer can see which spoken constraint produced which on-screen adaptation.

#### `session.end`
Ends the session, flushes logs, resets UI state.

```json
{
  "v": "mvp-0.2",
  "type": "session.end",
  "id": "req-999",
  "payload": {
    "reason": "study-complete"
  }
}
```

### 4.2 Host -> Client

#### `session.started`

```json
{
  "v": "mvp-0.2",
  "type": "session.started",
  "replyTo": "req-001",
  "payload": {
    "sessionId": "s-20260213-001"
  }
}
```

#### `snapshot.state`
Contains only allowed read surfaces.
`toolSchema` is stage-aware and contains only currently available tools.

```json
{
  "v": "mvp-0.2",
  "type": "snapshot.state",
  "replyTo": "req-002",
  "payload": {
    "sessionId": "s-20260213-001",
    "uiSpec": {},
    "messageHistory": [],
    "toolSchema": []
  }
}
```

#### `tool.result`

Acknowledges tool execution.
For state-changing tools, host may include an immediate `uiSpec`.
Authoritative state sync still comes from `state.updated`.

```json
{
  "v": "mvp-0.2",
  "type": "tool.result",
  "replyTo": "req-003",
  "payload": {
    "ok": true,
    "toolName": "select",
    "uiSpec": {}
  }
}
```

Notes:
- `payload.uiSpec` is optional.
- `next`, `prev`, `postMessage` may return `ok` without `uiSpec`; consume upcoming `state.updated`.

#### `state.updated`
Push event when the host state changes (user action, stage load, tool application).

```json
{
  "v": "mvp-0.2",
  "type": "state.updated",
  "payload": {
    "source": "host",
    "uiSpec": {},
    "messageHistory": [],
    "toolSchema": []
  }
}
```

#### `user.message`
Forwarded user text input from the host chat input to the external agent.

```json
{
  "v": "mvp-0.2",
  "type": "user.message",
  "payload": {
    "text": "I prefer evening showtimes.",
    "stage": "time"
  }
}
```

#### `voice.mode`
Announces whether the participant has voice mode turned on. Sent on every toggle.
Agents that pace themselves against spoken output should use this to decide
whether to wait for `tts.playback.complete` or to estimate reading time.

```json
{
  "v": "mvp-0.2",
  "type": "voice.mode",
  "payload": {
    "enabled": true
  }
}
```

#### Viewer connections

`relay.join` accepts a third role, `viewer`, alongside `host` and `agent`:

```json
{
  "v": "mvp-0.2",
  "type": "relay.join",
  "id": "viewer-join",
  "payload": { "role": "viewer", "viewToken": "<read-only token>" }
}
```

A viewer is a read-only spectator — a second device watching the session's
preference memory. It exists because `host` is a single slot: a second host join
evicts the first, so opening the same session on a phone would otherwise kill the
laptop's booking window.

Three properties hold:

- **It receives `agent.memory` and nothing else.** Tool calls, snapshots and the
  conversation stay between the agent and the host.
- **It can send nothing.** Any envelope from a viewer is answered with
  `INVALID_MESSAGE`.
- **It names its session only through a signed token**, never a raw session id,
  and that token is scoped `view` — it cannot be used to join as a host, download
  the trace, finish the session, or join as an agent. That last one is not
  decorative: see the note under `relay.join` for the escalation it closes.

The relay caches the last `agent.memory` per session and replays it when a viewer
joins, because the agent emits that envelope only when its content changes: a
device that pairs mid-session would otherwise sit on an empty panel until the
participant's next preference. Viewers do not keep a session alive; when the host
and agents are gone the viewers are closed with `SESSION_NOT_ACTIVE`.

#### Companion connections

`relay.join` accepts a fourth role, `companion`: a paired phone acting as the
session's microphone and speaker while the kiosk keeps the booking GUI.

```json
{
  "v": "mvp-0.2",
  "type": "relay.join",
  "id": "companion-join",
  "payload": { "role": "companion", "companionToken": "<pairing token>" }
}
```

**A companion never addresses the agent.** Its lane terminates at the host, and
that is the property everything else rests on. The host keeps the short-utterance
filter, the replay-suppression rule, the study logging, and — most importantly —
the single `tts.playback.complete` the agent's speech barrier counts. A phone
that could emit that directly would give the barrier two owners.

| Type | Direction | Payload |
|---|---|---|
| `companion.hello` | companion → host | `{}`. Sent on every successful join. |
| `companion.config` | host → companion | `{ language, transcriptionPrompt, listening }` |
| `companion.speak` | host → companion | `{ id, text, stop? }`. `stop: true` cuts playback. |
| `companion.transcript` | companion → host | `{ text, durationMs }`. Raw and unfiltered. |
| `companion.playback.complete` | companion → host | `{ id, interrupted }`. Raw. |

The four type sets (`AGENT_TO_HOST`, `HOST_TO_AGENT`, `HOST_TO_COMPANION`,
`COMPANION_TO_HOST`) are pairwise disjoint by the `companion.` prefix. Note that
`companion.playback.complete` is deliberately **not** named
`tts.playback.complete`: that string is a host→agent type, and reusing it would
let a phone's frame be routed to the agent.

Properties that are load-bearing rather than incidental:

- **Single slot, newest wins.** Two phones would each answer one
  `companion.speak`, the host would forward both completions, and the barrier
  counts completions as credits rather than matching ids — so the duplicate would
  spend another utterance's credit and let the agent act over live audio. The
  evicted phone is told why before its socket closes.
- **`companion.hello` exists because config delivery must be pull-based.** Under
  newest-wins, a second phone takes the slot before the first phone's close
  handler runs, so `companionActive` never transitions false→true. An
  edge-triggered config push would never fire and the new phone would sit mute
  forever while the host kept forwarding utterances into it.
- **Two failure classes, and a companion must not confuse them.** A refusal on
  the *join reply* (`COMPANION_PAIRING_INVALID`) is permanent. `HOST_UNAVAILABLE`,
  returned when a companion frame arrives while the host slot is momentarily
  empty, is transient — the host reconnects on a 1200ms timer, and treating that
  as a dead pairing would strand the phone for the rest of the session.
- **It sees `agent.memory` and nothing else** of the agent's traffic.
  `agent.message` is deliberately excluded: the host's voice-verbosity gate
  decides what is spoken, so a phone receiving agent messages directly would
  speak text the host chose to silence.
- **It does not keep a session alive.** Like a viewer, a phone left in a pocket
  must not hold a demo slot or an agent process open.
- **Presence.** `relay.presence` gains `companionActive: true` only while a phone
  is attached; the key is absent otherwise, so the envelope is byte-identical in
  sessions that have no phone.

The pairing token is minted on demand at `POST /study/companion-token` (host
credential, demo sessions only) and carries its own scope, its own enforced
expiry, and a revocation handle — minting a new one revokes the previous phone.
It cannot open a session context, read the session's key, download the trace,
finish the session, or stand in for a view or agent token.

**On spending the session's OpenAI key.** The phone mints its own Realtime
credential at `POST /study/companion/realtime-session`. It is worth being precise
about what bounds this, because the obvious claim is false: at a conference booth
the session-bound key *is* the operator key, since the access-code flow copies
`OPENAI_API_KEY` into the session. "This handler never reads the environment"
therefore proves nothing. What actually bounds it is that a mint requires a phone
to have **attached to the relay** — which grants a small, bounded allowance — so
photographing the QR is not enough, and anyone who does attach evicts the
visitor's phone visibly.

#### `conversation.language`
Names the language the participant is conversing in. Sent when the agent joins
and again on every change, so an agent that connects mid-session is never left
guessing.

```json
{
  "v": "mvp-0.2",
  "type": "conversation.language",
  "payload": {
    "language": "ko"
  }
}
```

`payload.language` is a BCP-47 primary subtag; the host currently sends `en` or
`ko`. The setting is host-owned — the agent is told, it does not choose — and an
agent that ignores this message keeps behaving exactly as it did before the
message existed.

It governs the spoken channel only. Tool names, tool parameter values and item
ids stay in the host's vocabulary in every language: the screen still reads
"Street Fighter" and seat "C1", so an agent that translated them would select
nothing. `reason` likewise stays English — it is a trace field, not something
the participant hears.

#### `tts.playback.complete`
Sent when spoken playback of the agent's most recent `agent.message` ends. In
voice mode the host speaks each `agent.message` through an OpenAI Realtime
session, so this is the signal that the user has actually heard the line and the
agent may take its next action.

`interrupted` is `true` when the user barged in over the speech or playback was
stopped programmatically, meaning the utterance was only partially heard. The
payload fields are informational: an agent may ignore them and treat any
`tts.playback.complete` as "the floor is free" (the reference agent does).

**The host may send this for a message it never spoke.** Voice verbosity lets
the participant silence whole categories of narration, and a silenced message is
still added to the chat timeline — it simply does not become audio. The host
reports it complete immediately, with `interrupted: true`, so the agent's turn
does not stall waiting for playback that will never start. Agents must therefore
treat this message as "the floor is free", never as "the user heard that line".

#### Voice verbosity

Participants can choose how much the agent says out loud without changing what
the agent decides. The host classifies each `agent.message` — moving between
steps, picking an option, changing what is on screen, or conversation — and
speaks it in full, speaks a shortened form, or stays silent. It additionally
drops sentences that repeat something just said, recite options already visible
on screen, or run on without a participant turn.

Two guarantees hold for every setting:

- **Nothing is lost.** Everything the agent says reaches the chat timeline and
  the study log; only the audio is filtered.
- **A question is never silenced.** Any utterance containing a question is
  spoken, shortened at worst, whatever the participant has configured.
- **Errors are always spoken,** and the automatic rules shorten conversation
  rather than muting it — an agent that repeats a failure notice verbatim will
  still be heard.

This is entirely host-side. The agent's planning is untouched, and the only
protocol consequences are the `tts.playback.complete` note above and the
optional `payload.category` on `agent.message`.

The host's own classifier reads English. In a `ko` session it recognises a
narrow set of Korean narration endings and sends everything else to `respond`,
so an agent that does not tag its messages will simply be more talkative in
Korean than in English — never quieter, and never silent where it should not be.

Agents should not block indefinitely on this message — playback can fail, and
the host may drop the connection mid-utterance. The reference agent releases
itself after 15 seconds.

```json
{
  "v": "mvp-0.2",
  "type": "tts.playback.complete",
  "payload": {
    "interrupted": false,
    "messageId": "m-20260213-014"
  }
}
```

#### `session.ended`

```json
{
  "v": "mvp-0.2",
  "type": "session.ended",
  "replyTo": "req-999",
  "payload": {
    "sessionId": "s-20260213-001",
    "logFile": "logs/study/s-20260213-001.jsonl",
    "stateReset": true
  }
}
```

#### `error`

```json
{
  "v": "mvp-0.2",
  "type": "error",
  "replyTo": "req-003",
  "payload": {
    "code": "INVALID_PARAMS",
    "message": "setQuantity requires quantity >= 0"
  }
}
```

### 4.3 Synchronization Rules

- Treat `state.updated` as the canonical external sync event.
- Use `tool.result` as an execution acknowledgement (`ok` / `error`) and optional fast-path `uiSpec`.
- Use `snapshot.get` / `snapshot.state` for explicit resync (for example on reconnect or if local view is stale).

## 5. Error Codes

- `INVALID_MESSAGE`
- `SESSION_NOT_ACTIVE`
- `UNKNOWN_TOOL`
- `INVALID_PARAMS`
- `NO_ACTIVE_SPEC`
- `TOOL_EXECUTION_FAILED`

## 6. Logging (Study Requirement)

Persist as JSONL; one event per line.

```json
{
  "sessionId": "s-20260213-001",
  "eventIndex": 12,
  "timestamp": "2026-02-13T10:22:17.123Z",
  "direction": "in",
  "type": "tool.call",
  "payload": {
    "toolName": "select",
    "params": { "itemId": "m1" },
    "reason": "Pick the first available movie option to continue the flow."
  }
}
```

Required fields:
- `sessionId`
- `eventIndex`
- `timestamp`
- `direction` (`in` | `out` | `internal`)
- `type`
- `payload`

## 7. Implementation Mapping

Current host integration points:
- Tool schema definition source: `apps/frontend/src/agent/tools.ts`
- Tool schema stage filter source: `apps/frontend/src/pages/ChatPage.tsx`
- Tool schema enforcement source: `apps/frontend/src/hooks/useAgentBridge.ts`
- Tool execution entry: `apps/frontend/src/hooks/useToolHandler.ts`
- Immediate tool result spec return: `apps/frontend/src/hooks/useToolHandler.ts` -> `apps/frontend/src/hooks/useAgentBridge.ts`
- WebSocket lifecycle guard for React dev StrictMode: `apps/frontend/src/hooks/useAgentBridge.ts`
- Visible state source (`uiSpec`): `apps/frontend/src/components/DevToolsContext.tsx`
- Chat state source (`messageHistory`): `apps/frontend/src/store/chatStore.ts`
- User input source (`user.message`): `apps/frontend/src/components/chat/ChatInput.tsx`
- Voice session, speech in and out (`voice.mode`, `tts.playback.complete`): `apps/frontend/src/hooks/useRealtimeVoice.ts`

`backendData` from the devtools context must not be serialized to external snapshots in this MVP.
