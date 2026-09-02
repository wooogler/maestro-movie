#!/usr/bin/env node
// Render a page of this app with the SERVER's own headless Chromium and write a
// PNG (or dump the rendered DOM). This machine is the only place that can reach
// the dev server: the local-browser tooling on a laptop has no port forward in,
// so this script is the browser for anything running here.
//
//   node scripts/shot.mjs /demo
//   node scripts/shot.mjs /demo --start          # boot the dev stack, shoot, tear it down
//   node scripts/shot.mjs / --size=390x844       # phone viewport
//   node scripts/shot.mjs /task-review --dom     # rendered HTML to stdout instead of a PNG
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
const HOST = process.env.FRONTEND_HOST || '127.0.0.1';
const PORT = Number(process.env.FRONTEND_PORT || 5173);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const opts = {
  target: '/',
  out: null,
  size: '1280x900',
  wait: 3000,
  start: false,
  stack: 'system',
  dom: false,
  bootTimeout: Number(process.env.SHOT_BOOT_TIMEOUT_MS || 90000),
};

for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) {
    opts.target = arg;
    continue;
  }
  const [key, value] = arg.slice(2).split('=');
  switch (key) {
    case 'out': opts.out = value; break;
    case 'size': opts.size = value; break;
    case 'wait': opts.wait = Number(value); break;
    case 'start': opts.start = true; break;
    case 'stack': opts.stack = value || 'system'; break;
    case 'dom': opts.dom = true; break;
    case 'help':
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
      process.exit(0);
      break;
    default:
      console.error(`[shot] Unknown flag: --${key}`);
      process.exit(1);
  }
}

const sizeMatch = /^(\d+)x(\d+)$/.exec(opts.size);
if (!sizeMatch) {
  console.error(`[shot] --size must look like 1280x900, got: ${opts.size}`);
  process.exit(1);
}
const [, width, height] = sizeMatch;

const url = /^https?:\/\//.test(opts.target)
  ? opts.target
  : `http://${HOST}:${PORT}${opts.target.startsWith('/') ? opts.target : `/${opts.target}`}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) return true;
    await sleep(500);
  }
  return false;
}

function startStack(mode) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'dev-orchestrator.mjs'), mode], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  // Keep the stack's own logs out of the way, but hold on to the tail so a
  // failed boot can explain itself instead of just timing out silently.
  const tail = [];
  const keep = (chunk) => {
    tail.push(chunk.toString());
    if (tail.length > 40) tail.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { child, tail };
}

function stopStack(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const force = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function runChromium(outPath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'));
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${opts.wait}`,
    opts.dom ? '--dump-dom' : `--screenshot=${outPath}`,
    url,
  ];
  return new Promise((resolve) => {
    const child = spawn(CHROMIUM, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      fs.rmSync(profile, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  if (!fs.existsSync(CHROMIUM)) {
    console.error(`[shot] No Chromium at ${CHROMIUM}. Set CHROMIUM_BIN to override.`);
    process.exit(1);
  }

  let stack = null;
  const remote = /^https?:\/\//.test(opts.target);

  if (!remote && !(await portOpen(HOST, PORT))) {
    if (!opts.start) {
      console.error(`[shot] Nothing listening on ${HOST}:${PORT}.`);
      console.error('[shot] Start the stack yourself, or re-run with --start to boot and tear it down:');
      console.error(`[shot]   node scripts/shot.mjs ${opts.target} --start`);
      process.exit(1);
    }
    console.error(`[shot] Booting the "${opts.stack}" dev stack...`);
    stack = startStack(opts.stack);
    const up = await waitForPort(HOST, PORT, opts.bootTimeout);
    if (!up) {
      console.error(`[shot] Frontend never came up on ${HOST}:${PORT} within ${opts.bootTimeout}ms. Last output:`);
      console.error(stack.tail.join(''));
      await stopStack(stack.child);
      process.exit(1);
    }
    // Vite answers the port before the first request is compiled; give the
    // dev server a beat so the screenshot isn't of a blank transform.
    await sleep(1500);
  }

  const outPath = opts.dom
    ? null
    : path.resolve(opts.out || path.join(os.tmpdir(), `shot-${opts.target.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'}-${width}x${height}.png`));

  const result = await runChromium(outPath);
  if (stack) await stopStack(stack.child);

  if (opts.dom) {
    process.stdout.write(result.stdout);
    process.exit(result.code === 0 ? 0 : 1);
  }

  if (result.code !== 0 || !fs.existsSync(outPath)) {
    console.error(`[shot] Chromium exited ${result.code} without writing ${outPath}`);
    console.error(result.stderr.split('\n').slice(-15).join('\n'));
    process.exit(1);
  }

  console.log(`${outPath}  (${fs.statSync(outPath).size} bytes, ${width}x${height}, ${url})`);
}

main().catch((error) => {
  console.error(`[shot] ${error?.stack || error}`);
  process.exit(1);
});
