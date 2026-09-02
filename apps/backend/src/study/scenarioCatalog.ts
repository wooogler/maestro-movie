import fs from 'fs';
import path from 'path';
import type { ScenarioDefinition, ScenarioStepBriefs } from './types';

interface ScenarioCatalogFile {
  scenarios?: ScenarioDefinition[];
}

function readSeatRows(catalogPath: string, seedDataFile: string): string[] | undefined {
  const seedDataPath = path.resolve(path.dirname(catalogPath), seedDataFile);
  if (!fs.existsSync(seedDataPath)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(seedDataPath, 'utf-8')) as {
      seatTemplate?: { rows?: unknown };
    };
    const rows = Array.isArray(parsed.seatTemplate?.rows)
      ? parsed.seatTemplate.rows.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : [];
    return rows.length > 0 ? rows : undefined;
  } catch {
    return undefined;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A generated dataset states the day it is set on. Reading it here keeps that
 * one fact in one place: the generator's world spec. Without it the calendar
 * falls back to FIXED_CURRENT_DATE, which is right only for the study worlds.
 */
function readDatasetClock(
  catalogPath: string,
  seedDataFile: string
): { todayIso?: string; dateWindowDays?: number } {
  const seedDataPath = path.resolve(path.dirname(catalogPath), seedDataFile);
  if (!fs.existsSync(seedDataPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(seedDataPath, 'utf-8')) as {
      todayIso?: unknown;
      dateCount?: unknown;
    };
    const todayIso =
      typeof parsed.todayIso === 'string' && DATE_PATTERN.test(parsed.todayIso.trim())
        ? parsed.todayIso.trim()
        : undefined;
    const dateWindowDays =
      typeof parsed.dateCount === 'number' && Number.isInteger(parsed.dateCount) && parsed.dateCount > 0
        ? parsed.dateCount
        : undefined;
    return {
      ...(todayIso ? { todayIso } : {}),
      ...(dateWindowDays ? { dateWindowDays } : {}),
    };
  } catch {
    return {};
  }
}

function readStepBriefs(value: unknown): ScenarioStepBriefs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const stepBriefs: ScenarioStepBriefs = {};

  for (const key of ['movie', 'theater', 'date', 'time', 'seat', 'confirm'] as const) {
    const rawValue = record[key];
    if (typeof rawValue !== 'string') continue;
    const normalized = rawValue.trim();
    if (!normalized) continue;
    stepBriefs[key] = normalized;
  }

  return Object.keys(stepBriefs).length > 0 ? stepBriefs : undefined;
}

function getCatalogCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'apps/backend/scenarios/catalog.json'),
    path.resolve(process.cwd(), 'scenarios/catalog.json'),
    path.resolve(__dirname, '../../scenarios/catalog.json'),
  ];
}

export function resolveScenarioCatalogPath(): string {
  for (const candidate of getCatalogCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return getCatalogCandidates()[0];
}

export function resolveScenarioTemplateDir(): string {
  const catalogPath = resolveScenarioCatalogPath();
  return path.resolve(path.dirname(catalogPath), 'db-templates');
}

function validateScenario(raw: unknown, catalogPath: string): ScenarioDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const background = typeof record.background === 'string' ? record.background.trim() : '';
  const story = typeof record.story === 'string' ? record.story.trim() : '';
  const stepBriefs = readStepBriefs(record.stepBriefs);
  const templateDbFile =
    typeof record.templateDbFile === 'string' ? record.templateDbFile.trim() : '';
  const seedDataFile =
    typeof record.seedDataFile === 'string' ? record.seedDataFile.trim() : '';
  const narratorPreferenceTypes = Array.isArray(record.narratorPreferenceTypes)
    ? record.narratorPreferenceTypes.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      )
    : [];

  if (!id || !title || !story || !templateDbFile || narratorPreferenceTypes.length === 0) {
    return null;
  }

  const seatRows =
    Array.isArray(record.seatRows) &&
    record.seatRows.every((item) => typeof item === 'string' && item.trim().length > 0)
      ? (record.seatRows as string[]).map((item) => item.trim())
      : seedDataFile
        ? readSeatRows(catalogPath, seedDataFile)
        : undefined;

  let seedFilters: ScenarioDefinition['seedFilters'] | undefined;
  const rawSeedFilters = record.seedFilters;
  if (rawSeedFilters && typeof rawSeedFilters === 'object' && !Array.isArray(rawSeedFilters)) {
    const seedRecord = rawSeedFilters as Record<string, unknown>;
    const includeMovieIds = Array.isArray(seedRecord.includeMovieIds)
      ? seedRecord.includeMovieIds.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : undefined;
    const includeTheaterIds = Array.isArray(seedRecord.includeTheaterIds)
      ? seedRecord.includeTheaterIds.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : undefined;
    seedFilters = {
      includeMovieIds,
      includeTheaterIds,
    };
  }

  // An explicit catalog entry wins over the dataset, so a scenario can be moved
  // in time without regenerating it.
  const datasetClock = seedDataFile ? readDatasetClock(catalogPath, seedDataFile) : {};
  const todayIso =
    typeof record.todayIso === 'string' && DATE_PATTERN.test(record.todayIso.trim())
      ? record.todayIso.trim()
      : datasetClock.todayIso;
  const dateWindowDays =
    typeof record.dateWindowDays === 'number' &&
    Number.isInteger(record.dateWindowDays) &&
    record.dateWindowDays > 0
      ? record.dateWindowDays
      : datasetClock.dateWindowDays;

  return {
    id,
    title,
    ...(background ? { background } : {}),
    story,
    ...(stepBriefs ? { stepBriefs } : {}),
    narratorPreferenceTypes,
    ...(seatRows ? { seatRows } : {}),
    templateDbFile,
    ...(seedDataFile ? { seedDataFile } : {}),
    seedFilters,
    ...(todayIso ? { todayIso } : {}),
    ...(dateWindowDays ? { dateWindowDays } : {}),
  };
}

function loadCatalogFromDisk(): ScenarioDefinition[] {
  const catalogPath = resolveScenarioCatalogPath();
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Scenario catalog not found: ${catalogPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')) as ScenarioCatalogFile;
  const scenarios = Array.isArray(parsed.scenarios)
    ? parsed.scenarios
        .map((scenario) => validateScenario(scenario, catalogPath))
        .filter((item): item is ScenarioDefinition => item !== null)
    : [];

  if (scenarios.length === 0) {
    throw new Error(`Scenario catalog has no valid scenarios: ${catalogPath}`);
  }

  const duplicate = scenarios.find(
    (scenario, index) => scenarios.findIndex((candidate) => candidate.id === scenario.id) !== index
  );
  if (duplicate) {
    throw new Error(`Duplicate scenario id in catalog: ${duplicate.id}`);
  }

  return scenarios;
}

let cachedScenarios: ScenarioDefinition[] | null = null;

export function getScenarioCatalog(forceReload = false): ScenarioDefinition[] {
  if (!cachedScenarios || forceReload) {
    cachedScenarios = loadCatalogFromDisk();
  }
  return cachedScenarios;
}

export function getScenarioById(scenarioId: string): ScenarioDefinition | null {
  const normalized = scenarioId.trim();
  return getScenarioCatalog().find((scenario) => scenario.id === normalized) ?? null;
}

export function getScenarioTemplatePath(scenario: ScenarioDefinition): string {
  return path.resolve(resolveScenarioTemplateDir(), scenario.templateDbFile);
}
