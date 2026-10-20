/**
 * The planner models a visitor may pick from the settings sheet.
 *
 * This file is deliberately free of Node imports: the frontend keeps a
 * byte-for-byte copy at apps/frontend/src/agent/plannerModels.ts (it cannot
 * import across apps at build time), and
 * apps/frontend/src/agent/plannerModels.check.ts fails `npm run check` the
 * moment the two drift. Edit both, in the same change.
 *
 * The list is an allow-list, not a suggestion: the agent refuses any id that
 * is not here (see modelSelection.ts), so a visitor at a public booth cannot
 * type an arbitrary model string onto the operator's key.
 *
 * Model facts below come from the OpenAI model docs as of 2026-10-17
 * (developers.openai.com/api/docs/guides/latest-model). The one that matters
 * to the request body is `supportsNoneReasoning`: GPT-6.1 Sol (and GPT-6
 * Astra) reject `reasoning.effort: "none"`, and once reasoning is active the
 * API also rejects `temperature`. modelSelection.ts adjusts both.
 *
 * GPT-6 Astra is deliberately NOT offered. Measured on 2026-10-17 with
 * scripts/planner-latency.ts it was the dearest option, ran at `low` effort
 * (~3s a turn against Terra's ~1.6s), and two of five requests never returned
 * -- a hung planner call is a frozen booth. Add it back only with a timeout
 * around the planner fetch.
 */

export interface PlannerModelOption {
  id: string;
  label: string;
  /**
   * One line for the settings sheet, per session language. English is
   * required; any other language reads in English until its line is written.
   * Keyed by the language code as a plain string because the agent's copy of
   * this file cannot import the frontend's `Language` type.
   */
  descriptions: { readonly en: string; readonly [language: string]: string | undefined };
  /**
   * Whether the model accepts `reasoning.effort: "none"`, which is what the
   * planner sends by default. False means the lowest legal rung is `low`.
   */
  supportsNoneReasoning: boolean;
}

// MACHINE-DRAFTED: the ja, zh-Hans and zh-Hant descriptions need native review.
export const PLANNER_MODEL_OPTIONS: readonly PlannerModelOption[] = [
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    descriptions: {
      en: 'Default. Matched the study model’s tool choice in replay at ~20% lower cost.',
      ko: '기본값. 재생 검증에서 스터디 모델의 툴 선택과 일치했고 비용은 약 20% 낮습니다.',
      ja: '既定。リプレイ検証で研究用モデルとツール選択が一致し、コストは約20%低くなります。',
      'zh-Hans': '默认。在回放验证中与研究所用模型的工具选择一致，成本约低 20%。',
      'zh-Hant': '預設。在重播驗證中與研究所用模型的工具選擇一致，成本約低 20%。',
    },
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    descriptions: {
      en: 'The model the published user study ran on.',
      ko: '발표된 사용자 스터디가 돌았던 모델입니다.',
      ja: '公開されたユーザースタディで使われたモデルです。',
      'zh-Hans': '已发表的用户研究所使用的模型。',
      'zh-Hant': '已發表的使用者研究所使用的模型。',
    },
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    descriptions: {
      en: 'GPT-5.6 flagship. Scored the same as Terra in replay, at twice the cost.',
      ko: 'GPT-5.6 플래그십. 재생 검증 점수는 Terra와 같았고 비용은 두 배입니다.',
      ja: 'GPT-5.6 のフラッグシップ。リプレイ検証のスコアは Terra と同じで、コストは2倍です。',
      'zh-Hans': 'GPT-5.6 旗舰模型。回放验证得分与 Terra 相同，成本是其两倍。',
      'zh-Hant': 'GPT-5.6 旗艦模型。重播驗證分數與 Terra 相同，成本是其兩倍。',
    },
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    descriptions: {
      en: 'Fastest and cheapest GPT-6, built for focused high-volume tasks.',
      ko: '가장 빠르고 저렴한 GPT-6. 집중된 대량 작업용입니다.',
      ja: '最速かつ最安の GPT-6。目的の絞られた大量処理向けです。',
      'zh-Hans': '最快、最便宜的 GPT-6，适合目标明确的大批量任务。',
      'zh-Hant': '最快、最便宜的 GPT-6，適合目標明確的大量任務。',
    },
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    descriptions: {
      en: 'GPT-6 for complex coding and agentic workflows.',
      ko: '복잡한 코딩과 에이전트 작업을 위한 GPT-6입니다.',
      ja: '複雑なコーディングとエージェント型ワークフロー向けの GPT-6 です。',
      'zh-Hans': '面向复杂编程和智能体工作流的 GPT-6。',
      'zh-Hant': '適用於複雜程式設計與代理程式工作流程的 GPT-6。',
    },
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    descriptions: {
      en: 'Near-Astra quality at lower cost. Always reasons (no "none" effort), so each turn is slower.',
      ko: 'Astra에 가까운 품질을 더 낮은 비용에. 항상 추론하므로("none" 불가) 턴마다 느립니다.',
      ja: 'Astra に近い品質をより低コストで。常に推論するため（"none" 不可）、ターンごとに遅くなります。',
      'zh-Hans': '以更低成本获得接近 Astra 的质量。始终进行推理（不支持 "none"），因此每轮较慢。',
      'zh-Hant': '以更低成本獲得接近 Astra 的品質。一律進行推理（不支援 "none"），因此每輪較慢。',
    },
    supportsNoneReasoning: false,
  },
];

export const DEFAULT_PLANNER_MODEL = 'gpt-5.6-terra';

export type PlannerModelId = (typeof PLANNER_MODEL_OPTIONS)[number]['id'];

/** The option's line in `language`, or in English when there is none yet. */
export function plannerModelDescription(option: PlannerModelOption, language: string): string {
  return option.descriptions[language] ?? option.descriptions.en;
}

export function findPlannerModelOption(id: string): PlannerModelOption | undefined {
  return PLANNER_MODEL_OPTIONS.find((option) => option.id === id);
}

export function isPlannerModelId(value: unknown): value is string {
  return typeof value === 'string' && findPlannerModelOption(value) !== undefined;
}
