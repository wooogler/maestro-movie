import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentMemorySnapshot } from '../agent/protocol';
import {
  AgentMemoryPanel,
  createMemoryCommander,
  subscribeToMemory,
  useMemoryViewer,
} from '../components/memory';
import { PREFERENCE_PRESETS, localizePreset } from '../study/preferenceProfile';
import { useLanguage } from '../i18n';

/**
 * Second-screen view of the agent's memory. Two ways to reach it, and which one
 * is in play depends on whether the URL carries a view token.
 *
 * **With a token** (`/demo/memory#<viewToken>`, normally reached by scanning the
 * QR in the booking window) it joins the relay as a read-only viewer. This is
 * the cross-device path: laptop books, phone watches.
 *
 * **Without one** it listens on a BroadcastChannel, which only reaches windows
 * in the same browser on the same machine. That is the booth's other setup — a
 * laptop with an HDMI display — and it is kept because it needs no backend, no
 * token and no network, so it survives a flaky conference wifi.
 *
 * Only the second of those can change anything, and it does so by ASKING the
 * booking window rather than by writing itself. The difference is not a policy
 * choice: BroadcastChannel reaches one other window on the operator's own
 * machine, where whoever has it can already drive the booking UI directly,
 * whereas the token path is a stranger's phone that scanned a QR off a table.
 * The relay enforces the same line — a viewer connection is refused on any
 * outbound frame at all.
 */
/** Shared empty set, so an unchanged render keeps the same reference. */
const EMPTY_PENDING: ReadonlySet<string> = new Set();

export function DemoMemoryMirrorPage() {
  const { s, language } = useLanguage();
  const [viewToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.location.hash.replace(/^#/, '').trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  });

  const viewer = useMemoryViewer(viewToken);

  const [channelSnapshot, setChannelSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [channelStage, setChannelStage] = useState<string | null>(null);

  useEffect(() => {
    // Only one source at a time: a paired phone must not also react to a
    // BroadcastChannel from some other tab on its own device.
    if (viewToken) return;
    return subscribeToMemory((nextSnapshot, nextStage) => {
      setChannelSnapshot(nextSnapshot);
      setChannelStage(nextStage);
    });
  }, [viewToken]);

  const snapshot = viewToken ? viewer.snapshot : channelSnapshot;
  const stage = viewToken ? viewer.stage : channelStage;

  /*
    Controls exist only on the same-machine mirror. `createMemoryCommander`
    reports whether this browser has BroadcastChannel at all, so a browser
    without it gets no buttons rather than buttons that quietly do nothing.
  */
  const commander = useMemo(() => (viewToken ? null : createMemoryCommander()), [viewToken]);
  useEffect(() => () => commander?.close(), [commander]);
  const canCommand = commander?.available === true;

  /*
    Which controls are waiting on an answer.

    Tied to the snapshot they were issued against and resolved during render
    rather than cleared from an effect — the booking window force-publishes
    after every removal, restore and load, so a newer snapshot IS the answer,
    and an effect would only add a second render pass to say what the first one
    already knew.
  */
  const [pending, setPending] = useState<{ snapshot: AgentMemorySnapshot | null; ids: ReadonlySet<string> }>(
    () => ({ snapshot: null, ids: EMPTY_PENDING })
  );
  const pendingIds = pending.snapshot === snapshot ? pending.ids : EMPTY_PENDING;

  const command = useCallback(
    (preferenceId: string, kind: 'preference.delete' | 'preference.restore') => {
      if (!commander?.send({ kind, preferenceId })) return;
      setPending((current) => ({
        snapshot,
        ids: new Set(current.snapshot === snapshot ? current.ids : []).add(preferenceId),
      }));
    },
    [commander, snapshot]
  );

  const handleDelete = useCallback(
    (preferenceId: string) => command(preferenceId, 'preference.delete'),
    [command]
  );
  const handleRestore = useCallback(
    (preferenceId: string) => command(preferenceId, 'preference.restore'),
    [command]
  );

  const notice = (() => {
    if (snapshot) return null;
    if (!viewToken) return s.mirrorWaiting;
    if (viewer.status === 'error') return viewer.message ?? s.mirrorEnded;
    if (viewer.status === 'ended') return s.mirrorEnded;
    return s.mirrorWaiting;
  })();

  return (
    <div className="h-full overflow-y-auto bg-dark px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 text-lg font-semibold text-fg-strong sm:text-xl">{s.mirrorTitle}</h1>
        {notice ? (
          <p className="mb-4 rounded-lg border border-dashed border-dark-border px-4 py-3 text-sm text-fg-muted">
            {notice}
          </p>
        ) : null}
        {/*
          `showHeading={false}` because the h1 above is the same sentence. The
          panel's own heading is hardcoded English, so on this page in Korean the
          phone showed the localized title followed by the English one.
        */}
        <AgentMemoryPanel
          snapshot={snapshot}
          currentStage={stage}
          variant="mirror"
          showHeading={false}
          {...(canCommand
            ? {
                onPreferenceDelete: handleDelete,
                onPreferenceRestore: handleRestore,
                onPreferenceClearAll: () => {
                  commander?.send({ kind: 'preference.clear' });
                },
                pendingPreferenceIds: pendingIds,
              }
            : {})}
        />

        {/*
          Collapsed, because this screen is usually pointed at a room. The
          operator opens it to re-arm the demo for the next visitor without
          walking back to the laptop; the audience sees the memory, not a
          control panel.
        */}
        {canCommand && (
          <details className="mt-6 rounded-lg border border-dark-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold text-fg-muted">
              {s.preferenceMemoryTitle}
            </summary>
            <div className="mt-3 grid gap-2">
              {PREFERENCE_PRESETS.map((raw) => localizePreset(raw, language)).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => commander?.send({ kind: 'profile.load', presetId: preset.id })}
                  className="rounded-lg border border-dark-border px-3 py-2 text-left transition-colors hover:border-primary"
                >
                  <span className="block text-sm font-semibold text-fg-strong">{preset.label}</span>
                  <span className="mt-0.5 block text-xs text-fg-muted">{preset.blurb}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
