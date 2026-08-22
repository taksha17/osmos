import { safeStorage } from 'electron';

/**
 * Encrypts/decrypts small secret strings (API keys) using Electron's
 * `safeStorage`, which is backed by the OS keychain (Keychain on macOS,
 * DPAPI on Windows, libsecret/kwallet on Linux where available).
 *
 * Values are persisted to the plain-JSON settings store, so this exists to
 * avoid writing provider API keys to disk in plaintext. It intentionally
 * degrades to plaintext (with a logged warning, once) rather than throwing
 * or losing data if OS-level encryption isn't available — e.g. some
 * headless Linux setups with no secret service running.
 */

const ENC_PREFIX = 'enc:v1:';

let warnedUnavailable = false;

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string | undefined | null): string {
  const value = plain || '';
  if (!value) return '';
  // Idempotent: callers may pass an already-encrypted value through this
  // path (e.g. a defensive re-encrypt during settings migration) — never
  // double-wrap it, or decryptSecret will unwrap to ciphertext instead of
  // the real secret.
  if (value.startsWith(ENC_PREFIX)) return value;
  if (!isEncryptionAvailable()) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        '[secretStore] OS secret storage unavailable — API keys will be saved in plaintext. ' +
          'On Linux, install/enable a Secret Service provider (gnome-keyring or kwallet) to fix this.',
      );
    }
    return value;
  }
  try {
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (e) {
    console.warn('[secretStore] encryption failed, storing plaintext:', e);
    return value;
  }
}

export function decryptSecret(value: string | undefined | null): string {
  const raw = value || '';
  if (!raw) return '';
  if (!raw.startsWith(ENC_PREFIX)) return raw; // legacy plaintext, or encryption unavailable
  try {
    const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    console.warn('[secretStore] decryption failed (key changed / keychain unavailable):', e);
    return '';
  }
}
