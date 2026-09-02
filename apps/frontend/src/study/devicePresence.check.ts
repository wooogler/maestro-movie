/**
 * Checks the rule that decides whether a presenter is told a phone is gone.
 *
 * This exists because the failure it guards is invisible in a screenshot and
 * expensive at a booth: an indicator that flashes "disconnected" during a
 * routine 1200ms reconnect trains the presenter to ignore it, and one that
 * stays green for a phone in a pocket sends them debugging the agent instead.
 *
 * Run with `npm run check:devices`.
 */
import {
  DEVICE_HEARTBEAT_STALE_MS,
  DEVICE_PRESENCE_GRACE_MS,
  describeDevicePresence,
  type DevicePresenceInput,
  type DeviceRoster,
} from './devicePresence';

let failures = 0;

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const NOW = 1_000_000;

const withCompanion = (lastSeenAgoMs: number | null, attachCount = 1): DeviceRoster => ({
  kioskActive: true,
  agentCount: 1,
  agents: [{ id: 'a1', name: 'agent-1' }],
  viewerCount: 0,
  companionAttachCount: attachCount,
  companionMissingForMs: null,
  companion: { lastSeenAgoMs },
});

const withoutCompanion = (missingForMs: number | null, attachCount = 1): DeviceRoster => ({
  kioskActive: true,
  agentCount: 1,
  agents: [{ id: 'a1', name: 'agent-1' }],
  viewerCount: 0,
  companionAttachCount: attachCount,
  companionMissingForMs: missingForMs,
  companion: null,
});

const base = (over: Partial<DevicePresenceInput> = {}): DevicePresenceInput => ({
  pairable: true,
  linked: true,
  endedMessage: null,
  rosterAtMs: NOW,
  roster: withCompanion(0),
  nowMs: NOW,
  ...over,
});

section('1. NOTHING TO SAY — the states that are not faults');
{
  check('no pairing at all is not a device problem', describeDevicePresence(base({ pairable: false })).kind === 'unavailable');

  check(
    'a phone that never attached is waiting, not dropped',
    describeDevicePresence(base({ roster: withoutCompanion(null, 0) })).kind === 'waiting'
  );

  // The single most important rule here. Our own socket being down says nothing
  // whatsoever about the phone, and saying "disconnected" then is a lie.
  const blind = describeDevicePresence(
    base({ linked: false, roster: withoutCompanion(60_000) })
  );
  check('our own link being down never reports the phone as dropped', blind.kind === 'checking');
  check('...and says so as link-down', blind.kind === 'checking' && blind.reason === 'link-down');

  const noRoster = describeDevicePresence(base({ roster: null, rosterAtMs: null }));
  check('connected but nothing heard yet is checking', noRoster.kind === 'checking');
  check('...as no-roster-yet', noRoster.kind === 'checking' && noRoster.reason === 'no-roster-yet');

  const ended = describeDevicePresence(base({ endedMessage: 'The session has ended.' }));
  check('a refused session reports itself, not the phone', ended.kind === 'ended');
}

section('2. THE RECONNECT WINDOW — a truthful negative that is still too early');
{
  // With no agent socket present a host disconnect tears the session down and
  // force-closes the phone; the host returns first, so a real roster briefly
  // and correctly says "no phone" about a phone that is coming back.
  const justGone = describeDevicePresence(
    base({ roster: withoutCompanion(500) })
  );
  check('a phone missing for 500ms is not yet dropped', justGone.kind === 'checking');
  check('...and names the grace window', justGone.kind === 'checking' && justGone.reason === 'grace');

  const atBoundary = describeDevicePresence(
    base({ roster: withoutCompanion(DEVICE_PRESENCE_GRACE_MS) })
  );
  check('at exactly the grace boundary it is a drop', atBoundary.kind === 'dropped');

  const gone = describeDevicePresence(
    base({ roster: withoutCompanion(30_000) })
  );
  check('a phone missing for 30s is dropped', gone.kind === 'dropped');
  check('...because it left', gone.kind === 'dropped' && gone.reason === 'left');
  check('and it reports how long', gone.kind === 'dropped' && gone.forMs === 30_000);
}

section('3. THE OPEN SOCKET THAT LIES — a locked phone still holds its connection');
{
  check('a phone heard from just now is attached', describeDevicePresence(base()).kind === 'attached');

  const beating = describeDevicePresence(base({ roster: withCompanion(2_500) }));
  check('one missed heartbeat is still attached', beating.kind === 'attached');

  // The socket is open the whole time here; only the page has stopped.
  const silent = describeDevicePresence(base({ roster: withCompanion(DEVICE_HEARTBEAT_STALE_MS) }));
  check('a silent phone is dropped even with its socket open', silent.kind === 'dropped');
  check('...and is distinguished from having left', silent.kind === 'dropped' && silent.reason === 'silent');

  // Silence accumulates across both hops: what the server had already counted,
  // plus however long since that roster reached us. Otherwise a roster that
  // stops arriving freezes the age and the phone looks permanently fresh.
  const aging = describeDevicePresence(
    base({ roster: withCompanion(5_000), rosterAtMs: NOW - 5_000 })
  );
  check('silence keeps counting after the roster stops arriving', aging.kind === 'dropped');

  check(
    'a null last-seen is not treated as infinitely stale',
    describeDevicePresence(base({ roster: withCompanion(null) })).kind === 'attached'
  );
}

section('4. NO LOCAL HISTORY — a page that just loaded still knows');
{
  // The point of carrying the history in the payload: a screen whose socket
  // reconnected a second ago must not restart the clock at zero and report a
  // long-gone phone as "just now".
  const freshPage = describeDevicePresence(base({ roster: withoutCompanion(45_000), rosterAtMs: NOW }));
  check('a freshly attached watcher still reports the full outage', freshPage.kind === 'dropped');
  check('...with the server\'s duration, not its own', freshPage.kind === 'dropped' && freshPage.forMs === 45_000);
  check(
    'and it knows a phone was once there',
    freshPage.kind === 'dropped' && freshPage.attachCount === 1
  );
}

section('5. A SWAPPED PHONE — visible under an otherwise flat "attached"');
{
  const swapped = describeDevicePresence(base({ roster: withCompanion(0, 2) }));
  check('the attach count rides along', swapped.kind === 'attached' && swapped.attachCount === 2);
}

if (failures > 0) {
  console.error(`\n${failures} device-presence check(s) failed.`);
  process.exit(1);
}
console.log('\nAll device-presence checks passed.');
