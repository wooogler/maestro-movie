import type {
  ScenarioDatasetShowing,
  ScenarioSeatOverride,
  ScenarioSeatTemplate,
  ScenarioSeatTemplateOverride,
} from '../study/scenarioDataset';

type SeatType = 'standard' | 'premium' | 'couple';
type SeatStatus = 'available' | 'occupied';

export interface ScenarioSeatRow {
  id: string;
  showingId: string;
  row: string;
  number: number;
  type: SeatType;
  price: number;
  status: SeatStatus;
}

interface SeatOverrideAccumulator {
  occupiedNumbers: Set<number>;
  availableNumbers: Set<number>;
}

function keyForOverride(showingId: string, row: string): string {
  return `${showingId}::${row}`;
}

function buildOverrideMap(overrides: ScenarioSeatOverride[]): Map<string, SeatOverrideAccumulator> {
  const map = new Map<string, SeatOverrideAccumulator>();

  for (const override of overrides) {
    const key = keyForOverride(override.showingId, override.row);
    const current = map.get(key) ?? {
      occupiedNumbers: new Set<number>(),
      availableNumbers: new Set<number>(),
    };

    for (const number of override.occupiedNumbers ?? []) {
      current.occupiedNumbers.add(number);
    }
    for (const number of override.availableNumbers ?? []) {
      current.availableNumbers.add(number);
    }

    map.set(key, current);
  }

  return map;
}

export function buildScenarioSeats(
  showings: ScenarioDatasetShowing[],
  seatTemplate: ScenarioSeatTemplate,
  seatOverrides: ScenarioSeatOverride[],
  seatTemplateOverrides: ScenarioSeatTemplateOverride[] = []
): ScenarioSeatRow[] {
  // Row rules are cached per layout: resolving them per seat would rebuild the
  // same map for every row of every showing.
  const rowRuleCache = new Map<ScenarioSeatTemplate, Map<string, { type?: SeatType; price?: number }>>();
  const rowRulesFor = (template: ScenarioSeatTemplate) => {
    const cached = rowRuleCache.get(template);
    if (cached) return cached;
    const built = new Map((template.rowRules ?? []).map((rule) => [rule.row, rule]));
    rowRuleCache.set(template, built);
    return built;
  };

  const templateByTheaterId = new Map(
    seatTemplateOverrides.map((override) => [override.theaterId, override as ScenarioSeatTemplate])
  );
  const overrideMap = buildOverrideMap(seatOverrides);

  const seats: ScenarioSeatRow[] = [];

  for (const showing of showings) {
    const template = templateByTheaterId.get(showing.theaterId) ?? seatTemplate;
    const rowRuleMap = rowRulesFor(template);
    const defaultStatus = template.defaultStatus ?? 'available';
    const seatsPerShowing = template.rows.length * template.seatsPerRow;

    if (showing.totalSeats !== seatsPerShowing) {
      throw new Error(
        `[${showing.id}] totalSeats=${showing.totalSeats} does not match template seats=${seatsPerShowing}`
      );
    }

    for (const row of template.rows) {
      const rowRule = rowRuleMap.get(row);
      const type = (rowRule?.type ?? template.defaultType) as SeatType;
      const price = rowRule?.price ?? template.defaultPrice;
      const override = overrideMap.get(keyForOverride(showing.id, row));

      for (let number = 1; number <= template.seatsPerRow; number++) {
        let status: SeatStatus = defaultStatus;

        if (override?.occupiedNumbers.has(number)) {
          status = 'occupied';
        }
        if (override?.availableNumbers.has(number)) {
          status = 'available';
        }

        seats.push({
          id: `${showing.id}-${row}${number}`,
          showingId: showing.id,
          row,
          number,
          type,
          price,
          status,
        });
      }
    }
  }

  return seats;
}
