/**
 * Web Access settings — isolated section (Architecture v3, §7).
 *
 * Rendered by SettingsPanel; owns only `settings.webAccess` so the v2 agent
 * can keep editing the rest of SettingsPanel without merge conflicts.
 * API keys are never displayed back and never logged — the main store keeps
 * them encrypted via the OS keychain.
 */
import { useState } from 'react';
import {
  DEFAULT_WEB_ACCESS_CONFIG,
  type WebAccessConfig,
  type WebAccessMode,
  type WebAccessTierSetting,
} from '@shared/webAccessConfig';

type Props = {
  value?: Partial<WebAccessConfig>;
  onChange: (patch: Partial<WebAccessConfig>) => void;
  onTest?: () => Promise<{ ok: boolean; detail: string } | void>;
};

export default function WebAccessSettings({ value, onChange, onTest }: Props) {
  const v: WebAccessConfig = { ...DEFAULT_WEB_ACCESS_CONFIG, ...(value ?? {}) };
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');

  const set = (patch: Partial<WebAccessConfig>): void => onChange(patch);

  const runTest = async (): Promise<void> => {
    if (!onTest) return;
    setTesting(true);
    setResult('');
    try {
      const r = await onTest();
      setResult(r && typeof r === 'object' ? `${r.ok ? '✓' : '✗'} ${r.detail}` : 'Probed.');
    } catch (e) {
      setResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section aria-label="Web access (self-hosted)">
      <header className="settings-section__head" style={{ marginTop: 28 }}>
        <h3>Self-hosted page fetching</h3>
        <p className="meta">
          Built-in search stays the default. Point OSMOS at your own Firecrawl service to fetch page
          text. Fully local means Firecrawl fetch plus a SearXNG search index.
        </p>
      </header>

      <div className="settings-row">
        <div className="settings-row__copy">
          <strong>Enable self-hosted web access</strong>
          <p>Fetch pages through your own service instead of the built-in reader</p>
        </div>
        <button
          type="button"
          className={`home-switch${v.enabled ? ' home-switch--on' : ''}`}
          aria-pressed={v.enabled}
          aria-label="Enable self-hosted web access"
          onClick={() => set({ enabled: !v.enabled })}
        >
          <span className="home-switch__knob" />
        </button>
      </div>

      <div className="field">
        <label>Tier</label>
        <select
          value={v.tier}
          onChange={(e) => set({ tier: e.target.value as WebAccessTierSetting })}
          disabled={!v.enabled}
        >
          <option value="builtin">Built-in only (T0)</option>
          <option value="firecrawl-local">Firecrawl Local binary (T1)</option>
          <option value="firecrawl-stack">Self-hosted stack (T2)</option>
          <option value="cloud">Cloud (T3, your key)</option>
        </select>
      </div>

      <div className="field">
        <label>Mode</label>
        <select
          value={v.mode}
          onChange={(e) => set({ mode: e.target.value as WebAccessMode })}
          disabled={!v.enabled}
        >
          <option value="connect">Connect (you run it)</option>
          <option value="remote">Remote (LAN box)</option>
          <option value="managed">Managed (opt-in launch)</option>
        </select>
      </div>

      <div className="field">
        <label>Base URL</label>
        <input
          value={v.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="http://127.0.0.1:3002"
          disabled={!v.enabled}
          inputMode="url"
        />
      </div>

      <div className="row" style={{ marginTop: 12, marginBottom: 8 }}>
        <button
          className="primary"
          style={{ height: 38 }}
          type="button"
          onClick={runTest}
          disabled={!v.enabled || testing || !onTest}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {result ? <p role="status" className="meta">{result}</p> : null}
      <p className="settings-callout">
        Privacy: <strong>{v.privacy}</strong> · Local-only never touches cloud tiers. Target sites still
        see your IP; respect robots.txt and site terms.
      </p>
    </section>
  );
}
