import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  QuestionBankItem,
  QuestionBankResponse,
  StarTemplate,
  StarTemplatesResponse,
} from '../../shared/types.js';
import { getSettings, updateSettings } from './settingsStore.js';
import { activeSavedProfile, normalizeSavedProfile } from '../../shared/profiles.js';

const QUESTION_BANK_FILE = 'question-bank.json';
const STAR_TEMPLATES_FILE = 'star-templates.json';

function questionBankPath() {
  return path.join(app.getPath('userData'), QUESTION_BANK_FILE);
}

function starTemplatesPath() {
  return path.join(app.getPath('userData'), STAR_TEMPLATES_FILE);
}

function readJsonFile<T>(filePath: string, fallback: T[]): T[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

/** One-time: pull legacy global files into the active profile if empty. */
export function migrateLegacyBanksIntoActiveProfile(): void {
  const settings = getSettings();
  const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
  const legacyQ = readJsonFile<QuestionBankItem>(questionBankPath(), []);
  const legacyS = readJsonFile<StarTemplate>(starTemplatesPath(), []);
  if (!legacyQ.length && !legacyS.length) return;
  if ((active.questions?.length || 0) > 0 || (active.starTemplates?.length || 0) > 0) return;

  const profiles = (settings.profiles || []).map((p) =>
    p.id === active.id
      ? normalizeSavedProfile({
          ...p,
          questions: legacyQ,
          starTemplates: legacyS,
        })
      : p,
  );
  updateSettings({ profiles, activeProfileId: active.id });
}

export function loadQuestionBank(): QuestionBankItem[] {
  const s = getSettings();
  return activeSavedProfile(s.profiles, s.activeProfileId).questions || [];
}

export function addQuestionBankItem(item: QuestionBankItem): QuestionBankResponse {
  const s = getSettings();
  const active = activeSavedProfile(s.profiles, s.activeProfileId);
  const items = [...(active.questions || []), item];
  const profiles = (s.profiles || []).map((p) =>
    p.id === active.id ? normalizeSavedProfile({ ...p, questions: items }) : p,
  );
  updateSettings({ profiles, activeProfileId: active.id });
  return { ok: true, items };
}

export function deleteQuestionBankItem(id: string): QuestionBankResponse {
  const s = getSettings();
  const active = activeSavedProfile(s.profiles, s.activeProfileId);
  const items = (active.questions || []).filter((item) => item.id !== id);
  const profiles = (s.profiles || []).map((p) =>
    p.id === active.id ? normalizeSavedProfile({ ...p, questions: items }) : p,
  );
  updateSettings({ profiles, activeProfileId: active.id });
  return { ok: true, items };
}

export function loadStarTemplates(): StarTemplate[] {
  const s = getSettings();
  return activeSavedProfile(s.profiles, s.activeProfileId).starTemplates || [];
}

export function addStarTemplate(template: StarTemplate): StarTemplatesResponse {
  const s = getSettings();
  const active = activeSavedProfile(s.profiles, s.activeProfileId);
  const templates = [...(active.starTemplates || []), template];
  const profiles = (s.profiles || []).map((p) =>
    p.id === active.id ? normalizeSavedProfile({ ...p, starTemplates: templates }) : p,
  );
  updateSettings({ profiles, activeProfileId: active.id });
  return { ok: true, templates };
}

export function deleteStarTemplate(id: string): StarTemplatesResponse {
  const s = getSettings();
  const active = activeSavedProfile(s.profiles, s.activeProfileId);
  const templates = (active.starTemplates || []).filter((t) => t.id !== id);
  const profiles = (s.profiles || []).map((p) =>
    p.id === active.id ? normalizeSavedProfile({ ...p, starTemplates: templates }) : p,
  );
  updateSettings({ profiles, activeProfileId: active.id });
  return { ok: true, templates };
}
