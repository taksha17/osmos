import { useState } from 'react';
import type { AppSettings } from '@shared/types';
import { APP_NAME, APP_TAGLINE } from '@shared/brand';
import { createSavedProfile } from '@shared/profiles';
import { BrandLogo } from './BrandLogo';
import { Icon } from './Icon';

type Props = {
  settings: AppSettings;
  onComplete: (next: AppSettings) => void;
  onSkip: (next: AppSettings) => void;
};

type Step = 'welcome' | 'llm' | 'mic' | 'profile' | 'done';

const STEP_META: Record<Step, { n: number; label: string }> = {
  welcome: { n: 1, label: 'Welcome' },
  llm: { n: 2, label: 'Your model' },
  mic: { n: 3, label: 'Microphone' },
  profile: { n: 4, label: 'Your profile' },
  done: { n: 4, label: 'Ready' },
};

export function OnboardingWizard({ settings, onComplete, onSkip }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [displayName, setDisplayName] = useState(settings.profile.displayName || '');
  const [profileLabel, setProfileLabel] = useState(
    settings.profiles?.[0]?.label || 'Default',
  );
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaBaseUrl);
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel);
  const [models, setModels] = useState<string[]>([]);
  const [probeMsg, setProbeMsg] = useState('');
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const probeOllama = async () => {
    setBusy(true);
    setProbeMsg('Checking…');
    try {
      await window.osmos.updateSettings({
        ollamaBaseUrl: ollamaUrl,
        ollamaModel,
        activeProvider: 'ollama',
      });
      const res = await window.osmos.listOllamaModels(ollamaUrl);
      if (res.ok && res.models.length) {
        setModels(res.models);
        if (!res.models.includes(ollamaModel)) {
          setOllamaModel(res.models[0]!);
        }
        setProbeMsg(`${res.models.length} models found`);
      } else {
        setModels([]);
        setProbeMsg(res.error || 'Ollama not reachable — you can still use a cloud provider later.');
      }
    } catch (e) {
      setProbeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const requestMic = async () => {
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicOk(true);
    } catch {
      setMicOk(false);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (startOverlay: boolean) => {
    setBusy(true);
    try {
      const profiles = (settings.profiles?.length
        ? settings.profiles
        : [
            createSavedProfile({
              id: settings.activeProfileId || 'default',
              label: profileLabel,
              displayName: displayName.trim(),
            }),
          ]
      ).map((p, i) =>
        i === 0 || p.id === settings.activeProfileId
          ? {
              ...p,
              label: profileLabel.trim() || p.label || 'Default',
              displayName: displayName.trim(),
            }
          : p,
      );
      const active = profiles.find((p) => p.id === settings.activeProfileId) || profiles[0]!;
      const next = await window.osmos.updateSettings({
        ollamaBaseUrl: ollamaUrl,
        ollamaModel,
        profiles,
        activeProfileId: active.id,
        profile: {
          ...settings.profile,
          displayName: displayName.trim(),
          resumeText: active.resumeText,
          jdText: active.jdText,
          notes: active.notes,
        },
        onboardingCompleted: true,
        sttProvider: settings.sttProvider === 'webspeech' ? 'local-whisper' : settings.sttProvider,
      });
      if (startOverlay) onComplete(next);
      else onSkip(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboard">
      <aside className="onboard__aside">
        <BrandLogo variant="hero" />
        <p className="onboard__kicker">The quiet co-pilot</p>
        <h2>Be present in the conversation. OSMOS handles the rest.</h2>
        <p className="onboard__lede">
          Live listening, screen context, and answers grounded in your own story — without a bot
          joining the call.
        </p>
        <ul className="onboard__points">
          <li><Icon name="shield" size={15} /> Private by default, local-first</li>
          <li><Icon name="screen" size={15} /> Sees the screen only when you ask</li>
          <li><Icon name="sparkles" size={15} /> Answers that sound like you</li>
        </ul>
        <span className="onboard__aside-note">No account. No subscription. MIT licensed.</span>
      </aside>
      <div className="onboard__card" data-step={String(STEP_META[step].n).padStart(2, '0')}>
        <div className="onboard__step-row">
          <span className="onboard__eyebrow">Setup · {STEP_META[step].label}</span>
          <span className="onboard__step-count">{STEP_META[step].n} / 4</span>
        </div>
        <div className="onboard__progress" aria-hidden>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={n <= STEP_META[step].n ? 'is-done' : ''} />
          ))}
        </div>
        <div className="onboard__step-body">
        {step === 'welcome' ? (
          <>
            <h1>Welcome to {APP_NAME}</h1>
            <p className="meta">{APP_TAGLINE}</p>
            <p>A quick setup so the overlay can listen, see your screen, and suggest answers.</p>
            <div className="onboard__actions">
              <button type="button" className="primary" onClick={() => setStep('llm')}>
                Get started
              </button>
              <button type="button" onClick={() => void finish(false)} disabled={busy}>
                Skip for now
              </button>
            </div>
          </>
        ) : null}

        {step === 'llm' ? (
          <>
            <h1>Connect your AI</h1>
            <p className="meta">Local Ollama is free and private. Cloud providers work in Settings later.</p>
            <div className="field">
              <label>Ollama URL</label>
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>Model</label>
              {models.length ? (
                <select value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} />
              )}
            </div>
            {probeMsg ? <p className="meta">{probeMsg}</p> : null}
            <div className="onboard__actions">
              <button type="button" onClick={() => void probeOllama()} disabled={busy}>
                Probe Ollama
              </button>
              <button type="button" className="primary" onClick={() => setStep('mic')}>
                Continue
              </button>
            </div>
          </>
        ) : null}

        {step === 'mic' ? (
          <>
            <h1>Microphone</h1>
            <p className="meta">OSMOS needs mic access for live interview assist.</p>
            <button type="button" className="primary" onClick={() => void requestMic()} disabled={busy}>
              Allow microphone
            </button>
            {micOk === true ? <p className="meta">Microphone ready.</p> : null}
            {micOk === false ? (
              <p className="meta">Permission denied — you can enable it later in the system tray / Settings.</p>
            ) : null}
            <div className="onboard__actions">
              <button type="button" onClick={() => setStep('llm')}>
                Back
              </button>
              <button type="button" className="primary" onClick={() => setStep('profile')}>
                Continue
              </button>
            </div>
          </>
        ) : null}

        {step === 'profile' ? (
          <>
            <h1>Your profile</h1>
            <p className="meta">Name the context you&apos;ll use most — you can add more later.</p>
            <div className="field">
              <label>Profile label</label>
              <input
                value={profileLabel}
                onChange={(e) => setProfileLabel(e.target.value)}
                placeholder="e.g. Interview @ Acme"
              />
            </div>
            <div className="field">
              <label>Your name</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
              />
            </div>
            <div className="onboard__actions">
              <button type="button" onClick={() => setStep('mic')}>
                Back
              </button>
              <button type="button" className="primary" onClick={() => setStep('done')}>
                Continue
              </button>
            </div>
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <h1>You&apos;re set</h1>
            <p>
              Start Osmos anytime from Home. Use the overlay dropdown to switch profile, mode, and mic
              mid-call.
            </p>
            <div className="onboard__actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void finish(true)}>
                Start Osmos
              </button>
              <button type="button" disabled={busy} onClick={() => void finish(false)}>
                Go to Home
              </button>
            </div>
          </>
        ) : null}
        </div>
        <div className="onboard__foot">
          <Icon name="shield" size={14} />
          Local-first. Your résumé, conversations, and keys stay on this machine.
        </div>
      </div>
    </div>
  );
}
