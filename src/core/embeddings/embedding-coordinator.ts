import type { Logger } from 'pino';
import { OpenAIErrorResponse } from '../../api/errors/openai-error.js';
import type { EmbeddingRequest, EmbeddingResponse } from '../../api/schemas/embeddings.js';
import type { FetchLike } from '../../providers/base/openai-compat-base.js';

export interface EmbeddingCoordinatorOptions {
  ollamaBaseUrl?: string;
  ollamaEnabled?: boolean;
  googleApiKey?: string;
  openrouterApiKey?: string;
  defaultModel?: string;
  fetchFn?: FetchLike;
  logger?: Logger;
}

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'text-embedding-004';
export const DEFAULT_OPENROUTER_FREE_EMBEDDING_MODEL = 'nvidia/nemotron-3.5-embed-1b:free';

const GENERIC_ALIASES = new Set([
  'auto',
  'auto-embed',
  'default',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
]);

function estimateTokensFromInput(input: unknown): number {
  if (typeof input === 'string') {
    return Math.ceil(Buffer.byteLength(input, 'utf8') / 3.4);
  }
  if (Array.isArray(input)) {
    let total = 0;
    for (const item of input) {
      if (typeof item === 'string') {
        total += Math.ceil(Buffer.byteLength(item, 'utf8') / 3.4);
      } else if (typeof item === 'number') {
        total += 1;
      } else if (Array.isArray(item)) {
        total += item.length;
      }
    }
    return Math.max(1, total);
  }
  return 1;
}

function normalizeInputToStrings(input: unknown): string[] {
  if (typeof input === 'string') {
    return [input];
  }
  if (Array.isArray(input)) {
    const result: string[] = [];
    for (const item of input) {
      if (typeof item === 'string') {
        result.push(item);
      } else {
        result.push(JSON.stringify(item));
      }
    }
    return result.length > 0 ? result : [''];
  }
  return [String(input ?? '')];
}

export function isDisallowedPaidEmbeddingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase().trim();
  if (lower.startsWith('openrouter:') && !lower.endsWith(':free')) {
    return true;
  }
  if (
    lower.startsWith('openai/') ||
    lower.startsWith('cohere/') ||
    lower.startsWith('mistralai/') ||
    lower.startsWith('amazon/') ||
    lower.startsWith('mongodb/') ||
    lower.startsWith('perplexity/')
  ) {
    if (!lower.endsWith(':free')) {
      return true;
    }
  }
  return false;
}

export class EmbeddingCoordinator {
  private readonly ollamaBaseUrl: string;
  private readonly ollamaEnabled: boolean;
  private readonly googleApiKey?: string;
  private readonly openrouterApiKey?: string;
  private readonly defaultModel: string;
  private readonly fetchFn: FetchLike;
  private readonly logger?: Logger;

  constructor(options: EmbeddingCoordinatorOptions = {}) {
    this.ollamaBaseUrl = (options.ollamaBaseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.ollamaEnabled = options.ollamaEnabled ?? true;
    this.googleApiKey = options.googleApiKey?.trim() || undefined;
    this.openrouterApiKey = options.openrouterApiKey?.trim() || undefined;
    this.defaultModel = options.defaultModel ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.logger = options.logger;
  }

  public async execute(
    request: EmbeddingRequest,
    signal?: AbortSignal
  ): Promise<EmbeddingResponse> {
    const rawModel = request.model?.trim() || 'auto';

    if (isDisallowedPaidEmbeddingModel(rawModel)) {
      throw OpenAIErrorResponse.forbidden(
        `Model "${rawModel}" is a paid model. UjjwalRouter strictly enforces zero paid inference and only allows verified free models.`
      );
    }

    const isGeneric = GENERIC_ALIASES.has(rawModel.toLowerCase());
    const targetLocalModel = isGeneric ? this.defaultModel : rawModel.replace(/^(ollama:)/i, '');

    const errors: Array<{ provider: string; error: string }> = [];

    // 1. Primary: Local Ollama (if enabled and applicable)
    const shouldTryOllama =
      this.ollamaEnabled &&
      (isGeneric || rawModel.startsWith('ollama:') || !rawModel.includes(':'));

    if (shouldTryOllama) {
      try {
        const ollamaResp = await this.executeOllama(targetLocalModel, request, signal);
        return ollamaResp;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err: errMsg, provider: 'ollama' }, 'Local Ollama embedding failed');
        errors.push({ provider: 'ollama', error: errMsg });
      }
    }

    // 2. Fallback 1: Google Gemini Embeddings (text-embedding-004)
    const shouldTryGemini =
      Boolean(this.googleApiKey) &&
      (isGeneric || rawModel.startsWith('google:') || rawModel.includes('text-embedding-004'));

    if (shouldTryGemini) {
      try {
        const geminiResp = await this.executeGemini(request, signal);
        return geminiResp;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err: errMsg, provider: 'google' }, 'Google Gemini embedding failed');
        errors.push({ provider: 'google', error: errMsg });
      }
    }

    // 3. Fallback 2: OpenRouter Free Embeddings
    const shouldTryOpenRouter =
      Boolean(this.openrouterApiKey) &&
      (isGeneric ||
        rawModel.startsWith('openrouter:') ||
        rawModel.includes('nemotron') ||
        rawModel.endsWith(':free'));

    if (shouldTryOpenRouter) {
      try {
        const targetOrModel =
          rawModel.endsWith(':free') && !isGeneric
            ? rawModel.replace(/^(openrouter:)/i, '')
            : DEFAULT_OPENROUTER_FREE_EMBEDDING_MODEL;

        const orResp = await this.executeOpenRouter(targetOrModel, request, signal);
        return orResp;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err: errMsg, provider: 'openrouter' }, 'OpenRouter free embedding failed');
        errors.push({ provider: 'openrouter', error: errMsg });
      }
    }

    const failureSummary = errors.map((e) => `[${e.provider}: ${e.error}]`).join(', ');
    throw OpenAIErrorResponse.noFreeModelsAvailable(
      `All eligible free embedding providers failed or are unavailable. Attempts: ${failureSummary || 'No providers available'}`
    );
  }

  private async executeOllama(
    model: string,
    request: EmbeddingRequest,
    signal?: AbortSignal
  ): Promise<EmbeddingResponse> {
    const url = `${this.ollamaBaseUrl}/v1/embeddings`;
    const body = {
      model,
      input: request.input,
      dimensions: request.dimensions,
      encoding_format: request.encoding_format,
    };

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama returned status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as EmbeddingResponse;
    if (!data || !Array.isArray(data.data)) {
      throw new Error('Ollama returned invalid embedding response format');
    }

    return {
      object: 'list',
      data: data.data,
      model: data.model || model,
      usage: data.usage || {
        prompt_tokens: estimateTokensFromInput(request.input),
        total_tokens: estimateTokensFromInput(request.input),
      },
    };
  }

  private async executeGemini(
    request: EmbeddingRequest,
    signal?: AbortSignal
  ): Promise<EmbeddingResponse> {
    const inputs = normalizeInputToStrings(request.input);
    const model = DEFAULT_GEMINI_EMBEDDING_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${this.googleApiKey}`;

    const requestsPayload = inputs.map((text) => ({
      model: `models/${model}`,
      content: {
        parts: [{ text }],
      },
    }));

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests: requestsPayload }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API returned status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Gemini API returned unexpected embedding payload structure');
    }

    const promptTokens = estimateTokensFromInput(request.input);

    return {
      object: 'list',
      data: data.embeddings.map((e, index) => ({
        object: 'embedding' as const,
        index,
        embedding: e.values || [],
      })),
      model: `google:${model}`,
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: promptTokens,
      },
    };
  }

  private async executeOpenRouter(
    model: string,
    request: EmbeddingRequest,
    signal?: AbortSignal
  ): Promise<EmbeddingResponse> {
    const url = 'https://openrouter.ai/api/v1/embeddings';
    const body = {
      model,
      input: request.input,
      dimensions: request.dimensions,
      encoding_format: request.encoding_format,
    };

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openrouterApiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenRouter returned status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as EmbeddingResponse;
    if (!data || !Array.isArray(data.data)) {
      throw new Error('OpenRouter returned invalid embedding response format');
    }

    return {
      object: 'list',
      data: data.data,
      model: data.model || model,
      usage: data.usage || {
        prompt_tokens: estimateTokensFromInput(request.input),
        total_tokens: estimateTokensFromInput(request.input),
      },
    };
  }
}
