import { useLanguage } from '../../i18n';
import type { DeviceRosterPayload } from '../../agent/protocol';
import type { DevicePresenceStatus } from '../../study/devicePresence';

/**
 * Who is attached to this session, for whoever is running the booth.
 *
 * Deliberately a fixed roster of named roles rather than a list of devices.
 * There is no device identity anywhere in the relay to list — a client is
 * `{id, role, sessionId, clientName, socket}` and `clientName` is resolved for
 * the agent role alone. The only way to make a literal list would be to render
 * something like a user-agent string, which is a fingerprint, on a kiosk screen
 * in a public room. Naming the roles says the true thing instead.
 *
 * The one number worth showing is how many watching screens are attached, and
 * how many times a phone has attached: a swap is invisible under a flat
 * "connected", and at a booth it is exactly the event that explains why the
 * microphone stopped working for the person still holding the first phone.
 */
export function DeviceRosterCard({
  roster,
  phone,
  compact = false,
}: {
  roster: DeviceRosterPayload | null;
  /** The phone's verdict, which is the only one that needs a state machine. */
  phone: DevicePresenceStatus;
  /** Tighter type, for the booking rail. */
  compact?: boolean;
}) {
  const { s } = useLanguage();

  if (phone.kind === 'unavailable') return null;

  const phoneLabel = (() => {
    switch (phone.kind) {
      case 'ended':
        return s.deviceNotConnected;
      case 'waiting':
        return s.deviceWaiting;
      case 'attached':
        return phone.attachCount > 1 ? s.deviceSwapped : s.deviceConnected;
      case 'checking':
        return s.deviceChecking;
      case 'dropped':
        return phone.reason === 'silent' ? s.deviceDroppedSilent : s.deviceDropped;
      default:
        return s.deviceNotConnected;
    }
  })();

  /*
    "Checking" is amber, never red.

    It covers our own socket being between reconnect attempts and the few
    seconds after a phone vanishes but before its own reconnect ladder has had a
    chance to finish. Painting either of those red would put a fault on screen
    during the most ordinary thing that happens all evening, and a presenter who
    learns to ignore the red dot has lost the indicator entirely.
  */
  const phoneTone =
    phone.kind === 'attached'
      ? 'good'
      : phone.kind === 'dropped'
        ? 'bad'
        : phone.kind === 'checking'
          ? 'wait'
          : 'idle';

  return (
    <div className={`rounded-xl border border-dark-border bg-dark ${compact ? 'p-2.5' : 'p-3'}`}>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {s.devicesTitle}
      </div>
      <ul className="space-y-1.5">
        <DeviceRow
          label={s.devicePhone}
          value={phoneLabel}
          tone={phoneTone}
          detail={
            phone.kind === 'dropped' && phone.forMs >= 1000
              ? formatAgo(phone.forMs)
              : phone.kind === 'attached' && phone.attachCount > 1
                ? `×${phone.attachCount}`
                : null
          }
        />
        <DeviceRow
          label={s.deviceKiosk}
          value={roster?.kioskActive ? s.deviceConnected : s.deviceNotConnected}
          tone={roster?.kioskActive ? 'good' : 'idle'}
        />
        <DeviceRow
          label={s.deviceAgent}
          value={
            roster && roster.agentCount > 0
              ? (roster.agents[0]?.name ?? s.deviceConnected)
              : s.deviceNotConnected
          }
          tone={roster && roster.agentCount > 0 ? 'good' : 'idle'}
          detail={roster && roster.agentCount > 1 ? `×${roster.agentCount}` : null}
        />
        {roster && roster.viewerCount > 0 ? (
          <DeviceRow
            label={s.deviceScreens}
            value={String(roster.viewerCount)}
            tone="idle"
          />
        ) : null}
      </ul>
    </div>
  );
}

function DeviceRow({
  label,
  value,
  tone,
  detail = null,
}: {
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'wait' | 'idle';
  detail?: string | null;
}) {
  const dot =
    tone === 'good'
      ? 'bg-primary'
      : tone === 'bad'
        ? 'bg-danger'
        : tone === 'wait'
          ? 'bg-accent'
          : 'bg-fg-faint';

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        {/* A shape as well as a colour: the row must survive being read from a
            metre away, and by someone who cannot separate the two hues. */}
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="truncate text-fg-muted">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="font-medium text-fg-strong">{value}</span>
        {detail ? <span className="text-xs text-fg-faint">{detail}</span> : null}
      </span>
    </li>
  );
}

function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
