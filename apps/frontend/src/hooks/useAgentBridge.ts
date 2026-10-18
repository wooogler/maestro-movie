import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolDefinition } from '../agent/tools';
import {
  PROTOCOL_VERSION,
  parseAgentMemorySnapshot,
  parseDeviceRoster,
  parseMemoryCommand,
  type AgentMemorySnapshot,
  type DeviceRosterPayload,
  type MemoryCommand,
  type PreferenceProfilePayload,
  type RelayEnvelope,
  type SnapshotPayload,
} from '../agent/protocol';
import type { UISpec, Stage } from '../spec';
import type { ChatMessage } from '../store/chatStore';
import type { ToolApplyContext } from '../components/devToolsContextShared';
import { STAGE_META } from '../spec/generators';

interface UseAgentBridgeOptions {
  uiSpec: UISpec | null;
  messageHistory: ChatMessage[];
  toolSchema: ToolDefinition[];
  sessionId?: string;
  studyToken?: string;
  plannerCpMemoryLimit?: number;
  guiAdaptationEnabled?: boolean;
  /** A quick-demo card is running; see `SnapshotPayload.narrateAdaptations`. */
  narrateAdaptations?: boolean;
  /** Voice-mode demo session; see `SnapshotPayload.spokenBrevity`. */
  spokenBrevity?: boolean;
  /**
   * Preference memory to open the session with, or null for none. Sent on every
   * snapshot; the agent applies each revision once, so re-sending is a no-op
   * and cannot undo a removal the visitor made since.
   */
  preferenceProfile?: PreferenceProfilePayload | null;
  /**
   * The language the visitor is conversing in, and whether voice mode is on.
   *
   * Both are pushed to the agent the moment the host joins the relay, and again
   * right before `session.started` is answered. The agent starts in English
   * with voice off and only learns otherwise from these envelopes, so a value
   * sent from a mount-time effect — before the socket is open — is silently
   * dropped by `sendEnvelope`, and the planner's first request then goes out
   * without the language section. The join-time push is what makes a Korean
   * session Korean from its first sentence; `sendConversationLanguage` and
   * `sendVoiceModeChange` remain the path for a change mid-session.
   */
  conversationLanguage?: string;
  voiceModeEnabled?: boolean;
  /**
   * The planner model the visitor chose, or null for the server's own. Pushed
   * on join with the two above, and on change via `sendPlannerModel`.
   */
  plannerModel?: string | null;
  /**
   * May return a promise, and the reply is held until it settles.
   *
   * The host uses that to land a GUI change with the sentence that describes
   * it: the agent sends its narration first and the tool call immediately
   * after, but speech takes a beat to start while a tool call applies in
   * milliseconds. The agent's request timeout is 12s and it waits for playback
   * to COMPLETE before planning again, so a hold of a second or two costs a
   * turn nothing.
   */
  onToolCall: (
    toolName: string,
    params: Record<string, unknown>,
    context?: ToolApplyContext
  ) => UISpec | null | void | Promise<UISpec | null | void>;
  onAgentMessage: (
    text: string,
    category?: string | null,
    timing?: { model: string; plannerMs: number } | null
  ) => void;
  onSessionEnd: () => void;
  enabled?: boolean;
  /**
   * Raw speech captured by a paired phone. Raw on purpose: the short-utterance
   * filter, the `voice` source tag and the study logging all live on the host,
   * so a companion transcript must enter through the same funnel as the kiosk's
   * own — never a second one.
   */
  onCompanionTranscript?: (payload: { text: string; durationMs: number }) => void;
  /** Raw playback report from the phone; the host still owns the replay rule. */
  onCompanionPlaybackComplete?: (payload: { id: string | null; interrupted: boolean }) => void;
  /**
   * A phone announced itself. This, not a presence edge, is what triggers the
   * config push — see the note on `companion.hello` in the relay.
   */
  onCompanionHello?: () => void;
  /** The phone asking to take voice, or hand it back. */
  onCompanionClaim?: (claimed: boolean) => void;
  /**
   * The phone asking to change preference memory. Routed through the host like
   * every other companion frame: the phone never addresses the agent, so the
   * write still leaves from the one socket that was ever allowed to make it.
   */
  onCompanionMemoryCommand?: (command: MemoryCommand) => void;
}

interface UseAgentBridgeResult {
  sendUserMessageToAgent: (text: string, stage: Stage) => void;
  sendSessionResetToAgent: (reason?: string) => void;
  sendVoiceModeChange: (enabled: boolean) => void;
  sendConversationLanguage: (language: string) => void;
  sendPlannerModel: (model: string | null) => void;
  /**
   * Remove one preference from the agent's memory, or put one back.
   *
   * Returns false when the frame could not be sent — the socket reconnects on a
   * flat timer, and a removal dropped into that window must be distinguishable
   * from one the agent simply has not echoed yet.
   */
  sendPreferenceDelete: (preferenceId: string) => boolean;
  sendPreferenceRestore: (preferenceId: string) => boolean;
  /** Withdraw everything at once, for clearing between visitors. */
  sendPreferenceClear: () => boolean;
  /**
   * Push a profile mid-session, rather than waiting for the next snapshot to
   * carry it. The agent applies a revision once, so this and the ride-along
   * payload cannot double-apply the same load.
   */
  sendPreferenceProfileLoad: (profile: PreferenceProfilePayload) => boolean;
  sendTtsPlaybackComplete: (info?: {
    interrupted?: boolean;
    messageId?: string | null;
  }) => void;
  /** Hand an utterance to the paired phone instead of speaking it here. */
  sendCompanionSpeak: (item: { id: string | null; text: string; stop?: boolean }) => void;
  /** Push the phone everything it needs that only the host knows. */
  sendCompanionConfig: (config: {
    language: string;
    transcriptionPrompt: string | null;
    listening: boolean;
  }) => void;
  /**
   * True while a phone is attached to this session.
   *
   * Read it as a fact about the phone ONLY while `isConnected` is also true.
   * The host's own relay socket reconnects on a flat 1200ms timer, and presence
   * is unavailable exactly while that is happening — an absent `companionActive`
   * during a host reconnect means "unknown", not "the phone left".
   */
  companionActive: boolean;
  isConnected: boolean;
  isJoined: boolean;
  joinedSessionId: string | null;
  connectedAgents: Array<{ id: string; name: string }>;
  agentActivityPhase: 'idle' | 'planning' | 'executing';
  agentStatusSupported: boolean;
  /** Latest preference memory / workflow navigation state, or null before the agent publishes one. */
  agentMemory: AgentMemorySnapshot | null;
  /**
   * Who is attached to this session. Null until the first roster lands, and
   * always null outside the demo — the relay does not send this envelope to a
   * study session at all.
   */
  deviceRoster: { roster: DeviceRosterPayload; atMs: number } | null;
}

type AgentActivityPhase = 'idle' | 'planning' | 'executing';

function buildWsUrl(): string {
  const configured = import.meta.env.VITE_AGENT_WS_URL as string | undefined;
  const endpoint =
    configured && configured.trim()
      ? configured.trim()
      : import.meta.env.DEV
      ? 'ws://localhost:3000/agent/ws'
      : '/agent/ws';

  if (/^wss?:\/\//.test(endpoint)) {
    return endpoint;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const basePath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${protocol}://${window.location.host}${basePath}`;
}

function parseEnvelope(raw: unknown): RelayEnvelope | null {
  if (!(raw instanceof MessageEvent)) return null;
  if (typeof raw.data !== 'string') return null;

  try {
    const parsed = JSON.parse(raw.data) as RelayEnvelope;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isUiSpec(value: unknown): value is UISpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<UISpec>;
  return typeof candidate.stage === 'string' && typeof candidate.state === 'object';
}

function sanitizeUiSpecForRelay(uiSpec: UISpec | null): Record<string, unknown> | null {
  if (!uiSpec) return null;
  return { ...(uiSpec as UISpec & Record<string, unknown>) };
}

export function useAgentBridge({
  uiSpec,
  messageHistory,
  toolSchema,
  sessionId,
  studyToken,
  plannerCpMemoryLimit = 10,
  guiAdaptationEnabled = true,
  narrateAdaptations = false,
  spokenBrevity = false,
  preferenceProfile = null,
  conversationLanguage = 'en',
  voiceModeEnabled = false,
  plannerModel = null,
  onToolCall,
  onAgentMessage,
  onSessionEnd,
  enabled = true,
  onCompanionTranscript,
  onCompanionPlaybackComplete,
  onCompanionHello,
  onCompanionClaim,
  onCompanionMemoryCommand,
}: UseAgentBridgeOptions): UseAgentBridgeResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [joinedSessionId, setJoinedSessionId] = useState<string | null>(null);
  const [companionActive, setCompanionActive] = useState(false);
  const [connectedAgents, setConnectedAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentActivityPhase>>({});
  const [agentStatusSupported, setAgentStatusSupported] = useState(false);
  const [agentMemory, setAgentMemory] = useState<AgentMemorySnapshot | null>(null);
  /** Demo-only; a study session never receives `relay.devices`. */
  const [deviceRoster, setDeviceRoster] = useState<{
    roster: DeviceRosterPayload;
    atMs: number;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string>(
    sessionId || (import.meta.env.VITE_AGENT_SESSION_ID as string) || 'default'
  );
  const studyTokenRef = useRef<string>(studyToken ?? '');
  const enabledRef = useRef(enabled);
  const latestRef = useRef({
    uiSpec,
    messageHistory,
    toolSchema,
    plannerCpMemoryLimit,
    guiAdaptationEnabled,
    narrateAdaptations,
    spokenBrevity,
    preferenceProfile,
    onToolCall,
    onAgentMessage,
    onSessionEnd,
  });

  // Held in their own refs rather than in `latestRef` so the two consumers of
  // that object (which is rebuilt on every uiSpec change) stay untouched.
  const sessionSettingsRef = useRef({ conversationLanguage, voiceModeEnabled, plannerModel });
  const onCompanionTranscriptRef = useRef(onCompanionTranscript);
  const onCompanionPlaybackCompleteRef = useRef(onCompanionPlaybackComplete);
  const onCompanionHelloRef = useRef(onCompanionHello);
  const onCompanionClaimRef = useRef(onCompanionClaim);
  const onCompanionMemoryCommandRef = useRef(onCompanionMemoryCommand);
  useEffect(() => {
    onCompanionTranscriptRef.current = onCompanionTranscript;
    onCompanionPlaybackCompleteRef.current = onCompanionPlaybackComplete;
    onCompanionHelloRef.current = onCompanionHello;
    onCompanionClaimRef.current = onCompanionClaim;
    onCompanionMemoryCommandRef.current = onCompanionMemoryCommand;
  }, [
    onCompanionTranscript,
    onCompanionPlaybackComplete,
    onCompanionHello,
    onCompanionClaim,
    onCompanionMemoryCommand,
  ]);

  const normalizeCpMemoryLimit = useCallback((value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
    return 0;
  }, []);

  useEffect(() => {
    latestRef.current = {
      uiSpec,
      messageHistory,
      toolSchema,
      plannerCpMemoryLimit,
      guiAdaptationEnabled,
      narrateAdaptations,
      spokenBrevity,
      preferenceProfile,
      onToolCall,
      onAgentMessage,
      onSessionEnd,
    };
  }, [
    uiSpec,
    messageHistory,
    toolSchema,
    plannerCpMemoryLimit,
    guiAdaptationEnabled,
    narrateAdaptations,
    spokenBrevity,
    preferenceProfile,
    onToolCall,
    onAgentMessage,
    onSessionEnd,
  ]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    sessionIdRef.current = sessionId || (import.meta.env.VITE_AGENT_SESSION_ID as string) || 'default';
  }, [sessionId]);

  useEffect(() => {
    studyTokenRef.current = studyToken ?? '';
  }, [studyToken]);

  const wsUrl = useMemo(() => buildWsUrl(), []);

  const sendEnvelope = useCallback((envelope: RelayEnvelope) => {
    if (!enabledRef.current) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...envelope }));
    return true;
  }, []);

  useEffect(() => {
    sessionSettingsRef.current = { conversationLanguage, voiceModeEnabled, plannerModel };
  }, [conversationLanguage, voiceModeEnabled, plannerModel]);

  /**
   * Tell the agent what the host already knows about this session. Called from
   * inside `handleEnvelope`, synchronously, because the agent asks for
   * `session.start` within milliseconds of seeing the host's presence — a React
   * effect keyed on `isJoined` would lose that race and the first planner
   * request would still be English.
   */
  const sendSessionSettings = useCallback(() => {
    const {
      conversationLanguage: language,
      voiceModeEnabled: enabled,
      plannerModel: model,
    } = sessionSettingsRef.current;
    sendEnvelope({ type: 'voice.mode', payload: { enabled } });
    sendEnvelope({ type: 'conversation.language', payload: { language } });
    // Always sent, even when null: a fresh agent process starts on the server
    // model anyway, but a reconnect to one that was switched mid-session must
    // reflect what this host now wants.
    sendEnvelope({ type: 'planner.model', payload: { model: model ?? '' } });
  }, [sendEnvelope]);

  const getSnapshotPayload = useCallback((): SnapshotPayload => {
    const current = latestRef.current;
    return {
      sessionId: sessionIdRef.current,
      uiSpec: sanitizeUiSpecForRelay(current.uiSpec),
      messageHistory: current.messageHistory,
      toolSchema: current.toolSchema,
      plannerCpMemoryLimit: normalizeCpMemoryLimit(current.plannerCpMemoryLimit),
      guiAdaptationEnabled: current.guiAdaptationEnabled !== false,
      // Spread only when on, so a study session's snapshot is byte-identical
      // to what it was before this field existed.
      ...(current.narrateAdaptations ? { narrateAdaptations: true } : {}),
      ...(current.spokenBrevity ? { spokenBrevity: true } : {}),
      stageMeta: STAGE_META,
      preferenceProfile: current.preferenceProfile ?? null,
    };
  }, [normalizeCpMemoryLimit]);

  const handleEnvelope = useCallback((message: RelayEnvelope) => {
    const { onToolCall: applyTool, onAgentMessage: postAgentMessage } = latestRef.current;

    switch (message.type) {
      case 'relay.joined':
        setIsJoined(true);
        sendSessionSettings();
        setJoinedSessionId(
          typeof message.payload?.sessionId === 'string' && message.payload.sessionId.trim()
            ? message.payload.sessionId.trim()
            : sessionIdRef.current
        );
        return;

      case 'relay.presence': {
        const agentsRaw = Array.isArray(message.payload?.agents) ? message.payload?.agents : [];
        const agents = agentsRaw
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const id = typeof (entry as Record<string, unknown>).id === 'string'
              ? (entry as Record<string, unknown>).id
              : '';
            const name = typeof (entry as Record<string, unknown>).name === 'string'
              ? (entry as Record<string, unknown>).name
              : '';
            if (!id || !name) return null;
            return { id, name };
          })
          .filter((entry): entry is { id: string; name: string } => entry !== null);
        setConnectedAgents(agents);
        setAgentStatuses((prev) => {
          if (agents.length === 0) return {};
          const connectedNames = new Set(agents.map((agent) => agent.name));
          const next = Object.fromEntries(
            Object.entries(prev).filter(([name]) => connectedNames.has(name))
          );
          return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
        if (typeof message.payload?.sessionId === 'string' && message.payload.sessionId.trim()) {
          setJoinedSessionId(message.payload.sessionId.trim());
        }
        // `=== true` because the relay spreads the key in only when a phone is
        // attached — an absent key is false, and that absence is what keeps the
        // presence envelope byte-identical in the study conditions.
        setCompanionActive(message.payload?.companionActive === true);
        return;
      }

      case 'agent.status': {
        const phaseRaw = message.payload?.phase;
        if (phaseRaw !== 'idle' && phaseRaw !== 'planning' && phaseRaw !== 'executing') {
          return;
        }
        const agentName =
          typeof message.payload?.agentName === 'string' && message.payload.agentName.trim()
            ? message.payload.agentName.trim()
            : 'agent';
        setAgentStatusSupported(true);
        setAgentStatuses((prev) =>
          prev[agentName] === phaseRaw ? prev : { ...prev, [agentName]: phaseRaw }
        );
        return;
      }

      case 'agent.memory': {
        const snapshot = parseAgentMemorySnapshot(message.payload);
        if (snapshot) setAgentMemory(snapshot);
        return;
      }

      case 'session.start':
        // Before the reply: the agent requests its snapshot and plans its
        // opening line as soon as `session.started` lands, and the language
        // has to be in place for that first request.
        sendSessionSettings();
        sendEnvelope({
          type: 'session.started',
          replyTo: message.id,
          payload: {
            sessionId: sessionIdRef.current,
          },
        });
        return;

      case 'snapshot.get':
        sendEnvelope({
          type: 'snapshot.state',
          replyTo: message.id,
          payload: getSnapshotPayload() as unknown as Record<string, unknown>,
        });
        return;

      case 'tool.call': {
        const toolName = message.payload?.toolName;
        const params = message.payload?.params;
        const reason =
          typeof message.payload?.reason === 'string' && message.payload.reason.trim()
            ? message.payload.reason.trim()
            : undefined;
        const preferenceIdsRaw = message.payload?.preferenceIds;
        const preferenceIds = Array.isArray(preferenceIdsRaw)
          ? preferenceIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          : [];

        if (typeof toolName !== 'string') {
          sendEnvelope({
            type: 'error',
            replyTo: message.id,
            payload: {
              code: 'INVALID_PARAMS',
              message: 'tool.call requires payload.toolName',
            },
          });
          return;
        }

        /*
          An async IIFE rather than an async `handleEnvelope`: only this one
          case can wait, and the envelopes that could arrive while it does —
          `agent.status`, a `snapshot.get` — neither depend on it nor race it.
          The agent cannot send a second tool call in the meantime; it awaits
          this reply before planning again.
        */
        void (async () => {
          try {
            const result = await applyTool(toolName, (params as Record<string, unknown>) ?? {}, {
              source: 'agent',
              reason,
              ...(preferenceIds.length > 0 ? { preferenceIds } : {}),
            });
            const immediateUiSpec = isUiSpec(result) ? result : undefined;
            sendEnvelope({
              type: 'tool.result',
              replyTo: message.id,
              payload: {
                ok: true,
                toolName,
                ...(immediateUiSpec ? { uiSpec: sanitizeUiSpecForRelay(immediateUiSpec) } : {}),
              },
            });
          } catch (error) {
            sendEnvelope({
              type: 'error',
              replyTo: message.id,
              payload: {
                code: 'TOOL_EXECUTION_FAILED',
                message: error instanceof Error ? error.message : 'Tool execution failed',
              },
            });
          }
        })();
        return;
      }

      case 'agent.message': {
        const text = message.payload?.text;
        // Optional, additive: an agent build that names the tool it is
        // narrating lets the host skip the text classifier. The study build
        // sends nothing here, and an unrecognised value falls through to the
        // classifier rather than failing — so this must stay unvalidated.
        const rawCategory = message.payload?.category;
        if (typeof text !== 'string' || !text.trim()) {
          sendEnvelope({
            type: 'error',
            replyTo: message.id,
            payload: {
              code: 'INVALID_PARAMS',
              message: 'agent.message requires a non-empty payload.text',
            },
          });
          return;
        }
        // Also additive: planner latency and model for the sentence. Shape is
        // checked field by field so a malformed value is dropped, not rendered.
        const rawTiming = message.payload?.timing as { model?: unknown; plannerMs?: unknown } | undefined;
        const timing =
          rawTiming &&
          typeof rawTiming.model === 'string' &&
          typeof rawTiming.plannerMs === 'number' &&
          Number.isFinite(rawTiming.plannerMs)
            ? { model: rawTiming.model, plannerMs: rawTiming.plannerMs }
            : null;
        postAgentMessage(text.trim(), typeof rawCategory === 'string' ? rawCategory : null, timing);
        return;
      }

      case 'companion.hello': {
        onCompanionHelloRef.current?.();
        return;
      }

      case 'companion.claim': {
        onCompanionClaimRef.current?.(message.payload?.claimed === true);
        return;
      }

      case 'relay.devices': {
        const roster = parseDeviceRoster(message.payload);
        // Stamped here, in the receive callback, so the server's durations can
        // keep ageing between frames — and so nothing reads the clock in render.
        if (roster) setDeviceRoster({ roster, atMs: Date.now() });
        return;
      }

      case 'companion.memory.command': {
        // Re-parsed rather than trusted: this crossed a network from a device
        // paired by photographing a QR code.
        const command = parseMemoryCommand(message.payload?.command);
        if (command) onCompanionMemoryCommandRef.current?.(command);
        return;
      }

      case 'companion.transcript': {
        const text = typeof message.payload?.text === 'string' ? message.payload.text : '';
        const durationMs =
          typeof message.payload?.durationMs === 'number' && Number.isFinite(message.payload.durationMs)
            ? message.payload.durationMs
            : 0;
        if (text.trim()) onCompanionTranscriptRef.current?.({ text, durationMs });
        return;
      }

      case 'companion.playback.complete': {
        onCompanionPlaybackCompleteRef.current?.({
          id: typeof message.payload?.id === 'string' ? message.payload.id : null,
          interrupted: message.payload?.interrupted === true,
        });
        return;
      }

      case 'session.end':
        // Intentionally ignore session.end from agent on host side.
        return;

      default:
        return;
    }
  }, [getSnapshotPayload, sendEnvelope, sendSessionSettings]);

  useEffect(() => {
    if (!enabled) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const ws = wsRef.current;
      if (ws && ws.readyState < WebSocket.CLOSING) {
        ws.close(1000, 'host-connection-disabled');
      }
      wsRef.current = null;
      setAgentStatuses({});
      setAgentStatusSupported(false);
      setAgentMemory(null);
      setDeviceRoster(null);
      return;
    }

    let disposed = false;
    let currentWs: WebSocket | null = null;

    const connect = () => {
      if (disposed || !enabled) return;

      const ws = new WebSocket(wsUrl);
      currentWs = ws;
      wsRef.current = ws;
      setIsJoined(false);

      ws.onopen = () => {
        if (disposed) return;
        setIsConnected(true);
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'relay.join',
            payload: {
              role: 'host',
              sessionId: sessionIdRef.current,
              ...(studyTokenRef.current ? { studyToken: studyTokenRef.current } : {}),
            },
          })
        );
      };

      ws.onmessage = (event) => {
        const envelope = parseEnvelope(event);
        if (!envelope) return;
        handleEnvelope(envelope);
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsJoined(false);
        setJoinedSessionId(null);
        setConnectedAgents([]);
        setAgentStatuses({});
        setAgentStatusSupported(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }

        if (!disposed && enabled) {
          reconnectTimerRef.current = window.setTimeout(connect, 1200);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (currentWs && currentWs.readyState < WebSocket.CLOSING) {
        currentWs.close();
      }
    };
  }, [enabled, handleEnvelope, sessionId, studyToken, wsUrl]);

  useEffect(() => {
    if (!isJoined) return;

    sendEnvelope({
      type: 'state.updated',
      payload: {
        source: 'host',
        uiSpec: sanitizeUiSpecForRelay(latestRef.current.uiSpec),
        messageHistory: latestRef.current.messageHistory,
        toolSchema: latestRef.current.toolSchema,
        plannerCpMemoryLimit: normalizeCpMemoryLimit(latestRef.current.plannerCpMemoryLimit),
        guiAdaptationEnabled: latestRef.current.guiAdaptationEnabled !== false,
        ...(latestRef.current.narrateAdaptations ? { narrateAdaptations: true } : {}),
        /*
          Sent as a plain boolean, not spread-when-true like the flags above.

          Voice can be turned off mid-session, and `perception.ts` reads an
          absent field on a state update as "unchanged" — deliberately, so a
          partial update cannot silence a card. Spreading only the true case
          would therefore latch this on for the rest of the session. The
          snapshot above keeps the spread, because there "absent" is read as
          false and a study session's snapshot stays as it was.
        */
        spokenBrevity: latestRef.current.spokenBrevity === true,
      },
    });
  }, [
    isJoined,
    uiSpec,
    messageHistory,
    toolSchema,
    plannerCpMemoryLimit,
    guiAdaptationEnabled,
    narrateAdaptations,
    spokenBrevity,
    sendEnvelope,
    normalizeCpMemoryLimit,
  ]);

  const sendUserMessageToAgent = useCallback(
    (text: string, stage: Stage) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      sendEnvelope({
        type: 'user.message',
        payload: {
          text: trimmed,
          stage,
        },
      });
    },
    [sendEnvelope]
  );

  const sendSessionResetToAgent = useCallback(
    (reason = 'host-manual-reset') => {
      sendEnvelope({
        type: 'session.reset',
        payload: { reason },
      });
    },
    [sendEnvelope]
  );

  const sendVoiceModeChange = useCallback(
    (enabled: boolean) => {
      sendEnvelope({ type: 'voice.mode', payload: { enabled } });
    },
    [sendEnvelope]
  );

  const sendConversationLanguage = useCallback(
    (language: string) => {
      sendEnvelope({ type: 'conversation.language', payload: { language } });
    },
    [sendEnvelope]
  );

  const sendPlannerModel = useCallback(
    (model: string | null) => {
      sendEnvelope({ type: 'planner.model', payload: { model: model ?? '' } });
    },
    [sendEnvelope]
  );

  const sendPreferenceDelete = useCallback(
    (preferenceId: string) => {
      const trimmed = preferenceId.trim();
      if (!trimmed) return false;
      return sendEnvelope({
        type: 'memory.preference.delete',
        payload: { preferenceId: trimmed },
      });
    },
    [sendEnvelope]
  );

  const sendPreferenceRestore = useCallback(
    (preferenceId: string) => {
      const trimmed = preferenceId.trim();
      if (!trimmed) return false;
      return sendEnvelope({
        type: 'memory.preference.restore',
        payload: { preferenceId: trimmed },
      });
    },
    [sendEnvelope]
  );

  const sendPreferenceClear = useCallback(
    () => sendEnvelope({ type: 'memory.preference.clear', payload: {} }),
    [sendEnvelope]
  );

  const sendPreferenceProfileLoad = useCallback(
    (profile: PreferenceProfilePayload) =>
      sendEnvelope({ type: 'memory.profile.load', payload: { preferenceProfile: profile } }),
    [sendEnvelope]
  );

  const sendCompanionSpeak = useCallback(
    (item: { id: string | null; text: string; stop?: boolean }) => {
      sendEnvelope({ type: 'companion.speak', payload: { ...item } });
    },
    [sendEnvelope]
  );

  const sendCompanionConfig = useCallback(
    (config: { language: string; transcriptionPrompt: string | null; listening: boolean }) => {
      sendEnvelope({ type: 'companion.config', payload: { ...config } });
    },
    [sendEnvelope]
  );

  const sendTtsPlaybackComplete = useCallback(
    (info?: { interrupted?: boolean; messageId?: string | null }) => {
      sendEnvelope({
        type: 'tts.playback.complete',
        payload: {
          interrupted: info?.interrupted ?? false,
          ...(info?.messageId ? { messageId: info.messageId } : {}),
        },
      });
    },
    [sendEnvelope]
  );

  const agentActivityPhase = useMemo<AgentActivityPhase>(() => {
    const connectedNames = new Set(connectedAgents.map((agent) => agent.name));
    const relevantPhases =
      connectedNames.size > 0
        ? Object.entries(agentStatuses)
            .filter(([name]) => connectedNames.has(name))
            .map(([, phase]) => phase)
        : Object.values(agentStatuses);

    if (relevantPhases.includes('executing')) {
      return 'executing';
    }
    if (relevantPhases.includes('planning')) {
      return 'planning';
    }
    return 'idle';
  }, [agentStatuses, connectedAgents]);

  return {
    sendUserMessageToAgent,
    sendSessionResetToAgent,
    sendVoiceModeChange,
    sendConversationLanguage,
    sendPlannerModel,
    sendPreferenceDelete,
    sendPreferenceRestore,
    sendPreferenceClear,
    sendPreferenceProfileLoad,
    sendTtsPlaybackComplete,
    sendCompanionSpeak,
    sendCompanionConfig,
    companionActive,
    isConnected,
    isJoined,
    joinedSessionId,
    connectedAgents,
    agentActivityPhase,
    agentStatusSupported,
    agentMemory,
    deviceRoster,
  };
}
