/**
 * Decode recorded audio and encode 16-bit mono PCM WAV for Local Whisper.
 */

export async function recordingToWavBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  const float32 = await blobToMonoFloat32(blob, 16_000);
  const wav = encodeWav(float32, 16_000);
  const bytes = new Uint8Array(wav);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return { base64: btoa(binary), mimeType: 'audio/wav' };
}

async function blobToMonoFloat32(blob: Blob, targetRate: number): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const raw = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    const ch0 = decoded.getChannelData(0);
    let mono: Float32Array;
    if (decoded.numberOfChannels > 1) {
      const ch1 = decoded.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i]! + ch1[i]!) / 2;
    } else {
      mono = ch0;
    }

    if (decoded.sampleRate === targetRate) return mono;

    const ratio = decoded.sampleRate / targetRate;
    const newLen = Math.max(1, Math.floor(mono.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      out[i] = mono[Math.floor(i * ratio)] ?? 0;
    }
    return out;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
