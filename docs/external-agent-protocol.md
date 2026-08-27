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

```json
{
  "v": "mvp-0.2",
  "type": "relay.join",
  "id": "join-001",
  "payload": {
    "role": "agent",
    "sessionId": "default"
  }
}
```

#### `relay.joined`

```json
{
  "v": "mvp-0.2",
  "type": "relay.joined",
  "replyTo": "join-001",
  "payload": {
    "role": "agent",
    "sessionId": "default"
  }
}
```

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

#### `tts.playback.complete`
Sent when spoken playback of the agent's most recent `agent.message` ends. In
voice mode the host speaks each `agent.message` through an OpenAI Realtime
session, so this is the signal that the user has actually heard the line and the
agent may take its next action.

`interrupted` is `true` when the user barged in over the speech or playback was
stopped programmatically, meaning the utterance was only partially heard. The
payload fields are informational: an agent may ignore them and treat any
`tts.playback.complete` as "the floor is free" (the reference agent does).

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
