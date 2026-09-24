export type { EmbeddingProvider } from './provider.js';
export { OpenAIEmbeddingProvider } from './openai-provider.js';

import { OpenAIEmbeddingProvider } from './openai-provider.js';
import type { EmbeddingProvider } from './provider.js';

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_provider) {
    _provider = new OpenAIEmbeddingProvider();
  }
  return _provider;
}
