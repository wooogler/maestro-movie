/**
 * Executable check for where a session's logs go:
 *
 *   npx tsx apps/backend/src/study/logPaths.check.ts
 *
 * Two claims worth defending.
 *
 * First, the demo and the study must not share a directory. `logs/interaction/`
 * and `logs/trace/` are what the corpus tools glob. A consenting booth visitor
 * agreed to be recorded for research, not to be filed as a counterbalanced,
 * PID-carrying participant — one stray path is all it takes to put a stranger
 * in a paper's dataset.
 *
 * Second, the agent writes the trace and the backend serves it back, from two
 * processes in two workspaces. They agree because the backend hands the path
 * over in `AGENT_LLM_TRACE_FILE`; the agent's own derivation is only a fallback
 * for a manual run, so that fallback is checked against the backend's rule
 * here rather than left to drift.
 *
 * Exit code 0 means every case passed.
 */
import path from 'path';
import { buildLlmTraceLogFilePath } from '../../../tuning-agent/src/runtime/studyLlmTraceLog';
import {
  buildLlmTraceRelativeFile,
  createDemoInteractionLogFilePath,
  createDemoLlmTraceFilePath,
  createInteractionLogFilePath,
  getLlmTraceFile,
  hasLlmTrace,
} from './interactionLogService';
import type { StudySessionRecord } from './types';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** Only the fields these functions read; the rest of the record is irrelevant. */
function record(fields: Partial<StudySessionRecord>): StudySessionRecord {
  return fields as StudySessionRecord;
}

/** What the agent's fallback would write, expressed relative to the repo root. */
function agentFallbackRelative(interactionLogFile: string): string {
  const absolute = buildLlmTraceLogFilePath(interactionLogFile);
  return path.relative(process.cwd(), absolute).split(path.sep).join('/');
}

const CREATED_AT = '2026-08-28T15:04:05.000Z';
const STUDY_LOG = createInteractionLogFilePath('P07', 'C2', 'scn_s1_t1_child_playdate_easy', CREATED_AT);

// -----------------------------------------------------------------------------
section('1. study paths are exactly what they were');
// -----------------------------------------------------------------------------
{
  check('the interaction log is under logs/interaction', STUDY_LOG.startsWith('logs/interaction/'), STUDY_LOG);
  check(
    'the trace is under logs/trace',
    buildLlmTraceRelativeFile(STUDY_LOG).startsWith('logs/trace/'),
    buildLlmTraceRelativeFile(STUDY_LOG)
  );
  check(
    'the trace keeps the interaction stem and gains .llm-trace',
    buildLlmTraceRelativeFile('logs/interaction/P07-C2-child-20260828-110405.jsonl') ===
      'logs/trace/P07-C2-child-20260828-110405.llm-trace.jsonl'
  );
}

// -----------------------------------------------------------------------------
section('2. demo output never enters the study tree');
// -----------------------------------------------------------------------------
{
  const demoTrace = createDemoLlmTraceFilePath('st_abc123', CREATED_AT);
  check('a demo trace is under logs/demo/trace', demoTrace.startsWith('logs/demo/trace/'), demoTrace);
  check('and therefore not under logs/trace', !demoTrace.startsWith('logs/trace/'), demoTrace);
  check('nor under logs/interaction', !demoTrace.startsWith('logs/interaction/'), demoTrace);

  // Demo visitors run concurrently and have no participant id, so a name built
  // only from a whole-second timestamp would have two of them appending to one
  // file. The session id is what keeps them apart.
  const a = createDemoLlmTraceFilePath('st_aaaaaa', CREATED_AT);
  const b = createDemoLlmTraceFilePath('st_bbbbbb', CREATED_AT);
  check('two demo sessions in the same second get different files', a !== b, `${a} vs ${b}`);
  check('the session id is what distinguishes them', a.includes('st_aaaaaa') && b.includes('st_bbbbbb'));
  // Session ids are server-generated (`st_<hex>`), so this is defence in depth
  // rather than a live risk. `..` surviving as literal characters inside one
  // file name is harmless; a path separator would not be.
  const hostile = createDemoLlmTraceFilePath('../../etc/passwd', CREATED_AT);
  check(
    'a session id with path characters cannot escape the directory',
    hostile.startsWith('logs/demo/trace/') && !hostile.slice('logs/demo/trace/'.length).includes('/'),
    hostile
  );
  check(
    'and resolving it stays inside the demo trace directory',
    path.resolve('/repo', hostile).startsWith('/repo/logs/demo/trace/'),
    path.resolve('/repo', hostile)
  );

  // The consented demo interaction log, added when the booth started asking.
  const demoInteraction = createDemoInteractionLogFilePath('st_abc123', CREATED_AT);
  check(
    'a demo interaction log is under logs/demo/interaction',
    demoInteraction.startsWith('logs/demo/interaction/'),
    demoInteraction
  );
  check(
    'and therefore not in the study corpus directory',
    !demoInteraction.startsWith('logs/interaction/'),
    demoInteraction
  );
  check(
    'two demo sessions in the same second get different interaction logs',
    createDemoInteractionLogFilePath('st_aaaaaa', CREATED_AT) !==
      createDemoInteractionLogFilePath('st_bbbbbb', CREATED_AT)
  );
  check(
    'a session id with path characters cannot escape the interaction directory',
    (() => {
      const escaped = createDemoInteractionLogFilePath('../../etc/passwd', CREATED_AT);
      return (
        escaped.startsWith('logs/demo/interaction/') &&
        !escaped.slice('logs/demo/interaction/'.length).includes('/')
      );
    })()
  );
  // The one that matters for the session record: a consented demo session sets
  // `interactionLogFile` and derives the trace from it, exactly as a study
  // session does. That derivation has to land on the demo trace name rather
  // than inventing a third one.
  check(
    'the trace derived from a demo interaction log is the demo trace path',
    buildLlmTraceRelativeFile(demoInteraction) === demoTrace,
    `${buildLlmTraceRelativeFile(demoInteraction)} vs ${demoTrace}`
  );
  check(
    'a demo visitor never has a participant id in either file name',
    !demoInteraction.includes('P07') && !demoTrace.includes('P07'),
    'the demo does not ask for one, so there is nothing to put there'
  );
}

// -----------------------------------------------------------------------------
section('3. the trace is tracked independently of the interaction log');
// -----------------------------------------------------------------------------
{
  // The split is still real for a study session, where the trace and the
  // interaction log are separate decisions. For a demo session they move
  // together with consent, and a tutorial has neither.
  const demoWithTrace = record({ llmTraceFile: 'logs/demo/trace/demo-st_x-20260828-110405.llm-trace.jsonl' });
  check('a trace can be tracked with no interaction log beside it', hasLlmTrace(demoWithTrace));
  check(
    'a session with neither has no trace',
    !hasLlmTrace(record({})),
    'this is a demo visitor who did not consent, and always the tutorial'
  );
  check(
    'the explicit field wins over the derivation',
    getLlmTraceFile(
      record({ interactionLogFile: STUDY_LOG, llmTraceFile: 'logs/demo/trace/explicit.llm-trace.jsonl' })
    ) === 'logs/demo/trace/explicit.llm-trace.jsonl'
  );
  check(
    'a record from before the field existed still derives its trace',
    getLlmTraceFile(record({ interactionLogFile: STUDY_LOG })) === buildLlmTraceRelativeFile(STUDY_LOG),
    'a backend restart must not lose the download for a session already running'
  );
  check(
    'a blank field is treated as absent, not as a path',
    getLlmTraceFile(record({ llmTraceFile: '   ' })) === null
  );
}

// -----------------------------------------------------------------------------
section("4. the agent's fallback derivation agrees with the backend");
// -----------------------------------------------------------------------------
{
  check(
    'study session: agent fallback === backend derivation',
    agentFallbackRelative(STUDY_LOG) === buildLlmTraceRelativeFile(STUDY_LOG),
    `${agentFallbackRelative(STUDY_LOG)} vs ${buildLlmTraceRelativeFile(STUDY_LOG)}`
  );
  check(
    'a bare file name resolves the same way on both sides',
    agentFallbackRelative('session.jsonl') === buildLlmTraceRelativeFile('session.jsonl'),
    buildLlmTraceRelativeFile('session.jsonl')
  );
}

console.log(failures === 0 ? '\nall log path checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
