import type {
  AgentConflictScope,
  AgentMemorySnapshot,
  AgentStageBinding,
} from '../../agent/protocol';

export const MEMORY_STAGE_ORDER = ['movie', 'theater', 'date', 'time', 'seat', 'confirm'] as const;

export type MemoryStage = (typeof MEMORY_STAGE_ORDER)[number];

export const MEMORY_STAGE_LABELS: Record<MemoryStage, string> = {
  movie: 'Movie',
  theater: 'Theater',
  date: 'Date',
  time: 'Showtime',
  seat: 'Seat',
  confirm: 'Confirm',
};

/**
 * The step names per session language: the stage words on a preference chip,
 * where space is scarce, and the workflow graph. Kept to the booking stepper's
 * own words so the chip and the stepper above it name a step the same way.
 * A language with no table reads in English — de, fr and es, whose UI is still
 * English.
 */
const MEMORY_STAGE_LABELS_BY_LANGUAGE: Readonly<Record<string, Record<MemoryStage, string>>> = {
  ko: {
    movie: '영화',
    theater: '극장',
    date: '날짜',
    time: '시간',
    seat: '좌석',
    confirm: '확인',
  },
  // MACHINE-DRAFTED — ja, zh-Hans and zh-Hant need native review.
  ja: {
    movie: '映画',
    theater: '映画館',
    date: '日付',
    time: '上映時間',
    seat: '座席',
    confirm: '確認',
  },
  'zh-Hans': {
    movie: '电影',
    theater: '影院',
    date: '日期',
    time: '场次',
    seat: '座位',
    confirm: '确认',
  },
  'zh-Hant': {
    movie: '電影',
    theater: '戲院',
    date: '日期',
    time: '場次',
    seat: '座位',
    confirm: '確認',
  },
};

/** The stage's name in the session language. */
export function memoryStageLabel(stage: MemoryStage, language: string): string {
  return (MEMORY_STAGE_LABELS_BY_LANGUAGE[language] ?? MEMORY_STAGE_LABELS)[stage];
}

export function isMemoryStage(value: string): value is MemoryStage {
  return (MEMORY_STAGE_ORDER as readonly string[]).includes(value);
}

/** Which committed-workflow key holds the selection made at a stage. */
const STAGE_COMMIT_KEY: Record<MemoryStage, string> = {
  movie: 'movie',
  theater: 'theater',
  date: 'date',
  time: 'showing',
  seat: 'seats',
  confirm: 'seats',
};

function readField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function describeSelection(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => describeSelection(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const seatLabel = readField(record, ['label', 'seatNumber']);
    const row = readField(record, ['row']);
    if (row && seatLabel) return `${row}${seatLabel}`;
    return readField(record, [
      'title',
      'name',
      'displayText',
      'time',
      'date',
      'value',
      'label',
      'id',
    ]);
  }
  return null;
}

/** The value the agent has locked in at a stage, formatted for display. */
export function readCommittedSelection(
  snapshot: AgentMemorySnapshot | null,
  stage: MemoryStage
): string | null {
  const committed = snapshot?.committedWorkflow;
  if (!committed) return null;
  return describeSelection(committed[STAGE_COMMIT_KEY[stage]]);
}

export function describeScope(scope: AgentConflictScope): string {
  const parts = [scope.movie, scope.theater, scope.date, scope.showing].filter(
    (part): part is string => Boolean(part && part.trim())
  );
  return parts.join(' · ');
}

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  contains: 'contains',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  in: 'in',
};

export function describeFilter(filter: AgentStageBinding['filters'][number]): string {
  const operator = OPERATOR_LABELS[filter.operator] ?? filter.operator;
  const value = Array.isArray(filter.value)
    ? filter.value.map((entry) => String(entry)).join(', ')
    : String(filter.value ?? '');
  return `${filter.field} ${operator} ${value}`;
}
