/**
 * The planner-model catalog exists twice -- apps/tuning-agent/src/llm and
 * apps/frontend/src/agent -- because neither app can import the other at build
 * time. This check fails the moment they differ, so a model added on one side
 * cannot be offered in the sheet without the agent accepting it, or vice versa.
 *
 *   npx tsx apps/frontend/src/agent/plannerModels.check.ts
 */
import fs from 'fs';
import path from 'path';
import * as frontendModule from './plannerModels';
import * as agentModule from '../../../tuning-agent/src/llm/plannerModels';

// The agent package is CommonJS and the frontend is ESM, so under tsx one of
// the two namespaces may arrive wrapped in `default`. Unwrap either.
type Catalog = typeof frontendModule;
function unwrap(mod: unknown): Catalog {
  const record = mod as { default?: Catalog } & Catalog;
  return record.PLANNER_MODEL_OPTIONS ? record : (record.default as Catalog);
}
const frontend = unwrap(frontendModule);
const agent = unwrap(agentModule);

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
const frontendSource = fs.readFileSync(path.join(here, 'plannerModels.ts'), 'utf-8');
const agentSource = fs.readFileSync(
  path.join(here, '../../../tuning-agent/src/llm/plannerModels.ts'),
  'utf-8'
);

console.log('\nPLANNER MODEL CATALOG — one list, two copies');
check('source files are byte-identical', frontendSource === agentSource);
check(
  'same option ids in the same order',
  JSON.stringify(frontend.PLANNER_MODEL_OPTIONS.map((o) => o.id)) ===
    JSON.stringify(agent.PLANNER_MODEL_OPTIONS.map((o) => o.id))
);
check('same default', frontend.DEFAULT_PLANNER_MODEL === agent.DEFAULT_PLANNER_MODEL);
check(
  'default is on the list',
  agent.isPlannerModelId(agent.DEFAULT_PLANNER_MODEL),
  agent.DEFAULT_PLANNER_MODEL
);
check(
  'ids are unique',
  new Set(agent.PLANNER_MODEL_OPTIONS.map((o) => o.id)).size === agent.PLANNER_MODEL_OPTIONS.length
);
check(
  'GPT-6.1 Sol is marked as not supporting "none"',
  agent.PLANNER_MODEL_OPTIONS.filter((o) => o.id === 'gpt-6.1-sol').every(
    (o) => o.supportsNoneReasoning === false
  )
);
check(
  'GPT-6 Astra stays off the list (cost, and it hung 2 of 5 planner calls)',
  !agent.isPlannerModelId('gpt-6-astra')
);

console.log(failures === 0 ? '\nPlanner model catalog checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
