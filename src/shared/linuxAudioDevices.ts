/** Linux ALSA / PipeWire device ids + labels (Zenbook / SOF-friendly heuristics). */

export type NamedAudioDevice = {
  id: string;
  name: string;
};

const ALSA_PLUGIN_PREFIX =
  /^(pipewire|pulse|jack|oss|null|dmix|dsnoop:|plughw:|sysdefault|front:|surround|spdif|hdmi|iec958|usbstream)/i;

function isAlsaPluginAlias(id: string): boolean {
  if (!id || id === 'default') return false;
  if (ALSA_PLUGIN_PREFIX.test(id)) return true;
  if (/^hw:CARD=.+,DEV=7$/i.test(id)) return true;
  return false;
}

export function humanizeLinuxAudioName(name: string): string {
  if (!name) return name;
  let label = name
    .replace(/^Alder Lake PCH-P High Definition Audio Controller\s+/i, '')
    .replace(/^.*?High Definition Audio Controller\s+/i, '')
    .replace(/^sof-hda-dsp\s*[-:]?\s*/i, '')
    .trim();
  label = label.replace(/^HDMI \/ DisplayPort\s+(\d+)\s+Output$/i, 'HDMI $1');
  if (/^hw:CARD=.+,DEV=6$/i.test(name)) return 'Laptop microphone';
  if (/^hw:CARD=.+,DEV=0$/i.test(name)) return 'Headset microphone';
  if (/digital microphone|dmic/i.test(name) && !/16k/i.test(name)) return 'Laptop microphone';
  if (/headphone.*mic|headset.*mic/i.test(name)) return 'Headset microphone';
  if (/speaker \+ headphones/i.test(label)) return 'Speakers + headphones';
  if (/\.monitor$/i.test(name) || /monitor/i.test(label)) {
    label = label.replace(/\.monitor$/i, '').replace(/\s*monitor\s*$/i, '');
    if (/speaker|headphone|sink/i.test(label)) return 'Meeting audio (speakers)';
    return 'Meeting audio';
  }
  return label || name;
}

export function sanitizeLinuxInputDevices(devices: NamedAudioDevice[]): NamedAudioDevice[] {
  const out: NamedAudioDevice[] = [];
  const seenIds = new Set<string>();

  for (const device of devices) {
    if (!device?.id) continue;
    if (isAlsaPluginAlias(device.id)) continue;
    if (device.id === 'default') continue;
    if (seenIds.has(device.id)) continue;
    seenIds.add(device.id);
    out.push({ id: device.id, name: humanizeLinuxAudioName(device.name || device.id) });
  }

  const dmic = out.find((d) => /laptop microphone/i.test(d.name) || /DEV=6\b|_6__source/.test(d.id));
  const ordered = dmic ? [dmic, ...out.filter((d) => d.id !== dmic.id)] : out;
  if (ordered.length === 0) {
    return [{ id: 'default', name: 'System default microphone' }];
  }
  return ordered;
}

export function sanitizeLinuxOutputDevices(devices: NamedAudioDevice[]): NamedAudioDevice[] {
  const seen = new Set<string>();
  const out: NamedAudioDevice[] = [];
  for (const device of devices) {
    if (!device?.id || seen.has(device.id)) continue;
    seen.add(device.id);
    out.push({ id: device.id, name: humanizeLinuxAudioName(device.name || device.id) });
  }
  out.sort((a, b) => Number(/hdmi/i.test(a.name)) - Number(/hdmi/i.test(b.name)));
  return out;
}

export function preferredLinuxInputId(devices: NamedAudioDevice[]): string {
  const dmic = devices.find((d) => /laptop microphone/i.test(d.name) || /DEV=6\b|_6__source/.test(d.id));
  if (dmic) return dmic.id;
  const analog = devices.find((d) => /headset microphone/i.test(d.name) || /DEV=0\b/.test(d.id));
  if (analog) return analog.id;
  if (devices.some((d) => d.id === 'default')) return 'default';
  return devices[0]?.id || 'default';
}

export function isJunkLinuxInputId(id: string | null | undefined): boolean {
  if (!id || id.trim() === '') return true;
  if (id === 'pipewire' || id === 'pulse') return true;
  if (isAlsaPluginAlias(id)) return true;
  if (id === 'default') return true;
  return false;
}

export function sanitizeLinuxInputId(
  requested: string | null | undefined,
  devices: NamedAudioDevice[],
): string {
  const id = (requested || '').trim();
  if (id && !isJunkLinuxInputId(id) && devices.some((d) => d.id === id)) {
    return id;
  }
  return preferredLinuxInputId(devices);
}

/** Prefer default sink monitor for meeting loopback. */
export function preferredLinuxMonitorId(
  monitors: NamedAudioDevice[],
  defaultSink?: string,
): string {
  if (defaultSink) {
    const direct = `${defaultSink}.monitor`;
    const hit = monitors.find((m) => m.id === direct || m.id.endsWith(`${defaultSink}.monitor`));
    if (hit) return hit.id;
  }
  const speakers = monitors.find(
    (m) => /speaker|headphone|sofhdadsp__sink\.monitor$/i.test(m.id) && !/hdmi/i.test(m.name),
  );
  if (speakers) return speakers.id;
  return monitors[0]?.id || '@DEFAULT_MONITOR@';
}
