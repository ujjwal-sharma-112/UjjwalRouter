import { buildContextCapabilityDetails, computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { assertResolvedEndpointSafe, validateProviderBaseUrl } from '../../security/ssrf.js';
import type { ProviderAdapter, ProviderExecutionOptions } from '../base/provider-adapter.js';
import {
  detectStandardQuotaExhaustion,
  executeOpenAICompatChat,
  executeOpenAICompatStream,
  extractStandardUsage,
  normalizeStandardHttpError,
  parseRateLimitHeaders,
  type FetchLike,
} from '../base/openai-compat-base.js';
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
} from '../base/types.js';

export interface CustomOpenAIAdapterOptions {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  allowLoopback?: boolean;
  zeroCostVerified?: boolean;
  verificationSource?: string;
  fetchFn?: FetchLike;
}

export class CustomOpenAIAdapter implements ProviderAdapter {
  public readonly id: string;
  public readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly allowLoopback: boolean;
  private readonly zeroCostVerified: boolean;
  private readonly verificationSource: string | null;
  private readonly fetchFn: FetchLike;

  constructor(options: CustomOpenAIAdapterOptions) {
    validateProviderBaseUrl(options.baseUrl, { allowLoopback: options.allowLoopback ?? false });
    this.id = options.id;
    this.displayName = options.displayName;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = (options.apiKey ?? '').trim();
    this.enabled = options.enabled ?? true;
    this.allowLoopback = options.allowLoopback ?? false;
    // Custom providers MUST default to FREE_UNVERIFIED unless zero-cost entitlement is independently verified
    this.zeroCostVerified = options.zeroCostVerified ?? false;
    this.verificationSource = options.verificationSource ?? null;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  public getInfo(): ProviderAdapterInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      endpointUrl: this.baseUrl,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes: this.zeroCostVerified
        ? `Independently verified zero-cost custom provider (${this.verificationSource ?? 'verified'}).`
        : 'Custom provider defaults to FREE_UNVERIFIED until zero-cost entitlement is independently verified.',
    };
  }

  public isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabled && this.isConfigured();
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    const url = `${this.baseUrl}/models`;
    await assertResolvedEndpointSafe(url, { allowLoopback: this.allowLoopback });
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(url, { method: 'GET', headers });
    if (!res.ok) {
      return { valid: false, reason: `Custom provider "${this.id}" returned HTTP ${res.status}.` };
    }
    return {
      valid: true,
      reason: this.zeroCostVerified
        ? 'Custom provider reachable and zero-cost verified.'
        : 'Custom provider reachable, remains FREE_UNVERIFIED until zero-cost entitlement is verified.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${this.baseUrl}/models`;
    await assertResolvedEndpointSafe(url, { allowLoopback: this.allowLoopback });
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await this.fetchFn(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(this.normalizeError(new Error(`HTTP ${res.status}`), res.status, res.headers, bodyText).message);
    }

    const payload = (await res.json()) as {
      data?: Array<{ id: string; context_window?: number; max_model_len?: number; max_output_tokens?: number }>;
    };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();

    return entries
      .filter((e) => typeof e.id === 'string' && e.id.length > 0)
      .map((entry) => {
        const ctx = entry.context_window ?? entry.max_model_len ?? 0;
        const verified = this.zeroCostVerified && ctx > 0 && Boolean(this.verificationSource);
        return {
          id: entry.id,
          canonicalId: `${this.id}:${entry.id}`,
          providerId: this.id,
          displayName: `${entry.id} (${this.displayName})`,
          contextWindow: ctx,
          providerInputLimit: ctx || null,
          accountFreeInputLimit: ctx || null,
          effectiveContextWindow: computeEffectiveContextWindow({ advertisedContextWindow: ctx }),
          maxOutputTokens: entry.max_output_tokens ?? Math.min(ctx || 4096, 8192),
          inputPrice: 0,
          outputPrice: 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility: verified ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
          freeTierType: verified ? 'PERMANENT_FREE' : 'UNVERIFIED',
          billingRequired: !verified,
          promotionalCredits: false,
          freeVerifiedAt: verified ? nowIso : null,
          verificationExpiresAt: verified ? new Date(Date.now() + 3_600_000).toISOString() : null,
          freeVerificationSource: verified
            ? this.verificationSource
            : 'custom_provider_unverified_default',
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: false,
          supportsJsonMode: true,
          supportsReasoning: false,
          codingCapability: 'unknown',
          availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            notes: verified
              ? 'Zero-cost custom provider.'
              : 'Custom provider requires independent zero-cost verification.',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: this.baseUrl,
        };
      });
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const eligible = this.zeroCostVerified && Boolean(this.verificationSource) && model.contextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: eligible ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
      freeTierType: eligible ? 'PERMANENT_FREE' : 'UNVERIFIED',
      billingRequired: !eligible,
      promotionalCredits: false,
      verifiedAt: new Date().toISOString(),
      expiresAt: eligible ? new Date(Date.now() + 3_600_000).toISOString() : null,
      source: eligible
        ? (this.verificationSource ?? 'custom_verified')
        : 'custom_provider_unverified_default',
      reason: eligible
        ? 'Custom provider zero-cost entitlement verified.'
        : 'Custom OpenAI-compatible providers default to FREE_UNVERIFIED until independently verified zero-cost.',
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'custom_openai_models',
    });
  }

  public chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    return executeOpenAICompatChat({
      providerId: 'custom',
      endpointUrl: this.baseUrl,
      apiKey: this.apiKey,
      allowLoopback: this.allowLoopback,
      model,
      request,
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
      providerId: 'custom',
      endpointUrl: this.baseUrl,
      apiKey: this.apiKey,
      allowLoopback: this.allowLoopback,
      model,
      request,
      options,
      fetchFn: this.fetchFn,
    });
  }

  public extractUsage(payload: unknown): TokenUsage | null {
    return extractStandardUsage(payload);
  }

  public detectRateLimit(_statusCode: number, headers: Headers, _bodyText: string): RateLimitObservation | null {
    return parseRateLimitHeaders(headers);
  }

  public detectQuotaExhaustion(statusCode: number, bodyText: string): boolean {
    return detectStandardQuotaExhaustion(statusCode, bodyText);
  }

  public async healthCheck(signal?: AbortSignal): Promise<ProviderHealthResult> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      const check = await this.validateAuthentication();
      void signal;
      return {
        providerId: this.id,
        healthy: check.valid,
        status: check.valid ? (this.zeroCostVerified ? 'healthy' : 'degraded') : 'unhealthy',
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
        message: err instanceof Error ? err.message : 'Custom provider health check failed.',
      };
    }
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
