# tuning-movie

## Browser checks run on this machine's Chromium — never a local browser

This repo is developed over SSH on a server. The dev server binds `127.0.0.1`
here and nothing forwards those ports back to a laptop, so any tooling that
drives a *local* Chrome (the `claude-in-chrome` MCP tools) is blind to this app.
That server is denied in `.claude/settings.local.json` for exactly this reason —
if a browser check is wanted, it happens here or not at all.

The server has its own Chromium at `/usr/bin/chromium-browser`. Reach it through
`scripts/shot.mjs`, which renders a route and prints the PNG path to read:

```bash
node scripts/shot.mjs /demo                   # route on the already-running dev server
node scripts/shot.mjs /demo --start           # boot the dev stack, shoot, tear it down
node scripts/shot.mjs / --size=390x844        # phone viewport
node scripts/shot.mjs /task-review --dom      # rendered HTML on stdout instead of a PNG
```

Routes: `/`, `/demo`, `/demo/memory`, `/demo/companion`, `/demo/card`,
`/demo/cards`, `/task-review`, `/booking`, `/end`, `/survey/per-trial`,
`/survey/post-study`. Other flags: `--out=`, `--wait=` (ms of virtual time before
the shot, default 3000), `--stack=system|agent|agent_monitor|all`.

`/demo/card` reads its card and access code from the URL **fragment**, so quote
the target: `node scripts/shot.mjs '/demo/card#c=seat&k=ABC123'`.

`shot.mjs` renders; it cannot click or type. For anything that only happens
after a tap, use `scripts/drive.mjs`, which speaks Chromium's DevTools Protocol
over the `ws` dependency the relay already pulls in — no playwright install:

```bash
node scripts/drive.mjs /demo/cards --out=/tmp/cards.png
node scripts/drive.mjs '/demo/card#c=seat&k=ABC123' --size=390x844 \
  --steps='[{"click":"Start and talk"},{"wait":9000},{"text":true},{"shot":"/tmp/landed.png"}]'
```

Steps take `click` (by button text — React renders no `autofocus` attribute, and
the class names are Tailwind soup), `eval`, `wait`, `shot` and `text`. It also
has no CJK font, so Korean renders blank in a screenshot while being present in
`--steps` `text` output.

For anything voice-related, headless has no microphone: getUserMedia rejects,
the composer goes `readOnly` with "Requested device not found", and you cannot
even type. `CHROMIUM_EXTRA_FLAGS` is the way in:

```bash
CHROMIUM_EXTRA_FLAGS="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream   --autoplay-policy=no-user-gesture-required --use-file-for-fake-audio-capture=/path/mic.wav"
```

`mic.wav` must be 16-bit PCM; 48 kHz stereo works, and Chromium loops it, so pad
a real utterance with a long silent tail. To measure when sound is genuinely
audible (rather than when a React flag flipped), attach a Web Audio analyser to
`document.querySelector('audio').srcObject` and poll RMS.

## Dev stack

`npm run dev` starts backend (3000) and frontend (5173) through
`scripts/dev-orchestrator.mjs`; `npm run dev:stack:agent` adds the tuning agent.
`FRONTEND_PORT`, `PORT`, and `FRONTEND_HOST` shift the bindings, and `shot.mjs`
honours the same variables.
