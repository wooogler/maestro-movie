export interface StudyModeConfig {
  agentEnabled: boolean;
  guiAdaptationEnabled: boolean;
  cpMemoryWindow: number;
  voiceModeAvailable: boolean;
}

export interface ConditionSelectionOption {
  id: StudyModeId;
  code: string;
  summary: string;
}

export type InterfaceConditionId = 'interface-a' | 'interface-b';
export type InteractionModeId = 'text' | 'voice';
const VISIBLE_STUDY_MODE_OPTIONS = [
  {
    id: 'basic-tuning-voice-off',
    label: 'C1: Interface A x Text Mode',
    description: 'C1: Interface A x Text Mode',
    config: {
      agentEnabled: true,
      guiAdaptationEnabled: false,
      cpMemoryWindow: 0,
      voiceModeAvailable: false,
    },
  },
  {
    id: 'basic-tuning-voice-on',
    label: 'C3: Interface A x Voice Mode',
    description: 'C3: Interface A x Voice Mode',
    config: {
      agentEnabled: true,
      guiAdaptationEnabled: false,
      cpMemoryWindow: 0,
      voiceModeAvailable: true,
    },
  },
  {
    id: 'full-tuning-voice-off',
    label: 'C2: Interface B x Text Mode',
    description: 'C2: Interface B x Text Mode',
    config: {
      agentEnabled: true,
      guiAdaptationEnabled: true,
      cpMemoryWindow: 10,
      voiceModeAvailable: false,
    },
  },
  {
    id: 'full-tuning-voice-on',
    label: 'C4: Interface B x Voice Mode',
    description: 'C4: Interface B x Voice Mode',
    config: {
      agentEnabled: true,
      guiAdaptationEnabled: true,
      cpMemoryWindow: 10,
      voiceModeAvailable: true,
    },
  },
] as const;

// Public demo condition. Intentionally kept out of VISIBLE_STUDY_MODE_OPTIONS and
// CONDITION_SELECTION_OPTIONS so it never shows up in the study condition pickers:
// demo is entered through its own route/toggle instead.
const DEMO_STUDY_MODE_OPTIONS = [
  {
    id: 'demo',
    label: 'Public Demo',
    description: 'Public demo: full TUNING experience, no participant ID, no logging.',
    config: {
      agentEnabled: true,
      guiAdaptationEnabled: true,
      cpMemoryWindow: 10,
      voiceModeAvailable: true,
    },
  },
] as const;

const ALL_STUDY_MODE_OPTIONS = [
  ...VISIBLE_STUDY_MODE_OPTIONS,
  ...DEMO_STUDY_MODE_OPTIONS,
] as const;

export type StudyModeId = (typeof ALL_STUDY_MODE_OPTIONS)[number]['id'];

export const DEMO_STUDY_MODE: StudyModeId = 'demo';

export function isDemoStudyMode(id: string | null | undefined): boolean {
  return id === DEMO_STUDY_MODE;
}

const ALL_CONDITION_SELECTION_OPTIONS: readonly ConditionSelectionOption[] = [
  {
    id: 'basic-tuning-voice-off',
    code: 'C1',
    summary: 'Interface A x Text Mode',
  },
  {
    id: 'full-tuning-voice-off',
    code: 'C2',
    summary: 'Interface B x Text Mode',
  },
  {
    id: 'basic-tuning-voice-on',
    code: 'C3',
    summary: 'Interface A x Voice Mode',
  },
  {
    id: 'full-tuning-voice-on',
    code: 'C4',
    summary: 'Interface B x Voice Mode',
  },
] as const;

export const STUDY_MODE_OPTIONS = VISIBLE_STUDY_MODE_OPTIONS;

export const CONDITION_SELECTION_OPTIONS: readonly ConditionSelectionOption[] =
  ALL_CONDITION_SELECTION_OPTIONS;

export const DEFAULT_STUDY_MODE: StudyModeId = 'basic-tuning-voice-off';

/**
 * The demo runs one open world. There is no picker: the printed cards carry the
 * suggested scenarios, and a visitor is free to ignore them.
 */
export const DEMO_SCENARIO_ID = 'demo_open_booking';

export function sanitizeSetupStudyMode(mode: StudyModeId): StudyModeId {
  return mode;
}

export function normalizeStudyMode(id: string | null | undefined): StudyModeId {
  return ALL_STUDY_MODE_OPTIONS.find((item) => item.id === id)?.id ?? DEFAULT_STUDY_MODE;
}

export function getStudyModeOption(id: string) {
  const normalized = normalizeStudyMode(id);
  return ALL_STUDY_MODE_OPTIONS.find((item) => item.id === normalized) ?? ALL_STUDY_MODE_OPTIONS[0];
}

export function getStudyModeLabel(id: string): string {
  return getStudyModeOption(id).label;
}

export function getStudyModeConfig(id: string): StudyModeConfig {
  return getStudyModeOption(id).config;
}

export function getInterfaceCondition(id: string): InterfaceConditionId {
  const normalized = normalizeStudyMode(id);
  switch (normalized) {
    case 'basic-tuning-voice-off':
    case 'basic-tuning-voice-on':
      return 'interface-a';
    case 'demo':
      // Demo mirrors the Interface B (full tuning) experience.
      return 'interface-b';
    default:
      return 'interface-b';
  }
}

export function getInteractionMode(id: string): InteractionModeId {
  const normalized = normalizeStudyMode(id);
  // Demo starts in text and lets the visitor turn voice on from the composer
  // (its config keeps voiceModeAvailable = true), so it is not a voice-locked mode.
  if (normalized === 'demo') return 'text';
  return normalized.endsWith('voice-on') ? 'voice' : 'text';
}

export function getStudyModeFromConditionSelection(
  interfaceCondition: InterfaceConditionId,
  interactionMode: InteractionModeId
): StudyModeId {
  if (interfaceCondition === 'interface-a') {
    return interactionMode === 'voice'
      ? 'basic-tuning-voice-on'
      : 'basic-tuning-voice-off';
  }
  return interactionMode === 'voice'
    ? 'full-tuning-voice-on'
    : 'full-tuning-voice-off';
}
