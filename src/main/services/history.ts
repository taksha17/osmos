import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChatSession } from '../../shared/types.js';

const HISTORY_FILE = 'chat-history.json';

function historyPath() {
  return path.join(app.getPath('userData'), HISTORY_FILE);
}

export function loadHistory(): ChatSession[] {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf-8');
    const data = JSON.parse(raw) as ChatSession[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveHistory(sessions: ChatSession[]): void {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify(sessions, null, 2), 'utf-8');
  } catch {
    // ignore write errors
  }
}

export function upsertSession(session: ChatSession): ChatSession[] {
  const all = loadHistory();
  const idx = all.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    all[idx] = session;
  } else {
    all.push(session);
  }
  saveHistory(all);
  return all;
}

export function deleteSession(id: string): ChatSession[] {
  const all = loadHistory().filter((s) => s.id !== id);
  saveHistory(all);
  return all;
}

export function clearAllHistory(): ChatSession[] {
  saveHistory([]);
  return [];
}
