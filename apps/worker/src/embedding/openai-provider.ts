import OpenAI from 'openai';
import type { EmbeddingProvider } from './provider.js';
import { config } from '../config.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = 1536;
  private client: OpenAI;

  constructor() {
    this.model = config.embeddingModel;
    this.client = new OpenAI({ apiKey: config.openAiApiKey });
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // OpenAI allows max 2048 inputs per request, and text-embedding-3-small supports
    // up to 8191 tokens per input. Batch in config.embeddingBatchSize chunks.
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += config.embeddingBatchSize) {
      const batch = texts.slice(i, i + config.embeddingBatchSize);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        encoding_format: 'float',
      });
      // Sort by index to ensure order is preserved
      const sorted = response.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map(d => d.embedding));
    }
    return results;
  }
}
