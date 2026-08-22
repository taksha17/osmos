import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  shell,
  session,
  nativeImage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlatformAdapter } from './platform/index.js';
import { getSettings, updateSettings } from './services/settingsStore.js';
import { chatOllama, listOllamaModels, streamChatOllama } from './services/ollama.js';
import { formatHitsForPrompt, searchSearxng } from './services/searxng.js';
import { searchWeb, testWebSearch, webSearchEnabled } from './services/webSearch.js';
import { stopLocalWhisperWorker, transcribeLocalWhisper } from './services/localWhisper.js';
import { transcribeWithWhisper } from './services/whisper.js';
import { extractTextFromImage } from './services/ocr.js';
import { researchCompany } from './services/companyIntel.js';
import { chatWithProvider, streamWithProvider } from './services/providers.js';
import { loadHistory, saveHistory, upsertSession, deleteSession } from './services/history.js';
import { checkForUpdates } from './services/updates.js';
import { retrieveChunks } from './services/retrieval.js';
import { extractTextFromUpload } from './services/documentExtract.js';
import { assembleInterviewPrep } from './services/profilePrep.js';
import {
  addQuestionBankItem,
  deleteQuestionBankItem,
  addStarTemplate,
  deleteStarTemplate,
  loadQuestionBank,
  loadStarTemplates,
  migrateLegacyBanksIntoActiveProfile,
} from './services/questionBank.js';
import { migrateLegacyUserData } from './services/migrateLegacy.js';
import { APP_NAME } from '../shared/brand.js';
import { FEATURES } from '../shared/features.js';
import { modeDef } from '../shared/modes.js';
import { activeSavedProfile } from '../shared/profiles.js';
import {
  DEFAULT_PROFILE,
  type AssemblePrepResponse,
  type CaptureResult,
  type ChatRequest,
  type ChatResponse,
  type ChatSession,
  type ChatStreamEvent,
  type CompanyIntelRequest,
  type CompanyIntelResponse,
  type ExtractTextRequest,
  type ExtractTextResponse,
  type HistoryResponse,
  type OcrRequest,
  type ProviderConfig,
  type QuestionBankItem,
  type QuestionBankResponse,
  type StarTemplate,
  type StarTemplatesResponse,
  type SystemAudioRequest,
  type SystemAudioResponse,
  type TranscribeRequest,
  type UpdateStatus,
  type AppSettings,
} from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && (process.env.OSMOS_DEV === '1' || process.env.UNCON_DEV === '1');

function projectRoot(): string {
  if (app.isPackaged) return app.getAppPath();
  return path.resolve(__dirname, '../..');
}

function resolveAppIcon() {
  const candidates = [
    path.join(projectRoot(), 'resources/icon.png'),
    path.join(projectRoot(), 'resources/logo.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return nativeImage.createFromPath(candidate);
  }
  return undefined;
}

const appIcon = resolveAppIcon();

// Linux: unpacked/dev Electron lacks a correctly configured chrome-sandbox.
// AppImages and dir builds need --no-sandbox; ozone auto picks Wayland/X11.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

const platform = createPlatformAdapter();
let launcher: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
const streamAbortControllers = new Map<string, AbortController>();

async function buildChatContext(message: string) {
  const s = getSettings();
  const mode = modeDef(s.activeMode || 'general');
  const active = activeSavedProfile(s.profiles, s.activeProfileId);
  const profile = s.profile || DEFAULT_PROFILE;
  const provider = s.providers?.[s.activeProvider || 'ollama'] || s.providers?.ollama;

  // Interview answers should ground in the saved profile — not random web hits.
  // Web search still runs for meeting/general, or when the user clearly asks for research.
  const wantsResearch = /\b(search|news|latest|today|company|salary|stock|who is|what is)\b/i.test(
    message,
  );
  const allowWeb =
    webSearchEnabled(s) &&
    (s.activeMode !== 'interview' || wantsResearch);

  let webBlock = '';
  let searchHits = 0;
  let usedWebSearch = false;
  if (allowWeb) {
    try {
      const hits = await searchWeb(s, message);
      searchHits = hits.length;
      usedWebSearch = hits.length > 0;
      const today = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZoneName: 'short',
      }).format(new Date());
      webBlock = formatHitsForPrompt(hits, today);
    } catch (e) {
      console.warn('[chat] web search skipped:', e);
    }
  }

  const clip = (text: string, max: number) => {
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max)}\n…[truncated]`;
  };

  const profileParts: string[] = [];
  if (profile.displayName.trim()) profileParts.push(`Name: ${profile.displayName.trim()}`);
  if (profile.resumeText.trim()) {
    profileParts.push(`Résumé / experience:\n${clip(profile.resumeText, 6_000)}`);
  }
  if (profile.jdText.trim()) {
    profileParts.push(`Target job description:\n${clip(profile.jdText, 3_500)}`);
  }
  if (profile.notes.trim()) profileParts.push(`Extra notes:\n${clip(profile.notes, 1_500)}`);
  if (active.companyName?.trim() || active.companyUrl?.trim()) {
    profileParts.push(
      `Target company: ${active.companyName || 'Unknown'}${active.companyUrl ? ` (${active.companyUrl})` : ''}`,
    );
  }
  if (active.companyIntel?.trim()) {
    profileParts.push(`Company intel:\n${clip(active.companyIntel, 4_000)}`);
  }
  const profileBlock =
    profileParts.length > 0
      ? `\n\n# User profile\n${profileParts.join('\n\n')}`
      : '\n\n# User profile\n(No résumé/JD saved yet — do not invent personal facts.)';

  const docs = active.documents?.length ? active.documents : s.documents || [];
  const docChunks = retrieveChunks(docs, message, 4);
  const docBlock =
    docChunks.length > 0
      ? `\n\n# Retrieved reference passages\n${docChunks.map((c, i) => `[${i + 1}] ${c.docName}\n${c.text}`).join('\n\n')}`
      : docs.length > 0
        ? `\n\n# Attached reference documents\n${docs.map((d, i) => `[${i + 1}] ${d.name}\n${clip(d.text, 3_500)}`).join('\n\n')}`
        : '';

  let prepBlock = '';
  if (s.activeMode === 'interview') {
    const stars = (active.starTemplates?.length ? active.starTemplates : loadStarTemplates()).slice(0, 6);
    const questions = (active.questions?.length ? active.questions : loadQuestionBank()).slice(0, 8);
    const parts: string[] = [];
    if (stars.length) {
      parts.push(
        `STAR stories (prefer these when answering behavioral questions):\n${stars
          .map(
            (t, i) =>
              `[${i + 1}] ${t.label}\nS: ${clip(t.situation, 400)}\nT: ${clip(t.task, 280)}\nA: ${clip(t.action, 500)}\nR: ${clip(t.result, 280)}`,
          )
          .join('\n\n')}`,
      );
    }
    if (questions.length) {
      parts.push(
        `Saved interview questions (for practice / anticipation):\n${questions
          .map((q, i) => `[${i + 1}] (${q.companyName} · ${q.category}) ${clip(q.question, 220)}`)
          .join('\n')}`,
      );
    }
    if (parts.length) {
      prepBlock = `\n\n# Interview prep bank\n${parts.join('\n\n')}`;
    }
  }

  const system = [
    `You are ${APP_NAME}, an open-source desktop AI copilot.`,
    'Be accurate, concise, and honest about uncertainty.',
    'If live web research is provided, prefer it for current events and public facts.',
    'Never invent personal résumé facts about the user.',
    'Answer the user question directly. Prefer short, speakable answers.',
    'Use attached reference documents when relevant; cite document names if possible.',
    'When STAR stories are provided, weave the matching story into behavioral answers without inventing outcomes.',
    'Use saved company intel when answering company-specific interview questions.',
    '',
    mode.systemAddon,
    profileBlock,
    prepBlock,
    docBlock,
    webBlock ? `\n\n# Live web research\n${webBlock}` : '',
  ].join('\n');

  return { s, system, usedWebSearch, searchHits, provider: provider as ProviderConfig };
}

function preloadPath() {
  return path.join(__dirname, '../preload/index.cjs');
}

function rendererUrl(hash = '') {
  if (isDev) return `http://127.0.0.1:5179/${hash}`;
  return `file://${path.join(__dirname, '../../dist/index.html')}${hash}`;
}

function createLauncher() {
  launcher = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: APP_NAME,
    icon: appIcon,
    backgroundColor: '#050508',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void launcher.loadURL(rendererUrl(''));
  launcher.on('closed', () => {
    launcher = null;
  });
}

function createOverlay() {
  const stealth = getSettings().stealthEnabled;
  overlay = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: stealth,
    resizable: true,
    show: false,
    icon: appIcon,
    backgroundColor: '#00000000',
    focusable: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void overlay.loadURL(rendererUrl('#/overlay'));
  overlay.on('closed', () => {
    overlay = null;
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  platform.applyStealth(stealth, [overlay]);
  // Re-assert OS capture exclusion whenever the overlay becomes visible —
  // some Windows builds drop WDA_EXCLUDEFROMCAPTURE across hide/show.
  overlay.on('show', () => {
    platform.applyStealth(getSettings().stealthEnabled, [overlay!]);
  });
  overlay.on('focus', () => {
    if (getSettings().stealthEnabled) platform.applyStealth(true, [overlay!]);
  });
}

let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;

function overlayIdleMs() {
  return getSettings().stealthEnabled ? 2500 : 5000;
}

function scheduleOverlayHide(delayMs = overlayIdleMs()) {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      try {
        overlay.webContents.send('overlay', { type: 'idle' });
      } catch {
        // ignore
      }
    }
  }, delayMs);
}

ipcMain.handle('overlay:reset-idle', () => {
  scheduleOverlayHide(overlayIdleMs());
  return { ok: true };
});

function allWindows(): BrowserWindow[] {
  return [launcher, overlay].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
}

let shortcutsRegistered = false;

function registerIpc() {
  ipcMain.handle('app:get-info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: platform.id,
    platformName: platform.displayName,
    capabilityNotes: platform.capabilityNotes(),
    features: FEATURES,
    shortcutsRegistered,
  }));

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_e, patch: Record<string, unknown>) => {
    const next = updateSettings(patch as Partial<ReturnType<typeof getSettings>>);
    platform.applyStealth(next.stealthEnabled, allWindows());
    if (overlay && !overlay.isDestroyed()) {
      try {
        overlay.setOpacity(Math.min(1, Math.max(0.35, next.overlayOpacity || 0.92)));
      } catch {
        /* ignore */
      }
    }
    for (const w of allWindows()) {
      try {
        w.webContents.send('settings:changed', next);
      } catch {
        /* ignore */
      }
    }
    return next;
  });

  ipcMain.handle('window:toggle-overlay', () => {
    if (!overlay || overlay.isDestroyed()) createOverlay();
    if (!overlay) return { visible: false };
    if (overlay.isVisible()) {
      overlay.hide();
      return { visible: false };
    }
    const stealth = getSettings().stealthEnabled;
    platform.applyStealth(stealth, allWindows());
    if (stealth) overlay.showInactive();
    else overlay.show();
    scheduleOverlayHide(overlayIdleMs());
    return { visible: true };
  });

  ipcMain.handle('window:show-launcher', () => {
    if (!launcher || launcher.isDestroyed()) createLauncher();
    launcher?.show();
    launcher?.focus();
  });

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle('ollama:list-models', async (_e, baseUrl?: string) => {
    const url = (baseUrl || getSettings().ollamaBaseUrl || '').trim();
    try {
      const models = await listOllamaModels(url);
      return { ok: true, models, baseUrl: url };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        models: [] as string[],
        baseUrl: url,
      };
    }
  });

  ipcMain.handle('searxng:test', async (_e, baseUrl?: string) => {
    const s = getSettings();
    const url = (baseUrl || s.searxngBaseUrl || '').trim();
    try {
      const hits = await searchSearxng(url, 'osmos connectivity test');
      return { ok: true, resultCount: hits.length, baseUrl: url };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle(
    'websearch:test',
    async (
      _e,
      override?: Partial<{
        webSearchProvider: AppSettings['webSearchProvider'];
        tavilyApiKey: string;
        searxngBaseUrl: string;
      }>,
    ) => {
      return testWebSearch(getSettings(), override);
    },
  );

  ipcMain.handle('stt:transcribe', async (_e, req: TranscribeRequest) => {
    const engine =
      req.engine ||
      (getSettings().sttProvider === 'local-whisper' ? 'local' : 'openai');
    if (engine === 'local') return transcribeLocalWhisper(req);
    return transcribeWithWhisper(req);
  });

  ipcMain.handle('screen:capture', async (): Promise<CaptureResult> => {
    return platform.captureRegion();
  });

  ipcMain.handle('system:audio', async (_e, req: SystemAudioRequest): Promise<SystemAudioResponse> => {
    return platform.captureSystemAudio(req?.durationMs, req?.device);
  });

  ipcMain.handle('company:intel', async (_e, req: CompanyIntelRequest): Promise<CompanyIntelResponse> => {
    const s = getSettings();
    const provider = s.providers?.[s.activeProvider || 'ollama'] || s.providers?.ollama;
    if (!provider) return { ok: false, error: 'No provider configured' };
    return researchCompany({ ...req, provider });
  });

  ipcMain.handle('profile:assemble-prep', async (): Promise<AssemblePrepResponse> => {
    return assembleInterviewPrep();
  });

  ipcMain.handle('file:extract-text', async (_e, req: ExtractTextRequest): Promise<ExtractTextResponse> => {
    return extractTextFromUpload(req);
  });

  ipcMain.handle('ocr:extract', async (_e, req: OcrRequest) => {
    return extractTextFromImage(req);
  });

  ipcMain.handle('chat:ask', async (_e, req: ChatRequest): Promise<ChatResponse> => {
    const message = (req?.message || '').trim();
    if (!message) return { ok: false, error: 'Empty message' };

    const { s, system, usedWebSearch, searchHits, provider } = await buildChatContext(message);

    try {
      const answer = await chatWithProvider(
        provider,
        system,
        [
          ...(req.history || []).slice(-12),
          { role: 'user', content: message },
        ],
      );
      return { ok: true, answer, usedWebSearch, searchHits };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        usedWebSearch,
        searchHits,
      };
    }
  });

  ipcMain.handle(
    'chat:ask-stream',
    async (event, req: ChatRequest & { requestId: string }) => {
      const requestId = String(req?.requestId || '').trim();
      const message = (req?.message || '').trim();
      const sender = event.sender;

      const emit = (payload: ChatStreamEvent) => {
        if (!sender.isDestroyed()) sender.send('chat:stream', payload);
      };

      if (!requestId) {
        return { ok: false, error: 'Missing requestId' };
      }
      if (!message) {
        emit({ requestId, type: 'error', error: 'Empty message' });
        return { ok: false, error: 'Empty message' };
      }

      const prev = streamAbortControllers.get(requestId);
      prev?.abort();
      const ac = new AbortController();
      streamAbortControllers.set(requestId, ac);

      const { s, system, usedWebSearch, searchHits, provider } = await buildChatContext(message);
      emit({ requestId, type: 'meta', usedWebSearch, searchHits });

      try {
        let answer = '';
        let sawThinking = false;
        for await (const chunk of streamWithProvider(provider, system, [
          ...(req.history || []).slice(-12),
          { role: 'user', content: message },
        ], ac.signal)) {
          if (chunk.kind === 'thinking') {
            if (!sawThinking) {
              sawThinking = true;
              emit({
                requestId,
                type: 'status',
                text: 'Model thinking… (gemma can take 1–2 min on long profiles)',
              });
            }
            continue;
          }
          answer += chunk.text;
          emit({ requestId, type: 'delta', text: chunk.text });
        }
        const trimmed = answer.trim();
        if (!trimmed) {
          emit({
            requestId,
            type: 'error',
            error:
              'Ollama returned an empty answer. Try a smaller model (e.g. qwen2.5:1.5b), wait longer, or shorten the profile/JD.',
            usedWebSearch,
            searchHits,
          });
          return { ok: false, error: 'Empty answer' };
        }
        emit({
          requestId,
          type: 'done',
          answer: trimmed,
          usedWebSearch,
          searchHits,
        });
        return { ok: true };
      } catch (e) {
        const aborted = ac.signal.aborted;
        const error = aborted
          ? 'Cancelled'
          : e instanceof Error
            ? e.message
            : String(e);
        emit({ requestId, type: 'error', error, usedWebSearch, searchHits });
        return { ok: false, error };
      } finally {
        streamAbortControllers.delete(requestId);
      }
    },
  );

  ipcMain.handle('chat:cancel-stream', async (_e, requestId: string) => {
    const ac = streamAbortControllers.get(String(requestId || ''));
    ac?.abort();
    return { ok: true };
  });

  ipcMain.handle('history:list', async (): Promise<HistoryResponse> => {
    try {
      const sessions = loadHistory();
      return { ok: true, sessions };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('history:save', async (_e, session: ChatSession): Promise<HistoryResponse> => {
    try {
      const sessions = upsertSession(session);
      return { ok: true, sessions };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('history:delete', async (_e, id: string): Promise<HistoryResponse> => {
    try {
      const sessions = deleteSession(id);
      return { ok: true, sessions };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('question:list', async (): Promise<QuestionBankResponse> => {
    try {
      const items = loadQuestionBank();
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('question:add', async (_e, item: QuestionBankItem): Promise<QuestionBankResponse> => {
    return addQuestionBankItem(item);
  });

  ipcMain.handle('question:delete', async (_e, id: string): Promise<QuestionBankResponse> => {
    return deleteQuestionBankItem(id);
  });

  ipcMain.handle('star:list', async (): Promise<StarTemplatesResponse> => {
    try {
      const templates = loadStarTemplates();
      return { ok: true, templates };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('star:add', async (_e, template: StarTemplate): Promise<StarTemplatesResponse> => {
    return addStarTemplate(template);
  });

  ipcMain.handle('star:delete', async (_e, id: string): Promise<StarTemplatesResponse> => {
    return deleteStarTemplate(id);
  });

  ipcMain.handle('app:check-updates', async (_e, updateUrl?: string): Promise<UpdateStatus> => {
    const url = (updateUrl || '').trim();
    if (!url) return { checking: false, error: 'No update URL configured' };
    return checkForUpdates(url, app.getVersion());
  });
}

function registerShortcuts() {
  const mod = platform.defaultShortcutModifier();
  try {
    const a = globalShortcut.register(`${mod}+Shift+Space`, () => {
      if (!overlay || overlay.isDestroyed()) createOverlay();
      if (!overlay) return;
      if (overlay.isVisible()) overlay.hide();
      else overlay.showInactive();
    });
    const b = globalShortcut.register(`${mod}+Shift+A`, () => {
      if (!overlay || overlay.isDestroyed()) createOverlay();
      overlay?.webContents.send('shortcut', 'ask');
    });
    const c = globalShortcut.register(`${mod}+Shift+C`, () => {
      if (!overlay || overlay.isDestroyed()) createOverlay();
      overlay?.webContents.send('shortcut', 'capture');
    });
    shortcutsRegistered = Boolean(a && b && c);
    if (!shortcutsRegistered) {
      console.warn(
        '[shortcuts] registration returned false (common on Wayland) — use in-app overlay controls',
      );
    }
  } catch (e) {
    shortcutsRegistered = false;
    console.warn('[shortcuts] registration failed (common on Wayland):', e);
  }
}

app.whenReady().then(() => {
  migrateLegacyUserData();
  migrateLegacyBanksIntoActiveProfile();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const p = String(permission);
    if (p === 'media' || p === 'microphone' || p === 'audioCapture') {
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    const p = String(permission);
    return p === 'media' || p === 'microphone' || p === 'audioCapture';
  });

  registerIpc();
  createLauncher();
  createOverlay();
  registerShortcuts();
  platform.applyStealth(getSettings().stealthEnabled, allWindows());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncher();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopLocalWhisperWorker();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
