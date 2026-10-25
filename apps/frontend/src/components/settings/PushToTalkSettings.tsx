/**
 * The booth's push-to-talk switch, the key it listens for, and a test light.
 *
 * The light is a second listener on the same key, so the presenter can check a
 * headset button or a remapped HID key before any visitor arrives — on the
 * setup screen as well, where no voice session exists yet. In a session the
 * voice hook's own listener fires too, so holding the key here also opens the
 * mic: what lights up is exactly what talks.
 *
 * "Press a key to choose" records the next key's `KeyboardEvent.code`, which
 * is how an F13 from a custom button gets picked without knowing its name.
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '../../i18n';
import { usePushToTalk, usePushToTalkSetting } from '../../hooks/usePushToTalk';
import { PTT_KEY_PRESETS, normalizePttKeyCode } from '../../voice/pushToTalk';

export function PushToTalkSettings() {
  const { s } = useLanguage();
  const setting = usePushToTalkSetting();
  const { setCode } = setting;
  const [capturing, setCapturing] = useState(false);
  const [draft, setDraft] = useState(setting.code);
  const { held } = usePushToTalk({ enabled: setting.enabled && !capturing, code: setting.code });

  useEffect(() => setDraft(setting.code), [setting.code]);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Ahead of the sheet's own Escape handler and of anything focused.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code !== 'Escape' && event.code) setCode(event.code);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, setCode]);

  const commitDraft = () => {
    const normalized = normalizePttKeyCode(draft);
    setting.setCode(normalized);
    setDraft(normalized);
  };

  return (
    <section className="mb-6">
      <button
        type="button"
        role="switch"
        aria-checked={setting.enabled}
        data-testid="ptt-toggle"
        onClick={() => setting.setEnabled(!setting.enabled)}
        className={`flex w-full items-start justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
          setting.enabled
            ? 'border-primary/60 bg-primary/10'
            : 'border-dark-border bg-dark hover:border-primary'
        }`}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-fg-strong">{s.pushToTalkLabel}</span>
          <span className="mt-0.5 block text-xs text-fg-muted">{s.pushToTalkHint}</span>
        </span>
        <span
          className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
            setting.enabled ? 'bg-primary' : 'bg-dark-lighter'
          }`}
        >
          <span
            className={`h-4 w-4 rounded-full bg-white transition-transform ${
              setting.enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
      </button>

      {setting.enabled ? (
        <div className="mt-3 space-y-3 rounded-xl border border-dark-border bg-dark px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {s.pushToTalkKeyLabel}
          </div>
          <div role="radiogroup" aria-label={s.pushToTalkKeyLabel} className="grid grid-cols-4 gap-2">
            {PTT_KEY_PRESETS.map((code) => {
              const selected = setting.code === code;
              return (
                <button
                  key={code}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setting.setCode(code)}
                  className={`rounded-lg border px-2 py-2 font-mono text-xs font-medium transition-colors ${
                    selected
                      ? 'border-primary bg-primary text-primary-fg'
                      : 'border-dark-border bg-dark-light text-fg hover:border-primary hover:text-fg-strong'
                  }`}
                >
                  {code}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted">
              <span className="shrink-0">{s.pushToTalkKeyOther}</span>
              <input
                type="text"
                value={draft}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={s.pushToTalkKeyOther}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitDraft();
                  }
                }}
                className="h-9 min-w-0 flex-1 rounded-lg border border-dark-border bg-dark-light px-2 font-mono text-xs text-fg-strong focus:border-primary focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => setCapturing(true)}
              className={`h-9 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors ${
                capturing
                  ? 'animate-pulse border-primary text-fg-strong'
                  : 'border-dark-border text-fg hover:border-primary hover:text-fg-strong'
              }`}
            >
              {capturing ? s.pushToTalkKeyCapturing : s.pushToTalkKeyCapture}
            </button>
          </div>
          <div
            className="flex items-center gap-2 text-xs"
            data-testid="ptt-indicator"
            data-held={held ? 'true' : 'false'}
            aria-live="polite"
          >
            <span
              className={`h-3 w-3 shrink-0 rounded-full transition-colors ${
                held ? 'bg-accent shadow-[0_0_0_3px_var(--app-accent-glow)]' : 'bg-dark-lighter'
              }`}
            />
            <span className={held ? 'font-semibold text-fg-strong' : 'text-fg-muted'}>
              {held ? s.pushToTalkTestHeld : s.pushToTalkTestIdle}
            </span>
            <span className="ml-auto font-mono text-fg-faint">{setting.code}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
