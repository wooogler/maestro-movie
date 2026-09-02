/**
 * Replay every recorded agent utterance through the voice classifier and the
 * verbosity gate, and score it against ground truth.
 *
 * Ground truth is the planner tool that produced the utterance, recorded in
 * `logs/trace/*.llm-trace.jsonl` as `llm.planner.response.raw`. Those logs are
 * gitignored (they sit next to participant data), so this script is a local
 * research tool, not part of `npm run check` — it exits 0 with a notice when
 * the corpus is absent.
 *
 *   npx tsx scripts/validate-voice-classifier.ts
 *   npx tsx scripts/validate-voice-classifier.ts --show-errors
 *
 * The numbers quoted in the header of `classifyUtterance.ts` come from here.
 * Re-run it after touching any regex.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyUtterance } from '../apps/frontend/src/voice/classifyUtterance';
import { RECENT_UTTERANCE_WINDOW, decideVoiceOutput } from '../apps/frontend/src/voice/smartSkip';
import {
  DEFAULT_VOICE_VERBOSITY,
  VOICE_VERBOSITY_PRESETS,
  resolveCategoryFromTool,
  type VoiceCategory,
  type VoiceVerbositySettings,
} from '../apps/frontend/src/voice/verbosity';

const TRACE_DIR = join(process.cwd(), 'logs', 'trace');
const SHOW_ERRORS = process.argv.includes('--show-errors');

interface Sample {
  gold: VoiceCategory;
  tool: string;
  text: string;
  /** What was on screen when the utterance was produced. */
  visibleLabels: string[];
  screenTitle: string | null;
}

/**
 * Pair each planner response with the request that produced it (by
 * `requestId`), because the request prompt carries `currentView.visibleItems` —
 * the literal on-screen options at that moment. Without it the on-screen rules
 * (R3, R5) cannot be replayed and the simulation understates the saving.
 */
function loadCorpus(): Sample[] {
  const samples: Sample[] = [];
  for (const file of readdirSync(TRACE_DIR).filter((name) => name.endsWith('.jsonl'))) {
    const lines = readFileSync(join(TRACE_DIR, file), 'utf8').split('\n').filter(Boolean);
    let voiceOn: boolean | null = null;
    const views = new Map<string, { labels: string[]; title: string | null }>();

    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (voiceOn === null) voiceOn = String(entry.studyMode ?? '').includes('voice-on');
      if (!voiceOn) break;

      if (entry.type === 'llm.planner.request') {
        const requestId = entry.payload?.requestId;
        const input = entry.payload?.body?.input;
        if (typeof requestId !== 'string' || !Array.isArray(input)) continue;
        const userTurn = [...input].reverse().find((m: any) => m?.role === 'user');
        if (!userTurn) continue;
        try {
          const view = JSON.parse(String(userTurn.content))?.workflow?.currentView;
          const labels = Array.isArray(view?.visibleItems)
            ? view.visibleItems.map((item: any) => String(item?.value ?? '')).filter(Boolean)
            : [];
          views.set(requestId, { labels, title: view?.stage ? String(view.stage) : null });
        } catch {
          // A prompt shape we do not recognise just means no GUI context.
        }
        continue;
      }

      if (entry.type !== 'llm.planner.response.raw') continue;
      const call = entry.payload?.nativeToolCall;
      if (!call?.toolName) continue;
      const text = String(call.arguments?.assistantMessage ?? '').trim();
      if (!text) continue;
      const view = views.get(String(entry.payload?.requestId ?? ''));
      samples.push({
        gold: resolveCategoryFromTool(call.toolName) ?? 'respond',
        tool: call.toolName,
        text,
        visibleLabels: view?.labels ?? [],
        screenTitle: view?.title ?? null,
      });
    }
  }
  return samples;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function main(): void {
  if (!existsSync(TRACE_DIR)) {
    console.log(`no corpus at ${TRACE_DIR} — nothing to validate (this is expected on a clean checkout)`);
    return;
  }
  const samples = loadCorpus();
  if (samples.length === 0) {
    console.log('corpus present but contains no voice-on planner responses');
    return;
  }

  const labels: VoiceCategory[] = ['nav', 'select', 'view', 'respond'];
  const matrix = new Map<string, number>();
  let correct = 0;
  const misroutedConversation: Array<{ predicted: VoiceCategory; text: string }> = [];

  for (const sample of samples) {
    const predicted = classifyUtterance(sample.text).category;
    const key = `${sample.gold}|${predicted}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (predicted === sample.gold) correct += 1;
    if (sample.gold === 'respond' && predicted !== 'respond') {
      misroutedConversation.push({ predicted, text: sample.text });
    }
  }

  const withView = samples.filter((item) => item.visibleLabels.length > 0).length;
  console.log(
    `corpus: ${samples.length} utterances from ${readdirSync(TRACE_DIR).length} trace files` +
      ` (${withView} paired with the on-screen options at the time)`
  );
  console.log(`\naccuracy ${pct(correct / samples.length)}\n`);

  const head = ['gold\\pred'.padEnd(10), ...labels.map((l) => l.padStart(9)), 'recall'.padStart(9)];
  console.log(head.join(''));
  for (const gold of labels) {
    const row = labels.map((p) => matrix.get(`${gold}|${p}`) ?? 0);
    const total = row.reduce((a, b) => a + b, 0);
    const hit = matrix.get(`${gold}|${gold}`) ?? 0;
    console.log(
      [gold.padEnd(10), ...row.map((v) => String(v).padStart(9)), (total ? pct(hit / total) : '-').padStart(9)].join('')
    );
  }
  console.log();
  for (const predicted of labels) {
    const column = labels.reduce((sum, gold) => sum + (matrix.get(`${gold}|${predicted}`) ?? 0), 0);
    const hit = matrix.get(`${predicted}|${predicted}`) ?? 0;
    console.log(`  precision ${predicted.padEnd(8)} ${column ? pct(hit / column) : '-'}  (n=${column})`);
  }

  // The only error that costs the participant anything: real conversation
  // classified as narration AND containing no question, so the question floor
  // cannot save it.
  const silenceable = misroutedConversation.filter((item) => !item.text.includes('?'));
  console.log(
    `\nconversation misrouted to a narration category: ${misroutedConversation.length}` +
      `\n  ...with no question, i.e. genuinely silenceable: ${silenceable.length} of ${samples.length}` +
      ` (${pct(silenceable.length / samples.length)})`
  );
  for (const item of silenceable) console.log(`    [${item.predicted}] ${item.text}`);

  // Simulate each preset over the corpus so the panel's savings claims stay honest.
  console.log('\npreset simulation (spoken characters over the whole corpus):');
  const baseline = samples.reduce((sum, s) => sum + s.text.length, 0);
  const presets: Array<[string, VoiceVerbositySettings]> = [
    ['full', { preset: 'full', ...VOICE_VERBOSITY_PRESETS.full }],
    ['balanced (default)', DEFAULT_VOICE_VERBOSITY],
    ['minimal', { preset: 'minimal', ...VOICE_VERBOSITY_PRESETS.minimal }],
  ];
  for (const [name, settings] of presets) {
    let spoken = 0;
    let silenced = 0;
    let shortened = 0;
    const rules = new Map<string, number>();
    const recent: string[] = [];
    for (const sample of samples) {
      const classification = classifyUtterance(sample.text);
      const decision = decideVoiceOutput({
        text: sample.text,
        classification,
        settings,
        visibleLabels: sample.visibleLabels,
        screenTitle: sample.screenTitle,
        recentSpoken: recent,
        consecutiveCount: 0,
      });
      spoken += decision.spokenText.length;
      if (decision.rule) rules.set(decision.rule, (rules.get(decision.rule) ?? 0) + 1);
      if (decision.mode === 'silent') silenced += 1;
      else if (decision.spokenText !== sample.text) shortened += 1;
      if (decision.mode !== 'silent') {
        recent.push(sample.text);
        if (recent.length > RECENT_UTTERANCE_WINDOW) recent.shift();
      }
    }
    console.log(
      `  ${name.padEnd(20)} ${pct(1 - spoken / baseline).padStart(6)} quieter` +
        `   silenced ${String(silenced).padStart(4)}   shortened ${String(shortened).padStart(4)}` +
        `   waits removed ${pct(silenced / samples.length).padStart(6)}`
    );
    const byRule = [...rules.entries()].sort((a, b) => b[1] - a[1]);
    if (byRule.length > 0) {
      console.log(`    smart rules fired: ${byRule.map(([r, n]) => `${r} ${n}`).join(', ')}`);
    }
  }

  if (SHOW_ERRORS) {
    console.log('\nall misclassifications:');
    for (const sample of samples) {
      const predicted = classifyUtterance(sample.text).category;
      if (predicted !== sample.gold) {
        console.log(`  ${sample.gold} -> ${predicted} [${sample.tool}] ${sample.text.slice(0, 110)}`);
      }
    }
  }
}

main();
