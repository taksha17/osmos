/**
 * macOS privacy (TCC) decisions.
 *
 * Why this exists: when Screen Recording is denied, macOS answers
 * `screencapture -x` with **exit 0 and a black/empty image**. The CLI reports
 * success, the PNG is tiny, OCR returns '', `classifySnapshot` sees nothing and
 * routing silently drops to text-only. The user sees "screen reading does not
 * work" with no error anywhere — the same failure shape as Symptom M on Linux.
 *
 * Electron exposes the real state, so the *decision* lives here (pure, unit
 * tested) and the caller only supplies the status string from
 * `systemPreferences.getMediaAccessStatus()`. Non-darwin callers get an
 * "unknown" status, which is permissive: behaviour elsewhere is unchanged.
 */

export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export type AccessVerdict = {
  /** Whether the capture may be attempted at all. */
  ok: boolean;
  /** Shown to the user instead of an empty result. */
  reason?: string;
  /** True on the first run: macOS shows its permission prompt on that attempt. */
  needsPrompt: boolean;
};

/** Deep links understood by System Settings on macOS 13+. */
export const SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
export const MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

const SCREEN_HELP =
  'macOS needs Screen Recording for OSMOS. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable OSMOS, then quit and reopen the app.';

const MIC_HELP =
  'macOS needs Microphone access for OSMOS. Open System Settings → Privacy & Security → Microphone, enable OSMOS, then quit and reopen the app.';

export function normalizeAccessStatus(status: unknown): MediaAccessStatus {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  switch (value) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return value;
    default:
      return 'unknown';
  }
}

/** Screen capture may only be attempted when macOS will actually hand over pixels. */
export function describeScreenAccess(status: unknown): AccessVerdict {
  switch (normalizeAccessStatus(status)) {
    case 'granted':
      return { ok: true, needsPrompt: false };
    // First attempt: allowed, and it is what raises the system prompt.
    case 'not-determined':
      return { ok: true, needsPrompt: true };
    case 'denied':
    case 'restricted':
      return { ok: false, needsPrompt: false, reason: SCREEN_HELP };
    default:
      return { ok: true, needsPrompt: false };
  }
}

/** Microphone is prompted by Chromium itself; denial still needs a real message. */
export function describeMicAccess(status: unknown): AccessVerdict {
  switch (normalizeAccessStatus(status)) {
    case 'granted':
      return { ok: true, needsPrompt: false };
    case 'not-determined':
      return { ok: true, needsPrompt: true };
    case 'denied':
    case 'restricted':
      return { ok: false, needsPrompt: false, reason: MIC_HELP };
    default:
      return { ok: true, needsPrompt: false };
  }
}
