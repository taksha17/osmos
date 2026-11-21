#!/usr/bin/env node
/**
 * Phase 5 exit check: run the real migration planner over the real v0.6 files.
 *
 *   node --experimental-strip-types scripts/memory-dry-run.mjs
 *   node --experimental-strip-types scripts/memory-dry-run.mjs --history <chat-history.json> --settings <settings.json>
 *
 * Reads only. Prints what would be written (counts, ids by kind, and everything
 * the planner refused with its reason) so the migration can be judged against the
 * user's actual data before any store exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planMemoryMigration } from '../src/shared/policy/memoryMigration.ts';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(file) {
  if (!fs.existsSync(file)) return { file, state: 'absent' };
  try {
    return { file, state: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (error) {
    return { file, state: 'unreadable', error: error.message };
  }
}

function defaultDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'osmos');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'osmos');
  }
  return path.join(os.homedir(), '.config', 'osmos');
}

const dir = defaultDir();
const historyFile = arg('history') || path.join(dir, 'chat-history.json');
const settingsFile = arg('settings') || path.join(dir, 'osmos-settings.json');

const history = readJson(historyFile);
const settings = readJson(settingsFile);

for (const entry of [history, settings]) {
  if (entry.state === 'unreadable') {
    console.error(`[dry-run] cannot parse ${entry.file}: ${entry.error}`);
  }
}

if (history.state !== 'ok' && settings.state !== 'ok') {
  console.error(`[dry-run] no legacy files found in ${dir}`);
  process.exit(2);
}

const sessions = Array.isArray(history.value) ? history.value : [];
// electron-store wraps our state one level down: { settings: AppSettings }.
const appSettings = settings.value?.settings ?? settings.value;
const profiles = Array.isArray(appSettings?.profiles) ? appSettings.profiles : [];

const describe = (entry, count, unit) =>
  entry.state === 'ok' ? `${entry.file} (${count} ${unit})` : `${entry.file} (${entry.state})`;
console.log(`[dry-run] history:  ${describe(history, sessions.length, 'sessions')}`);
console.log(`[dry-run] settings: ${describe(settings, profiles.length, 'profiles')}`);

const plan = planMemoryMigration({ sessions, profiles });

console.log('[dry-run] records:', plan.counts);
console.log(`[dry-run] total: ${plan.records.length}`);

const sample = plan.records.slice(0, 3);
for (const record of sample) {
  console.log(`[dry-run]   ${record.id} · ${record.text.length} chars · ${new Date(record.at).toISOString()}`);
}

if (plan.skipped.length) {
  console.log(`[dry-run] skipped: ${plan.skipped.length}`);
  for (const entry of plan.skipped.slice(0, 10)) {
    console.log(`[dry-run]   ${entry.ref}: ${entry.reason}`);
  }
  if (plan.skipped.length > 10) console.log(`[dry-run]   … ${plan.skipped.length - 10} more`);
} else {
  console.log('[dry-run] skipped: 0');
}

if (plan.records.length === 0) {
  console.log('[dry-run] note: this install has no migratable content yet — a real v0.6 migration check needs a machine that has used the app');
}
