import { useEffect, useState } from 'react';
import { useLanguage } from '../../i18n';

/**
 * Mounted only while the agent is working, so the clock starts at mount. It
 * ticks every 100 ms but renders tenths; the point is that the number is
 * visibly moving, which is what makes a slow model's turn feel slow instead of
 * looking frozen. Shown only when `showElapsed` is set (the demo), because a
 * study participant should not be timing the agent.
 */
function ElapsedSeconds() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums text-info-label/85" aria-hidden="true">
      {((now - startedAt) / 1000).toFixed(1)}s
    </span>
  );
}

export function AgentActivityOverlay({ showElapsed = false }: { showElapsed?: boolean } = {}) {
  const { s } = useLanguage();
  return (
    <div
      className="pointer-events-none inline-flex items-center gap-2 px-2 py-1 text-xs font-medium text-info-label [text-shadow:0_1px_6px_rgba(2,6,23,0.28)]"
      role="status"
      aria-live="polite"
      aria-label={s.agentWorking}
    >
      <span>{s.agentWorking}</span>
      {showElapsed ? <ElapsedSeconds /> : null}
      <div className="flex items-center gap-1 text-info-label/75" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot typing-dot-delay-1" />
        <span className="typing-dot typing-dot-delay-2" />
      </div>
    </div>
  );
}
