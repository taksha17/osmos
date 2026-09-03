export type SttProvider = 'webspeech' | 'local-whisper' | 'openai-whisper';

/** Smart assist listens to meeting loopback, mic, or both. */
export type AssistAudioSource = 'system' | 'mic' | 'both';

export type CopilotMode = 'interview' | 'meeting' | 'general';

export type DocumentReference = {
  id: string;
  name: string;
  text: string;
  addedAt: number;
};

export type QuestionBankItem = {
  id: string;
  companyName: string;
  question: string;
  category: 'behavioral' | 'technical' | 'system-design' | 'product' | 'leadership' | 'other';
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  createdAt: number;
};

export type StarTemplate = {
  id: string;
  label: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  tags: string[];
};

export type UserProfile = {
  displayName: string;
  resumeText: string;
  jdText: string;
  notes: string;
};

/** Named profile slot (Cluely-style Customize) — switchable from home + overlay. */
export type SavedProfile = UserProfile & {
  id: string;
  /** Short label shown in switchers, e.g. "Interview @ Acme" */
  label: string;
  preferredMode?: CopilotMode;
  /** Target employer for this interview profile */
  companyName: string;
  /** Careers / about URL — used to ground company research */
  companyUrl: string;
  /** Cached research brief for this company */
  companyIntel: string;
  /** Reference docs attached to this profile only */
  documents: DocumentReference[];
  /** Interview questions for this profile */
  questions: QuestionBankItem[];
  /** STAR stories for this profile */
  starTemplates: StarTemplate[];
  /** Optional agent wiring for this profile */
  agent?: AgentConfig;
};

export type LlmProvider = 'ollama' | 'openai' | 'anthropic' | 'groq' | 'openrouter' | 'litellm';

export type WebSearchProvider = 'off' | 'duckduckgo' | 'tavily' | 'searxng';

export type ProviderConfig = {
  id: LlmProvider;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AgentSkill =
  | 'resume-review'
  | 'jd-parse'
  | 'company-research'
  | 'behavioral-answers'
  | 'technical-answers'
  | 'document-qa'
  | 'meeting-notes';

export type AgentMcp = {
  id: 'github' | 'linkedin' | 'calendar';
  enabled: boolean;
  config?: Record<string, string>;
};

export type AgentConfig = {
  id: string;
  profileId: string;
  displayName?: string;
  systemPrompt?: string;
  skills?: AgentSkill[];
  mcp?: AgentMcp[];
  preferredProvider?: LlmProvider;
  preferredModel?: string;
  temperature?: number;
  maxTokens?: number;
};

export type AppSettings = {
  ollamaBaseUrl: string;
  ollamaModel: string;
  searxngBaseUrl: string;
  /** @deprecated Prefer webSearchProvider; kept for migration / UI sync */
  useWebSearch: boolean;
  webSearchProvider: WebSearchProvider;
  tavilyApiKey: string;
  overlayOpacity: number;
  stealthEnabled: boolean;
  sttProvider: SttProvider;
  sttLanguage: string;
  micDeviceId: string;
  /** Smart mode: system loopback (default), mic, or both */
  assistAudioSource: AssistAudioSource;
  /**
   * When Smart/continuous is on, keep reading the screen (OCR → assist).
   * Uses loop-safe capture only (no Wayland portal loops).
   */
  continuousScreenAssist: boolean;
  /** One-time migration flag: legacy 'system'-default installs move to 'both'. */
  assistSourceMigrated?: boolean;
  /** Explicit settings schema version — bump when a breaking migration runs. */
  schemaVersion?: number;
  /** Audio chunk size in ms (2000–8000). Lower = snappier responses, more CPU. */
  transcribeChunkMs: number;
  /** Optional loopback device (BlackHole name, WASAPI device, PipeWire source). Empty = auto. */
  systemAudioDevice: string;
  autoAskOnFinal: boolean;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiWhisperModel: string;
  activeMode: CopilotMode;
  /** Active profile mirror (kept in sync with profiles[activeProfileId]). */
  profile: UserProfile;
  profiles: SavedProfile[];
  activeProfileId: string;
  /** First-run setup wizard completed */
  onboardingCompleted: boolean;
  /** @deprecated Mirrored from active profile.documents — prefer profile-scoped docs */
  documents: DocumentReference[];
  activeProvider: LlmProvider;
  providers: Record<LlmProvider, ProviderConfig>;
};

export const DEFAULT_PROFILE: UserProfile = {
  displayName: '',
  resumeText: '',
  jdText: '',
  notes: '',
};

export const DEFAULT_SAVED_PROFILE: SavedProfile = {
  id: 'default',
  label: 'Default',
  ...DEFAULT_PROFILE,
  preferredMode: 'interview',
  companyName: '',
  companyUrl: '',
  companyIntel: '',
  documents: [],
  questions: [],
  starTemplates: [],
};

export const DEFAULT_SETTINGS: AppSettings = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2',
  searxngBaseUrl: 'http://127.0.0.1/searxng',
  useWebSearch: true,
  webSearchProvider: 'duckduckgo',
  tavilyApiKey: '',
  overlayOpacity: 0.92,
  stealthEnabled: false,
  sttProvider: 'local-whisper',
  sttLanguage: 'en-US',
  micDeviceId: '',
  assistAudioSource: 'both',
  continuousScreenAssist: true,
  systemAudioDevice: '',
  autoAskOnFinal: true,
  transcribeChunkMs: 4000,
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiWhisperModel: 'whisper-1',
  activeMode: 'interview',
  profile: { ...DEFAULT_PROFILE },
  profiles: [{ ...DEFAULT_SAVED_PROFILE }],
  activeProfileId: 'default',
  onboardingCompleted: false,
  documents: [],
  activeProvider: 'ollama',
  providers: {
    ollama: { id: 'ollama', label: 'Ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
    openai: { id: 'openai', label: 'OpenAI', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    anthropic: { id: 'anthropic', label: 'Anthropic', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest' },
    groq: { id: 'groq', label: 'Groq', apiKey: '', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openrouter: { id: 'openrouter', label: 'OpenRouter', apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', model: 'auto' },
    litellm: { id: 'litellm', label: 'LiteLLM', apiKey: '', baseUrl: 'http://127.0.0.1:4000', model: 'gpt-4o-mini' },
  },
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
};

export type ChatRequest = {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export type ChatStreamEvent =
  | { requestId: string; type: 'meta'; usedWebSearch: boolean; searchHits: number }
  | { requestId: string; type: 'status'; text: string }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; answer: string; usedWebSearch: boolean; searchHits: number }
  | { requestId: string; type: 'error'; error: string; usedWebSearch?: boolean; searchHits?: number };

export type ChatResponse = {
  ok: boolean;
  answer?: string;
  error?: string;
  usedWebSearch?: boolean;
  searchHits?: number;
};

export type TranscribeRequest = {
  base64: string;
  mimeType: string;
  fileName?: string;
  /** local = system Node + Transformers.js Whisper; openai = Whisper API */
  engine?: 'local' | 'openai';
};

export type TranscribeResponse = {
  ok: boolean;
  text?: string;
  error?: string;
};

export type CaptureResult = {
  dataUrl: string;
  cancelled: boolean;
  /** Set when loop-safe capture has no non-portal backend. */
  error?: string;
};

export type OcrRequest = {
  base64: string;
};

export type OcrResponse = {
  ok: boolean;
  text?: string;
  error?: string;
};

export type SystemAudioRequest = {
  durationMs?: number;
  /** Platform loopback / virtual device override (BlackHole, WASAPI, PipeWire). */
  device?: string;
};

export type SystemAudioResponse = {
  ok: boolean;
  base64?: string;
  mimeType?: string;
  error?: string;
};

export type AudioDeviceInfo = {
   id: string;
   name: string;
   type?: string; // 'input' or 'output' or 'speaker' or 'microphone'
   platform?: string;
   capabilities?: string[];
   sample_rates?: number[];
   channel_counts?: number[];
   is_default?: boolean;
};

export type PythonAudioDevicesResponse = {
   ok: boolean;
   inputs?: AudioDeviceInfo[];
   outputs?: AudioDeviceInfo[];
   preferredInputId?: string;
   preferredOutputId?: string;
   error?: string;
};

export type PythonAudioDeviceInfo = {
   [key: string]: unknown;
};

export type PythonAudioCaptureResponse = {
   ok: boolean;
   error?: string;
   message?: string;
};

export type AudioDevicesResponse = {
  ok: boolean;
  inputs?: AudioDeviceInfo[];
  monitors?: AudioDeviceInfo[];
  preferredInputId?: string;
  preferredMonitorId?: string;
  warning?: string;
  error?: string;
};

export type CompanyIntelRequest = {
  companyName: string;
  companyUrl?: string;
  jdText?: string;
  provider?: ProviderConfig;
};

export type CompanyIntelResponse = {
  ok: boolean;
  intel?: string;
  error?: string;
};

export type ExtractTextRequest = {
  base64: string;
  fileName?: string;
  mimeType?: string;
};

export type ExtractTextResponse = {
  ok: boolean;
  text?: string;
  error?: string;
};

export type AssemblePrepResponse = {
  ok: boolean;
  companyIntel?: string;
  questionsAdded?: number;
  error?: string;
  settings?: AppSettings;
};

export type ChatSession = {
  id: string;
  mode: CopilotMode;
  messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
};

export type HistoryResponse = {
  ok: boolean;
  sessions?: ChatSession[];
  error?: string;
};

export type QuestionBankResponse = {
  ok: boolean;
  items?: QuestionBankItem[];
  error?: string;
};

export type StarTemplatesResponse = {
  ok: boolean;
  templates?: StarTemplate[];
  error?: string;
};

export type UpdateStatus = {
  checking: boolean;
  available?: boolean;
  version?: string;
  url?: string;
  error?: string;
};
