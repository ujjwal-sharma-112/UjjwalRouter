import { buildContextCapabilityDetails } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
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

export const HUGGINGFACE_ROUTER_URL = 'https://router.huggingface.co/v1';

interface HuggingFaceModelEntry {
  id: string;
  owned_by?: string;
}

export interface HuggingFaceAdapterOptions {
  token: string;
  enabled?: boolean; // Disabled by default per STRICT_FREE_ONLY policy
  fetchFn?: FetchLike;
}

export class HuggingFaceAdapter implements ProviderAdapter {
  public readonly id = 'huggingface';
  public readonly displayName = 'Hugging Face Inference Providers';

  private readonly token: string;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;

  constructor(options: HuggingFaceAdapterOptions) {
    this.token = options.token.trim();
    // Disabled by default because Hugging Face free tier grants finite promotional credits ($0.10/mo).
    this.enabled = options.enabled ?? false;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  public getInfo(): ProviderAdapterInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      endpointUrl: HUGGINGFACE_ROUTER_URL,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes:
        'Disabled by default: Hugging Face free inference uses finite monthly promotional credits ($0.10/mo) rather than permanent zero-cost inference.',
    };
  }

  public isConfigured(): boolean {
    return this.token.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabled && this.isConfigured();
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isEnabled()) {
      return {
        valid: false,
        reason: 'Hugging Face adapter is disabled by default because promotional credits are ineligible under STRICT_FREE_ONLY.',
      };
    }
    const url = `${HUGGINGFACE_ROUTER_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      return { valid: false, reason: `Hugging Face auth failed (HTTP ${res.status}).` };
    }
    return {
      valid: true,
      reason: 'Hugging Face token valid, but models remain TRIAL_ONLY under STRICT_FREE_ONLY.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${HUGGINGFACE_ROUTER_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(this.normalizeError(new Error(`HTTP ${res.status}`), res.status, res.headers, bodyText).message);
    }

    const payload = (await res.json()) as { data?: HuggingFaceModelEntry[] };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();

    return entries
      .filter((e) => typeof e.id === 'string' && e.id.length > 0)
      .map((entry) => ({
        id: entry.id,
        canonicalId: `${this.id}:${entry.id}`,
        providerId: this.id,
        displayName: `${entry.id} (HF Inference)`,
        contextWindow: 0,
        providerInputLimit: null,
        accountFreeInputLimit: null,
        effectiveContextWindow: 0,
        maxOutputTokens: 0,
        inputPrice: 0,
        outputPrice: 0,
        requestPrice: 0,
        imagePrice: 0,
        freeEligibility: 'TRIAL_ONLY',
        freeTierType: 'PROMOTIONAL_CREDITS',
        billingRequired: false,
        promotionalCredits: true,
        freeVerifiedAt: null,
        verificationExpiresAt: null,
        freeVerificationSource: 'huggingface_monthly_credit_allowance_rejected',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        supportsJsonMode: true,
        supportsReasoning: false,
        codingCapability: 'unknown',
        availabilityStatus: 'UNAVAILABLE',
        lastCheckedAt: nowIso,
        quotaInfo: {
          notes: 'Promotional $0.10/month inference credits do not satisfy STRICT_FREE_ONLY.',
        },
        providerEnabled: this.isEnabled(),
        endpointUrl: HUGGINGFACE_ROUTER_URL,
      }));
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    return {
      providerId: this.id,
      modelId: model.id,
      eligible: false,
      freeEligibility: 'TRIAL_ONLY',
      freeTierType: 'PROMOTIONAL_CREDITS',
      billingRequired: false,
      promotionalCredits: true,
      verifiedAt: new Date().toISOString(),
      expiresAt: null,
      source: 'huggingface_monthly_credit_allowance_rejected',
      reason:
        'Hugging Face Inference Providers draw down finite monthly promotional credits ($0.10/mo) and are ineligible for STRICT_FREE_ONLY routing.',
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'huggingface_router_v1_models',
    });
  }

  public chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    if (model.freeEligibility !== 'FREE_VERIFIED' || model.promotionalCredits) {
      throw new Error(
        `Refusing Hugging Face inference for "${model.id}": promotional credit endpoints cannot serve STRICT_FREE_ONLY requests.`
      );
    }
    return executeOpenAICompatChat({
      providerId: this.id,
      endpointUrl: HUGGINGFACE_ROUTER_URL,
      apiKey: this.token,
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
    if (model.freeEligibility !== 'FREE_VERIFIED' || model.promotionalCredits) {
      throw new Error(
        `Refusing Hugging Face streaming for "${model.id}": promotional credit endpoints cannot serve STRICT_FREE_ONLY requests.`
      );
    }
    return executeOpenAICompatStream({
      providerId: this.id,
      endpointUrl: HUGGINGFACE_ROUTER_URL,
      apiKey: this.token,
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

  public async healthCheck(): Promise<ProviderHealthResult> {
    return {
      providerId: this.id,
      healthy: false,
      status: 'disabled',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      message:
        'Hugging Face adapter is disabled by default under STRICT_FREE_ONLY (promotional credits are excluded).',
    };
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
      knownSecrets: this.token ? [this.token] : [],
    });
  }
}
