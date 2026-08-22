import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const LEGACY_APP_DIR = 'Unconventionally';
const LEGACY_SETTINGS_FILE = 'unconventionally-settings.json';
const NEW_SETTINGS_FILE = 'osmos-settings.json';

const USER_DATA_FILES = [
  'chat-history.json',
  'question-bank.json',
  'star-templates.json',
  'whisper-cache',
];

/** Copy settings and file-backed data from the old Unconventionally userData folder. */
export function migrateLegacyUserData(): void {
  const newUserData = app.getPath('userData');
  const legacyUserData = path.join(path.dirname(newUserData), LEGACY_APP_DIR);
  if (legacyUserData === newUserData || !fs.existsSync(legacyUserData)) return;

  fs.mkdirSync(newUserData, { recursive: true });

  const legacySettings = path.join(legacyUserData, LEGACY_SETTINGS_FILE);
  const newSettings = path.join(newUserData, NEW_SETTINGS_FILE);
  if (fs.existsSync(legacySettings) && !fs.existsSync(newSettings)) {
    fs.copyFileSync(legacySettings, newSettings);
  }

  for (const name of USER_DATA_FILES) {
    const src = path.join(legacyUserData, name);
    const dest = path.join(newUserData, name);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}
