/**
 * Web content sanitizer — main-process entry (Architecture v3, §9.2/§9.3).
 *
 * Thin wrapper over the pure helpers in `src/shared/webSanitize.ts` so the
 * Context Engine and prep jobs have one import. No Electron here.
 */

export {
  sanitizeWebMarkdown,
  untrustedWebBlock,
  instructionPatternHit,
  WEB_PAGE_MAX_CHARS,
  WEB_TRUSTED_MAX_CHARS,
} from '../../shared/webSanitize.js';
