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
  assistAudioSource: 'system',
  systemAudioDevice: '',
  autoAskOnFinal: true,
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
