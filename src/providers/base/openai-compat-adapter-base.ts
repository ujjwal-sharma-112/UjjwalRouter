import { buildContextCapabilityDetails } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import type { ProviderAdapter, ProviderExecutionOptions } from './provider-adapter.js';
import {
  detectStandardQuotaExhaustion,
  executeOpenAICompatChat,
  executeOpenAICompatStream,
  extractStandardUsage,
  normalizeStandardHttpError,
  parseRateLimitHeaders,
  type FetchLike,
} from './openai-compat-base.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ContextCapabilityDetails,
  FreeEligibilityVerification,
  NormalizedChatRequest,
  NormalizedProviderError,
  ProviderAdapterInfo,
  ProviderHealthResult,
  RateLimitObservation,
  TokenUsage,
} from './types.js';

export interface OpenAICompatAdapterBaseOptions {
  apiKey?: string;
  enabled?: boolean;
  fetchFn?: FetchLike;
  verificationTtlMs?: number;
}

/**
 * Shared base class for OpenAI-compatible provider adapters so discovery, eligibility policy,
 * chat, streaming, rate-limit extraction, health checks, and error normalization stay uniform.
 */
export abstract class OpenAICompatProviderBase implements ProviderAdapter {
  public abstract readonly id: string;
  public abstract readonly displayName: string;

  protected readonly apiKey: string;
  protected readonly enabledFlag: boolean;
  protected readonly fetchFn: FetchLike;
  protected readonly verificationTtlMs: number;

  protected constructor(options: OpenAICompatAdapterBaseOptions) {
    this.apiKey = (options.apiKey ?? '').trim();
    this.enabledFlag = options.enabled ?? true;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.verificationTtlMs = options.verificationTtlMs ?? 3_600_000;
  }

  protected abstract getEndpointBaseUrl(): string;
  protected abstract getCapabilitySource(): string;
  protected abstract getAdapterNotes(): string;

  protected allowLoopbackEndpoint(): boolean {
    return false;
  }

  protected omitStreamOptions(): boolean {
    return false;
  }

  protected getExtraHeaders(): Record<string, string> | undefined {
    return undefined;
  }

  protected prepareChatRequest(
    _model: ModelRecord,
    request: NormalizedChatRequest
  ): NormalizedChatRequest {
    return request;
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabledFlag && this.isConfigured();
  }

  public getInfo(): ProviderAdapterInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      endpointUrl: this.getEndpointBaseUrl(),
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes: this.getAdapterNotes(),
    };
  }

  public abstract validateAuthentication(): Promise<{ valid: boolean; reason: string }>;
  public abstract discoverModels(signal?: AbortSignal): Promise<ModelRecord[]>;
  public abstract verifyFreeEligibility(
    model: ModelRecord,
    signal?: AbortSignal
  ): Promise<FreeEligibilityVerification>;

  public async getModelMetadata(
    modelId: string,
    signal?: AbortSignal
  ): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: this.getCapabilitySource(),
    });
  }

  public chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    return executeOpenAICompatChat({
      providerId: this.id,
      endpointUrl: this.getEndpointBaseUrl(),
      apiKey: this.apiKey,
      extraHeaders: this.getExtraHeaders(),
      allowLoopback: this.allowLoopbackEndpoint(),
      model,
      request: this.prepareChatRequest(model, request),
      options,
      fetchFn: this.fetchFn,
    });
  }

  public streamChatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): AsyncIterable<ChatCompletionStreamChunk> {
    return executeOpenAICompatStream({
      providerId: this.id,
      endpointUrl: this.getEndpointBaseUrl(),
      apiKey: this.apiKey,
      extraHeaders: this.getExtraHeaders(),
      allowLoopback: this.allowLoopbackEndpoint(),
      omitStreamOptions: this.omitStreamOptions(),
      model,
      request: this.prepareChatRequest(model, request),
      options,
      fetchFn: this.fetchFn,
    });
  }

  public extractUsage(payload: unknown): TokenUsage | null {
    return extractStandardUsage(payload);
  }

  public detectRateLimit(
    _statusCode: number,
    headers: Headers,
    _bodyText: string
  ): RateLimitObservation | null {
    return parseRateLimitHeaders(headers);
  }

  public detectQuotaExhaustion(statusCode: number, bodyText: string): boolean {
    return detectStandardQuotaExhaustion(statusCode, bodyText);
  }

  public async healthCheck(signal?: AbortSignal): Promise<ProviderHealthResult> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();
    if (!this.isEnabled()) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'disabled',
        latencyMs: 0,
        checkedAt,
        message: `${this.displayName} is disabled or unconfigured.`,
      };
    }

    try {
      const check = await this.performHealthProbe(signal);
      return {
        providerId: this.id,
        healthy: check.valid,
        status: check.valid ? 'healthy' : 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: check.reason,
      };
    } catch (err) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: err instanceof Error ? err.message : `${this.displayName} health check failed`,
      };
    }
  }

  protected async performHealthProbe(
    signal?: AbortSignal
  ): Promise<{ valid: boolean; reason: string }> {
    const url = `${this.getEndpointBaseUrl().replace(/\/$/, '')}/models`;
    await assertResolvedEndpointSafe(url, {
      providerId: this.id,
      allowLoopback: this.allowLoopbackEndpoint(),
    });
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      return { valid: false, reason: `${this.displayName} returned HTTP ${res.status}` };
    }
    return { valid: true, reason: `${this.displayName} endpoint reachable.` };
  }

  public normalizeError(
    error: unknown,
    statusCode?: number,
    headers?: Headers,
    bodyText?: string
  ): NormalizedProviderError {
    return normalizeStandardHttpError({
      providerId: this.id,
      error,
      statusCode,
      headers,
      bodyText,
      knownSecrets: this.apiKey ? [this.apiKey] : [],
    });
  }
}
