/**
 * The date stage, replayed: does the booth agent ask "목요일로 할까요?" about a
 * day the visitor said themselves, two stages earlier?
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/statedDay.regress.ts \
 *       --trace-dir /home/sangwonlee/tuning-movie/logs/demo/trace --since 20261024
 *   ... --runs 3          replays per case and side (default 3)
 *   ... --no-widen        the AFTER side without select at stage entry, so the
 *                         prompt change and the tool change can be told apart
 *   ... --only 19d4408b   one session (substring of the trace file name)
 *   ... --verbose         print every replayed chain
 *
 * Read out of the 2026-10-24 Korean simulation (docs/scenarios/
 * ksea2026-korean-simulation.md, issue 5): every full card that reached the
 * date stage — 10 of 10 — asked to confirm a day the visitor had named in the
 * opener ("오늘 날짜로 할까요?", "Nov 5 (Thu)로 할까요?"). By the date stage
 * the opener has scrolled out of the 8–12-entry planner history, so rule (6)
 * [ask-remembered] of DECISIVE_SELECTION_RULES, which then read "an id that
 * begins with prf_, or one the visitor has not stated in history", took the
 * visitor's own `pref_` preference for a remembered one.
 *
 * Every case is the FIRST planner call at the date stage of a logged session
 * (the one the host makes right after `next`), with the memory the session
 * had. The chain is followed the way decisiveSelection.regress.ts follows it
 * (highlight leaves only respond; select ends the chain as a commit).
 *
 *   BEFORE  the code on disk as you run it, without select at stage entry —
 *           run this file from a `git archive` of the parent commit for the
 *           old prompt (the file has no imports the old tree lacks).
 *   AFTER   the same, plus the demo-only select at the date stage's entry when
 *           memory holds a hard `pref_` preference for the date stage
 *           (keepSelectAtDateEntry in core/planner.ts). --no-widen drops it.
 *
 * Scored per chain: `commit` (select — and whether the selected day is the one
 * the preference names), `confirm-q` (asks to confirm a day), `statement`
 * (states it, asks nothing), `open-q` (asks which day). The `prf-control`
 * cases are the same requests with the date preference's id renamed to
 * `prf_…` (a profile-seeded one, never said): those must still ask — that is
 * what [ask-remembered] is for.
 *
 * Real API calls, so this stays out of `npm run check` like the other
 * `*.regress.ts` harnesses; `plannerPrompt.check.ts` is the offline half.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Preference } from '../types';
import { SUPPORTED_CONVERSATION_LANGUAGES, buildLanguageSection, planActionWithOpenAI } from './llmPlanner';
import type { PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';
import { requireApiKey, toolsFor } from './plannerReplay.regress';

type Json = Record<string, unknown>;

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const TRACE_DIR = readArg('--trace-dir') ?? path.resolve(process.cwd(), 'logs/demo/trace');
const SINCE = readArg('--since') ?? '20261024';
const ONLY = readArg('--only') ?? '';
const RUNS = Number.parseInt(readArg('--runs') ?? '', 10) || 3;
const WIDEN = !process.argv.includes('--no-widen');
const VERBOSE = process.argv.includes('--verbose');
const SIDE = readArg('--side') ?? 'both';
const CONCURRENCY = Number.parseInt(readArg('--concurrency') ?? '', 10) || 4;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Case {
  name: string;
  trace: string;
  history: unknown[];
  memory?: PlannerWorkflowMemory;
  workflow: PlannerWorkflow;
  toolNames: string[];
  systemPrompt: string;
  /** The item id the date preference names, when it names exactly one. */
  expected: string | null;
  datePreferences: Preference[];
  profileControl: boolean;
}

/** The day a hard date preference names, by the item fields the planner sees. */
function expectedDay(preferences: Preference[], workflow: PlannerWorkflow): string | null {
  const view = (workflow.currentView ?? {}) as Json;
  const items = Array.isArray(view.items) ? view.items.filter(isRecord) : [];
  const text = preferences.map((p) => p.description).join(' ');
  const matches = (predicate: (item: Json) => boolean): string | null => {
    const found = items.filter(predicate);
    return found.length === 1 ? String(found[0].id) : null;
  };
  if (/tonight|today|오늘/i.test(text)) return matches((item) => item.isToday === true);
  const days: Array<[RegExp, string]> = [
    [/monday|월요일/i, 'mon'], [/tuesday|화요일/i, 'tue'], [/wednesday|수요일/i, 'wed'],
    [/thursday|목요일/i, 'thu'], [/friday|금요일/i, 'fri'], [/saturday|토요일/i, 'sat'], [/sunday|일요일/i, 'sun'],
  ];
  for (const [pattern, day] of days) {
    if (pattern.test(text)) return matches((item) => String(item.dayOfWeek ?? '').toLowerCase().startsWith(day));
  }
  return null;
}

function readCases(): Case[] {
  const files = fs
    .readdirSync(TRACE_DIR)
    .filter((name) => name.endsWith('.llm-trace.jsonl'))
    .filter((name) => (/-(\d{8})-\d{6}\.llm-trace\.jsonl$/.exec(name)?.[1] ?? '') >= SINCE)
    .filter((name) => !ONLY || name.includes(ONLY))
    .sort();
  const cases: Case[] = [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(TRACE_DIR, file), 'utf8').split('\n')) {
      if (!line) continue;
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (event.type !== 'llm.planner.request') continue;
      const payload = event.payload as Json;
      const body = payload.body as { input?: Array<{ content?: unknown }>; tools?: Array<{ name?: string }> };
      const messages = body?.input ?? [];
      const content = messages[messages.length - 1]?.content;
      if (typeof content !== 'string') continue;
      const parsed = JSON.parse(content) as Json;
      const workflow = parsed.workflow as PlannerWorkflow;
      if (workflow?.currentStage !== 'date') continue;
      const history = Array.isArray(parsed.history) ? parsed.history : [];
      const last = history[history.length - 1];
      // Stage entry: the newest entry is the date stage's own system entry, with
      // no tool annotation (nothing has been done or said here yet).
      if (!isRecord(last) || last.type !== 'system' || last.stage !== 'date' || isRecord(last.annotation)) continue;
      const memory = parsed.memory as PlannerWorkflowMemory | undefined;
      const datePreferences = (memory?.preferences ?? []).filter(
        (p) => p.strength === 'hard' && p.relevantStages.includes('date')
      );
      if (datePreferences.length === 0) continue;
      const base = {
        trace: file,
        history,
        workflow,
        toolNames: (body.tools ?? []).map((tool) => String(tool.name ?? '')).filter((name) => name && name !== 'respond'),
        systemPrompt: typeof messages[0]?.content === 'string' ? (messages[0].content as string) : '',
        expected: expectedDay(datePreferences, workflow),
        datePreferences,
      };
      const session = file.slice('demo-st_'.length, 'demo-st_'.length + 8);
      cases.push({ ...base, name: `stated ${session}`, ...(memory ? { memory } : {}), profileControl: false });
      // The same request, with the date preference seeded from a profile.
      const renamed = JSON.parse(JSON.stringify(memory)) as PlannerWorkflowMemory;
      for (const preference of renamed.preferences) {
        if (datePreferences.some((p) => p.id === preference.id)) preference.id = preference.id.replace(/^pref_/, 'prf_');
      }
      cases.push({
        ...base,
        name: `prf-control ${session}`,
        memory: renamed,
        datePreferences: renamed.preferences.filter((p) => p.strength === 'hard' && p.relevantStages.includes('date')),
        profileControl: true,
      });
      break; // one date entry per session
    }
  }
  return cases;
}

function flagsFromPrompt(systemPrompt: string): { language?: string; spokenBrevity: boolean } {
  let language: string | undefined;
  for (const candidate of SUPPORTED_CONVERSATION_LANGUAGES) {
    const section = buildLanguageSection(candidate);
    if (section && systemPrompt.includes(section)) language = candidate;
  }
  return { ...(language ? { language } : {}), spokenBrevity: systemPrompt.includes('Writing for the ear') };
}

function parseStageMeta(systemPrompt: string): Array<{ stage: string; goal: string; fieldGuide: string }> {
  const start = systemPrompt.indexOf('Stage goals:\n');
  if (start < 0) return [];
  const meta: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  for (const line of systemPrompt.slice(start + 'Stage goals:\n'.length).split('\n')) {
    const match = /^ {2}(\w+): (.+)$/.exec(line);
    if (!match) break;
    meta.push({ stage: match[1], goal: match[2], fieldGuide: '' });
  }
  return meta;
}

type Outcome = 'commit' | 'confirm-q' | 'open-q' | 'statement' | 'silent' | 'other';

const OPEN_Q = /어느|어떤|무엇|몇|언제|which|what day|what date|when/i;
const CONFIRM_Q = /할까요|하실까요|맞나요|맞으세요|괜찮으세요|좋으세요|would you like|shall i|is that right|does .* work|ok\?|okay\?/i;

function classify(message: string): Outcome {
  const text = message.trim();
  if (!text) return 'silent';
  if (!/\?/.test(text)) return 'statement';
  if (CONFIRM_Q.test(text) && !OPEN_Q.test(text)) return 'confirm-q';
  if (OPEN_Q.test(text)) return 'open-q';
  return 'confirm-q';
}

interface Result {
  outcome: Outcome;
  tools: string[];
  message: string;
  selected: string | null;
  rule: string;
}

/** Mirrors getPlannerToolSchema after `next`, with or without the date-entry select. */
function entryTools(testCase: Case, widen: boolean): string[] {
  const gui = new Set(['augment', 'filter', 'sort', 'highlight', 'clearModification']);
  const tools = testCase.toolNames.filter((name) => gui.has(name));
  const stated = (testCase.memory?.preferences ?? []).some(
    (p) => p.strength === 'hard' && p.relevantStages.includes('date') && !p.id.startsWith('prf_')
  );
  return widen && stated ? [...tools, 'select'] : tools;
}

async function replay(testCase: Case, widen: boolean): Promise<Result | null> {
  const flags = flagsFromPrompt(testCase.systemPrompt);
  const history = JSON.parse(JSON.stringify(testCase.history)) as unknown[];
  const workflow = JSON.parse(JSON.stringify(testCase.workflow)) as PlannerWorkflow;
  let toolNames = entryTools(testCase, widen);
  const tools: string[] = [];
  let message = '';
  let selected: string | null = null;
  let rule = '';
  for (let step = 0; step < 5; step += 1) {
    workflow.availableToolNames = [...toolNames, 'respond'];
    const output = await planActionWithOpenAI({
      history,
      availableTools: toolsFor([...toolNames, 'respond']),
      workflow,
      stageMeta: parseStageMeta(testCase.systemPrompt),
      ...(testCase.memory ? { memory: testCase.memory } : {}),
      ...(flags.language ? { language: flags.language } : {}),
      ...(flags.spokenBrevity ? { spokenBrevity: true } : {}),
      ...(testCase.profileControl ? { preloadedMemory: true } : {}),
      demoSession: true,
      decisiveSelection: true,
      requirementConflicts: true,
      // The rest of the booth's flags as core/planner.ts sets them; a tree
      // that predates them ignores them.
      openingQuestions: true,
      seatChoices: true,
    } as Parameters<typeof planActionWithOpenAI>[0]);
    if (!output) return null;
    const tool = output.action.type === 'none' ? 'respond' : output.action.toolName;
    tools.push(tool);
    if (step === 0) rule = /^\s*\[([a-z-]+)\]/i.exec(output.action.reason)?.[1] ?? '';
    if (output.assistantMessage.trim()) message = output.assistantMessage.trim();
    if (tool === 'select') {
      selected = String(output.action.params.itemId ?? '');
      break;
    }
    if (tool === 'respond' || !toolNames.includes(tool)) break;
    const annotation: Json = { kind: 'tool-modification', toolName: tool, source: 'agent', reason: output.action.reason };
    const entry: Json = { type: 'system', stage: 'date', annotation };
    if (output.assistantMessage.trim()) entry.linkedAgentText = output.assistantMessage.trim();
    history.push(entry);
    const view = (workflow.currentView ?? {}) as Json;
    if (tool === 'highlight') {
      view.highlightedIds = Array.isArray(output.action.params.itemIds) ? output.action.params.itemIds : [];
      toolNames = [];
    } else if (tool === 'clearModification') {
      delete view.highlightedIds;
    }
  }
  return { outcome: selected ? 'commit' : classify(message), tools, message, selected, rule };
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index]);
      }
    })
  );
  return results;
}

async function main(): Promise<void> {
  requireApiKey('statedDay.regress.ts');
  const cases = readCases();
  console.log(`${cases.length / 2} sessions with a date-stage entry and a hard date preference (since ${SINCE}), ${RUNS} run(s) per side`);
  const sides: Array<{ label: string; widen: boolean }> = [];
  if (SIDE === 'both' || SIDE === 'before') sides.push({ label: 'BEFORE', widen: false });
  if (SIDE === 'both' || SIDE === 'after') sides.push({ label: WIDEN ? 'AFTER' : 'AFTER (no widen)', widen: WIDEN });
  const jobs = cases.flatMap((testCase) =>
    sides.flatMap((side) => Array.from({ length: RUNS }, () => ({ testCase, side })))
  );
  const results = await pool(jobs, CONCURRENCY, async (job) => ({ ...job, result: await replay(job.testCase, job.side.widen) }));

  for (const side of sides) {
    for (const control of [false, true]) {
      const mine = results.filter((r) => r.side === side && r.testCase.profileControl === control);
      const tally = new Map<string, number>();
      let rightDay = 0;
      let wrongDay = 0;
      for (const { result, testCase } of mine) {
        const key = result ? result.outcome : 'FAILED';
        tally.set(key, (tally.get(key) ?? 0) + 1);
        if (result?.selected) {
          if (testCase.expected && result.selected === testCase.expected) rightDay += 1;
          else wrongDay += 1;
        }
      }
      console.log(
        `\n${side.label} — ${control ? 'prf-control (profile-seeded day: should still ask)' : 'stated day (pref_)'}: ` +
          [...tally.entries()].map(([k, v]) => `${k} ${v}`).join(', ') +
          ` / ${mine.length}; selects on the named day ${rightDay}, on another day ${wrongDay}`
      );
      for (const { testCase, result } of mine) {
        if (!VERBOSE && result && result.outcome !== 'confirm-q' && !(result.selected && result.selected !== testCase.expected)) continue;
        console.log(
          `  ${testCase.name.padEnd(22)} [${testCase.datePreferences.map((p) => p.description).join(' | ').slice(0, 50)}] → ` +
            (result ? `${result.tools.join('>')} ${result.selected ?? ''} [${result.rule}] "${result.message}"` : 'FAILED')
        );
      }
    }
  }
}

void main();
