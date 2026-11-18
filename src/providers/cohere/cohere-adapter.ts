import { computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import {
  OpenAICompatProviderBase,
  type OpenAICompatAdapterBaseOptions,
} from '../base/openai-compat-adapter-base.js';
import type {
  FreeEligibilityVerification,
  NormalizedChatRequest,
} from '../base/types.js';

export const COHERE_COMPAT_BASE_URL = 'https://api.cohere.ai/compatibility/v1';
export const COHERE_MODELS_BASE_URL = 'https://api.cohere.com/v1';

interface CohereModelEntry {
  name?: string;
  id?: string;
  is_deprecated?: boolean;
  endpoints?: string[];
  context_length?: number;
  features?: string[];
}

export interface CohereAdapterOptions extends OpenAICompatAdapterBaseOptions {
  apiKey: string;
  freePlanConfirmed: boolean;
}

/**
 * Adapter for Cohere OpenAI Compatibility API (non-expiring free Trial key: 20 RPM, 1,000 calls/mo).
 */
export class CohereAdapter extends OpenAICompatProviderBase {
  public readonly id = 'cohere';
  public readonly displayName = 'Cohere';

  private readonly freePlanConfirmed: boolean;

  constructor(options: CohereAdapterOptions) {
    super(options);
    this.freePlanConfirmed = options.freePlanConfirmed;
  }

  protected getEndpointBaseUrl(): string {
    return COHERE_COMPAT_BASE_URL;
  }

  protected getCapabilitySource(): string {
    return 'cohere_v1_models_api';
  }

  protected override omitStreamOptions(): boolean {
    return true;
  }

  protected override prepareChatRequest(
    model: ModelRecord,
    request: NormalizedChatRequest
  ): NormalizedChatRequest {
    if (request.reasoning_effort === undefined) return request;
    if (!model.supportsReasoning || request.reasoning_effort === 'none') {
      const { reasoning_effort: _omit, ...rest } = request;
      return rest;
    }
    // Cohere reasoning endpoints reject 'minimal'/'low'/'medium'/'xhigh' with HTTP 422
    if (request.reasoning_effort !== 'high') {
      return {
        ...request,
        reasoning_effort: 'high',
      };
    }
    return request;
  }

  protected getAdapterNotes(): string {
    return this.freePlanConfirmed
      ? 'Cohere non-expiring Trial API key confirmed (20 RPM, 1,000 calls/month, no billing attached).'
      : 'Cohere Trial keys require no card & do not expire (1,000 calls/mo); confirm COHERE_FREE_PLAN_CONFIRMED=true in .env or Dashboard.';
  }

  protected override async performHealthProbe(
    signal?: AbortSignal
  ): Promise<{ valid: boolean; reason: string }> {
    const url = `${COHERE_MODELS_BASE_URL}/models?page_size=1`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      return { valid: false, reason: `Cohere returned HTTP ${res.status}` };
    }
    return { valid: true, reason: 'Cohere Compatibility API reachable.' };
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'COHERE_API_KEY is not configured.' };
    }
    const probe = await this.performHealthProbe();
    if (!probe.valid) return probe;
    return {
      valid: true,
      reason: this.freePlanConfirmed
        ? 'Cohere key valid and non-commercial free Trial rate-limited tier confirmed.'
        : 'Cohere key valid; confirm COHERE_FREE_PLAN_CONFIRMED=true (1,000 calls/mo no-billing Trial key).',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${COHERE_MODELS_BASE_URL}/models?endpoint=chat&page_size=100`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(this.normalizeError(new Error(`HTTP ${res.status}`), res.status, res.headers, bodyText).message);
    }

    const payload = (await res.json()) as { models?: CohereModelEntry[] };
    const entries = Array.isArray(payload.models) ? payload.models : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    const records: ModelRecord[] = [];
    for (const entry of entries) {
      const modelId = entry.name ?? entry.id;
      if (!modelId || entry.is_deprecated) continue;
      if (Array.isArray(entry.endpoints) && !entry.endpoints.includes('chat')) continue;

      const contextWindow =
        typeof entry.context_length === 'number' && entry.context_length > 0
          ? entry.context_length
          : 0;
      const verified = this.freePlanConfirmed && contextWindow > 0;
      const features = Array.isArray(entry.features) ? entry.features : [];
      const supportsTools = features.length === 0 || features.includes('tools') || features.includes('strict_tools');
      const supportsJsonMode = features.length === 0 || features.includes('json_mode') || features.includes('structured_outputs');
      const lower = modelId.toLowerCase();

      records.push({
        id: modelId,
        canonicalId: `${this.id}:${modelId}`,
        providerId: this.id,
        displayName: `${modelId} (Cohere)`,
        contextWindow,
        providerInputLimit: contextWindow || null,
        accountFreeInputLimit: contextWindow || null,
        effectiveContextWindow: computeEffectiveContextWindow({ advertisedContextWindow: contextWindow }),
        maxOutputTokens: Math.min(contextWindow || 4096, 8192),
        inputPrice: 0,
        outputPrice: 0,
        requestPrice: 0,
        imagePrice: 0,
        freeEligibility: verified ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
        freeTierType: verified ? 'FREE_TIER_RATE_LIMITED' : 'UNVERIFIED',
        billingRequired: false,
        promotionalCredits: false,
        freeVerifiedAt: verified ? nowIso : null,
        verificationExpiresAt: verified ? expiresIso : null,
        freeVerificationSource: verified
          ? 'cohere_models_api_free_trial_confirmed'
          : 'cohere_free_plan_unconfirmed',
        supportsStreaming: true,
        supportsTools,
        supportsVision: lower.includes('vision'),
        supportsJsonMode,
        supportsReasoning: lower.includes('reasoning') || features.includes('reasoning'),
        codingCapability: inferCodingCapabilityTier(modelId, supportsTools),
        availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
        lastCheckedAt: nowIso,
        quotaInfo: {
          rpmLimit: 20,
          notes: 'Cohere non-expiring Trial key: 20 RPM, 1,000 calls/month, no card attached.',
        },
        providerEnabled: this.isEnabled(),
        endpointUrl: COHERE_COMPAT_BASE_URL,
      });
    }

    return records;
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
      source: eligible ? 'cohere_models_api_free_trial_confirmed' : 'cohere_free_plan_unconfirmed',
      reason: eligible
        ? 'Cohere non-expiring Trial API key (20 RPM / 1,000 calls/mo, no billing) verified.'
        : 'Confirm COHERE_FREE_PLAN_CONFIRMED=true in .env or Dashboard (requires no billing card).',
    };
  }
}
