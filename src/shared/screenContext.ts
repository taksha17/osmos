/**
 * Screen-context hygiene for OCR text (original OSMOS code).
 *
 * Linux has no OS-level capture exclusion, so full-screen frames include the
 * OSMOS overlay itself. Without filtering, the model gets fed its own previous
 * answer as "on-screen text". These helpers strip that echo and drop UI noise.
 */

/** Static overlay strings that show up in OCR when the frame includes OSMOS. */
export const OVERLAY_UI_STRINGS: readonly string[] = [
  'OSMOS',
  'Smart',
  'What should I say?',
  'Follow-up questions',
  'Recap',
  'STAR story',
  'Mic',
  'Screen',
  'Audio',
  'Live',
  'Stop',
  'Ready',
  'Ask about your screen or conversation, or Ctrl+Enter for Assist',
  'Answers appear here while you interview, meet, or share your screen.',
  'Listening to meeting audio',
  'waiting for media on this machine',
  'Streaming',
  'Thinking',
  'Writing',
  'Reading screen',
  'Watching screen',
  'Screen read',
];

function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t.length >= 3);
}

/**
 * Drop OCR lines that are almost certainly UI noise: icon glyph soup, separators,
 * browser chrome ("® = Flex X <3 (29) HD"), fragments with no real word.
 * Keeps the model prompt short and readable.
 */
function looksLikeBrowserChrome(t: string): boolean {
  if (/\b(new tab|extensions|bookmarks bar|incognito|ohter tabs|other tabs)\b/i.test(t)) return true;
  const domains = t.match(/\b[\w-]+\.(com|dev|io|org|net|ai|app|co|in)\b/gi) || [];
  if (domains.length >= 2) return true;
  // Tab titles mashed on one line: "Inbox - Gmail GitHub OSMOS Settings"
  if ((t.match(/ - /g) || []).length >= 2 && t.length < 120) return true;
  return false;
}

export function cleanOcrText(raw: string): string {
  const out: string[] = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t.length < 3) continue;
    const alnum = (t.match(/[a-z0-9]/gi) || []).length;
    if (alnum / t.length < 0.55) continue;
    if (!/[a-z]{2,}/i.test(t)) continue;
    // Toolbar / tab-strip soup: mostly 1–2 char tokens. Real prose is ~20–25%.
    const words = t.split(' ');
    const short = words.filter((w) => w.replace(/[^a-z0-9]/gi, '').length <= 2).length;
    if (words.length >= 3 && short / words.length >= 0.5) continue;
    if (looksLikeBrowserChrome(t)) continue;
    out.push(t);
  }
  return out.join('\n').trim();
}

/**
 * Remove OCR lines that echo text OSMOS is currently displaying (answers,
 * transcript, composer, button labels). Matching is tolerant of OCR errors:
 * a line is treated as echo when it matches exactly after normalisation, is a
 * substring of our own text, or shares ≥80% of its words (≥4 words) with it.
 */
export function stripOverlayEcho(ocrText: string, ownTexts: readonly string[]): string {
  const ownLines = new Set<string>();
  const ownTokens = new Set<string>();
  const uiTokens = new Set<string>();
  const blobParts: string[] = [];
  for (const t of OVERLAY_UI_STRINGS) {
    const n = normalizeLine(t);
    for (const tok of n.split(' ')) if (tok.length >= 2) uiTokens.add(tok);
  }
  for (const t of [...OVERLAY_UI_STRINGS, ...ownTexts]) {
    for (const line of String(t || '').split(/\r?\n/)) {
      const n = normalizeLine(line);
      if (n.length < 3) continue;
      ownLines.add(n);
      blobParts.push(n);
      for (const tok of tokens(n)) ownTokens.add(tok);
    }
  }
  if (ownLines.size === 0) return ocrText;
  const blob = ` ${blobParts.join(' | ')} `;
  const longOwn = [...ownLines].filter((o) => o.length >= 16);

  const kept: string[] = [];
  for (const line of String(ocrText || '').split(/\r?\n/)) {
    const n = normalizeLine(line);
    if (!n) continue;
    if (ownLines.has(n)) continue;
    if (n.length >= 12 && blob.includes(n)) continue;
    if (n.length >= 12 && longOwn.some((o) => n.includes(o))) continue;
    const all = n.split(' ').filter(Boolean);
    // Short line made only of overlay button/status words ("Smart Ready", "Mic Screen Audio").
    if (all.length <= 5 && all.every((w) => uiTokens.has(w))) continue;
    const toks = tokens(n);
    if (toks.length >= 4) {
      let hit = 0;
      for (const tok of toks) if (ownTokens.has(tok)) hit++;
      // OCR mangles a few words of our own answer ("numbcr", "targct") — allow
      // more slack on longer lines where coincidence is unlikely.
      const need = toks.length >= 6 ? 0.7 : 0.8;
      if (hit / toks.length >= need) continue;
    }
    kept.push(line.trim());
  }
  return kept.join('\n').trim();
}

/** Clean + de-echo in one call. */
export function prepareScreenContext(rawOcr: string, ownTexts: readonly string[]): string {
  return stripOverlayEcho(cleanOcrText(rawOcr), ownTexts);
}

/** Cap on screen text sent with a chat request. */
export const SCREEN_CONTEXT_MAX_CHARS = 3_500;
