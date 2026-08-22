import { useEffect, useRef, useState } from 'react';
import type { AppSettings, CopilotMode } from '@shared/types';
import { MODE_DEFS } from '@shared/modes';
import { activeSavedProfile, modeLabel } from '@shared/profiles';
import { DEFAULT_SAVED_PROFILE } from '@shared/types';
import type { MicDevice } from '../stt/micStt';

type Props = {
  settings: AppSettings;
  micDevices: MicDevice[];
  onRefreshMics?: () => void;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void> | void;
};

export function OverlayQuickMenu({ settings, micDevices, onRefreshMics, onUpdate }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const profiles = settings.profiles?.length
    ? settings.profiles
    : [{ ...DEFAULT_SAVED_PROFILE, ...settings.profile, id: 'default', label: 'Default' }];
  const active = activeSavedProfile(profiles, settings.activeProfileId);
  const micLabel =
    micDevices.find((d) => d.deviceId === settings.micDeviceId)?.label ||
    (settings.micDeviceId ? 'Selected mic' : 'System default');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) onRefreshMics?.();
  }, [open, onRefreshMics]);

  const apply = async (patch: Partial<AppSettings>) => {
    await onUpdate(patch);
    setOpen(false);
  };

  return (
    <div className="overlay-menu" ref={rootRef}>
      <button
        type="button"
        className={`overlay-menu__trigger${open ? ' overlay-menu__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="overlay-menu__label">{active.label || 'Profile'}</span>
        <span className="overlay-menu__meta">
          {modeLabel(settings.activeMode)} · {micLabel.length > 22 ? `${micLabel.slice(0, 20)}…` : micLabel}
        </span>
        <span className="overlay-menu__caret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="overlay-menu__panel" role="menu">
          <div className="overlay-menu__section">
            <div className="overlay-menu__heading">Profile</div>
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === active.id}
                className={`overlay-menu__item${p.id === active.id ? ' overlay-menu__item--active' : ''}`}
                onClick={() =>
                  void apply({
                    activeProfileId: p.id,
                    profile: {
                      displayName: p.displayName,
                      resumeText: p.resumeText,
                      jdText: p.jdText,
                      notes: p.notes,
                    },
                    ...(p.preferredMode ? { activeMode: p.preferredMode } : {}),
                  })
                }
              >
                {p.label || p.displayName || 'Untitled'}
              </button>
            ))}
          </div>

          <div className="overlay-menu__section">
            <div className="overlay-menu__heading">Mode</div>
            {MODE_DEFS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={settings.activeMode === m.id}
                className={`overlay-menu__item${settings.activeMode === m.id ? ' overlay-menu__item--active' : ''}`}
                onClick={() => void apply({ activeMode: m.id as CopilotMode })}
              >
                {m.name}
              </button>
            ))}
          </div>

          <div className="overlay-menu__section">
            <div className="overlay-menu__heading">Microphone</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!settings.micDeviceId}
              className={`overlay-menu__item${!settings.micDeviceId ? ' overlay-menu__item--active' : ''}`}
              onClick={() => void apply({ micDeviceId: '' })}
            >
              System default
            </button>
            {micDevices.map((d) => (
              <button
                key={d.deviceId}
                type="button"
                role="menuitemradio"
                aria-checked={settings.micDeviceId === d.deviceId}
                className={`overlay-menu__item${settings.micDeviceId === d.deviceId ? ' overlay-menu__item--active' : ''}`}
                onClick={() => void apply({ micDeviceId: d.deviceId })}
              >
                {d.label || 'Microphone'}
              </button>
            ))}
            {micDevices.length === 0 ? (
              <p className="overlay-menu__empty meta">Allow mic access to list devices.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
