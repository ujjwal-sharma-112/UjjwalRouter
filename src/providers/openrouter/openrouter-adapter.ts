import { buildContextCapabilityDetails, computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord, ProviderQuotaInfo } from '../../core/policy/types.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
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

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterKeyInfo {
  is_free_tier?: boolean;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  usage_daily?: number;
  rate_limit?: {
    requests?: number;
    interval?: string;
  };
}

interface OpenRouterCatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    request?: string | number;
    image?: string | number;
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
  };
}

export interface OpenRouterAdapterOptions {
  apiKey: string;
  enabled?: boolean;
  fetchFn?: FetchLike;
  verificationTtlMs?: number;
}

function parseZeroOrPositiveNumber(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY;
}

export class OpenRouterAdapter implements ProviderAdapter {
  public readonly id = 'openrouter';
  public readonly displayName = 'OpenRouter';

  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;
  private readonly verificationTtlMs: number;
  private lastKeyInfo: OpenRouterKeyInfo | null = null;

  constructor(options: OpenRouterAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    this.enabled = options.enabled ?? this.apiKey.length > 0;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.verificationTtlMs = options.verificationTtlMs ?? 3_600_000;
  }

  public getInfo(): ProviderAdapterInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      endpointUrl: OPENROUTER_BASE_URL,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes: 'Strictly restricts requests to verified :free zero-cost models; never strips :free suffix.',
    };
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabled && this.isConfigured();
  }

  private getDefaultHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'http://127.0.0.1:8787',
      'X-Title': 'UjjwalRouter',
    };
  }

  public async fetchKeyEntitlement(signal?: AbortSignal): Promise<{ valid: boolean; info?: OpenRouterKeyInfo; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'OPENROUTER_API_KEY is not configured.' };
    }
    const url = `${OPENROUTER_BASE_URL}/key`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getDefaultHeaders(),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { valid: false, reason: `OpenRouter key verification failed (HTTP ${response.status}): ${body.slice(0, 200)}` };
    }
    const payload = (await response.json()) as { data?: OpenRouterKeyInfo };
    this.lastKeyInfo = payload.data ?? {};
    return {
      valid: true,
      info: this.lastKeyInfo,
      reason: this.lastKeyInfo.is_free_tier
        ? 'Verified OpenRouter free-tier key (no paid credits).'
        : 'Verified OpenRouter key; strict :free zero-price model filter enforced.',
    };
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    try {
      const res = await this.fetchKeyEntitlement();
      return { valid: res.valid, reason: res.reason };
    } catch (err) {
      return {
        valid: false,
        reason: err instanceof Error ? err.message : 'OpenRouter authentication check failed.',
      };
    }
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const keyCheck = await this.fetchKeyEntitlement(signal);
    const keyValid = keyCheck.valid;
    const isFreeTierAccount = keyCheck.info?.is_free_tier ?? true;

    const url = `${OPENROUTER_BASE_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getDefaultHeaders(),
      signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const normalized = this.normalizeError(new Error(`HTTP ${response.status}`), response.status, response.headers, bodyText);
      throw new Error(normalized.message);
    }

    const payload = (await response.json()) as { data?: OpenRouterCatalogModel[] };
    const catalog = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    const quotaNotes = isFreeTierAccount
      ? 'OpenRouter free-tier account (~20 RPM / ~50 RPD free quota).'
      : 'OpenRouter account has purchased credits on file; router strictly restricts to zero-priced :free variants.';

    const quotaInfo: ProviderQuotaInfo = {
      rpmLimit: 20,
      rpdLimit: isFreeTierAccount ? 50 : 1000,
      notes: quotaNotes,
    };

    const records: ModelRecord[] = [];
    for (const raw of catalog) {
      if (!raw.id || typeof raw.id !== 'string') continue;

      const inputPrice = parseZeroOrPositiveNumber(raw.pricing?.prompt);
      const outputPrice = parseZeroOrPositiveNumber(raw.pricing?.completion);
      const requestPrice = parseZeroOrPositiveNumber(raw.pricing?.request);
      const imagePrice = parseZeroOrPositiveNumber(raw.pricing?.image);

      const isExplicitFreeSuffix = raw.id.endsWith(':free');
      const isZeroPriced =
        inputPrice === 0 && outputPrice === 0 && requestPrice === 0 && imagePrice === 0;

      const advertisedContext =
        typeof raw.context_length === 'number' && raw.context_length > 0 ? raw.context_length : 0;
      const topProviderContext =
        typeof raw.top_provider?.context_length === 'number' && raw.top_provider.context_length > 0
          ? raw.top_provider.context_length
          : null;
      const effectiveContext = computeEffectiveContextWindow({
        advertisedContextWindow: advertisedContext,
        providerInputLimit: topProviderContext,
      });

      const maxOutputTokens =
        typeof raw.top_provider?.max_completion_tokens === 'number' &&
        raw.top_provider.max_completion_tokens > 0
          ? raw.top_provider.max_completion_tokens
          : Math.min(effectiveContext || 8192, 8192);

      const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
      const supportsTools = params.includes('tools');
      const supportsJsonMode =
        params.includes('response_format') || params.includes('structured_outputs');
      const supportsReasoning =
        params.includes('reasoning') || params.includes('include_reasoning');
      const inputMods = raw.architecture?.input_modalities ?? [];
      const supportsVision =
        inputMods.includes('image') || (raw.architecture?.modality?.includes('image') ?? false);

      const isEligibleFree =
        keyValid && isExplicitFreeSuffix && isZeroPriced && effectiveContext > 0;

      records.push({
        id: raw.id,
        canonicalId: `${this.id}:${raw.id}`,
        providerId: this.id,
        displayName: raw.name ?? raw.id,
        contextWindow: advertisedContext,
        providerInputLimit: topProviderContext,
        accountFreeInputLimit: effectiveContext || null,
        effectiveContextWindow: effectiveContext,
        maxOutputTokens,
        inputPrice,
        outputPrice,
        requestPrice,
        imagePrice,
        freeEligibility: isEligibleFree
          ? 'FREE_VERIFIED'
          : isExplicitFreeSuffix && !keyValid
            ? 'FREE_UNVERIFIED'
            : 'PAID',
        freeTierType: isEligibleFree ? 'PERMANENT_FREE' : 'PAID',
        billingRequired: !isEligibleFree,
        promotionalCredits: false,
        freeVerifiedAt: isEligibleFree ? nowIso : null,
        verificationExpiresAt: isEligibleFree ? expiresIso : null,
        freeVerificationSource: isEligibleFree
          ? 'openrouter_models_and_key_api'
          : 'openrouter_rejected_non_free_or_paid',
        supportsStreaming: true,
        supportsTools,
        supportsVision,
        supportsJsonMode,
        supportsReasoning,
        codingCapability: inferCodingCapabilityTier(raw.id, supportsTools),
        availabilityStatus: isEligibleFree ? 'AVAILABLE' : 'UNAVAILABLE',
        lastCheckedAt: nowIso,
        quotaInfo,
        providerEnabled: this.isEnabled(),
        endpointUrl: OPENROUTER_BASE_URL,
      });
    }

    return records;
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(
    model: ModelRecord,
    signal?: AbortSignal
  ): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const keyCheck = await this.fetchKeyEntitlement(signal);

    if (!model.id.endsWith(':free')) {
      return {
        providerId: this.id,
        modelId: model.id,
        eligible: false,
        freeEligibility: 'PAID',
        freeTierType: 'PAID',
        billingRequired: true,
        promotionalCredits: false,
        verifiedAt: nowIso,
        expiresAt: null,
        source: 'openrouter_free_suffix_check',
        reason: 'OpenRouter model ID does not end with :free.',
      };
    }

    if (
      model.inputPrice !== 0 ||
      model.outputPrice !== 0 ||
      model.requestPrice !== 0 ||
      model.imagePrice !== 0
    ) {
      return {
        providerId: this.id,
        modelId: model.id,
        eligible: false,
        freeEligibility: 'PAID',
        freeTierType: 'PAID',
        billingRequired: true,
        promotionalCredits: false,
        verifiedAt: nowIso,
        expiresAt: null,
        source: 'openrouter_pricing_check',
        reason: 'OpenRouter model has non-zero pricing.',
      };
    }

    if (!keyCheck.valid) {
      return {
        providerId: this.id,
        modelId: model.id,
        eligible: false,
        freeEligibility: 'FREE_UNVERIFIED',
        freeTierType: 'UNVERIFIED',
        billingRequired: false,
        promotionalCredits: false,
        verifiedAt: nowIso,
        expiresAt: null,
        source: 'openrouter_key_check',
        reason: keyCheck.reason,
      };
    }

    return {
      providerId: this.id,
      modelId: model.id,
      eligible: true,
      freeEligibility: 'FREE_VERIFIED',
      freeTierType: 'PERMANENT_FREE',
      billingRequired: false,
      promotionalCredits: false,
      verifiedAt: nowIso,
      expiresAt: new Date(Date.now() + this.verificationTtlMs).toISOString(),
      source: 'openrouter_models_and_key_api',
      reason: keyCheck.reason,
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'openrouter_models_catalog',
    });
  }

  public async chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    if (!model.id.endsWith(':free')) {
      throw new Error(`Refusing non-:free OpenRouter model "${model.id}".`);
    }
    return executeOpenAICompatChat({
      providerId: this.id,
      endpointUrl: OPENROUTER_BASE_URL,
      apiKey: this.apiKey,
      extraHeaders: {
        'HTTP-Referer': 'http://127.0.0.1:8787',
        'X-Title': 'UjjwalRouter',
      },
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
    if (!model.id.endsWith(':free')) {
      throw new Error(`Refusing non-:free OpenRouter model "${model.id}".`);
    }
    return executeOpenAICompatStream({
      providerId: this.id,
      endpointUrl: OPENROUTER_BASE_URL,
      apiKey: this.apiKey,
      extraHeaders: {
        'HTTP-Referer': 'http://127.0.0.1:8787',
        'X-Title': 'UjjwalRouter',
      },
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
    if (!this.isEnabled()) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'disabled',
        latencyMs: 0,
        checkedAt,
        message: 'OpenRouter API key not configured.',
      };
    }

    try {
      const check = await this.fetchKeyEntitlement(signal);
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
        message: err instanceof Error ? err.message : 'Health check failed',
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
