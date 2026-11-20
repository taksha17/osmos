/**
 * Tesseract OCR adapter — Architecture v2, §6.3 (text path).
 *
 * Thin contract wrapper over the existing main-process OCR service. The v0.6
 * hash cache and worker reuse stay where they are; a platform engine
 * (Windows.Media.Ocr / macOS Vision) can implement `OcrProvider` later and be
 * selected by the vision worker without touching call sites.
 */

import type { OcrProvider, OcrResult } from '../../../shared/contracts/ocr.js';
import { extractTextFromImage } from '../../services/ocr.js';

export const tesseractOcrProvider: OcrProvider = {
  id: 'tesseract',
  capabilities: { local: true, languages: ['eng'] },
  async recognize(req): Promise<OcrResult> {
    const startedAt = Date.now();
    const res = await extractTextFromImage({ base64: req.imageBase64 });
    if (!res.ok) throw new Error(res.error || 'OCR failed');
    return { text: res.text || '', ms: Date.now() - startedAt };
  },
};
