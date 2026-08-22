import { getSettings, updateSettings } from './settingsStore.js';
import { researchCompany } from './companyIntel.js';
import { chatWithProvider } from './providers.js';
import { formatHitsForPrompt, searchWeb, webSearchEnabled } from './webSearch.js';
import {
  activeSavedProfile,
  guessCompanyFromUrl,
  normalizeSavedProfile,
} from '../../shared/profiles.js';
import type {
  AssemblePrepResponse,
  QuestionBankItem,
  ProviderConfig,
} from '../../shared/types.js';

const QUESTIONS_SYSTEM = `You extract likely interview questions for a candidate.
Return ONLY a JSON array of objects: [{"question":"...","category":"behavioral|technical|system-design|product|leadership|other","difficulty":"easy|medium|hard"}]
Max 8 items. No markdown fences. Prefer questions grounded in the company + JD + résumé.`;

function parseQuestionsJson(raw: string): Array<Pick<QuestionBankItem, 'question' | 'category' | 'difficulty'>> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => ({
        question: String(row?.question || '').trim(),
        category: (['behavioral', 'technical', 'system-design', 'product', 'leadership', 'other'].includes(
          String(row?.category),
        )
          ? String(row.category)
          : 'other') as QuestionBankItem['category'],
        difficulty: (['easy', 'medium', 'hard'].includes(String(row?.difficulty))
          ? String(row.difficulty)
          : 'medium') as QuestionBankItem['difficulty'],
      }))
      .filter((q) => q.question.length > 8)
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Research the profile's company (name/URL), merge intel, and seed question bank
 * from web + résumé/JD context.
 */
export async function assembleInterviewPrep(): Promise<AssemblePrepResponse> {
  try {
    const settings = getSettings();
    const provider =
      (settings.providers?.[settings.activeProvider || 'ollama'] ||
        settings.providers?.ollama) as ProviderConfig | undefined;
    if (!provider) return { ok: false, error: 'No provider configured' };

    const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
    let companyName = active.companyName.trim();
    const companyUrl = active.companyUrl.trim();
    if (!companyName && companyUrl) companyName = guessCompanyFromUrl(companyUrl);
    if (!companyName && !companyUrl) {
      return { ok: false, error: 'Add a company name or company URL on this profile first' };
    }

    const research = await researchCompany({
      companyName: companyName || 'Company',
      companyUrl: companyUrl || undefined,
      jdText: active.jdText,
      provider,
    });
    if (!research.ok || !research.intel) {
      return { ok: false, error: research.error || 'Company research failed' };
    }

    let questionsAdded = 0;
    const existing = active.questions || [];
    const existingSet = new Set(existing.map((q) => q.question.trim().toLowerCase()));

    if (webSearchEnabled(settings)) {
      const today = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date());
      const qHits = (
        await Promise.all([
          searchWeb(settings, `${companyName} interview questions`).catch(() => []),
          searchWeb(settings, `${companyName} behavioral interview`).catch(() => []),
        ])
      )
        .flat()
        .slice(0, 10);
      const webBlock = formatHitsForPrompt(qHits, today);

      const prompt = [
        `Company: ${companyName}`,
        companyUrl ? `URL: ${companyUrl}` : '',
        active.jdText.trim() ? `JD:\n${active.jdText.trim().slice(0, 3500)}` : '',
        active.resumeText.trim()
          ? `Candidate résumé (clip):\n${active.resumeText.trim().slice(0, 3500)}`
          : '',
        `Company intel:\n${research.intel.slice(0, 4000)}`,
        `Web hits:\n${webBlock || '(none)'}`,
        'Propose likely interview questions for this candidate at this company.',
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const raw = await chatWithProvider(provider, QUESTIONS_SYSTEM, [
          { role: 'user', content: prompt },
        ]);
        const parsed = parseQuestionsJson(raw);
        const additions: QuestionBankItem[] = [];
        for (const q of parsed) {
          const key = q.question.toLowerCase();
          if (existingSet.has(key)) continue;
          existingSet.add(key);
          additions.push({
            id: `q-${Date.now()}-${additions.length}`,
            companyName: companyName || 'Company',
            question: q.question,
            category: q.category,
            difficulty: q.difficulty,
            tags: ['auto'],
            createdAt: Date.now(),
          });
        }
        questionsAdded = additions.length;
        const nextQuestions = [...existing, ...additions].slice(0, 80);

        const profiles = (settings.profiles || []).map((p) =>
          p.id === active.id
            ? normalizeSavedProfile({
                ...p,
                companyName: companyName || p.companyName,
                companyUrl: companyUrl || p.companyUrl,
                companyIntel: research.intel!,
                questions: nextQuestions,
              })
            : p,
        );
        const next = updateSettings({ profiles, activeProfileId: active.id });
        return {
          ok: true,
          companyIntel: research.intel,
          questionsAdded,
          settings: next,
        };
      } catch (e) {
        // Still save intel even if question generation fails
        console.warn('[assemble] question generation failed:', e);
      }
    }

    const profiles = (settings.profiles || []).map((p) =>
      p.id === active.id
        ? normalizeSavedProfile({
            ...p,
            companyName: companyName || p.companyName,
            companyUrl: companyUrl || p.companyUrl,
            companyIntel: research.intel!,
          })
        : p,
    );
    const next = updateSettings({ profiles, activeProfileId: active.id });
    return {
      ok: true,
      companyIntel: research.intel,
      questionsAdded,
      settings: next,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
