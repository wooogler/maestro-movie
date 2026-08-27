import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { DEMO_STUDY_MODE } from './modes';
import type { StudyModeConfig, StudyModeId } from './types';

type StartAgentParams = Parameters<typeof startAgentForSession>[0];

interface AgentProcessHandle {
  child: ChildProcess;
  relaySessionId: string;
  /** Kept so a crashed agent can be respawned with identical configuration. */
  params: StartAgentParams;
  restartCount: number;
  startedAt: number;
  restartTimer?: NodeJS.Timeout;
  stopping?: boolean;
}

const handles = new Map<string, AgentProcessHandle>();
/**
 * A crashed agent used to be a dead end: `child.on('exit')` wrote one stderr
 * line and nothing restarted it, nothing told the host, and the participant was
 * left with a session whose agent would never answer again. Restarts are
 * bounded so a deterministic startup failure (port conflict, missing binary)
 * fails loudly instead of looping forever.
 */
const MAX_AGENT_RESTARTS = 3;
const AGENT_RESTART_BASE_DELAY_MS = 1_000;
/** Past this, the process is considered to have started successfully. */
const AGENT_HEALTHY_UPTIME_MS = 60_000;
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
const AGENT_ENTRYPOINT = path.resolve(WORKSPACE_ROOT, 'apps/tuning-agent/src/index.ts');
const AGENT_DIST_ENTRYPOINT = path.resolve(WORKSPACE_ROOT, 'apps/tuning-agent/dist/index.js');

function resolveTsxBinary(): string {
  const name = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const candidates = [
    path.resolve(WORKSPACE_ROOT, 'apps/backend/node_modules/.bin', name),
    path.resolve(WORKSPACE_ROOT, 'node_modules/.bin', name),
    path.resolve(process.cwd(), 'node_modules/.bin', name),
    path.resolve(process.cwd(), '../../node_modules/.bin', name),
    name,
  ];
  for (const candidate of candidates) {
    if (candidate === name || fs.existsSync(candidate)) return candidate;
  }
  return name;
}

interface AgentLaunchPlan {
  command: string;
  entrypoint: string;
}

/**
 * In production a compiled bundle is preferred so the agent does not depend on
 * a dev-only tsx binary; everywhere else keep running TypeScript sources.
 */
function resolveAgentLaunchPlan(): AgentLaunchPlan {
  if (process.env.NODE_ENV === 'production' && fs.existsSync(AGENT_DIST_ENTRYPOINT)) {
    return { command: process.execPath, entrypoint: AGENT_DIST_ENTRYPOINT };
  }
  return { command: resolveTsxBinary(), entrypoint: AGENT_ENTRYPOINT };
}

function prefixedWrite(prefix: string, chunk: Buffer | string): void {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    process.stdout.write(`${prefix} ${line}\n`);
  }
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

/**
 * The monitor keeps the whole conversation plus every LLM request/response in
 * memory and serves it unauthenticated. Demo sessions log nothing anywhere, so
 * the monitor is always off for them.
 */
function isMonitorEnabledForSession(studyMode: StudyModeId): boolean {
  if (studyMode === DEMO_STUDY_MODE) return false;
  return parseBooleanEnv(process.env.AGENT_MONITOR_ENABLED) ?? process.env.NODE_ENV !== 'production';
}

function resolveSupervisorAgentMonitorPort(studyMode: StudyModeId): string {
  // Demo sessions run concurrently, so they must never contend for a fixed port
  // (the monitor is disabled for them anyway).
  if (studyMode === DEMO_STUDY_MODE) return '0';

  const override = process.env.AGENT_MONITOR_PORT_OVERRIDE?.trim();
  if (override) return override;

  if (!isMonitorEnabledForSession(studyMode)) return '0';

  if (process.env.NODE_ENV !== 'production') {
    return process.env.AGENT_MONITOR_PORT?.trim() || '3500';
  }

  // In production, keep monitor port dynamic to avoid cross-session conflicts
  // if monitor is explicitly enabled.
  return '0';
}

export function startAgentForSession(
  params: {
    sessionId: string;
    relaySessionId: string;
    scenarioId: string;
    participantId: string;
    loggingParticipantId?: string;
    interactionLogFile?: string;
    studyMode: StudyModeId;
    modeConfig: StudyModeConfig;
    apiKey?: string;
    /** Internal: how many times this session's agent has already been respawned. */
    restartCount?: number;
  }
): void {
  const {
    sessionId,
    relaySessionId,
    scenarioId,
    participantId,
    loggingParticipantId,
    interactionLogFile,
    studyMode,
    modeConfig,
    apiKey,
  } = params;
  if (!modeConfig.agentEnabled) return;

  stopAgentForSession(sessionId);

  const launchPlan = resolveAgentLaunchPlan();
  if (!fs.existsSync(launchPlan.entrypoint)) {
    process.stderr.write(
      `[agent-supervisor] Agent entrypoint not found: ${launchPlan.entrypoint}\n`
    );
    return;
  }

  const child = spawn(launchPlan.command, [launchPlan.entrypoint], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      AGENT_SESSION_ID: relaySessionId,
      AGENT_RUNTIME_SESSION_ID: sessionId,
      AGENT_STUDY_ID: scenarioId,
      AGENT_PARTICIPANT_ID: participantId,
      AGENT_LOGGING_PARTICIPANT_ID: loggingParticipantId ?? '',
      AGENT_INTERACTION_LOG_FILE: interactionLogFile ?? '',
      AGENT_STUDY_MODE: studyMode,
      AGENT_ENABLE_GUI_ADAPTATION: modeConfig.guiAdaptationEnabled ? 'true' : 'false',
      AGENT_DEFAULT_CP_MEMORY_LIMIT: String(modeConfig.cpMemoryWindow),
      AGENT_MONITOR_PORT: resolveSupervisorAgentMonitorPort(studyMode),
      AGENT_MONITOR_ENABLED: isMonitorEnabledForSession(studyMode) ? 'true' : 'false',
      // User-provided key for public demo sessions. Never log this value.
      AGENT_OPENAI_API_KEY: apiKey ?? '',
      // A demo session runs on the visitor's key only: drop the inherited
      // operator key so the agent cannot silently fall back to it.
      ...(studyMode === DEMO_STUDY_MODE ? { OPENAI_API_KEY: apiKey ?? '' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[agent-supervisor:${relaySessionId}]`;
  child.stdout?.on('data', (chunk) => prefixedWrite(prefix, chunk));
  child.stderr?.on('data', (chunk) => prefixedWrite(prefix, chunk));

  child.on('error', (error) => {
    process.stderr.write(
      `${prefix} Failed to start agent process (${launchPlan.command}): ${error.message}\n`
    );
    const handle = handles.get(sessionId);
    if (handle?.child === child) {
      handles.delete(sessionId);
    }
  });

  child.on('exit', (code, signal) => {
    const handle = handles.get(sessionId);
    const wasCurrent = handle?.child === child;
    if (!wasCurrent) return;

    const intentional = handle?.stopping === true || signal === 'SIGTERM';
    const cleanExit = code === 0;
    if (code !== 0 && code !== null) {
      process.stderr.write(`${prefix} Agent process exited with code ${code}\n`);
    } else if (signal && signal !== 'SIGTERM') {
      process.stderr.write(`${prefix} Agent process was killed by ${signal}\n`);
    }

    if (intentional || cleanExit) {
      handles.delete(sessionId);
      return;
    }

    // A process that stayed up long enough is treated as having started
    // successfully, so a late crash gets a fresh restart budget.
    const ranHealthily = Date.now() - handle.startedAt >= AGENT_HEALTHY_UPTIME_MS;
    const restartCount = ranHealthily ? 0 : handle.restartCount;

    if (restartCount >= MAX_AGENT_RESTARTS) {
      process.stderr.write(
        `${prefix} Agent process failed ${restartCount} times; giving up. ` +
          'The session will have no agent until it is reset.\n'
      );
      handles.delete(sessionId);
      return;
    }

    const delayMs = AGENT_RESTART_BASE_DELAY_MS * 2 ** restartCount;
    process.stderr.write(
      `${prefix} Restarting agent process in ${delayMs}ms ` +
        `(attempt ${restartCount + 1}/${MAX_AGENT_RESTARTS})\n`
    );
    const restartTimer = setTimeout(() => {
      const current = handles.get(sessionId);
      // Only restart if this handle is still the live one and nothing asked us
      // to stop in the meantime.
      if (current?.child !== child || current?.stopping) return;
      handles.delete(sessionId);
      startAgentForSession({ ...handle.params, restartCount: restartCount + 1 });
    }, delayMs);
    restartTimer.unref?.();
    handles.set(sessionId, { ...handle, restartTimer });
  });

  handles.set(sessionId, {
    child,
    relaySessionId,
    params,
    restartCount: params.restartCount ?? 0,
    startedAt: Date.now(),
  });
}

export function stopAgentForSession(sessionId: string): void {
  const handle = handles.get(sessionId);
  if (!handle) return;
  // Mark before deleting so an exit event racing with this call does not read
  // the stop as a crash and respawn the process we just asked to go away.
  handle.stopping = true;
  if (handle.restartTimer) clearTimeout(handle.restartTimer);
  handles.delete(sessionId);
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGTERM');
  }
}

export function stopAllSessionAgents(): void {
  for (const sessionId of Array.from(handles.keys())) {
    stopAgentForSession(sessionId);
  }
}
