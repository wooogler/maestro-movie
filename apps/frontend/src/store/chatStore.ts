import { create } from 'zustand';
import type { Stage, UISpec } from '../spec';
import type { AgentMessageVoiceMeta } from '../voice';

// =============================================================================
// Message Types
// =============================================================================

interface BaseMessage {
  id: string;
  timestamp: number;
  stage: Stage;
}

export interface SystemMessageAnnotation {
  kind: 'tool-modification';
  toolName: string;
  reason: string;
  source: 'agent' | 'devtools';
}

export interface AgentMessageActionTag {
  toolName: 'next' | 'prev';
  reason: string;
  source: 'agent' | 'devtools';
}

export interface SystemMessage extends BaseMessage {
  type: 'system';
  spec: UISpec;
  annotation?: SystemMessageAnnotation;
}

export interface UserMessage extends BaseMessage {
  type: 'user';
  action: 'select' | 'back' | 'input';
  label: string;
  inputSource?: 'text' | 'voice';
}

/**
 * How long the planner took to produce this sentence, and on which model.
 * Demo only: the agent sends it for every LLM-decided message, but the host
 * stores it only where a visitor is allowed to switch models and so has a
 * reason to compare them.
 */
export interface AgentMessageTiming {
  model: string;
  plannerMs: number;
}

export interface AgentMessage extends BaseMessage {
  type: 'agent';
  text: string;
  actionTag?: AgentMessageActionTag;
  timing?: AgentMessageTiming;
  /**
   * What the voice verbosity gate decided for this message. Absent in text
   * mode, where nothing is spoken and nothing is gated.
   */
  voice?: AgentMessageVoiceMeta;
}

export type ChatMessage = SystemMessage | UserMessage | AgentMessage;

// =============================================================================
// Store State & Actions
// =============================================================================

interface ChatState {
  messages: ChatMessage[];
  messageSnapshots: Record<string, UISpec>;
  stageSnapshots: Partial<Record<Stage, UISpec>>;
  currentStage: Stage;
  activeSpec: UISpec | null;
}

interface ChatActions {
  /** Add a new system message with stage spec */
  addSystemMessage: (stage: Stage, spec: UISpec, annotation?: SystemMessageAnnotation) => void;

  /** Add user message (selection/back/input) */
  addUserMessage: (
    stage: Stage,
    action: 'select' | 'back' | 'input',
    label: string,
    specSnapshot?: UISpec | null,
    inputSource?: 'text' | 'voice'
  ) => void;

  /** Add agent explanation message */
  addAgentMessage: (
    stage: Stage,
    text: string,
    specSnapshot?: UISpec | null,
    voice?: AgentMessageVoiceMeta,
    timing?: AgentMessageTiming | null
  ) => string;

  /** Attach tool-action tag to the latest agent message in the stage */
  annotateLastAgentMessage: (stage: Stage, actionTag: AgentMessageActionTag) => void;

  /** Update the active spec (for selections/modifications) */
  updateActiveSpec: (spec: UISpec) => void;

  /**
   * Rewrite the active spec AND every stage snapshot with the same transform.
   *
   * Both halves are required. `updateActiveSpec` only ever writes the snapshot
   * for the spec's own stage, so a change applied to the active spec alone is
   * reinstated by `restoreStageSnapshot` the next time the visitor steps back
   * and forward — which, for an un-applied filter, means it silently comes back.
   */
  transformSpecs: (transform: (spec: UISpec) => UISpec) => void;

  /** Set current stage */
  setCurrentStage: (stage: Stage) => void;

  /** Reset chat to initial state */
  reset: () => void;
}

// =============================================================================
// Stage Order
// =============================================================================

export const STAGE_ORDER: Stage[] = [
  'movie',
  'theater',
  'date',
  'time',
  'seat',
  'confirm',
];

export function getNextStage(current: Stage): Stage | null {
  const index = STAGE_ORDER.indexOf(current);
  if (index === -1 || index === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1];
}

export function getPrevStage(current: Stage): Stage | null {
  const index = STAGE_ORDER.indexOf(current);
  if (index <= 0) return null;
  return STAGE_ORDER[index - 1];
}

// =============================================================================
// Store
// =============================================================================

const initialState: ChatState = {
  messages: [],
  messageSnapshots: {},
  stageSnapshots: {},
  currentStage: 'movie',
  activeSpec: null,
};

function cloneSpecSnapshot(spec: UISpec | null | undefined): UISpec | undefined {
  if (!spec) return undefined;
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(spec) as UISpec;
  }
  return JSON.parse(JSON.stringify(spec)) as UISpec;
}

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...initialState,

  addSystemMessage: (stage, spec, annotation) => {
    const frozenSpec = cloneSpecSnapshot(spec) ?? spec;
    const message: SystemMessage = {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'system',
      timestamp: Date.now(),
      stage,
      spec: frozenSpec,
      annotation,
    };

    set((state) => ({
      messages: [...state.messages, message],
      stageSnapshots: {
        ...state.stageSnapshots,
        [stage]: cloneSpecSnapshot(spec) ?? spec,
      },
      currentStage: stage,
      activeSpec: spec,
    }));
  },

  addUserMessage: (stage, action, label, specSnapshot, inputSource) => {
    const message: UserMessage = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'user',
      timestamp: Date.now(),
      stage,
      action,
      label,
      ...(action === 'input' && inputSource ? { inputSource } : {}),
    };
    const clonedSnapshot = cloneSpecSnapshot(specSnapshot);

    set((state) => ({
      messages: [...state.messages, message],
      messageSnapshots: clonedSnapshot
        ? { ...state.messageSnapshots, [message.id]: clonedSnapshot }
        : state.messageSnapshots,
    }));
  },

  addAgentMessage: (stage, text, specSnapshot, voice, timing) => {
    const message: AgentMessage = {
      id: `agt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'agent',
      timestamp: Date.now(),
      stage,
      text,
      ...(voice ? { voice } : {}),
      ...(timing ? { timing } : {}),
    };
    const clonedSnapshot = cloneSpecSnapshot(specSnapshot);

    set((state) => ({
      messages: [...state.messages, message],
      messageSnapshots: clonedSnapshot
        ? { ...state.messageSnapshots, [message.id]: clonedSnapshot }
        : state.messageSnapshots,
    }));

    return message.id;
  },

  annotateLastAgentMessage: (stage, actionTag) => {
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.type === 'agent' && message.stage === stage) {
          messages[i] = { ...message, actionTag };
          break;
        }
      }
      return { messages };
    });
  },

  updateActiveSpec: (spec) => {
    set((state) => {
      const stage = spec.stage;
      return {
        activeSpec: spec,
        stageSnapshots: {
          ...state.stageSnapshots,
          [stage]: cloneSpecSnapshot(spec) ?? spec,
        },
      };
    });
  },

  transformSpecs: (transform) => {
    set((state) => {
      const stageSnapshots: Partial<Record<Stage, UISpec>> = {};
      for (const [stage, spec] of Object.entries(state.stageSnapshots)) {
        if (spec) stageSnapshots[stage as Stage] = transform(spec);
      }
      return {
        activeSpec: state.activeSpec ? transform(state.activeSpec) : state.activeSpec,
        stageSnapshots,
      };
    });
  },

  setCurrentStage: (stage) => set({ currentStage: stage }),

  reset: () => set(initialState),
}));
