/**
 * Does telling the booth extractor "write in Korean" change anything but the
 * language of the descriptions?
 *
 *   set -a; . ./.env; set +a
 *   npx tsx apps/tuning-agent/src/llm/extractorLanguage.regress.ts --runs 2 <trace.jsonl>...
 *
 * Real API calls, so this stays out of `npm run check`; `extractorPrompt.check.ts`
 * is the offline half (it pins the prompts). Each extractor request in the given
 * demo traces (Korean sessions) is replayed with the booth prompt BEFORE the
 * change (no language line, which is what a Korean booth session sent) and
 * AFTER it (the Korean line), RUNS times each, and compared on the output's
 * shape: how many preferences, which existing ids survive, strengths and
 * relevantStages. BEFORE against BEFORE is the control: the extractor is not
 * deterministic, so only a disagreement rate above the control's is the
 * line's doing.
 *
 * The language is counted over NEW descriptions only (an id not in
 * existingPreferences): an unchanged existing preference keeps its wording by
 * design, so an English one carried in from the logged session stays English.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Preference } from '../types';
import { extractStructuredPreferences, type PreferenceExtractionContext } from './llmExtractor';
import { readRuns, requireApiKey } from './plannerReplay.regress';

type Json = Record<string, unknown>;

interface ExtractorRequest {
  trace: string;
  requestId: string;
  systemPrompt: string;
  input: Json;
}

const RUNS = readRuns();
const traces = process.argv.slice(2).filter((arg) => arg.endsWith('.jsonl'));

function loadRequests(file: string): ExtractorRequest[] {
  const found: ExtractorRequest[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('llm.extractor.request')) continue;
    const event = JSON.parse(line) as Json;
    if (event.type !== 'llm.extractor.request') continue;
    const payload = event.payload as Json;
    const body = payload.body as { input?: Array<{ content?: unknown }> };
    const messages = body.input ?? [];
    found.push({
      trace: path.basename(file),
      requestId: String(payload.requestId),
      systemPrompt: String(messages[0]?.content ?? ''),
      input: JSON.parse(String(messages[messages.length - 1]?.content ?? '{}')) as Json,
    });
  }
  return found;
}

/** The study notes are what the frontend sends; the booth rewrite is redone by the extractor. */
function stageMeta(systemPrompt: string): Array<{ stage: string; goal: string; fieldGuide: string }> {
  const start = systemPrompt.indexOf('stageFieldGuides:\n');
  if (start < 0) return [];
  const meta: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  for (const line of systemPrompt.slice(start + 'stageFieldGuides:\n'.length).split('\n')) {
    const match = /^- (movie|theater|date|time|seat|confirm): (.+)$/.exec(line);
    if (!match) break;
    meta.push({ stage: match[1], goal: '', fieldGuide: match[2] });
  }
  return meta;
}

function ctxFor(request: ExtractorRequest, language: string | undefined): PreferenceExtractionContext {
  const input = JSON.parse(JSON.stringify(request.input)) as Json;
  return {
    userMessage: String(input.userMessage ?? ''),
    currentStage: String(input.currentStage ?? ''),
    state: (input.state ?? null) as Json | null,
    compactUi: input.compactUi,
    recentDialogue: (input.recentDialogue ?? []) as PreferenceExtractionContext['recentDialogue'],
    existingPreferences: (input.existingPreferences ?? []) as Preference[],
    stageMeta: stageMeta(request.systemPrompt),
    // BEFORE: a Korean booth session added no language line, which is what
    // `undefined` gives today. AFTER: 'ko'.
    ...(language ? { language } : {}),
    demoSession: true,
  };
}

/** Everything about the output except the wording. */
function shape(output: Preference[], existing: Preference[]): string {
  const existingIds = new Set(existing.map((p) => p.id));
  const kept = output.filter((p) => existingIds.has(p.id)).map((p) => `${p.id}:${p.strength}:${[...p.relevantStages].sort().join('+')}`).sort();
  const added = output.filter((p) => !existingIds.has(p.id)).map((p) => `new:${p.strength}:${[...p.relevantStages].sort().join('+')}`).sort();
  return JSON.stringify({ n: output.length, kept, added });
}

const HANGUL = /[가-힣]/;

async function main(): Promise<void> {
  requireApiKey('extractorLanguage.regress.ts');
  if (traces.length === 0) {
    console.error('pass one or more demo llm-trace.jsonl files');
    process.exit(2);
  }
  const requests = traces.flatMap(loadRequests);
  console.log(`${requests.length} extractor requests from ${traces.length} trace(s), ${RUNS} run(s) per side`);

  let controlPairs = 0;
  let controlSame = 0;
  let pairs = 0;
  let same = 0;
  let newBefore = 0;
  let newBeforeKo = 0;
  let newAfter = 0;
  let newAfterKo = 0;
  let idsLostBefore = 0;
  let idsLostAfter = 0;
  const fmtDesc = (list: Preference[]) => list.map((p) => `${p.strength[0]}:${p.description}`).join(' | ');

  for (const request of requests) {
    const existing = (request.input.existingPreferences ?? []) as Preference[];
    const before: Preference[][] = [];
    const after: Preference[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      before.push(await extractStructuredPreferences(ctxFor(request, undefined)));
      after.push(await extractStructuredPreferences(ctxFor(request, 'ko')));
    }
    const existingIds = new Set(existing.map((p) => p.id));
    for (const [side, outputs] of [['before', before], ['after', after]] as const) {
      for (const output of outputs) {
        const added = output.filter((p) => !existingIds.has(p.id));
        const lost = existing.filter((p) => !output.some((q) => q.id === p.id)).length;
        if (side === 'before') {
          newBefore += added.length;
          newBeforeKo += added.filter((p) => HANGUL.test(p.description)).length;
          idsLostBefore += lost;
        } else {
          newAfter += added.length;
          newAfterKo += added.filter((p) => HANGUL.test(p.description)).length;
          idsLostAfter += lost;
        }
      }
    }
    for (let i = 0; i < RUNS; i += 1) {
      for (let j = i + 1; j < RUNS; j += 1) {
        controlPairs += 1;
        if (shape(before[i], existing) === shape(before[j], existing)) controlSame += 1;
      }
      for (let j = 0; j < RUNS; j += 1) {
        pairs += 1;
        if (shape(before[i], existing) === shape(after[j], existing)) same += 1;
      }
    }
    console.log(`\n${request.trace} ${request.requestId}: "${String(request.input.userMessage)}"`);
    console.log(`  in      ${fmtDesc(existing) || '(none)'}`);
    before.forEach((output, i) => console.log(`  before${i + 1} ${shape(output, existing)}\n          ${fmtDesc(output)}`));
    after.forEach((output, i) => console.log(`  after${i + 1}  ${shape(output, existing)}\n          ${fmtDesc(output)}`));
  }

  console.log('\nsummary');
  console.log(`  shape agreement, before vs before (control): ${controlSame}/${controlPairs}`);
  console.log(`  shape agreement, before vs after:            ${same}/${pairs}`);
  console.log(`  new descriptions in Korean: before ${newBeforeKo}/${newBefore}, after ${newAfterKo}/${newAfter}`);
  console.log(`  existing ids dropped: before ${idsLostBefore}, after ${idsLostAfter}`);
}

void main();
