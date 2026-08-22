import type {
  CopilotMode,
  DocumentReference,
  QuestionBankItem,
  SavedProfile,
  StarTemplate,
  UserProfile,
} from './types';
import { DEFAULT_PROFILE, DEFAULT_SAVED_PROFILE } from './types';

export function toUserProfile(p: SavedProfile | UserProfile): UserProfile {
  return {
    displayName: p.displayName || '',
    resumeText: p.resumeText || '',
    jdText: p.jdText || '',
    notes: p.notes || '',
  };
}

export function normalizeSavedProfile(
  raw: Partial<SavedProfile> & { id?: string },
  fallbackId = `profile-${Date.now()}`,
): SavedProfile {
  const id = (raw.id || fallbackId).trim() || fallbackId;
  const displayName = (raw.displayName || '').trim();
  const label =
    (raw.label || '').trim() ||
    displayName ||
    DEFAULT_SAVED_PROFILE.label;
  return {
    id,
    label,
    displayName,
    resumeText: raw.resumeText || '',
    jdText: raw.jdText || '',
    notes: raw.notes || '',
    preferredMode: raw.preferredMode,
    companyName: raw.companyName || '',
    companyUrl: raw.companyUrl || '',
    companyIntel: raw.companyIntel || '',
    documents: Array.isArray(raw.documents) ? raw.documents : [],
    questions: Array.isArray(raw.questions) ? raw.questions : [],
    starTemplates: Array.isArray(raw.starTemplates) ? raw.starTemplates : [],
  };
}

export function createSavedProfile(partial?: Partial<SavedProfile>): SavedProfile {
  return normalizeSavedProfile({
    ...DEFAULT_PROFILE,
    preferredMode: 'interview',
    companyName: '',
    companyUrl: '',
    companyIntel: '',
    documents: [],
    questions: [],
    starTemplates: [],
    ...partial,
    id: partial?.id || `profile-${Date.now()}`,
    label: partial?.label || 'New profile',
  });
}

export function activeSavedProfile(
  profiles: SavedProfile[] | undefined,
  activeProfileId: string | undefined,
): SavedProfile {
  const list = profiles?.length ? profiles : [{ ...DEFAULT_SAVED_PROFILE }];
  return list.find((p) => p.id === activeProfileId) || list[0]!;
}

export function profileSummary(p: SavedProfile | UserProfile | null | undefined) {
  if (!p) {
    return {
      hasResume: false,
      hasJd: false,
      hasNotes: false,
      hasCompany: false,
      docCount: 0,
      questionCount: 0,
    };
  }
  const saved = p as SavedProfile;
  return {
    hasResume: Boolean(p.resumeText?.trim()),
    hasJd: Boolean(p.jdText?.trim()),
    hasNotes: Boolean(p.notes?.trim()),
    hasCompany: Boolean(saved.companyName?.trim() || saved.companyUrl?.trim() || saved.companyIntel?.trim()),
    docCount: Array.isArray(saved.documents) ? saved.documents.length : 0,
    questionCount: Array.isArray(saved.questions) ? saved.questions.length : 0,
  };
}

export function modeLabel(mode: CopilotMode | undefined) {
  if (mode === 'meeting') return 'Meeting';
  if (mode === 'general') return 'General';
  return 'Interview';
}

export function guessCompanyFromUrl(url: string): string {
  try {
    const host = new URL(url.trim()).hostname.replace(/^www\./i, '');
    const root = host.split('.')[0] || host;
    if (!root) return '';
    return root.charAt(0).toUpperCase() + root.slice(1);
  } catch {
    return '';
  }
}

export function patchActiveProfile(
  profiles: SavedProfile[],
  activeProfileId: string,
  patch: Partial<SavedProfile>,
): SavedProfile[] {
  return profiles.map((p) =>
    p.id === activeProfileId ? normalizeSavedProfile({ ...p, ...patch, id: p.id }) : p,
  );
}

export function activeDocuments(settings: {
  profiles?: SavedProfile[];
  activeProfileId?: string;
  documents?: DocumentReference[];
}): DocumentReference[] {
  const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
  if (active.documents?.length) return active.documents;
  return settings.documents || [];
}

export function activeQuestions(settings: {
  profiles?: SavedProfile[];
  activeProfileId?: string;
}): QuestionBankItem[] {
  return activeSavedProfile(settings.profiles, settings.activeProfileId).questions || [];
}

export function activeStarTemplates(settings: {
  profiles?: SavedProfile[];
  activeProfileId?: string;
}): StarTemplate[] {
  return activeSavedProfile(settings.profiles, settings.activeProfileId).starTemplates || [];
}
