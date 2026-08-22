import type { UpdateStatus } from '../../shared/types.js';

export type { UpdateStatus };

type Listener = (status: UpdateStatus) => void;

const listeners = new Set<Listener>();
let status: UpdateStatus = { checking: false };

export function onUpdateStatusChange(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(next: UpdateStatus) {
  status = next;
  for (const fn of listeners) fn(next);
}

export async function checkForUpdates(updateUrl: string, currentVersion: string): Promise<UpdateStatus> {
  const next: UpdateStatus = { checking: true };
  emit(next);

  try {
    const res = await fetch(updateUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Update check failed (${res.status})`);
    const data = (await res.json()) as { latest?: string; url?: string };
    const latest = String(data.latest || '').trim();
    if (!latest) {
      emit({ checking: false, error: 'No version info from update feed' });
      return status;
    }
    const available = latest !== currentVersion;
    emit({ checking: false, available, version: latest, url: data.url });
  } catch (e) {
    emit({ checking: false, error: e instanceof Error ? e.message : String(e) });
  }

  return status;
}

export function getCurrentUpdateStatus() {
  return status;
}
