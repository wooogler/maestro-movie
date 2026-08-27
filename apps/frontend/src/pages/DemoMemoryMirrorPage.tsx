import { useEffect, useState } from 'react';
import type { AgentMemorySnapshot } from '../agent/protocol';
import { AgentMemoryPanel, subscribeToMemory } from '../components/memory';

/**
 * Second-screen view for the demo booth. Open it in a separate window, drag it
 * onto the big display, and it mirrors whatever the booking window's agent is
 * remembering. It holds no relay connection of its own — the relay allows a
 * single host per session.
 */
export function DemoMemoryMirrorPage() {
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeToMemory((nextSnapshot, nextStage) => {
        setSnapshot(nextSnapshot);
        setStage(nextStage);
      }),
    []
  );

  return (
    <div className="min-h-screen bg-dark px-8 py-6">
      <div className="mx-auto max-w-3xl">
        {!snapshot && (
          <p className="mb-4 rounded-lg border border-dashed border-dark-border px-4 py-3 text-sm text-fg-muted">
            Waiting for the booking window on this machine. Start a demo session there and this
            screen will follow along.
          </p>
        )}
        <AgentMemoryPanel snapshot={snapshot} currentStage={stage} variant="mirror" />
      </div>
    </div>
  );
}
