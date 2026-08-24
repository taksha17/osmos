import type { AppSettings, AgentConfig, AgentSkill, AgentMcp, LlmProvider, SavedProfile } from './types.js';
import { DEFAULT_SAVED_PROFILE } from './types.js';

export function resolveAgent(
  profile: SavedProfile | null | undefined,
  settings: AppSettings | null | undefined,
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  const active = profile ?? DEFAULT_SAVED_PROFILE;
  const base: AgentConfig = {
    id: active.agent?.id ?? active.id,
    profileId: active.id,
    displayName: active.agent?.displayName ?? active.label ?? 'Default',
    systemPrompt: active.agent?.systemPrompt,
    skills: active.agent?.skills ?? [],
    mcp: active.agent?.mcp ?? [],
    preferredProvider: active.agent?.preferredProvider,
    preferredModel: active.agent?.preferredModel,
    temperature: active.agent?.temperature,
    maxTokens: active.agent?.maxTokens,
  };

  const merged = { ...base, ...overrides };

  if (!merged.preferredProvider && settings?.activeProvider) {
    merged.preferredProvider = settings.activeProvider;
  }
  if (!merged.preferredModel && settings?.activeProvider && settings?.providers?.[settings.activeProvider]?.model) {
    merged.preferredModel = settings.providers[settings.activeProvider].model;
  }

  return merged;
}

export function effectiveProvider(
  agent: AgentConfig,
  settings: AppSettings | null | undefined,
): { provider: LlmProvider; model: string } {
  const provider = agent.preferredProvider ?? settings?.activeProvider ?? 'ollama';
  const providerConfig = settings?.providers?.[provider];
  const model = agent.preferredModel ?? providerConfig?.model ?? '';
  return { provider, model };
}

export function renderSkillLabel(skill: AgentSkill): string {
  const map: Record<AgentSkill, string> = {
    'resume-review': 'Résumé review',
    'jd-parse': 'JD parsing',
    'company-research': 'Company research',
    'behavioral-answers': 'Behavioral answers',
    'technical-answers': 'Technical answers',
    'document-qa': 'Document Q&A',
    'meeting-notes': 'Meeting notes',
  };
  return map[skill] ?? skill;
}

export function renderMcpLabel(mcp: AgentMcp): string {
  return mcp.id ?? 'mcp';
}

export function allSupportedSkills(): AgentSkill[] {
  return [
    'resume-review',
    'jd-parse',
    'company-research',
    'behavioral-answers',
    'technical-answers',
    'document-qa',
    'meeting-notes',
  ];
}

export function allSupportedMcps(): AgentMcp[] {
  return [
    { id: 'github', enabled: false },
    { id: 'linkedin', enabled: false },
    { id: 'calendar', enabled: false },
  ];
}
