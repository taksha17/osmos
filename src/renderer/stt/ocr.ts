/**
 * Renderer OCR helper — forwards to main-process tesseract via IPC.
 * (Running tesseract workers inside Electron's renderer is brittle.)
 */

export async function extractTextFromBase64(
  dataUrlOrBase64: string,
): Promise<{ text: string; error?: string }> {
  const res = await window.osmos.ocrExtract({ base64: dataUrlOrBase64 });
  if (!res.ok) {
    return { text: '', error: res.error || 'OCR failed' };
  }
  return { text: (res.text || '').trim() };
}
