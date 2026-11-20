/**
 * OCR contract — Architecture v2, §6.3 (text path, always on and cheap).
 *
 * Types only, so the Tesseract adapter can later be swapped for a platform
 * engine (Windows.Media.Ocr, macOS Vision) without touching call sites.
 */

export type OcrCapabilities = {
  local: boolean;
  languages: string[];
};

export type OcrImageRequest = {
  /** Raw base64, with or without a `data:` prefix. */
  imageBase64: string;
  languages?: string[];
};

export type OcrResult = {
  text: string;
  confidence?: number;
  /** Wall-clock cost of this recognition, for the latency budget. */
  ms: number;
};

export interface OcrProvider {
  id: string;
  capabilities: OcrCapabilities;
  recognize(req: OcrImageRequest): Promise<OcrResult>;
}
