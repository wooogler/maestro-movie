import { useLanguage } from '../../i18n';

export function AgentActivityOverlay() {
  const { s } = useLanguage();
  return (
    <div
      className="pointer-events-none inline-flex items-center gap-2 px-2 py-1 text-xs font-medium text-info-label [text-shadow:0_1px_6px_rgba(2,6,23,0.28)]"
      role="status"
      aria-live="polite"
      aria-label={s.agentWorking}
    >
      <span>{s.agentWorking}</span>
      <div className="flex items-center gap-1 text-info-label/75" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot typing-dot-delay-1" />
        <span className="typing-dot typing-dot-delay-2" />
      </div>
    </div>
  );
}
