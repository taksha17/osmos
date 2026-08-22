import { useRef, useState } from 'react';
import type { AppSettings, DocumentReference } from '@shared/types';
import { activeSavedProfile } from '@shared/profiles';

type Props = {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  /** When true, render as a profile subsection (no outer panel chrome). */
  embedded?: boolean;
};

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function DocumentsTab({ settings, onSettingsChange, embedded }: Props) {
  const active = activeSavedProfile(settings.profiles, settings.activeProfileId);
  const docs = active.documents || settings.documents || [];
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const saveDocs = async (nextDocs: DocumentReference[]) => {
    const profiles = (settings.profiles || []).map((p) =>
      p.id === active.id ? { ...p, documents: nextDocs } : p,
    );
    const next = await window.osmos.updateSettings({
      profiles,
      activeProfileId: active.id,
      documents: nextDocs,
    });
    onSettingsChange(next);
  };

  const addTextDoc = async () => {
    const n = name.trim();
    const t = text.trim();
    if (!n || !t) return;
    await saveDocs([...docs, { id: `${Date.now()}`, name: n, text: t, addedAt: Date.now() }]);
    setName('');
    setText('');
    setStatus('Added');
    setTimeout(() => setStatus(''), 1500);
  };

  const uploadFile = async (file: File | null) => {
    if (!file) return;
    setError('');
    setStatus(`Reading ${file.name}…`);
    try {
      const base64 = await fileToBase64(file);
      const res = await window.osmos.extractFileText({
        base64,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!res.ok || !res.text) {
        setError(res.error || 'Extract failed');
        setStatus('');
        return;
      }
      await saveDocs([
        ...docs,
        { id: `${Date.now()}`, name: file.name, text: res.text, addedAt: Date.now() },
      ]);
      setStatus(`Imported ${file.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    } finally {
      setTimeout(() => setStatus(''), 2000);
    }
  };

  const body = (
    <>
      {!embedded ? (
        <>
          <h2>Documents</h2>
          <p>
            Reference files for profile <strong>{active.label}</strong> only. Upload PDF/DOCX or paste
            text — retrieval uses these during chat.
          </p>
        </>
      ) : (
        <p className="meta" style={{ marginBottom: 12 }}>
          Attach PDF/DOCX or paste text. These docs are only used while this profile is active.
        </p>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" className="primary" style={{ height: 40 }} onClick={() => fileRef.current?.click()}>
          Upload PDF / DOCX
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.doc,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          hidden
          onChange={(e) => {
            void uploadFile(e.target.files?.[0] || null);
            e.target.value = '';
          }}
        />
      </div>
      <div className="field">
        <label>Document name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. offer-letter.pdf" />
      </div>
      <div className="field">
        <label>Text content</label>
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste document text here."
        />
      </div>
      <button className="primary" style={{ height: 40 }} type="button" onClick={() => void addTextDoc()}>
        Add document
      </button>
      {status ? <p className="meta" style={{ marginTop: 10 }}>{status}</p> : null}
      {error ? <div className="error" style={{ marginTop: 8 }}>{error}</div> : null}
      {docs.length > 0 ? (
        <ul style={{ marginTop: 16 }}>
          {docs.map((d) => (
            <li key={d.id} style={{ marginBottom: 8 }}>
              <strong>{d.name}</strong>
              <span className="meta"> · {d.text.length.toLocaleString()} chars</span>
              <button
                style={{ marginLeft: 8 }}
                type="button"
                onClick={() => void saveDocs(docs.filter((x) => x.id !== d.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta" style={{ marginTop: 16 }}>No documents on this profile yet.</p>
      )}
    </>
  );

  if (embedded) return <div className="profile-embed">{body}</div>;
  return <section className="panel">{body}</section>;
}
