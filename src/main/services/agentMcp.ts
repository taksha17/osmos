export type McpClient = {
  id: string;
  enabled: boolean;
  config?: Record<string, string>;
};

export type ToolResult = {
  ok: boolean;
  name: string;
  data?: unknown;
  error?: string;
};

function getHeaderToken(client: McpClient): string | undefined {
  if (!client.config) return undefined;
  return client.config.token || client.config.apiKey || undefined;
}

export async function callMcp(client: McpClient, action: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!client.enabled) {
    return { ok: false, error: `${client.id} MCP is disabled` };
  }

  if (client.id === 'github') {
    const token = getHeaderToken(client);
    if (!token) {
      return { ok: false, error: 'GitHub token missing in MCP config' };
    }

    if (action === 'search_repos') {
      const q = String(params.q || '').trim();
      if (!q) return { ok: false, error: 'Missing q for github search_repos' };
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: (params.signal as AbortSignal | undefined) ?? AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `GitHub search failed (${res.status}): ${text.slice(0, 200)}` };
      }
      const data = await res.json();
      return { ok: true, data };
    }

    return { ok: false, error: `Unsupported GitHub action: ${action}` };
  }

  if (client.id === 'linkedin') {
    if (action === 'profile_summary') {
      const target = String(params.target || '').trim();
      if (!target) return { ok: false, error: 'Missing target for linkedin profile_summary' };
      return {
        ok: true,
        data: {
          source: 'linkedin',
          note: 'LinkedIn connector stub — replace with real auth/API integration.',
          target,
          summary: `LinkedIn profile context for ${target}.`,
        },
      };
    }

    return { ok: false, error: `Unsupported LinkedIn action: ${action}` };
  }

  if (client.id === 'calendar') {
    if (action === 'upcoming') {
      const limit = Number(params.limit ?? 5);
      return {
        ok: true,
        data: {
          source: 'calendar',
          note: 'Calendar connector stub — replace with real calendar API integration.',
          events: Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
            id: `evt-${i + 1}`,
            title: `Stub meeting ${i + 1}`,
            start: new Date(Date.now() + i * 3600_000).toISOString(),
            end: new Date(Date.now() + i * 3600_000 + 1800_000).toISOString(),
          })),
        },
      };
    }

    return { ok: false, error: `Unsupported Calendar action: ${action}` };
  }

  return { ok: false, error: `Unsupported MCP client: ${client.id}` };
}

export async function executeAgentTools(
  skills: string[] = [],
  mcp: { id: string; enabled: boolean; config?: Record<string, string> }[] = [],
  message: string,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  const run = async (name: string, fn: () => Promise<{ ok: boolean; data?: unknown; error?: string }>) => {
    try {
      const res = await fn();
      results.push({ ok: res.ok, name, data: res.data, error: res.error });
    } catch (e) {
      results.push({ ok: false, name, error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (skills.includes('company-research') || message.toLowerCase().includes('company research')) {
    await run('company-research', async () => ({
      ok: false,
      error: 'company-research tool not wired yet',
    }));
  }

  const github = mcp.find((m) => m.id === 'github' && m.enabled);
  if (github) {
    await run('github.search_repos', async () => callMcp(github, 'search_repos', { q: message }));
  }

  const linkedin = mcp.find((m) => m.id === 'linkedin' && m.enabled);
  if (linkedin) {
    await run('linkedin.profile_summary', async () => callMcp(linkedin, 'profile_summary', { target: message }));
  }

  const calendar = mcp.find((m) => m.id === 'calendar' && m.enabled);
  if (calendar) {
    await run('calendar.upcoming', async () => callMcp(calendar, 'upcoming', { limit: 5 }));
  }

  return results;
}
