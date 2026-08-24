import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  preferredLinuxInputId,
  preferredLinuxMonitorId,
  sanitizeLinuxInputDevices,
  sanitizeLinuxInputId,
  sanitizeLinuxOutputDevices,
  type NamedAudioDevice,
} from '../../shared/linuxAudioDevices.js';

const execFileAsync = promisify(execFile);

export type AudioDeviceList = {
  inputs: NamedAudioDevice[];
  outputs: NamedAudioDevice[];
  monitors: NamedAudioDevice[];
  preferredInputId: string;
  preferredMonitorId: string;
};

async function pactl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('pactl', args, { timeout: 5000 });
  return stdout;
}

function parseShortList(out: string): NamedAudioDevice[] {
  const devices: NamedAudioDevice[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1];
    if (!name || name === 'auto_null') continue;
    devices.push({ id: name, name });
  }
  return devices;
}

export async function listLinuxAudioDevices(): Promise<AudioDeviceList> {
  try {
    const [sourcesOut, sinksOut, defaultSink, defaultSource] = await Promise.all([
      pactl(['list', 'sources', 'short']),
      pactl(['list', 'sinks', 'short']),
      pactl(['get-default-sink']).catch(() => ''),
      pactl(['get-default-source']).catch(() => ''),
    ]);

    const rawSources = parseShortList(sourcesOut);
    const rawSinks = parseShortList(sinksOut);
    const monitors = rawSources
      .filter((s) => s.id.endsWith('.monitor'))
      .map((s) => ({ id: s.id, name: s.name }));
    const inputs = sanitizeLinuxInputDevices(
      rawSources.filter((s) => !s.id.endsWith('.monitor')),
    );
    const outputs = sanitizeLinuxOutputDevices(rawSinks);

    const preferredInputId = sanitizeLinuxInputId(defaultSource.trim(), inputs);
    const preferredMonitorId = preferredLinuxMonitorId(monitors, defaultSink.trim());

    return {
      inputs,
      outputs,
      monitors: monitors.map((m) => ({
        id: m.id,
        name: m.name.replace(/\.monitor$/i, ' (meeting audio)'),
      })),
      preferredInputId,
      preferredMonitorId,
    };
  } catch {
    return {
      inputs: [{ id: 'default', name: 'System default microphone' }],
      outputs: [],
      monitors: [{ id: '@DEFAULT_MONITOR@', name: 'Meeting audio' }],
      preferredInputId: 'default',
      preferredMonitorId: '@DEFAULT_MONITOR@',
    };
  }
}

export async function listAudioDevices(): Promise<AudioDeviceList | null> {
  if (process.platform !== 'linux') return null;
  return listLinuxAudioDevices();
}

export function resolveLinuxMicSource(requested: string | undefined, list: AudioDeviceList): string {
  return sanitizeLinuxInputId(requested, list.inputs);
}

export function resolveLinuxMonitor(requested: string | undefined, list: AudioDeviceList): string {
  const id = (requested || '').trim();
  if (id) {
    const normalize = (s: string) => s.replace(/_/g, '.');
    const hit = list.monitors.find(
      (m) => normalize(m.id) === normalize(id) || normalize(m.id).includes(normalize(id)),
    );
    if (hit) return hit.id;
    if (id.endsWith('.monitor')) return id;
  }
  return list.preferredMonitorId;
}
