/**
 * OCR via tesseract.js in the main process.
 * Uses dynamic import to avoid crashing app startup if the bundle
 * cannot resolve tesseract.js for the main-process target.
 */
import type { OcrRequest, OcrResponse } from '../../shared/types.js';

let workerPromise: Promise<any> | null = null;

async function getWorker() {
  if (!workerPromise) {
    const mod = await import('tesseract.js');
    const createWorker = mod.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js createWorker is not available in this environment');
    }
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

export async function extractTextFromImage(req: OcrRequest): Promise<OcrResponse> {
  const raw = String(req?.base64 || '').trim();
  if (!raw) return { ok: false, error: 'No image data' };

  try {
    const worker = await getWorker();
    const image = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    const { data } = await worker.recognize(image);
    const text = String(data?.text || '').trim();
    if (!text) return { ok: false, error: 'OCR returned no text' };
    return { ok: true, text };
  } catch (e) {
    workerPromise = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
