#!/usr/bin/env node
// Drive this app in the SERVER's own Chromium: navigate, click, type, screenshot.
//
// The companion to scripts/shot.mjs, which renders a route and stops there.
// Anything that only happens AFTER a tap — a form submitted, a card scanned, a
// stage landed on — is invisible to a screenshot, and this machine has no
// port forward to a laptop's browser, so there is nowhere else to check it.
//
// No new dependency: Chromium's own DevTools Protocol over `ws`, which the
// relay already pulls in. That is the whole reason this exists rather than a
// playwright install.
//
//   node scripts/drive.mjs /demo/cards --out=/tmp/cards.png
//   node scripts/drive.mjs '/demo/card#c=seat&k=ABC123' --size=390x844 \
//     --steps='[{"click":"Start and talk"},{"wait":9000},{"eval":"location.pathname"},{"shot":"/tmp/landed.png"}]'
//
// Steps run in order. Each may carry any of:
//   {"click": "<button text>"}  click the first button whose text matches
//   {"eval":  "<js>"}           evaluate and print the result
//   {"wait":  <ms>}             pause
//   {"shot":  "<path>"}         write a PNG
//   {"text":  true}             print document.body.innerText, newlines as " | "
//   {"key":   "Enter"}          a real key press (keyDown + keyUp) through
//                               Input.dispatchKeyEvent, so the page sees a
//                               trusted event: Enter, ArrowLeft, ArrowRight,
//                               Space, Escape, Tab, or a single character
//   {"when":  "<js>", ...}      run the rest of this step only if <js> is truthy
//   {"size":  "1080x1920"}      re-emulate the viewport mid-run (same page)
//   {"type":  "<text>"}         insert text at the focused element, as an IME
//                               commit would (Input.insertText)
//
// Flags: --out= (final screenshot), --size=WxH (default 1280x900),
//        --wait= (ms after navigation before the first step, default 3500),
//        --steps= (JSON array).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

/** What Input.dispatchKeyEvent needs for the named keys a check presses. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
};

const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
const HOST = process.env.FRONTEND_HOST || '127.0.0.1';
const PORT = Number(process.env.FRONTEND_PORT || 5173);

const flag = (name, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '/';
const url = /^https?:|^file:/.test(target) ? target : `http://${HOST}:${PORT}${target}`;
const [width, height] = flag('size', '1280x900').split('x').map(Number);
const out = flag('out', null);

let steps;
try {
  steps = JSON.parse(flag('steps', '[]'));
} catch (error) {
  console.error(`[drive] --steps is not valid JSON: ${error.message}`);
  process.exit(1);
}

// Its own port and its own throwaway profile, so two of these can run at once
// and neither inherits the other's storage — a booth flow keyed on
// localStorage would otherwise leak between checks.
const debugPort = 9500 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-chromium-'));
/*
  Extra Chromium flags, space separated. The reason this exists: a voice check
  needs `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --autoplay-policy=no-user-gesture-required`, without which headless has no
  microphone, getUserMedia rejects, and the realtime session never opens.
*/
const extraFlags = (process.env.CHROMIUM_EXTRA_FLAGS ?? '').split(' ').filter(Boolean);
const chromium = spawn(
  CHROMIUM,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, ...extraFlags, 'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
chromium.stderr.on('data', () => {});

async function waitForDebugPort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(debugPort, '127.0.0.1');
      socket.on('connect', () => { socket.end(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Chromium never opened its debug port');
}

function cleanup() {
  chromium.kill('SIGKILL');
  // Chromium keeps writing into the profile as it dies, so a plain rmSync races
  // it and throws ENOTEMPTY *after* the work is already done. A leftover temp
  // directory is not worth failing a check over.
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Ignore.
  }
}

try {
  await waitForDebugPort();

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find((entry) => entry.type === 'page');
  if (!page) throw new Error('Chromium exposed no page target');

  const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  let nextId = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const failure = reply.result?.exceptionDetails;
    if (failure) {
      throw new Error(failure.exception?.description ?? failure.text ?? 'evaluate failed');
    }
    return reply.result?.result?.value;
  };

  const screenshot = async (file) => {
    const reply = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'));
    console.log(`[drive] ${file}  (${fs.statSync(file).size} bytes)`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 700,
  });
  await send('Page.navigate', { url });
  await new Promise((resolve) => setTimeout(resolve, Number(flag('wait', '3500'))));

  for (const step of steps) {
    if (step.when) {
      const go = await evaluate(`Boolean(${step.when})`);
      if (!go) {
        console.log(`[drive] skipped (when: ${step.when})`);
        continue;
      }
    }
    if (step.click) {
      /*
        By text, not by selector. React renders no `autofocus` attribute for its
        `autoFocus` prop and the app's class names are Tailwind soup, so the
        visible label is the only stable handle a check can hold.
      */
      const label = JSON.stringify(step.click);
      const clicked = await evaluate(
        `(() => {
           const needle = ${label};
           const button = [...document.querySelectorAll('button, a')]
             .find((el) => (el.textContent || '').includes(needle));
           if (!button) return 'NOT FOUND: ' + needle;
           if (button.disabled) return 'DISABLED: ' + needle;
           button.click();
           return 'clicked: ' + needle;
         })()`
      );
      console.log(`[drive] ${clicked}`);
      if (String(clicked).startsWith('NOT FOUND') || String(clicked).startsWith('DISABLED')) {
        throw new Error(clicked);
      }
    }
    if (step.key) {
      const spec = KEYS[step.key] ?? {
        key: step.key,
        code: `Key${step.key.toUpperCase()}`,
        keyCode: step.key.toUpperCase().charCodeAt(0),
        text: step.key,
      };
      const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode };
      await send('Input.dispatchKeyEvent', {
        type: spec.text ? 'keyDown' : 'rawKeyDown',
        ...base,
        ...(spec.text ? { text: spec.text } : {}),
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      console.log(`[drive] key: ${step.key}`);
    }
    if (step.size) {
      const [w, h] = String(step.size).split('x').map(Number);
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: w < 700,
      });
      console.log(`[drive] size: ${w}x${h}`);
    }
    if (step.type) {
      await send('Input.insertText', { text: step.type });
      console.log(`[drive] typed: ${step.type}`);
    }
    if (step.eval) console.log(`[drive] ${JSON.stringify(await evaluate(step.eval))}`);
    if (step.text) {
      console.log(`[drive] ${await evaluate('document.body.innerText.replace(/\\n+/g, " | ")')}`);
    }
    if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
    if (step.shot) await screenshot(step.shot);
  }

  if (out) await screenshot(out);
  socket.close();
} catch (error) {
  console.error(`[drive] ${error.message}`);
  cleanup();
  process.exit(1);
}

cleanup();
