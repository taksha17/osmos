/**
 * Provider contracts (Architecture v2 §3.3, §5.3, §6.3, §8.1, §9).
 *
 * Type-only barrel: importing this file costs nothing at runtime, so main,
 * workers and the benchmark harness can all depend on it.
 */

export type {
  AudioBackend,
  AudioBackendStatus,
  AudioChannel,
  AudioFormat,
  AudioFrame,
} from './audio.ts';
export type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from './embed.ts';
export type {
  ChatRole,
  ChatTurn,
  LlmCapabilities,
  LlmImageInput,
  LlmProvider,
  LlmStreamChunk,
  LlmStreamRequest,
  LlmUsage,
} from './llm.ts';
export type {
  OcrCapabilities,
  OcrImageRequest,
  OcrProvider,
  OcrResult,
} from './ocr.ts';
export type {
  CallOpts,
  CallPurpose,
  Page,
  SearchHit,
  WebAccessProvider,
  WebCapability,
  WebHealth,
  WebPrivacy,
  WebTier,
} from './web.ts';
export type {
  SttCapabilities,
  SttFinal,
  SttPartial,
  SttProvider,
  SttSession,
  SttStartOptions,
} from './stt.ts';
