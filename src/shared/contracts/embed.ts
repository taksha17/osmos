/**
 * Embedding contract — Architecture v2, §9.
 *
 * Types only. Vector rows are stored per dimension, so the model id and
 * dimension travel with every result instead of being assumed.
 */

export type EmbeddingRequest = {
  texts: string[];
};

export type EmbeddingResult = {
  model: string;
  dimensions: number;
  vectors: number[][];
};

export interface EmbeddingProvider {
  id: string;
  model: string;
  dimensions: number;
  /** Must return one vector per input text, in order. */
  embed(req: EmbeddingRequest): Promise<EmbeddingResult>;
}
