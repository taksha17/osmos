import { useEffect, useState } from 'react';
import type { AppSettings, QuestionBankItem, StarTemplate } from '@shared/types';
import { activeSavedProfile } from '@shared/profiles';

type Props = {
  settings: AppSettings | null;
  embedded?: boolean;
  onSettingsChange?: (next: AppSettings) => void;
};

export function QuestionBankTab({ settings, embedded }: Props) {
  const active = settings
    ? activeSavedProfile(settings.profiles, settings.activeProfileId)
    : null;
  const [questions, setQuestions] = useState<QuestionBankItem[]>(active?.questions || []);
  const [templates, setTemplates] = useState<StarTemplate[]>(active?.starTemplates || []);
  const [companyName, setCompanyName] = useState(active?.companyName || '');
  const [questionText, setQuestionText] = useState('');
  const [category, setCategory] = useState<QuestionBankItem['category']>('behavioral');
  const [difficulty, setDifficulty] = useState<QuestionBankItem['difficulty']>('medium');
  const [tags, setTags] = useState('');
  const [starLabel, setStarLabel] = useState('');
  const [starSituation, setStarSituation] = useState('');
  const [starTask, setStarTask] = useState('');
  const [starAction, setStarAction] = useState('');
  const [starResult, setStarResult] = useState('');
  const [starTags, setStarTags] = useState('');
  const [activeTab, setActiveTab] = useState<'questions' | 'templates'>('questions');

  useEffect(() => {
    if (!active) return;
    setQuestions(active.questions || []);
    setTemplates(active.starTemplates || []);
    if (active.companyName) setCompanyName(active.companyName);
  }, [settings?.activeProfileId, settings?.profiles, active]);

  const addQuestion = async () => {
    const trimmed = questionText.trim();
    if (!companyName.trim() || !trimmed) return;
    const item: QuestionBankItem = {
      id: `${Date.now()}`,
      companyName: companyName.trim(),
      question: trimmed,
      category,
      difficulty,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      createdAt: Date.now(),
    };
    const res = await window.osmos.addQuestion(item);
    if (res.ok && res.items) setQuestions(res.items);
    setQuestionText('');
    setTags('');
  };

  const deleteQuestion = async (id: string) => {
    const res = await window.osmos.deleteQuestion(id);
    if (res.ok && res.items) setQuestions(res.items);
  };

  const addTemplate = async () => {
    if (!starLabel.trim() || !starSituation.trim() || !starTask.trim() || !starAction.trim() || !starResult.trim()) return;
    const template: StarTemplate = {
      id: `${Date.now()}`,
      label: starLabel.trim(),
      situation: starSituation.trim(),
      task: starTask.trim(),
      action: starAction.trim(),
      result: starResult.trim(),
      tags: starTags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    const res = await window.osmos.addStarTemplate(template);
    if (res.ok && res.templates) setTemplates(res.templates);
    setStarLabel('');
    setStarSituation('');
    setStarTask('');
    setStarAction('');
    setStarResult('');
    setStarTags('');
  };

  const deleteTemplate = async (id: string) => {
    const res = await window.osmos.deleteStarTemplate(id);
    if (res.ok && res.templates) setTemplates(res.templates);
  };

  const body = (
    <>
      {!embedded ? (
        <>
          <h2>Interview prep</h2>
          <p>
            Question bank and STAR stories for profile <strong>{active?.label || 'current'}</strong>.
          </p>
        </>
      ) : (
        <p className="meta" style={{ marginBottom: 12 }}>
          Practice questions and STAR stories stay with this profile. Assemble interview prep (Company
          section) can auto-seed questions from the web.
        </p>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <button
          className={`primary${activeTab === 'questions' ? '' : ' secondary'}`}
          style={{ height: 38 }}
          type="button"
          onClick={() => setActiveTab('questions')}
        >
          Question bank ({questions.length})
        </button>
        <button
          className={`primary${activeTab === 'templates' ? '' : ' secondary'}`}
          style={{ height: 38 }}
          type="button"
          onClick={() => setActiveTab('templates')}
        >
          STAR ({templates.length})
        </button>
      </div>

      {activeTab === 'questions' && (
        <>
          <div className="field">
            <label>Company</label>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme" />
          </div>
          <div className="field">
            <label>Question</label>
            <textarea value={questionText} onChange={(e) => setQuestionText(e.target.value)} rows={3} placeholder="Paste or type an interview question." />
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as QuestionBankItem['category'])}>
                <option value="behavioral">Behavioral</option>
                <option value="technical">Technical</option>
                <option value="system-design">System design</option>
                <option value="product">Product</option>
                <option value="leadership">Leadership</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Difficulty</label>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as QuestionBankItem['difficulty'])}>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Tags (comma separated)</label>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="react, leadership, incident" />
          </div>
          <button className="primary" style={{ height: 40 }} type="button" onClick={() => void addQuestion()}>
            Add question
          </button>

          <div style={{ marginTop: 18 }}>
            {questions.length === 0 && <p className="meta">No questions yet for this profile.</p>}
            <ul>
              {questions.map((q) => (
                <li key={q.id} style={{ marginBottom: 10 }}>
                  <strong>{q.companyName}</strong> · <span className="meta">{q.category} · {q.difficulty}</span>
                  <p style={{ margin: '4px 0' }}>{q.question}</p>
                  <button type="button" onClick={() => void deleteQuestion(q.id)}>Remove</button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {activeTab === 'templates' && (
        <>
          <div className="field">
            <label>Label</label>
            <input value={starLabel} onChange={(e) => setStarLabel(e.target.value)} placeholder="e.g. Conflict resolution" />
          </div>
          <div className="field">
            <label>Situation</label>
            <textarea value={starSituation} onChange={(e) => setStarSituation(e.target.value)} rows={2} placeholder="Context / challenge" />
          </div>
          <div className="field">
            <label>Task</label>
            <textarea value={starTask} onChange={(e) => setStarTask(e.target.value)} rows={2} placeholder="Your responsibility" />
          </div>
          <div className="field">
            <label>Action</label>
            <textarea value={starAction} onChange={(e) => setStarAction(e.target.value)} rows={2} placeholder="What you actually did" />
          </div>
          <div className="field">
            <label>Result</label>
            <textarea value={starResult} onChange={(e) => setStarResult(e.target.value)} rows={2} placeholder="Outcome / metrics" />
          </div>
          <div className="field">
            <label>Tags (comma separated)</label>
            <input value={starTags} onChange={(e) => setStarTags(e.target.value)} placeholder="leadership, incident" />
          </div>
          <button className="primary" style={{ height: 40 }} type="button" onClick={() => void addTemplate()}>
            Save STAR template
          </button>

          <div style={{ marginTop: 18 }}>
            {templates.length === 0 && <p className="meta">No STAR templates yet for this profile.</p>}
            <ul>
              {templates.map((t) => (
                <li key={t.id} style={{ marginBottom: 10 }}>
                  <strong>{t.label}</strong>
                  <p style={{ margin: '4px 0' }}>S: {t.situation}</p>
                  <p style={{ margin: '4px 0' }}>T: {t.task}</p>
                  <p style={{ margin: '4px 0' }}>A: {t.action}</p>
                  <p style={{ margin: '4px 0' }}>R: {t.result}</p>
                  <button type="button" onClick={() => void deleteTemplate(t.id)}>Remove</button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );

  if (embedded) return <div className="profile-embed">{body}</div>;
  return <section className="panel">{body}</section>;
}
