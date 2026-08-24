/**
 * Feature registry — capability map for OSMOS.
 * Status tracks greenfield progress toward full interview/meeting-copilot parity.
 */

export type FeatureStatus = 'live' | 'scaffold' | 'planned';

export type FeatureDef = {
  id: string;
  name: string;
  description: string;
  status: FeatureStatus;
  platforms: Array<'linux' | 'darwin' | 'win32'>;
};

export const FEATURES: FeatureDef[] = [
  {
    id: 'overlay',
    name: 'Floating overlay',
    description: 'Always-on-top translucent assistant window with click-through modes.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'launcher',
    name: 'Launcher hub',
    description: 'Home surface to open chat, settings, profile, and modes.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'chat',
    name: 'Ask / chat',
    description: 'Manual questions with streaming LLM replies.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'ollama',
    name: 'Local LLM (Ollama)',
    description: 'Talk to local models on 127.0.0.1:11434.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'web-search',
    name: 'Web search',
    description: 'DuckDuckGo (free default), optional Tavily API, or self-hosted SearXNG.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'settings',
    name: 'Settings',
    description: 'Providers, shortcuts, overlay, privacy, and search.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'providers',
    name: 'Multi-provider LLMs',
    description: 'OpenAI, Anthropic, Groq, OpenRouter, LiteLLM (+ local Ollama).',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'stt-mic',
    name: 'Microphone STT',
    description: 'Live speech-to-text from the selected mic (Web Speech or Whisper).',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'system-audio',
    name: 'System / speaker capture',
    description:
      'Continuous meeting loopback → STT → Smart assist (ffmpeg pulse / pw-record on Linux; ffmpeg WASAPI / BlackHole elsewhere).',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'screen-capture',
    name: 'Screen / screenshot OCR',
    description:
      'On-demand full-screen OCR (📷 / hotkey). Not continuous on Linux — avoids stealing the Wayland screen-share portal from Zoom/Meet.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'stealth',
    name: 'Stealth / undetectable',
    description:
      'Windows WDA_EXCLUDEFROMCAPTURE + macOS NSWindowSharingNone via setContentProtection; skip taskbar; Linux share-tab tips.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'shortcuts',
    name: 'Global shortcuts',
    description: 'Hotkeys for ask, capture, and toggle overlay — with Wayland fallback tips when OS registration fails.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'profile',
    name: 'Profile intelligence',
    description: 'Named profiles (résumé / JD / notes), switchable from Home and the overlay menu.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'company-intel',
    name: 'Company intel',
    description: 'Research target employers from JD + web search.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'modes',
    name: 'Modes / personas',
    description: 'Interview, meeting, and general modes with prompt policies.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'rag',
    name: 'Document RAG',
    description: 'Attach reference files and retrieve evidence per turn.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'meetings',
    name: 'Meeting history',
    description: 'Persist transcripts, answers, and session timelines.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'auto-update',
    name: 'Auto-update channel',
    description: 'Check for newer releases from a configurable update feed.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'branding',
    name: 'Branding',
    description: 'App icon, name lock, and landing polish.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'overlay-deep',
    name: 'Overlay polish',
    description: 'Compact answer cards, auto-hide, screen-share safe behavior.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'question-bank',
    name: 'Question bank + STAR templates',
    description: 'Interview prep with saved questions and STAR stories injected into interview prompts + overlay.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
  {
    id: 'meeting-assistant',
    name: 'Continuous meeting assistant',
    description: 'Smart mode: auto-listen, segment audio, detect questions, and suggest answers in the overlay.',
    status: 'live',
    platforms: ['linux', 'darwin', 'win32'],
  },
];

export function featuresByStatus(status: FeatureStatus): FeatureDef[] {
  return FEATURES.filter((f) => f.status === status);
}
