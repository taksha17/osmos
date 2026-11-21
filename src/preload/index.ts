import { contextBridge, ipcRenderer } from 'electron';
import type { ChatStreamEvent } from '../shared/types';

/**
 * VAD-endpointed utterance (Architecture v2 §5.2): one complete question /
 * statement whose audio the STT worker can transcribe as a unit.
 */
type UtteranceEvent = {
  ok: boolean;
  base64?: string;
  mimeType?: string;
  startMs?: number;
  endMs?: number;
  speechMs?: number;
  reason?: string;
  error?: string;
};

const api = {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:update', patch),
  toggleOverlay: () => ipcRenderer.invoke('window:toggle-overlay'),
  showLauncher: () => ipcRenderer.invoke('window:show-launcher'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  listOllamaModels: (baseUrl?: string) => ipcRenderer.invoke('ollama:list-models', baseUrl),
  testSearxng: (baseUrl?: string) => ipcRenderer.invoke('searxng:test', baseUrl),
  testWebAccess: (override?: {
    enabled?: boolean;
    tier?: string;
    baseUrl?: string;
    apiKeyRef?: string;
  }) => ipcRenderer.invoke('webaccess:test', override),
  testWebSearch: (override?: {
    webSearchProvider?: 'off' | 'duckduckgo' | 'tavily' | 'searxng';
    tavilyApiKey?: string;
    searxngBaseUrl?: string;
  }) => ipcRenderer.invoke('websearch:test', override),
  transcribeAudio: (payload: {
    base64: string;
    mimeType: string;
    fileName?: string;
    engine?: 'local' | 'openai';
    model?: string;
  }) => ipcRenderer.invoke('stt:transcribe', payload),
  captureRegion: () => ipcRenderer.invoke('screen:capture'),
  captureFullScreen: (opts?: { loopSafe?: boolean }) =>
    ipcRenderer.invoke('screen:capture-full', opts),
  canLoopSafeScreenCapture: () => ipcRenderer.invoke('screen:can-loop'),
  listDesktopSources: () => ipcRenderer.invoke('desktop:list-sources'),
  enableLoopbackAudio: () => ipcRenderer.invoke('loopback:enable'),
  disableLoopbackAudio: () => ipcRenderer.invoke('loopback:disable'),
  verifyStealth: () =>
    ipcRenderer.invoke('stealth:verify') as Promise<{
      ok: boolean;
      supported: boolean;
      detail: string;
      checkedAt: number;
    }>,
  ocrExtract: (payload: { base64: string }) => ipcRenderer.invoke('ocr:extract', payload),
  companyIntel: (payload: { companyName: string; jdText?: string; companyUrl?: string }) =>
    ipcRenderer.invoke('company:intel', payload),
  assembleInterviewPrep: () => ipcRenderer.invoke('profile:assemble-prep'),
  extractFileText: (payload: { base64: string; fileName?: string; mimeType?: string }) =>
    ipcRenderer.invoke('file:extract-text', payload),
  captureSystemAudio: (payload?: { durationMs?: number; device?: string }) =>
    ipcRenderer.invoke('system:audio', payload || {}),
  startSystemAudioListen: (payload?: { durationMs?: number; device?: string; chunkMs?: number }) =>
    ipcRenderer.invoke('system:listen-start', {
      device: payload?.device,
      chunkMs: payload?.chunkMs ?? payload?.durationMs,
    }),
  stopSystemAudioListen: () => ipcRenderer.invoke('system:listen-stop'),
  startMicListen: (payload?: { device?: string; chunkMs?: number }) =>
    ipcRenderer.invoke('mic:listen-start', payload || {}),
  stopMicListen: () => ipcRenderer.invoke('mic:listen-stop'),
  micDiagnostics: () =>
    ipcRenderer.invoke('mic:diagnostics') as Promise<{
      deathCount: number;
      lastSpawnAt: number | null;
      lastDeathAt: number | null;
      lastSpawnArgs: string[];
      lastStderr: string;
      lastExitCode: number | null;
      lastErrorMessage: string;
    }>,
  onMicChunk: (
    listener: (chunk: {
      ok: boolean;
      base64?: string;
      mimeType?: string;
      error?: string;
      rms?: number;
      silent?: boolean;
    }) => void,
  ) => {
    const handler = (_e: Electron.IpcRendererEvent, chunk: Parameters<typeof listener>[0]) =>
      listener(chunk);
    ipcRenderer.on('mic:audio-chunk', handler);
    return () => ipcRenderer.removeListener('mic:audio-chunk', handler);
  },
  onMicStatus: (listener: (ev: { text: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: { text: string }) => listener(ev);
    ipcRenderer.on('mic:audio-status', handler);
    return () => ipcRenderer.removeListener('mic:audio-status', handler);
  },
  /** VAD-endpointed microphone utterances (Architecture v2 §5.2). */
  onMicUtterance: (listener: (ev: UtteranceEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: UtteranceEvent) => listener(ev);
    ipcRenderer.on('mic:utterance', handler);
    return () => ipcRenderer.removeListener('mic:utterance', handler);
  },
  listAudioDevicesPython: () => ipcRenderer.invoke('audio:list-devices-python'),
  startAudioCapturePython: (payload?: {
    sampleRate?: number;
    channels?: number;
    deviceId?: string;
    audioSource?: 'system' | 'mic' | 'both';
  }) => ipcRenderer.invoke('audio:start-capture-python', payload || {}),
  stopAudioCapturePython: () => ipcRenderer.invoke('audio:stop-capture-python'),
  getAudioDeviceInfoPython: (deviceId: string) =>
    ipcRenderer.invoke('audio:get-device-info-python', deviceId),
  onSystemAudioChunk: (
    listener: (chunk: {
      ok: boolean;
      base64?: string;
      mimeType?: string;
      error?: string;
      silent?: boolean;
      rms?: number;
    }) => void,
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      chunk: {
        ok: boolean;
        base64?: string;
        mimeType?: string;
        error?: string;
        silent?: boolean;
        rms?: number;
      },
    ) => listener(chunk);
    ipcRenderer.on('system:audio-chunk', handler);
    return () => ipcRenderer.removeListener('system:audio-chunk', handler);
  },
  onSystemAudioStatus: (listener: (ev: { text: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: { text: string }) => listener(ev);
    ipcRenderer.on('system:audio-status', handler);
    return () => ipcRenderer.removeListener('system:audio-status', handler);
  },
  /** VAD-endpointed meeting utterances (Architecture v2 §5.2). */
  onSystemAudioUtterance: (listener: (ev: UtteranceEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: UtteranceEvent) => listener(ev);
    ipcRenderer.on('system:audio-utterance', handler);
    return () => ipcRenderer.removeListener('system:audio-utterance', handler);
  },
  listAudioDevices: () => ipcRenderer.invoke('audio:list-devices'),
  captureMicAudio: (payload?: { durationMs?: number; device?: string }) =>
    ipcRenderer.invoke('audio:capture-mic', payload || {}),
  listHistory: () => ipcRenderer.invoke('history:list'),
  saveHistory: (session: {
    id: string;
    mode: string;
    messages: Array<{ role: string; content: string; createdAt: number }>;
    createdAt: number;
    updatedAt: number;
  }) => ipcRenderer.invoke('history:save', session),
  deleteHistory: (id: string) => ipcRenderer.invoke('history:delete', id),
  exportSessionReport: (id: string) => ipcRenderer.invoke('history:export-report', id),
  listQuestions: () => ipcRenderer.invoke('question:list'),
  addQuestion: (item: {
    id: string;
    companyName: string;
    question: string;
    category: string;
    difficulty: string;
    tags: string[];
    createdAt: number;
  }) => ipcRenderer.invoke('question:add', item),
  deleteQuestion: (id: string) => ipcRenderer.invoke('question:delete', id),
  listStarTemplates: () => ipcRenderer.invoke('star:list'),
  addStarTemplate: (template: {
    id: string;
    label: string;
    situation: string;
    task: string;
    action: string;
    result: string;
    tags: string[];
  }) => ipcRenderer.invoke('star:add', template),
  deleteStarTemplate: (id: string) => ipcRenderer.invoke('star:delete', id),
  checkUpdates: (updateUrl?: string) => ipcRenderer.invoke('app:check-updates', updateUrl),
  ask: (payload: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) => ipcRenderer.invoke('chat:ask', payload),
  askStream: (
    payload: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      screenText?: string;
      screenAt?: number;
    },
    onEvent: (event: ChatStreamEvent) => void,
  ) => {
    const requestId =
      globalThis.crypto?.randomUUID?.() ??
      `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const handler = (_event: Electron.IpcRendererEvent, data: ChatStreamEvent) => {
      if (!data || data.requestId !== requestId) return;
      onEvent(data);
    };
    ipcRenderer.on('chat:stream', handler);

    const done = ipcRenderer.invoke('chat:ask-stream', { ...payload, requestId }).finally(() => {
      ipcRenderer.removeListener('chat:stream', handler);
    });

    return {
      requestId,
      done,
      cancel: () => ipcRenderer.invoke('chat:cancel-stream', requestId),
    };
  },
  warmupProvider: () => ipcRenderer.invoke('provider:warmup'),
  warmupStatus: () => ipcRenderer.invoke('provider:warmup-status'),
  probeLumenGateway: (url?: string) => ipcRenderer.invoke('lumen:probe-gateway', url),
  onOverlayEvent: (listener: (event: { type: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: string }) => {
      listener(data);
    };
    ipcRenderer.on('overlay', handler);
    return () => ipcRenderer.removeListener('overlay', handler);
  },
  onShortcut: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => {
      listener(action);
    };
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },
  onSettingsChanged: (listener: (settings: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      listener(data);
    };
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
  resetOverlayIdle: () => ipcRenderer.invoke('overlay:reset-idle'),
  /** §11: the overlay only takes keyboard focus when the user clicks it. */
  focusOverlay: () => ipcRenderer.invoke('overlay:focus'),
  setOverlayClickThrough: (enabled: boolean) =>
    ipcRenderer.invoke('overlay:click-through', enabled) as Promise<{
      ok: boolean;
      enabled: boolean;
    }>,
  getOverlayClickThrough: () =>
    ipcRenderer.invoke('overlay:get-click-through') as Promise<{ enabled: boolean }>,
  onOverlayClickThrough: (listener: (enabled: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, enabled: boolean) => listener(enabled);
    ipcRenderer.on('overlay:click-through', handler);
    return () => ipcRenderer.removeListener('overlay:click-through', handler);
  },
  log: (level: 'log' | 'info' | 'warn' | 'error', ...args: any[]) => ipcRenderer.invoke('app:log', level, ...args),
  clearAllHistory: () => ipcRenderer.invoke('history:clear-all'),
  startScreenLive: (
    payload?: { intervalMs?: number },
  ): Promise<{ ok: boolean; error?: string; backend?: string }> =>
    ipcRenderer.invoke('screen:live-start', payload || {}),
  stopScreenLive: () => ipcRenderer.invoke('screen:live-stop'),
  grabScreen: (): Promise<{ ok: boolean; text?: string; at?: number; error?: string }> =>
    ipcRenderer.invoke('screen:grab'),
  screenLiveCapable: () => ipcRenderer.invoke('screen:live-capable'),
  onScreenLiveText: (listener: (ev: { text: string; at: number; error?: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      ev: { text: string; at: number; error?: string },
    ) => listener(ev);
    ipcRenderer.on('screen:live-text', handler);
    return () => ipcRenderer.removeListener('screen:live-text', handler);
  },
};

contextBridge.exposeInMainWorld('osmos', api);

export type OsmosApi = typeof api;
