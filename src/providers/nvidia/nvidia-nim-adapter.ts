import { buildContextCapabilityDetails, computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
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

export const NVIDIA_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

interface NvidiaModelEntry {
  id: string;
  owned_by?: string;
  max_model_len?: number;
  permission?: Array<{
    allow_sampling?: boolean;
  }>;
}

export interface NvidiaNimAdapterOptions {
  apiKey: string;
  hostedFreeNoCreditsConfirmed: boolean;
  enabled?: boolean;
  fetchFn?: FetchLike;
  verificationTtlMs?: number;
}

function isNonChatNimModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes('embed') ||
    lower.includes('rerank') ||
    lower.includes('whisper') ||
    lower.includes('tts') ||
    lower.includes('diffusion') ||
    lower.includes('usd') ||
    lower.includes('corrdiff') ||
    lower.includes('esmfold')
  );
}

export class NvidiaNimAdapter implements ProviderAdapter {
  public readonly id = 'nvidia';
  public readonly displayName = 'NVIDIA NIM';

  private readonly apiKey: string;
  private readonly hostedFreeNoCreditsConfirmed: boolean;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;
  private readonly verificationTtlMs: number;

  constructor(options: NvidiaNimAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    this.hostedFreeNoCreditsConfirmed = options.hostedFreeNoCreditsConfirmed;
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
      endpointUrl: NVIDIA_NIM_BASE_URL,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes: this.hostedFreeNoCreditsConfirmed
        ? 'NVIDIA hosted non-credit free inference verified.'
        : 'NVIDIA free developer accounts default to finite prototyping trial credits (TRIAL_ONLY) and are excluded under STRICT_FREE_ONLY unless verified non-credit.',
    };
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabled && this.isConfigured();
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'NVIDIA_API_KEY is not configured.' };
    }
    const url = `${NVIDIA_NIM_BASE_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      return { valid: false, reason: `NVIDIA NIM auth failed (HTTP ${res.status}).` };
    }
    return {
      valid: true,
      reason: this.hostedFreeNoCreditsConfirmed
        ? 'NVIDIA NIM key valid and non-credit free tier verified.'
        : 'NVIDIA NIM key valid, classified TRIAL_ONLY until non-credit free entitlement is verified.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${NVIDIA_NIM_BASE_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(this.normalizeError(new Error(`HTTP ${response.status}`), response.status, response.headers, bodyText).message);
    }

    const payload = (await response.json()) as { data?: NvidiaModelEntry[] };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    return entries
      .filter((entry) => entry.id && !isNonChatNimModel(entry.id))
      .map((entry) => {
        const allowSampling = entry.permission?.[0]?.allow_sampling !== false;
        const hasReportedContext =
          typeof entry.max_model_len === 'number' && entry.max_model_len > 0;
        const contextWindow = hasReportedContext ? entry.max_model_len! : 0;
        const verifiedNonCredit =
          this.hostedFreeNoCreditsConfirmed && allowSampling && hasReportedContext;

        return {
          id: entry.id,
          canonicalId: `${this.id}:${entry.id}`,
          providerId: this.id,
          displayName: `${entry.id} (NVIDIA NIM)`,
          contextWindow,
          providerInputLimit: hasReportedContext ? contextWindow : null,
          accountFreeInputLimit: hasReportedContext ? contextWindow : null,
          effectiveContextWindow: computeEffectiveContextWindow({
            advertisedContextWindow: contextWindow,
          }),
          maxOutputTokens: Math.min(contextWindow || 4096, 8192),
          inputPrice: 0,
          outputPrice: 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility: verifiedNonCredit
            ? 'FREE_VERIFIED'
            : this.hostedFreeNoCreditsConfirmed && !hasReportedContext
              ? 'FREE_UNVERIFIED'
              : 'TRIAL_ONLY',
          freeTierType: verifiedNonCredit ? 'FREE_TIER_RATE_LIMITED' : 'TRIAL_CREDITS',
          billingRequired: false,
          promotionalCredits: !this.hostedFreeNoCreditsConfirmed,
          freeVerifiedAt: verifiedNonCredit ? nowIso : null,
          verificationExpiresAt: verifiedNonCredit ? expiresIso : null,
          freeVerificationSource: verifiedNonCredit
            ? 'nvidia_nim_models_api_verified_non_credit'
            : 'nvidia_nim_trial_credits_rejected_by_policy',
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: entry.id.toLowerCase().includes('vl') || entry.id.toLowerCase().includes('vision'),
          supportsJsonMode: true,
          supportsReasoning: entry.id.toLowerCase().includes('deepseek') || entry.id.toLowerCase().includes('nemotron'),
          codingCapability: inferCodingCapabilityTier(entry.id, true),
          availabilityStatus: verifiedNonCredit ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            rpmLimit: 40,
            notes: this.hostedFreeNoCreditsConfirmed
              ? 'NVIDIA hosted NIM 40 RPM shared tier.'
              : 'Excluded by default: hosted NIM accounts use finite prototyping trial credits unless verified non-credit.',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: NVIDIA_NIM_BASE_URL,
        };
      });
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const eligible = this.hostedFreeNoCreditsConfirmed && model.contextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: eligible
        ? 'FREE_VERIFIED'
        : this.hostedFreeNoCreditsConfirmed
          ? 'FREE_UNVERIFIED'
          : 'TRIAL_ONLY',
      freeTierType: eligible ? 'FREE_TIER_RATE_LIMITED' : 'TRIAL_CREDITS',
      billingRequired: false,
      promotionalCredits: !this.hostedFreeNoCreditsConfirmed,
      verifiedAt: nowIso,
      expiresAt: eligible ? new Date(Date.now() + this.verificationTtlMs).toISOString() : null,
      source: eligible
        ? 'nvidia_nim_models_api_verified_non_credit'
        : 'nvidia_nim_trial_credits_rejected_by_policy',
      reason: eligible
        ? 'Verified hosted NVIDIA NIM endpoint without trial-credit drawdown.'
        : 'NVIDIA NIM free prototyping relies on finite developer trial credits; excluded under STRICT_FREE_ONLY.',
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'nvidia_nim_v1_models',
    });
  }

  public chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    return executeOpenAICompatChat({
      providerId: this.id,
      endpointUrl: NVIDIA_NIM_BASE_URL,
      apiKey: this.apiKey,
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
      providerId: this.id,
      endpointUrl: NVIDIA_NIM_BASE_URL,
      apiKey: this.apiKey,
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
        message: 'NVIDIA API key not configured.',
      };
    }
    try {
      const url = `${NVIDIA_NIM_BASE_URL}/models`;
      await assertResolvedEndpointSafe(url, { providerId: this.id });
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      return {
        providerId: this.id,
        healthy: res.ok,
        status: res.ok ? (this.hostedFreeNoCreditsConfirmed ? 'healthy' : 'degraded') : 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: res.ok
          ? this.hostedFreeNoCreditsConfirmed
            ? 'NVIDIA NIM reachable and verified.'
            : 'NVIDIA NIM reachable, held in TRIAL_ONLY mode under STRICT_FREE_ONLY.'
          : `NVIDIA NIM returned HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: err instanceof Error ? err.message : 'NVIDIA NIM health check failed.',
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
