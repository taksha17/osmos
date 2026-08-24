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
  warning?: string;
};

async function pactl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('pactl', args, { timeout: 5000 });
  return stdout;
}

async function pactlListShort(kind: 'sources' | 'sinks'): Promise<string> {
  // `pactl list short <kind>` is the common PipeWire/Pulse spelling.
  // Keep the older argument order as a fallback in case a distro wrapper
  // happens to accept it.
  try {
    return await pactl(['list', 'short', kind]);
  } catch {
    return pactl(['list', kind, 'short']);
  }
}

function parseShortList(out: string): NamedAudioDevice[] {
  const devices: NamedAudioDevice[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    if (!/^\d+$/.test(parts[0] || '')) continue;
    const name = parts[1];
    if (!name || name === 'auto_null') continue;
    devices.push({ id: name, name });
  }
  return devices;
}

export async function listLinuxAudioDevices(): Promise<AudioDeviceList> {
  try {
    const [sourcesOut, sinksOut, defaultSink, defaultSource] = await Promise.all([
      pactlListShort('sources'),
      pactlListShort('sinks'),
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
    const hasRealDevices =
      inputs.some((d) => d.id !== 'default') || monitors.some((d) => d.id !== '@DEFAULT_MONITOR@');

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
      warning: hasRealDevices
        ? undefined
        : 'No real PipeWire/Pulse devices were discovered, so Osmos is showing placeholder audio devices.',
    };
  } catch (err) {
    return {
      inputs: [{ id: 'default', name: 'System default microphone' }],
      outputs: [],
      monitors: [{ id: '@DEFAULT_MONITOR@', name: 'Meeting audio' }],
      preferredInputId: 'default',
      preferredMonitorId: '@DEFAULT_MONITOR@',
      warning: `Could not query PipeWire/Pulse audio devices (${err instanceof Error ? err.message : String(err)}). Showing fallback devices.`,
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
