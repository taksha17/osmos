import { contextBridge, ipcRenderer } from 'electron';
import type { ChatStreamEvent } from '../shared/types';

const api = {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:update', patch),
  toggleOverlay: () => ipcRenderer.invoke('window:toggle-overlay'),
  showLauncher: () => ipcRenderer.invoke('window:show-launcher'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  listOllamaModels: (baseUrl?: string) => ipcRenderer.invoke('ollama:list-models', baseUrl),
  testSearxng: (baseUrl?: string) => ipcRenderer.invoke('searxng:test', baseUrl),
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
  }) => ipcRenderer.invoke('stt:transcribe', payload),
  captureRegion: () => ipcRenderer.invoke('screen:capture'),
  captureFullScreen: () => ipcRenderer.invoke('screen:capture-full'),
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
};

contextBridge.exposeInMainWorld('osmos', api);

export type OsmosApi = typeof api;
