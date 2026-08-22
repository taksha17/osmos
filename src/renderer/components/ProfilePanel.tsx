import { useRef, useState } from 'react';
import type { AppSettings, CopilotMode, SavedProfile, UserProfile } from '../../shared/types';
import { MODE_DEFS } from '../../shared/modes';
import { createSavedProfile, guessCompanyFromUrl } from '../../shared/profiles';
import { DocumentsTab } from './DocumentsTab';
import { QuestionBankTab } from './QuestionBankTab';

type ProfileSection = 'basics' | 'company' | 'documents' | 'questions';

type Props = {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onSave: () => void;
  status?: string;
};

const SECTIONS: Array<{ id: ProfileSection; label: string }> = [
  { id: 'basics', label: 'Basics' },
  { id: 'company', label: 'Company' },
  { id: 'documents', label: 'Documents' },
  { id: 'questions', label: 'Questions' },
];

function readInitialSection(): ProfileSection {
  try {
    const raw = sessionStorage.getItem('osmos-profile-section');
    sessionStorage.removeItem('osmos-profile-section');
    if (raw === 'basics' || raw === 'company' || raw === 'documents' || raw === 'questions') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'basics';
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function ProfilePanel({ settings, onChange, onSave, status }: Props) {
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
    <section className="panel">
      <h2>Profile</h2>
      <p>
        One place for everything about this interview context: identity, company research, documents,
        and question bank.
      </p>

      <div className="profile-switcher">
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

      <div className="profile-sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`profile-section-tab${section === s.id ? ' profile-section-tab--active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
            {s.id === 'documents' && (active.documents?.length || 0) > 0
              ? ` (${active.documents!.length})`
              : ''}
            {s.id === 'questions' &&
            (active.questions?.length || 0) + (active.starTemplates?.length || 0) > 0
              ? ` (${(active.questions?.length || 0) + (active.starTemplates?.length || 0)})`
              : ''}
          </button>
        ))}
      </div>

      {section === 'basics' ? (
        <>
          <div className="field">
            <label>Profile label</label>
            <input
              value={active.label}
              onChange={(e) => setActiveFields({ label: e.target.value })}
              placeholder="e.g. Interview @ Acme"
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

          <h3>Identity</h3>
          <div className="field">
            <label>Display name</label>
            <input
              value={profile.displayName}
              onChange={(e) => setActiveFields({ displayName: e.target.value })}
              placeholder="Your name"
            />
          </div>

          <div className="field">
            <div className="field-label-row">
              <label>Résumé / experience</label>
              <button type="button" className="dash-link" onClick={() => resumeInputRef.current?.click()}>
                Upload PDF / DOCX
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
            <textarea
              rows={10}
              value={profile.resumeText}
              onChange={(e) => setActiveFields({ resumeText: e.target.value })}
              placeholder="Paste résumé or upload PDF/DOCX…"
            />
          </div>

          <div className="field">
            <div className="field-label-row">
              <label>Target job description</label>
              <button type="button" className="dash-link" onClick={() => jdInputRef.current?.click()}>
                Upload PDF / DOCX
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
            <textarea
              rows={8}
              value={profile.jdText}
              onChange={(e) => setActiveFields({ jdText: e.target.value })}
              placeholder="Paste the JD or upload PDF/DOCX…"
            />
          </div>

          <div className="field">
            <label>Extra notes</label>
            <textarea
              rows={4}
              value={profile.notes}
              onChange={(e) => setActiveFields({ notes: e.target.value })}
              placeholder="Talking points, constraints, stories to prefer…"
            />
          </div>
        </>
      ) : null}

      {section === 'company' ? (
        <>
          <p className="meta">
            Add a name and/or careers URL. Research pulls live web results into this profile; Assemble
            also seeds likely interview questions.
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
            <label>Company intel (saved on this profile)</label>
            <textarea
              rows={10}
              value={active.companyIntel || ''}
              onChange={(e) => patchActive({ companyIntel: e.target.value })}
              placeholder="Research results appear here…"
            />
          </div>
        </>
      ) : null}

      {section === 'documents' ? (
        <DocumentsTab settings={settings} onSettingsChange={applySettings} embedded />
      ) : null}

      {section === 'questions' ? (
        <QuestionBankTab settings={settings} embedded onSettingsChange={applySettings} />
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary" style={{ height: 40 }} type="button" onClick={onSave}>
          Save profile
        </button>
        {profiles.length > 1 ? (
          <button type="button" style={{ height: 40 }} onClick={removeProfile}>
            Delete this profile
          </button>
        ) : null}
        {busy ? <span className="meta">{busy}</span> : null}
        {status ? <span className="meta">{status}</span> : null}
      </div>
      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
    </section>
  );
}
