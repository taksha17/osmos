import type { CopilotMode } from './types';

export type ModeDef = {
  id: CopilotMode;
  name: string;
  blurb: string;
  /** Extra system-prompt lines for this mode */
  systemAddon: string;
};

export const MODE_DEFS: ModeDef[] = [
  {
    id: 'interview',
    name: 'Interview',
    blurb: 'Answer as the candidate. Ground only in the saved profile / JD.',
    systemAddon: [
      'Mode: interview copilot.',
      'Help the user answer as themselves in a job interview.',
      'Prefer STAR-style structure when useful (Situation, Task, Action, Result).',
      'Use only facts from the user profile, résumé, JD, and notes — never invent experience, employers, or skills.',
      'If something is missing from the profile, say what to ask or invent carefully as a placeholder labeled as a suggestion.',
      'Keep answers concise and speakable (about 30–90 seconds aloud unless asked for more).',
    ].join('\n'),
  },
  {
    id: 'meeting',
    name: 'Meeting',
    blurb: 'Live meeting aid — clarify, summarize, suggest next steps.',
    systemAddon: [
      'Mode: meeting copilot.',
      'Help the user follow and contribute in a live meeting.',
      'Prefer short bullets: key points, risks, clarifying questions, and action items.',
      'Do not invent commitments on the user’s behalf.',
      'Use profile/notes only when relevant to introductions or context.',
    ].join('\n'),
  },
  {
    id: 'general',
    name: 'General',
    blurb: 'Default assistant — no interview/meeting bias.',
    systemAddon: [
      'Mode: general assistant.',
      'Answer helpfully without forcing interview or meeting framing.',
    ].join('\n'),
  },
];

export function modeDef(id: CopilotMode): ModeDef {
  return MODE_DEFS.find((m) => m.id === id) ?? MODE_DEFS[MODE_DEFS.length - 1]!;
}
