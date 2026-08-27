import { parseAgentMemorySnapshot, type AgentMemorySnapshot } from '../../agent/protocol';

/**
 * Cross-window bridge for the booth setup: the visitor drives the booking UI on
 * one window while a second window — dragged onto the big screen — mirrors the
 * agent's memory.
 *
 * BroadcastChannel keeps this to zero backend work, at the cost of only reaching
 * windows in the same browser on the same machine. That is exactly the booth
 * setup (laptop plus an HDMI second display). Mirroring onto a separate device
 * would need a viewer role in the relay instead.
 */
const CHANNEL_NAME = 'maestro-demo-memory';

interface MemoryChannelMessage {
  type: 'memory';
  snapshot: AgentMemorySnapshot;
  stage: string | null;
}

function openChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') {
    return null;
  }
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

export function createMemoryPublisher(): {
  publish: (snapshot: AgentMemorySnapshot | null, stage: string | null) => void;
  close: () => void;
} {
  const channel = openChannel();
  return {
    publish: (snapshot, stage) => {
      if (!channel || !snapshot) return;
      try {
        channel.postMessage({ type: 'memory', snapshot, stage } satisfies MemoryChannelMessage);
      } catch {
        // A structured-clone failure must not break the booking UI.
      }
    },
    close: () => channel?.close(),
  };
}

export function subscribeToMemory(
  onMessage: (snapshot: AgentMemorySnapshot, stage: string | null) => void
): () => void {
  const channel = openChannel();
  if (!channel) return () => {};

  const handler = (event: MessageEvent) => {
    const data = event.data as Partial<MemoryChannelMessage> | null;
    if (!data || data.type !== 'memory') return;
    const snapshot = parseAgentMemorySnapshot(data.snapshot);
    if (!snapshot) return;
    onMessage(snapshot, typeof data.stage === 'string' ? data.stage : null);
  };

  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
