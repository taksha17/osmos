import mammoth from 'mammoth';
import type { ExtractTextRequest, ExtractTextResponse } from '../../shared/types.js';

function decodeBase64(raw: string): Buffer {
  const cleaned = raw.includes(',') ? raw.split(',').pop() || raw : raw;
  return Buffer.from(cleaned, 'base64');
}

function looksLikePdf(buf: Buffer, fileName?: string, mimeType?: string) {
  if (mimeType?.includes('pdf')) return true;
  if (fileName?.toLowerCase().endsWith('.pdf')) return true;
  return buf.slice(0, 5).toString('utf8') === '%PDF-';
}

function looksLikeDocx(buf: Buffer, fileName?: string, mimeType?: string) {
  if (mimeType?.includes('wordprocessingml') || mimeType?.includes('msword')) return true;
  if (fileName?.toLowerCase().endsWith('.docx') || fileName?.toLowerCase().endsWith('.doc')) return true;
  // ZIP magic (DOCX is a zip)
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return (result.text || '').trim();
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return (result.value || '').trim();
}

export async function extractTextFromUpload(req: ExtractTextRequest): Promise<ExtractTextResponse> {
  try {
    const base64 = String(req?.base64 || '').trim();
    if (!base64) return { ok: false, error: 'Missing file data' };
    const buf = decodeBase64(base64);
    if (!buf.length) return { ok: false, error: 'Empty file' };

    let text = '';
    if (looksLikePdf(buf, req.fileName, req.mimeType)) {
      text = await extractPdf(buf);
    } else if (looksLikeDocx(buf, req.fileName, req.mimeType)) {
      text = await extractDocx(buf);
    } else if (req.fileName?.toLowerCase().endsWith('.txt') || req.mimeType?.startsWith('text/')) {
      text = buf.toString('utf8').trim();
    } else {
      return { ok: false, error: 'Unsupported file type. Use PDF, DOCX, or TXT.' };
    }

    if (!text) return { ok: false, error: 'No extractable text found in file' };
    // Cap huge uploads so prompts stay usable
    if (text.length > 80_000) text = `${text.slice(0, 80_000)}\n…[truncated]`;
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
