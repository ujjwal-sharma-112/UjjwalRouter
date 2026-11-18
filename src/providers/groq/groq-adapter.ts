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

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

interface GroqModelEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  active?: boolean;
  context_window?: number;
  max_completion_tokens?: number;
}

export interface GroqAdapterOptions {
  apiKey: string;
  freePlanConfirmed: boolean;
  enabled?: boolean;
  fetchFn?: FetchLike;
  verificationTtlMs?: number;
}

function isNonChatModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes('whisper') ||
    lower.includes('tts') ||
    lower.includes('orpheus') ||
    lower.includes('guard') ||
    lower.includes('safeguard')
  );
}

export class GroqAdapter implements ProviderAdapter {
  public readonly id = 'groq';
  public readonly displayName = 'Groq';

  private readonly apiKey: string;
  private readonly freePlanConfirmed: boolean;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;
  private readonly verificationTtlMs: number;

  constructor(options: GroqAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    this.freePlanConfirmed = options.freePlanConfirmed;
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
      endpointUrl: GROQ_BASE_URL,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
      notes: this.freePlanConfirmed
        ? 'Groq Free Plan confirmed (no billing card attached, rate-limited).'
        : 'Groq offers a permanent free plan with NO billing card required; set GROQ_FREE_PLAN_CONFIRMED=true or check confirmation in Dashboard.',
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
      return { valid: false, reason: 'GROQ_API_KEY is not configured.' };
    }
    const url = `${GROQ_BASE_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      return { valid: false, reason: `Groq auth failed (HTTP ${response.status}).` };
    }
    return {
      valid: true,
      reason: this.freePlanConfirmed
        ? 'Groq key valid and Free Plan confirmed.'
        : 'Groq key valid, awaiting GROQ_FREE_PLAN_CONFIRMED=true verification.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${GROQ_BASE_URL}/models`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(this.normalizeError(new Error(`HTTP ${response.status}`), response.status, response.headers, bodyText).message);
    }

    const payload = (await response.json()) as { data?: GroqModelEntry[] };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    return entries
      .filter((entry) => entry.id && !isNonChatModel(entry.id))
      .map((entry) => {
        const contextWindow =
          typeof entry.context_window === 'number' && entry.context_window > 0
            ? entry.context_window
            : 0;
        const maxOutput =
          typeof entry.max_completion_tokens === 'number' && entry.max_completion_tokens > 0
            ? entry.max_completion_tokens
            : Math.min(contextWindow || 8192, 8192);
        const isActive = entry.active !== false;
        const verified = this.freePlanConfirmed && isActive && contextWindow > 0;
        const lower = entry.id.toLowerCase();

        return {
          id: entry.id,
          canonicalId: `${this.id}:${entry.id}`,
          providerId: this.id,
          displayName: `${entry.id} (Groq)`,
          contextWindow,
          providerInputLimit: contextWindow || null,
          accountFreeInputLimit: contextWindow || null,
          effectiveContextWindow: computeEffectiveContextWindow({
            advertisedContextWindow: contextWindow,
          }),
          maxOutputTokens: maxOutput,
          inputPrice: 0,
          outputPrice: 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility: verified ? 'FREE_VERIFIED' : isActive ? 'FREE_UNVERIFIED' : 'DISABLED',
          freeTierType: verified ? 'FREE_TIER_RATE_LIMITED' : 'UNVERIFIED',
          billingRequired: false,
          promotionalCredits: false,
          freeVerifiedAt: verified ? nowIso : null,
          verificationExpiresAt: verified ? expiresIso : null,
          freeVerificationSource: verified
            ? 'groq_models_api_free_plan_confirmed'
            : 'groq_free_plan_unconfirmed',
          supportsStreaming: true,
          supportsTools: !lower.includes('gemma'),
          supportsVision: lower.includes('vision') || lower.includes('maverick') || lower.includes('scout'),
          supportsJsonMode: true,
          supportsReasoning:
            lower.includes('deepseek') ||
            lower.includes('qwen') ||
            lower.includes('gpt-oss') ||
            lower.includes('kimi'),
          codingCapability: inferCodingCapabilityTier(entry.id, !lower.includes('gemma')),
          availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            notes: 'Groq Free Plan enforces per-model RPM/RPD/TPM limits via response headers.',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: GROQ_BASE_URL,
        };
      });
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    return models.find((m) => m.id === modelId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const eligible = this.freePlanConfirmed && model.contextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: eligible ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
      freeTierType: eligible ? 'FREE_TIER_RATE_LIMITED' : 'UNVERIFIED',
      billingRequired: false,
      promotionalCredits: false,
      verifiedAt: nowIso,
      expiresAt: eligible ? new Date(Date.now() + this.verificationTtlMs).toISOString() : null,
      source: eligible ? 'groq_models_api_free_plan_confirmed' : 'groq_free_plan_unconfirmed',
      reason: eligible
        ? 'Groq Free Plan entitlement confirmed and active chat model verified.'
        : 'Set GROQ_FREE_PLAN_CONFIRMED=true after verifying Groq organization has no billing method attached.',
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'groq_openai_v1_models',
    });
  }

  public chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    return executeOpenAICompatChat({
      providerId: this.id,
      endpointUrl: GROQ_BASE_URL,
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
      endpointUrl: GROQ_BASE_URL,
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
        message: 'Groq API key not configured.',
      };
    }
    try {
      const url = `${GROQ_BASE_URL}/models`;
      await assertResolvedEndpointSafe(url, { providerId: this.id });
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      return {
        providerId: this.id,
        healthy: res.ok,
        status: res.ok ? (this.freePlanConfirmed ? 'healthy' : 'degraded') : 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: res.ok
          ? this.freePlanConfirmed
            ? 'Groq API reachable and Free Plan confirmed.'
            : 'Groq API reachable, awaiting GROQ_FREE_PLAN_CONFIRMED=true.'
          : `Groq health check returned HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: err instanceof Error ? err.message : 'Groq health check failed.',
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
