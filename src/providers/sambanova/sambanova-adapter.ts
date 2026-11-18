import { computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import {
  OpenAICompatProviderBase,
  type OpenAICompatAdapterBaseOptions,
} from '../base/openai-compat-adapter-base.js';
import type { FreeEligibilityVerification } from '../base/types.js';

export const SAMBANOVA_BASE_URL = 'https://api.sambanova.ai/v1';

interface SambaNovaModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt?: number | string;
    completion?: number | string;
  };
}

export interface SambaNovaAdapterOptions extends OpenAICompatAdapterBaseOptions {
  apiKey: string;
  freeTierConfirmed: boolean;
}

function isNonChatSambaNovaModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes('whisper') ||
    lower.includes('embed') ||
    lower.includes('rerank') ||
    lower.includes('e5-')
  );
}

/**
 * Adapter for SambaNova Cloud Free Tier (api.sambanova.ai/v1) — fast RDU inference.
 */
export class SambaNovaAdapter extends OpenAICompatProviderBase {
  public readonly id = 'sambanova';
  public readonly displayName = 'SambaNova Cloud';

  private readonly freeTierConfirmed: boolean;

  constructor(options: SambaNovaAdapterOptions) {
    super(options);
    this.freeTierConfirmed = options.freeTierConfirmed;
  }

  protected getEndpointBaseUrl(): string {
    return SAMBANOVA_BASE_URL;
  }

  protected getCapabilitySource(): string {
    return 'sambanova_v1_models_api';
  }

  protected getAdapterNotes(): string {
    return this.freeTierConfirmed
      ? 'SambaNova Cloud permanent Free Tier verified (no payment card / trial credits linked).'
      : 'Confirm SAMBANOVA_FREE_TIER_CONFIRMED=true after verifying account uses Free Tier without linked payment card.';
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'SAMBANOVA_API_KEY is not configured.' };
    }
    const probe = await this.performHealthProbe();
    if (!probe.valid) return probe;
    return {
      valid: true,
      reason: this.freeTierConfirmed
        ? 'SambaNova key valid and Free Tier confirmed.'
        : 'SambaNova key valid; confirm SAMBANOVA_FREE_TIER_CONFIRMED=true to exclude trial/card tiers.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${SAMBANOVA_BASE_URL}/models`;
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

    const payload = (await res.json()) as { data?: SambaNovaModelEntry[] };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    return entries
      .filter((e) => e.id && !isNonChatSambaNovaModel(e.id))
      .map((entry) => {
        const contextWindow =
          typeof entry.context_length === 'number' && entry.context_length > 0
            ? entry.context_length
            : 0;
        const maxOutput =
          typeof entry.max_completion_tokens === 'number' && entry.max_completion_tokens > 0
            ? entry.max_completion_tokens
            : Math.min(contextWindow || 8192, 8192);
        const inputPrice = Number(entry.pricing?.prompt ?? 0);
        const outputPrice = Number(entry.pricing?.completion ?? 0);
        const zeroPriced = Number.isFinite(inputPrice) && Number.isFinite(outputPrice) && inputPrice === 0 && outputPrice === 0;
        const verified = this.freeTierConfirmed && zeroPriced && contextWindow > 0;
        const lower = entry.id.toLowerCase();
        const supportsTools = !lower.includes('deepseek-r1-distill-llama-8b');

        return {
          id: entry.id,
          canonicalId: `${this.id}:${entry.id}`,
          providerId: this.id,
          displayName: `${entry.id} (SambaNova)`,
          contextWindow,
          providerInputLimit: contextWindow || null,
          accountFreeInputLimit: contextWindow || null,
          effectiveContextWindow: computeEffectiveContextWindow({ advertisedContextWindow: contextWindow }),
          maxOutputTokens: maxOutput,
          inputPrice: Number.isFinite(inputPrice) ? inputPrice : 0,
          outputPrice: Number.isFinite(outputPrice) ? outputPrice : 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility: !zeroPriced
            ? 'PAID'
            : verified
              ? 'FREE_VERIFIED'
              : this.freeTierConfirmed
                ? 'FREE_UNVERIFIED'
                : 'TRIAL_ONLY',
          freeTierType: !zeroPriced
            ? 'PAID'
            : verified
              ? 'FREE_TIER_RATE_LIMITED'
              : this.freeTierConfirmed
                ? 'UNVERIFIED'
                : 'TRIAL_CREDITS',
          billingRequired: !zeroPriced,
          promotionalCredits: !this.freeTierConfirmed,
          freeVerifiedAt: verified ? nowIso : null,
          verificationExpiresAt: verified ? expiresIso : null,
          freeVerificationSource: verified
            ? 'sambanova_models_api_free_tier_confirmed'
            : 'sambanova_free_tier_unconfirmed',
          supportsStreaming: true,
          supportsTools,
          supportsVision: lower.includes('vision') || lower.includes('maverick') || lower.includes('vl'),
          supportsJsonMode: true,
          supportsReasoning: lower.includes('deepseek-r1') || lower.includes('qwen3') || lower.includes('gpt-oss'),
          codingCapability: inferCodingCapabilityTier(entry.id, supportsTools),
          availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            rpmLimit: 20,
            notes: 'SambaNova Cloud permanent Free Tier (~20 RPM / ~200K TPD, no card linked).',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: SAMBANOVA_BASE_URL,
        };
      });
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const eligible = this.freeTierConfirmed && model.inputPrice === 0 && model.outputPrice === 0 && model.contextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: eligible ? 'FREE_VERIFIED' : this.freeTierConfirmed ? 'FREE_UNVERIFIED' : 'TRIAL_ONLY',
      freeTierType: eligible ? 'FREE_TIER_RATE_LIMITED' : 'TRIAL_CREDITS',
      billingRequired: model.inputPrice > 0 || model.outputPrice > 0,
      promotionalCredits: !this.freeTierConfirmed,
      verifiedAt: nowIso,
      expiresAt: eligible ? new Date(Date.now() + this.verificationTtlMs).toISOString() : null,
      source: eligible ? 'sambanova_models_api_free_tier_confirmed' : 'sambanova_free_tier_unconfirmed',
      reason: eligible
        ? 'SambaNova Free Tier (no card/trial credits) verified.'
        : 'Confirm SAMBANOVA_FREE_TIER_CONFIRMED=true after verifying account uses Free Tier with no linked card.',
    };
  }
}
