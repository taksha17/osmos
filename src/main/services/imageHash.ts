/**
 * Lightweight perceptual-ish image fingerprint for OCR dedupe.
 * Downsamples luminance from a PNG/JPEG data URL or raw base64 — original MIT code.
 */

export function averageHashFromImageDataUrl(dataUrlOrBase64: string): string | null {
  try {
    const raw = dataUrlOrBase64.includes(',')
      ? dataUrlOrBase64.slice(dataUrlOrBase64.indexOf(',') + 1)
      : dataUrlOrBase64;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 64) return null;

    // Sample evenly across the buffer (works for PNG/JPEG without full decode).
    // Not a true aHash of pixels, but stable enough to skip identical captures.
    const samples = 64;
    const step = Math.max(1, Math.floor(buf.length / samples));
    const vals: number[] = [];
    for (let i = 0; i < samples; i++) {
      vals.push(buf[i * step]!);
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    let bits = '';
    for (const v of vals) bits += v >= avg ? '1' : '0';
    // Also mix length so different-sized frames rarely collide.
    return `${buf.length}:${bits}`;
  } catch {
    return null;
  }
}

export function hashesLikelySame(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [la, ba] = a.split(':');
  const [lb, bb] = b.split(':');
  if (!ba || !bb || ba.length !== bb.length) return false;
  if (la !== lb) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) diff++;
  return diff <= 4;
}
