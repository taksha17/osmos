import { useRef, useState } from 'react';
import type { AppSettings, CopilotMode, SavedProfile, UserProfile, AgentSkill, AgentMcp, LlmProvider } from '../../shared/types';
import { MODE_DEFS } from '../../shared/modes';
import { createSavedProfile, guessCompanyFromUrl } from '../../shared/profiles';
import { resolveAgent, effectiveProvider, allSupportedSkills, allSupportedMcps, renderSkillLabel, renderMcpLabel } from '../../shared/agents';
import { DocumentsTab } from './DocumentsTab';
import { QuestionBankTab } from './QuestionBankTab';

type ProfileSection = 'identity' | 'profile' | 'company' | 'documents' | 'questions' | 'web';

type Props = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onSave: () => void;
  status?: string;
  onClose?: () => void;
};

const NAV: Array<{ id: ProfileSection; label: string; icon: string }> = [
  { id: 'identity', label: 'Identity', icon: '◎' },
  { id: 'profile', label: 'Profile', icon: '◉' },
  { id: 'company', label: 'Company Intel', icon: '▣' },
  { id: 'documents', label: 'Role Insight', icon: '▤' },
  { id: 'questions', label: 'Cover Letter', icon: '✎' },
  { id: 'web', label: 'Web Search', icon: '⌕' },
];

function readInitialSection(): ProfileSection {
  try {
    const raw = sessionStorage.getItem('osmos-profile-section');
    sessionStorage.removeItem('osmos-profile-section');
    if (raw === 'basics' || raw === 'identity') return 'identity';
    if (raw === 'company') return 'company';
    if (raw === 'documents') return 'documents';
    if (raw === 'questions') return 'questions';
  } catch {
    /* ignore */
  }
  return 'identity';
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function ProfilePanel({ settings, onChange, onSave, status, onClose }: Props) {
  const profiles = settings.profiles?.length
    ? settings.profiles
    : [
        createSavedProfile({
          id: settings.activeProfileId || 'default',
          label: 'Default',
          ...settings.profile,
        }),
      ];
  const activeId = settings.activeProfileId || profiles[0]!.id;
  const active = profiles.find((p) => p.id === activeId) || profiles[0]!;
  const profile = settings.profile;
  const [section, setSection] = useState<ProfileSection>(readInitialSection);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const jdInputRef = useRef<HTMLInputElement>(null);

  const applySettings = (next: AppSettings) => {
    onChange({
      profiles: next.profiles,
      activeProfileId: next.activeProfileId,
      profile: next.profile,
      documents: next.documents,
    });
  };

  const patchActive = (patch: Partial<SavedProfile>) => {
    const nextProfiles = profiles.map((p) => (p.id === activeId ? { ...p, ...patch } : p));
    const nextActive = nextProfiles.find((p) => p.id === activeId)!;
    onChange({
      profiles: nextProfiles,
      profile: {
        displayName: nextActive.displayName,
        resumeText: nextActive.resumeText,
        jdText: nextActive.jdText,
        notes: nextActive.notes,
      },
      documents: nextActive.documents || [],
    });
  };

  const setActiveFields = (patch: Partial<UserProfile> & { label?: string }) => {
    patchActive({
      ...patch,
      label: patch.label !== undefined ? patch.label : active.label,
    });
  };

  const switchProfile = (id: string) => {
    const target = profiles.find((p) => p.id === id);
    if (!target) return;
    onChange({
      activeProfileId: id,
      profile: {
        displayName: target.displayName,
        resumeText: target.resumeText,
        jdText: target.jdText,
        notes: target.notes,
      },
      documents: target.documents || [],
      ...(target.preferredMode ? { activeMode: target.preferredMode } : {}),
    });
  };

  const addProfile = () => {
    const created = createSavedProfile({
      label: `Profile ${profiles.length + 1}`,
      preferredMode: settings.activeMode,
    });
    onChange({
      profiles: [...profiles, created],
      activeProfileId: created.id,
      profile: {
        displayName: created.displayName,
        resumeText: created.resumeText,
        jdText: created.jdText,
        notes: created.notes,
      },
      documents: [],
    });
  };

  const removeProfile = () => {
    if (profiles.length <= 1) return;
    const next = profiles.filter((p) => p.id !== activeId);
    const fallback = next[0]!;
    onChange({
      profiles: next,
      activeProfileId: fallback.id,
      profile: {
        displayName: fallback.displayName,
        resumeText: fallback.resumeText,
        jdText: fallback.jdText,
        notes: fallback.notes,
      },
      documents: fallback.documents || [],
    });
  };

  const setPreferredMode = (mode: CopilotMode) => {
    const nextProfiles = profiles.map((p) =>
      p.id === activeId ? { ...p, preferredMode: mode } : p,
    );
    onChange({ profiles: nextProfiles, activeMode: mode });
  };

  const uploadInto = async (kind: 'resume' | 'jd', file: File | null) => {
    if (!file) return;
    setBusy(`Reading ${file.name}…`);
    setError('');
    try {
      const base64 = await fileToBase64(file);
      const res = await window.osmos.extractFileText({
        base64,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!res.ok || !res.text) {
        setError(res.error || 'Could not extract text');
        return;
      }
      if (kind === 'resume') setActiveFields({ resumeText: res.text });
      else setActiveFields({ jdText: res.text });
      setBusy(`Imported ${file.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy(''), 2000);
    }
  };

  const researchCompany = async () => {
    setBusy('Researching company…');
    setError('');
    try {
      const name =
        active.companyName.trim() ||
        (active.companyUrl.trim() ? guessCompanyFromUrl(active.companyUrl) : '');
      if (!name && !active.companyUrl.trim()) {
        setError('Add a company name or URL first');
        return;
      }
      const res = await window.osmos.companyIntel({
        companyName: name || 'Company',
        companyUrl: active.companyUrl.trim() || undefined,
        jdText: profile.jdText || undefined,
      });
      if (!res.ok || !res.intel) {
        setError(res.error || 'Research failed');
        return;
      }
      patchActive({
        companyName: name || active.companyName,
        companyIntel: res.intel,
      });
      setBusy('Company intel saved to this profile');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy(''), 2500);
    }
  };

  const assemblePrep = async () => {
    setBusy('Assembling interview prep…');
    setError('');
    try {
      const saved = await window.osmos.updateSettings({
        profiles: profiles.map((p) =>
          p.id === activeId
            ? {
                ...p,
                ...profile,
                companyName: active.companyName,
                companyUrl: active.companyUrl,
                companyIntel: active.companyIntel,
                documents: active.documents || [],
                questions: active.questions || [],
                starTemplates: active.starTemplates || [],
              }
            : p,
        ),
        activeProfileId: activeId,
        profile,
      });
      onChange(saved);

      const res = await window.osmos.assembleInterviewPrep();
      if (!res.ok) {
        setError(res.error || 'Assemble failed');
        return;
      }
      if (res.settings) onChange(res.settings);
      setBusy(
        `Prep ready — intel saved${res.questionsAdded ? `, ${res.questionsAdded} questions added` : ''}`,
      );
      if (res.questionsAdded) setSection('questions');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy(''), 4000);
    }
  };

  return (
    <div className="hub-modal" role="dialog" aria-label="Profile Intelligence">
      <aside className="hub-modal__nav">
        {onClose ? (
          <button type="button" className="hub-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        ) : null}
        <div className="hub-modal__nav-label">Profile Intelligence</div>
        <nav className="hub-modal__nav-list">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`hub-nav-item${section === item.id ? ' hub-nav-item--active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <button type="button" className="hub-modal__manage" onClick={onSave}>
          Save profile <span aria-hidden>✓</span>
        </button>
      </aside>

      <div className="hub-modal__body">
        <div className="profile-switcher hub-modal__profiles">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`profile-chip${p.id === activeId ? ' profile-chip--active' : ''}`}
              onClick={() => switchProfile(p.id)}
            >
              {p.label || p.displayName || 'Untitled'}
            </button>
          ))}
          <button type="button" className="profile-chip profile-chip--add" onClick={addProfile}>
            + New
          </button>
        </div>

        {section === 'identity' ? (
          <div className="hub-identity">
            <div className="hub-block">
              <h2>Resume</h2>
              <p className="hub-block__desc">
                Grounds every answer in what you&apos;ve actually done, instead of generic advice.
              </p>
              <div className="hub-upload">
                <span>Add your resume as real-time context</span>
                <button type="button" className="hub-upload__btn" onClick={() => resumeInputRef.current?.click()}>
                  📎 Upload file
                </button>
                <input
                  ref={resumeInputRef}
                  type="file"
                  accept=".pdf,.docx,.doc,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                  hidden
                  onChange={(e) => {
                    void uploadInto('resume', e.target.files?.[0] || null);
                    e.target.value = '';
                  }}
                />
              </div>
              {profile.resumeText?.trim() ? (
                <textarea
                  className="hub-upload__preview"
                  rows={6}
                  value={profile.resumeText}
                  onChange={(e) => setActiveFields({ resumeText: e.target.value })}
                />
              ) : null}
            </div>

            <div className="hub-block">
              <h2>Job Description</h2>
              <p className="hub-block__desc">
                Frames answers around what this specific role asks for, and powers Company Intel.
              </p>
              <div className="hub-upload">
                <span>Add a job description as real-time context</span>
                <button type="button" className="hub-upload__btn" onClick={() => jdInputRef.current?.click()}>
                  📎 Upload file
                </button>
                <input
                  ref={jdInputRef}
                  type="file"
                  accept=".pdf,.docx,.doc,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                  hidden
                  onChange={(e) => {
                    void uploadInto('jd', e.target.files?.[0] || null);
                    e.target.value = '';
                  }}
                />
              </div>
              {profile.jdText?.trim() ? (
                <textarea
                  className="hub-upload__preview"
                  rows={6}
                  value={profile.jdText}
                  onChange={(e) => setActiveFields({ jdText: e.target.value })}
                />
              ) : null}
            </div>

            <p className="hub-footnote meta">
              ℹ Used only in Looking for work and Technical Interview modes. Other modes never receive them.
            </p>
          </div>
        ) : null}

        {section === 'profile' ? (
          <div className="hub-identity">
            <div className="field">
              <label>Profile label</label>
              <input
                value={active.label}
                onChange={(e) => setActiveFields({ label: e.target.value })}
                placeholder="e.g. Interview @ Acme"
              />
            </div>
            <div className="field">
              <label>Display name</label>
              <input
                value={profile.displayName}
                onChange={(e) => setActiveFields({ displayName: e.target.value })}
                placeholder="Your name"
              />
            </div>
            <h3>Mode</h3>
            <div className="mode-grid">
              {MODE_DEFS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mode-card ${settings.activeMode === m.id ? 'mode-card--active' : ''}`}
                  onClick={() => setPreferredMode(m.id as CopilotMode)}
                >
                  <strong>{m.name}</strong>
                  <span className="meta">{m.blurb}</span>
                </button>
              ))}
            </div>
            <div className="field">
              <label>Extra notes</label>
              <textarea
                rows={5}
                value={profile.notes}
                onChange={(e) => setActiveFields({ notes: e.target.value })}
                placeholder="Talking points, constraints, stories…"
              />
            </div>
            {profiles.length > 1 ? (
              <button type="button" onClick={removeProfile}>
                Delete this profile
              </button>
            ) : null}

            <hr className="hub-divider" />

            <h3>Agent behavior</h3>
            <p className="hub-block__desc">
              This profile acts as an agent with its own identity, skills, and optional provider override.
            </p>
            {(() => {
              const agent = resolveAgent(active, settings);
              const { provider: effectiveProviderId, model: effectiveModel } = effectiveProvider(agent, settings);
              const providerModel = effectiveModel || settings.providers?.[effectiveProviderId]?.model || '';
              const skills = allSupportedSkills();
              const mcpList = allSupportedMcps();
              const currentSkills = agent.skills || [];
              const currentMcp = agent.mcp || [];

              const updateAgent = (patch: Partial<SavedProfile['agent']>) => {
                patchActive({
                  agent: { ...(active.agent || {}), id: active.id, profileId: active.id, ...patch },
                });
              };

              const toggleSkill = (skill: AgentSkill) => {
                const next = currentSkills.includes(skill)
                  ? currentSkills.filter((s) => s !== skill)
                  : [...currentSkills, skill];
                updateAgent({ skills: next });
              };

              const toggleMcp = (id: AgentMcp['id']) => {
                const next = currentMcp.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m));
                const existing = next.find((m) => m.id === id);
                if (!existing) {
                  next.push({ id, enabled: true, config: {} });
                }
                updateAgent({ mcp: next });
              };

              const updateMcpConfig = (id: AgentMcp['id'], config: Record<string, string>) => {
                const next = currentMcp.map((m) => (m.id === id ? { ...m, config } : m));
                updateAgent({ mcp: next });
              };

              return (
                <>
                  <div className="field">
                    <label>Agent display name</label>
                    <input
                      value={agent.displayName || ''}
                      onChange={(e) => updateAgent({ displayName: e.target.value })}
                      placeholder="e.g. Interview assistant"
                    />
                  </div>

                  <div className="field">
                    <label>System prompt</label>
                    <textarea
                      rows={6}
                      value={agent.systemPrompt || ''}
                      onChange={(e) => updateAgent({ systemPrompt: e.target.value })}
                      placeholder="Custom behavior for this agent..."
                    />
                  </div>

                  <div className="field">
                    <label>Provider override</label>
                    <select
                      value={agent.preferredProvider || settings.activeProvider || 'ollama'}
                      onChange={(e) =>
                        updateAgent({ preferredProvider: e.target.value as LlmProvider })
                      }
                    >
                      {(['ollama', 'openai', 'anthropic', 'groq', 'openrouter', 'litellm'] as LlmProvider[]).map((p) => (
                        <option key={p} value={p}>
                          {settings.providers?.[p]?.label || p}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label>Model override</label>
                    <input
                      value={agent.preferredModel || ''}
                      onChange={(e) => updateAgent({ preferredModel: e.target.value })}
                      placeholder={`Default: ${providerModel}`}
                    />
                    <p className="meta">Leave blank to use the provider default.</p>
                  </div>

                  <div className="field">
                    <label>Skills</label>
                    <div className="mode-grid">
                      {skills.map((skill) => (
                        <button
                          key={skill}
                          type="button"
                          className={`mode-card ${currentSkills.includes(skill) ? 'mode-card--active' : ''}`}
                          onClick={() => toggleSkill(skill)}
                        >
                          <strong>{renderSkillLabel(skill)}</strong>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <label>MCP connectors</label>
                    <div className="mode-grid">
                      {mcpList.map((mcp) => (
                        <button
                          key={mcp.id}
                          type="button"
                          className={`mode-card ${currentMcp.find((m) => m.id === mcp.id)?.enabled ? 'mode-card--active' : ''}`}
                          onClick={() => toggleMcp(mcp.id)}
                        >
                          <strong>{renderMcpLabel(mcp)}</strong>
                        </button>
                      ))}
                    </div>
                    {currentMcp.find((m) => m.id === 'github')?.enabled ? (
                      <div className="field" style={{ marginTop: 10 }}>
                        <label>GitHub token</label>
                        <input
                          type="password"
                          value={currentMcp.find((m) => m.id === 'github')?.config?.token || ''}
                          onChange={(e) =>
                            updateMcpConfig('github', {
                              ...currentMcp.find((m) => m.id === 'github')?.config,
                              token: e.target.value,
                            })
                          }
                          placeholder="ghp_..."
                        />
                      </div>
                    ) : null}
                  </div>

                  <button type="button" className="primary" onClick={onSave}>
                    Save agent
                  </button>
                </>
              );
            })()}
          </div>
        ) : null}

        {section === 'company' ? (
          <div className="hub-identity">
            <h2>Company Intel</h2>
            <p className="hub-block__desc">
              Add a name and/or careers URL. Research pulls live web results into this profile.
            </p>
            <div className="field">
              <label>Company name</label>
              <input
                value={active.companyName || ''}
                onChange={(e) => patchActive({ companyName: e.target.value })}
                placeholder="e.g. Acme Corp"
              />
            </div>
            <div className="field">
              <label>Company / careers URL</label>
              <input
                value={active.companyUrl || ''}
                onChange={(e) => {
                  const companyUrl = e.target.value;
                  const guessed =
                    !active.companyName.trim() && companyUrl.trim()
                      ? guessCompanyFromUrl(companyUrl)
                      : active.companyName;
                  patchActive({ companyUrl, companyName: guessed });
                }}
                placeholder="https://acme.com/careers"
              />
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <button type="button" style={{ height: 40 }} onClick={() => void researchCompany()} disabled={Boolean(busy)}>
                Research company
              </button>
              <button
                type="button"
                className="primary"
                style={{ height: 40 }}
                onClick={() => void assemblePrep()}
                disabled={Boolean(busy)}
              >
                Assemble interview prep
              </button>
            </div>
            <div className="field">
              <label>Company intel</label>
              <textarea
                rows={10}
                value={active.companyIntel || ''}
                onChange={(e) => patchActive({ companyIntel: e.target.value })}
                placeholder="Research results appear here…"
              />
            </div>
          </div>
        ) : null}

        {section === 'documents' ? (
          <div className="hub-identity">
            <h2>Role Insight</h2>
            <p className="hub-block__desc">Attach reference docs for retrieval during interviews.</p>
            <DocumentsTab settings={settings} onSettingsChange={applySettings} embedded />
          </div>
        ) : null}

        {section === 'questions' ? (
          <div className="hub-identity">
            <h2>Cover Letter / STAR</h2>
            <p className="hub-block__desc">Question bank and STAR stories for speakable answers.</p>
            <QuestionBankTab settings={settings} embedded onSettingsChange={applySettings} />
          </div>
        ) : null}

        {section === 'web' ? (
          <div className="hub-identity">
            <h2>Web Search</h2>
            <p className="hub-block__desc">
              Live grounding is configured in Settings → Web. Provider:{' '}
              <strong>{settings.webSearchProvider || 'duckduckgo'}</strong>
              {settings.useWebSearch === false ? ' (disabled)' : ''}.
            </p>
            <button type="button" className="primary" onClick={onSave}>
              Save &amp; continue
            </button>
          </div>
        ) : null}

        {(busy || status) && (
          <p className="meta" style={{ marginTop: 12 }}>
            {busy || status}
          </p>
        )}
        {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
      </div>
    </div>
  );
}
