import Store from 'electron-store';
import {
  DEFAULT_SAVED_PROFILE,
  DEFAULT_SETTINGS,
  type AppSettings,
  type DocumentReference,
  type SavedProfile,
  type WebSearchProvider,
} from '../../shared/types.js';
import {
  activeSavedProfile,
  normalizeSavedProfile,
  toUserProfile,
} from '../../shared/profiles.js';

const store = new Store<{ settings: AppSettings }>({
  name: 'osmos-settings',
  defaults: { settings: DEFAULT_SETTINGS },
});

const DEFAULT_SEARX = 'http://127.0.0.1/searxng';

function migrateWebSearch(raw: Partial<AppSettings>): {
  webSearchProvider: WebSearchProvider;
  useWebSearch: boolean;
} {
  if (raw.webSearchProvider) {
    return {
      webSearchProvider: raw.webSearchProvider,
      useWebSearch: raw.webSearchProvider !== 'off',
    };
  }

  if (raw.useWebSearch === false) {
    return { webSearchProvider: 'off', useWebSearch: false };
  }

  const searx = (raw.searxngBaseUrl || '').trim().replace(/\/+$/, '');
  const customized =
    Boolean(searx) &&
    searx !== DEFAULT_SEARX &&
    searx !== 'http://127.0.0.1:8080' &&
    !searx.includes('example.com');

  if (customized) {
    return { webSearchProvider: 'searxng', useWebSearch: true };
  }

  return { webSearchProvider: 'duckduckgo', useWebSearch: true };
}

function attachLegacyDocuments(
  profiles: SavedProfile[],
  activeProfileId: string,
  legacyDocs: DocumentReference[],
): SavedProfile[] {
  if (!legacyDocs.length) return profiles;
  return profiles.map((p) => {
    if (p.id !== activeProfileId) return p;
    if (p.documents?.length) return p;
    return normalizeSavedProfile({ ...p, documents: legacyDocs });
  });
}

function migrateProfiles(raw: Partial<AppSettings>): {
  profiles: SavedProfile[];
  activeProfileId: string;
  profile: AppSettings['profile'];
  documents: DocumentReference[];
} {
  const legacyDocs = Array.isArray(raw.documents) ? raw.documents : [];

  if (Array.isArray(raw.profiles) && raw.profiles.length > 0) {
    let profiles = raw.profiles.map((p, i) =>
      normalizeSavedProfile(p, p.id || `profile-${i}`),
    );
    const activeProfileId =
      profiles.find((p) => p.id === raw.activeProfileId)?.id || profiles[0]!.id;
    profiles = attachLegacyDocuments(profiles, activeProfileId, legacyDocs);
    const active = activeSavedProfile(profiles, activeProfileId);
    return {
      profiles,
      activeProfileId,
      profile: toUserProfile(active),
      documents: active.documents || [],
    };
  }

  const seeded = normalizeSavedProfile({
    ...DEFAULT_SAVED_PROFILE,
    ...(raw.profile || {}),
    id: 'default',
    label:
      (raw.profile?.displayName || '').trim() ||
      DEFAULT_SAVED_PROFILE.label,
    documents: legacyDocs,
  });
  return {
    profiles: [seeded],
    activeProfileId: seeded.id,
    profile: toUserProfile(seeded),
    documents: seeded.documents,
  };
}

export function getSettings(): AppSettings {
  const raw = store.get('settings') || DEFAULT_SETTINGS;
  const web = migrateWebSearch(raw);
  const migrated = migrateProfiles(raw);
  const next: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    ...migrated,
    providers: { ...DEFAULT_SETTINGS.providers, ...(raw.providers || {}) },
    webSearchProvider: web.webSearchProvider,
    useWebSearch: web.useWebSearch,
    tavilyApiKey: typeof raw.tavilyApiKey === 'string' ? raw.tavilyApiKey : '',
    onboardingCompleted:
      typeof raw.onboardingCompleted === 'boolean' ? raw.onboardingCompleted : true,
  };

  if (next.sttProvider === 'webspeech' && process.platform === 'linux') {
    next.sttProvider = 'local-whisper';
  }

  const active = activeSavedProfile(next.profiles, next.activeProfileId);
  next.documents = active.documents || [];

  if (
    !raw.webSearchProvider ||
    raw.useWebSearch !== next.useWebSearch ||
    !Array.isArray(raw.profiles) ||
    !raw.activeProfileId ||
    typeof raw.onboardingCompleted !== 'boolean' ||
    (Array.isArray(raw.documents) &&
      raw.documents.length > 0 &&
      !(raw.profiles || []).some((p) => (p.documents || []).length > 0)) ||
    (next.sttProvider === 'local-whisper' && raw.sttProvider === 'webspeech' && process.platform === 'linux')
  ) {
    store.set('settings', next);
  }

  return next;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  let profiles = Array.isArray(patch.profiles)
    ? patch.profiles.map((p, i) => normalizeSavedProfile(p, p.id || `profile-${i}`))
    : [...(current.profiles || [])];

  if (!profiles.length) profiles = [{ ...DEFAULT_SAVED_PROFILE }];

  let activeProfileId =
    patch.activeProfileId && profiles.find((p) => p.id === patch.activeProfileId)
      ? patch.activeProfileId
      : profiles.find((p) => p.id === current.activeProfileId)?.id || profiles[0]!.id;

  const switching =
    Boolean(patch.activeProfileId) && patch.activeProfileId !== current.activeProfileId;

  let profile = switching
    ? toUserProfile(activeSavedProfile(profiles, activeProfileId))
    : { ...current.profile, ...(patch.profile || {}) };

  // Global documents patch writes into the active profile slot.
  if (Array.isArray(patch.documents) && !patch.profiles) {
    profiles = profiles.map((p) =>
      p.id === activeProfileId
        ? normalizeSavedProfile({ ...p, documents: patch.documents })
        : p,
    );
  }

  profiles = profiles.map((p) =>
    p.id === activeProfileId
      ? normalizeSavedProfile({
          ...p,
          ...profile,
          id: p.id,
          label: p.label || profile.displayName || DEFAULT_SAVED_PROFILE.label,
          documents: Array.isArray(patch.documents) && !patch.profiles ? patch.documents! : p.documents,
        })
      : p,
  );

  const active = activeSavedProfile(profiles, activeProfileId);
  profile = toUserProfile(active);

  const next: AppSettings = {
    ...current,
    ...patch,
    profiles,
    activeProfileId,
    profile,
    documents: active.documents || [],
    providers: { ...current.providers, ...(patch.providers || {}) },
  };

  if (switching && patch.activeMode === undefined && active.preferredMode) {
    next.activeMode = active.preferredMode;
  }

  if (patch.webSearchProvider !== undefined) {
    next.useWebSearch = patch.webSearchProvider !== 'off';
  } else if (patch.useWebSearch !== undefined && patch.webSearchProvider === undefined) {
    next.webSearchProvider = patch.useWebSearch
      ? current.webSearchProvider === 'off'
        ? 'duckduckgo'
        : current.webSearchProvider
      : 'off';
    next.useWebSearch = patch.useWebSearch;
  }

  store.set('settings', next);
  return next;
}
