import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  humanizeLinuxAudioName,
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

/**
 * Long-form `pactl list sinks|sources` carries human descriptions
 * ("Built-in Audio Analog Stereo") that short mode lacks. Returns a map of
 * ALSA id -> description so pickers can show real names, not pci strings.
 */
function parseDescriptions(out: string, kind: 'Sink' | 'Source'): Map<string, string> {
  const map = new Map<string, string>();
  let currentId = '';
  let desc = '';
  const flush = () => {
    if (currentId && desc) map.set(currentId, desc);
    currentId = '';
    desc = '';
  };
  for (const line of out.split('\n')) {
    if (line.startsWith(`${kind} #`)) {
      flush();
      continue;
    }
    const nameMatch = /^\s*Name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      flush();
      currentId = nameMatch[1]!.trim();
      continue;
    }
    const descMatch = /^\s*Description:\s*(.+)$/.exec(line);
    if (descMatch && !desc) desc = descMatch[1].trim();
  }
  flush();
  return map;
}

export async function listLinuxAudioDevices(): Promise<AudioDeviceList> {
  try {
    // Bug fix: the first two slots MUST be the LONG pactl output because
    // parseShortList and parseDescriptions both look for "Name:" /
    // "Description:" lines that only exist in long format. Previously the
    // long outputs were fetched but discarded into thin air (positions
    // 2 and 3) and the short outputs were misfed to the long-format parser,
    // which returned an empty list. Net effect: Smart mode had no
    // devices to work with, even when pactl clearly saw them.
    const [sourcesOut, sinksOut, _sourcesShort, _sinksShort, defaultSink, defaultSource] = await Promise.all([
      pactl(['list', 'sources']),
      pactl(['list', 'sinks']),
      pactlListShort('sources'),
      pactlListShort('sinks'),
      pactl(['get-default-sink']).catch(() => ''),
      pactl(['get-default-source']).catch(() => ''),
    ]);

    const sinkDescs = parseDescriptions(sinksOut, 'Sink');
    const sourceDescs = parseDescriptions(sourcesOut, 'Source');

    const rawSources = parseShortList(
      sourcesOut
        .split('\n')
        .filter((l) => /^\s*Name:\s*/.test(l))
        .map((l) => `0 ${/^\s*Name:\s*(.+)$/.exec(l)![1]!.trim()}`)
        .join('\n'),
    );
    const rawSinks = parseShortList(
      sinksOut
        .split('\n')
        .filter((l) => /^\s*Name:\s*/.test(l))
        .map((l) => `0 ${/^\s*Name:\s*(.+)$/.exec(l)![1]!.trim()}`)
        .join('\n'),
    );

    const monitors = rawSources
      .filter((s) => s.id.endsWith('.monitor'))
      .map((s) => ({ id: s.id, name: s.name }));
    const inputs = sanitizeLinuxInputDevices(
      rawSources.filter((s) => !s.id.endsWith('.monitor')),
    );
    const outputs = sanitizeLinuxOutputDevices(rawSinks).map((d) => ({
      id: d.id,
      name: humanizeLinuxAudioName(sinkDescs.get(d.id) || d.name),
    }));
    const hasRealDevices =
      inputs.some((d) => d.id !== 'default') || monitors.some((d) => d.id !== '@DEFAULT_MONITOR@');

    const preferredInputId = sanitizeLinuxInputId(defaultSource.trim(), inputs);
    const preferredMonitorId = preferredLinuxMonitorId(monitors, defaultSink.trim());

    return {
      inputs,
      outputs,
      // Friendly labels from pactl Description ("Built-in Audio Analog Stereo");
      // monitor descriptions read "Monitor of X" → strip to just "X".
      monitors: monitors.map((m) => ({
        id: m.id,
        name: `${humanizeLinuxAudioName((sourceDescs.get(m.id) || m.name).replace(/^Monitor of /i, ''))} (meeting audio)`,
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
