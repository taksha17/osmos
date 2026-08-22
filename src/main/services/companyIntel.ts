import { getSettings } from './settingsStore.js';
import { chatWithProvider } from './providers.js';
import { formatHitsForPrompt, searchWeb, webSearchEnabled } from './webSearch.js';
import type { CompanyIntelRequest, CompanyIntelResponse } from '../../shared/types.js';
import { guessCompanyFromUrl } from '../../shared/profiles.js';

const SYSTEM = `You are a company research assistant for interview preparation.
Use the provided web research to produce concise, factual company intel.
Focus on: business model, recent news/products, culture signals, size/stage, and anything relevant to the user's target role.
If a company website URL is provided, treat it as a primary source hint.
If the JD is provided, tailor findings to that role.
If unsure, say so instead of inventing.`;

export async function researchCompany(req: CompanyIntelRequest): Promise<CompanyIntelResponse> {
  const url = String(req?.companyUrl || '').trim();
  let company = String(req?.companyName || '').trim();
  if (!company && url) company = guessCompanyFromUrl(url);
  if (!company) return { ok: false, error: 'Missing company name or URL' };

  try {
    const settings = getSettings();
    const today = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZoneName: 'short',
    }).format(new Date());

    const queries = [
      `${company} company overview`,
      `${company} recent news 2025 2026`,
      `${company} products services culture`,
      `${company} interview process`,
    ];
    if (url) {
      queries.unshift(`site:${(() => {
        try {
          return new URL(url).hostname;
        } catch {
          return company;
        }
      })()} about company`);
      queries.push(`${url} company about careers`);
    }
    if (req.jdText?.trim()) {
      queries.push(`${company} ${req.jdText.trim().slice(0, 120)}`);
    }

    let hits: Awaited<ReturnType<typeof searchWeb>> = [];
    if (webSearchEnabled(settings)) {
      const allHits = await Promise.all(
        queries.map((q) => searchWeb(settings, q).catch(() => [] as const)),
      );
      hits = allHits.flat().slice(0, 14);
    }

    const webBlock = formatHitsForPrompt(hits, today);

    const jdBlock = req.jdText?.trim()
      ? `\n\nTarget JD:\n${req.jdText.trim().slice(0, 4_000)}`
      : '';
    const urlBlock = url ? `\n\nCompany URL: ${url}` : '';

    const user = `Research this company for interview prep: ${company}${urlBlock}${jdBlock ? jdBlock : ''}\n\nWeb research:\n${webBlock || '(no live results)'}`;

    const provider = req.provider;
    if (!provider) return { ok: false, error: 'No provider configured' };

    const intel = await chatWithProvider(
      provider,
      SYSTEM,
      [{ role: 'user', content: user }],
    );

    if (!intel.trim()) return { ok: false, error: 'Model returned empty intel' };
    return { ok: true, intel: intel.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
