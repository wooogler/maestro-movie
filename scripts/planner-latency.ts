/**
 * Times the planner's own request against several models.
 *
 *   OPENAI_API_KEY=sk-... npx tsx scripts/planner-latency.ts [--runs 3] [--models gpt-6-luna,gpt-6-astra]
 *       [--trace logs/demo/trace/<file>.llm-trace.jsonl]
 *
 * Not a synthetic prompt: it replays the first `llm.planner.request` body from
 * a real trace file (the full system prompt, the GUI snapshot and the seven
 * tools), swapping only the model and the parameters that model requires --
 * the same rules the agent applies at runtime (modelSelection.ts). Each run is
 * one Responses API call, timed from fetch to the last byte, sequentially so
 * the runs do not contend with each other.
 *
 * Costs real money (one planner call per run per model). Nothing is written to
 * the repo; results print as a table and as JSON on the last line.
 */
import fs from 'fs';
import path from 'path';
import {
  PLANNER_MODEL_OPTIONS,
} from '../apps/tuning-agent/src/llm/plannerModels';
import {
  resolveReasoningEffortFor,
  resolveTemperatureFor,
} from '../apps/tuning-agent/src/llm/modelSelection';

const REQUEST_TIMEOUT_MS = 90_000;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function newestTrace(): string | null {
  const dirs = ['logs/demo/trace', 'logs/trace'];
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.llm-trace.jsonl')) continue;
      const file = path.join(dir, name);
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

function loadRequestBody(traceFile: string): Record<string, unknown> {
  for (const line of fs.readFileSync(traceFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { type?: string; payload?: { body?: unknown; url?: string } };
    if (row.type !== 'llm.planner.request') continue;
    const body = row.payload?.body;
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (parsed && typeof parsed === 'object' && 'input' in parsed) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error(`No llm.planner.request with a Responses body in ${traceFile}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function timeOnce(
  body: Record<string, unknown>,
  apiKey: string
): Promise<{ ms: number; ok: boolean; status: number; tool: string | null; detail?: string }> {
  const started = performance.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // A planner turn that takes longer than this is a failure for the booth
      // whatever the model eventually says, and undici's own 300 s header
      // timeout would otherwise throw out of the loop and lose the table.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    const ms = performance.now() - started;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ms, ok: false, status: 0, tool: null, detail: `after ${(ms / 1000).toFixed(1)}s — ${detail}` };
  }
  const ms = performance.now() - started;
  if (!response.ok) {
    return { ms, ok: false, status: response.status, tool: null, detail: text.slice(0, 200).replace(/sk-[A-Za-z0-9_*-]{6,}/g, 'sk-[redacted]') };
  }
  let tool: string | null = null;
  try {
    const parsed = JSON.parse(text) as { output?: Array<{ type?: string; name?: string }> };
    tool = parsed.output?.find((item) => item.type === 'function_call')?.name ?? null;
  } catch {
    // Leave tool null; the timing is still valid.
  }
  return { ms, ok: true, status: response.status, tool };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required.');
    process.exit(2);
  }
  const runs = Number.parseInt(flag('runs') ?? '3', 10);
  const traceFile = flag('trace') ?? newestTrace();
  if (!traceFile) {
    console.error('No trace file found; pass --trace.');
    process.exit(2);
  }
  const requested = flag('models')?.split(',').map((m) => m.trim()).filter(Boolean);
  const models = requested ?? PLANNER_MODEL_OPTIONS.map((option) => option.id);
  const base = loadRequestBody(traceFile);
  const userChars = JSON.stringify(base.input).length;
  console.log(`trace: ${traceFile}`);
  console.log(`request: ${userChars} chars of input, ${(base.tools as unknown[] | undefined)?.length ?? 0} tools, ${runs} run(s) per model\n`);

  const results: Array<{
    model: string;
    effort: string;
    temperature: number | undefined;
    ms: number[];
    failures: string[];
    tools: string[];
  }> = [];

  for (const model of models) {
    const effort = resolveReasoningEffortFor(model, 'none');
    const temperature = resolveTemperatureFor(effort, 0);
    const body: Record<string, unknown> = {
      ...base,
      model,
      reasoning: { effort },
    };
    if (temperature === undefined) delete body.temperature;
    else body.temperature = temperature;

    const entry = { model, effort, temperature, ms: [] as number[], failures: [] as string[], tools: [] as string[] };
    process.stdout.write(`${model.padEnd(14)} effort=${effort.padEnd(5)} `);
    for (let i = 0; i < runs; i += 1) {
      const result = await timeOnce(body, apiKey);
      if (result.ok) {
        entry.ms.push(result.ms);
        entry.tools.push(result.tool ?? '-');
        process.stdout.write(`${(result.ms / 1000).toFixed(2)}s `);
      } else {
        entry.failures.push(`${result.status} ${result.detail ?? ''}`);
        process.stdout.write(`FAIL(${result.status}) `);
      }
    }
    process.stdout.write('\n');
    results.push(entry);
  }

  console.log('\nmodel          effort  median   min     max     tool calls');
  for (const r of results) {
    const sorted = [...r.ms].sort((a, b) => a - b);
    const fmt = (v: number) => (Number.isFinite(v) ? `${(v / 1000).toFixed(2)}s` : '  -  ');
    console.log(
      `${r.model.padEnd(14)} ${r.effort.padEnd(6)}  ${fmt(percentile(sorted, 50)).padEnd(7)}  ${fmt(sorted[0]).padEnd(6)}  ${fmt(sorted[sorted.length - 1]).padEnd(6)}  ${r.tools.join(',') || r.failures[0] || ''}`
    );
  }
  console.log(
    JSON.stringify(
      results.map((r) => ({ model: r.model, effort: r.effort, ms: r.ms.map((v) => Math.round(v)), failures: r.failures, tools: r.tools }))
    )
  );
}

void main();
