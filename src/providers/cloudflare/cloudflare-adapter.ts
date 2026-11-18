import { computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import {
  OpenAICompatProviderBase,
  type OpenAICompatAdapterBaseOptions,
} from '../base/openai-compat-adapter-base.js';
import type { FreeEligibilityVerification } from '../base/types.js';

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const SAFE_ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

interface CloudflareModelEntry {
  id: string;
  name?: string;
  description?: string;
  task?: { name?: string };
  context_length?: number | null;
  max_output_tokens?: number | null;
  properties?: Array<{ property_id?: string; property?: string; value?: string | number }>;
}

export interface CloudflareAdapterOptions extends OpenAICompatAdapterBaseOptions {
  apiToken: string;
  accountId: string;
  freePlanConfirmed: boolean;
}

function readCloudflareContext(entry: CloudflareModelEntry): number {
  if (typeof entry.context_length === 'number' && entry.context_length > 0) {
    return entry.context_length;
  }
  const prop = entry.properties?.find(
    (p) =>
      p.property_id === 'context_length' ||
      p.property_id === 'max_context_length' ||
      p.property === 'context_length'
  );
  if (prop?.value !== undefined) {
    const parsed = Number.parseInt(String(prop.value), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function readCloudflareMaxOutput(entry: CloudflareModelEntry, contextWindow: number): number {
  if (typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0) {
    return entry.max_output_tokens;
  }
  const prop = entry.properties?.find(
    (p) => p.property_id === 'max_output_tokens' || p.property === 'max_tokens'
  );
  if (prop?.value !== undefined) {
    const parsed = Number.parseInt(String(prop.value), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Math.min(contextWindow || 4096, 8192);
}

/**
 * Adapter for Cloudflare Workers AI OpenAI-compatible API (10,000 Neurons/day Workers Free plan).
 */
export class CloudflareAdapter extends OpenAICompatProviderBase {
  public readonly id = 'cloudflare';
  public readonly displayName = 'Cloudflare Workers AI';

  private readonly accountId: string;
  private readonly freePlanConfirmed: boolean;

  constructor(options: CloudflareAdapterOptions) {
    super({
      apiKey: options.apiToken,
      enabled: options.enabled,
      fetchFn: options.fetchFn,
      verificationTtlMs: options.verificationTtlMs,
    });
    this.accountId = options.accountId.trim();
    this.freePlanConfirmed = options.freePlanConfirmed;
  }

  public override isConfigured(): boolean {
    return this.apiKey.length > 0 && SAFE_ACCOUNT_ID_RE.test(this.accountId);
  }

  protected getEndpointBaseUrl(): string {
    if (!SAFE_ACCOUNT_ID_RE.test(this.accountId)) {
      return `${CLOUDFLARE_API_ORIGIN}/accounts/{accountId}/ai/v1`;
    }
    return `${CLOUDFLARE_API_ORIGIN}/accounts/${encodeURIComponent(this.accountId)}/ai/v1`;
  }

  private getModelsSearchUrl(perPage = 100): string {
    return `${CLOUDFLARE_API_ORIGIN}/accounts/${encodeURIComponent(this.accountId)}/ai/models/search?task=Text%20Generation&per_page=${perPage}`;
  }

  protected getCapabilitySource(): string {
    return 'cloudflare_workers_ai_catalog';
  }

  protected getAdapterNotes(): string {
    return this.freePlanConfirmed
      ? 'Cloudflare Workers Free Plan verified (10,000 free Neurons/day, hard-capped at 0 cost).'
      : 'Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and CLOUDFLARE_FREE_PLAN_CONFIRMED=true (Workers Free plan only, no paid overage).';
  }

  protected override async performHealthProbe(
    signal?: AbortSignal
  ): Promise<{ valid: boolean; reason: string }> {
    if (!SAFE_ACCOUNT_ID_RE.test(this.accountId)) {
      return { valid: false, reason: 'Invalid or missing CLOUDFLARE_ACCOUNT_ID.' };
    }
    const url = this.getModelsSearchUrl(1);
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      return { valid: false, reason: `Cloudflare Workers AI returned HTTP ${res.status}` };
    }
    return { valid: true, reason: 'Cloudflare Workers AI account reachable.' };
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'CLOUDFLARE_API_TOKEN and valid CLOUDFLARE_ACCOUNT_ID are required.' };
    }
    const probe = await this.performHealthProbe();
    if (!probe.valid) return probe;
    return {
      valid: true,
      reason: this.freePlanConfirmed
        ? 'Cloudflare Workers AI credentials valid and Workers Free plan confirmed.'
        : 'Cloudflare credentials valid; confirm CLOUDFLARE_FREE_PLAN_CONFIRMED=true (Workers Free plan only).',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = this.getModelsSearchUrl(100);
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

    const payload = (await res.json()) as { result?: CloudflareModelEntry[] };
    const entries = Array.isArray(payload.result) ? payload.result : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    return entries
      .filter((e) => {
        const modelRef = e.name ?? e.id;
        return typeof modelRef === 'string' && (modelRef.startsWith('@cf/') || modelRef.startsWith('@hf/'));
      })
      .map((entry) => {
        const modelId = entry.name?.startsWith('@') ? entry.name : entry.id;
        const contextWindow = readCloudflareContext(entry);
        const maxOutput = readCloudflareMaxOutput(entry, contextWindow);
        const verified = this.freePlanConfirmed && contextWindow > 0;
        const lower = modelId.toLowerCase();
        const supportsTools =
          lower.includes('llama-3.3') ||
          lower.includes('llama-4') ||
          lower.includes('qwen') ||
          lower.includes('gpt-oss') ||
          lower.includes('deepseek-v');

        return {
          id: modelId,
          canonicalId: `${this.id}:${modelId}`,
          providerId: this.id,
          displayName: `${modelId} (Cloudflare)`,
          contextWindow,
          providerInputLimit: contextWindow || null,
          accountFreeInputLimit: contextWindow || null,
          effectiveContextWindow: computeEffectiveContextWindow({ advertisedContextWindow: contextWindow }),
          maxOutputTokens: maxOutput,
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
            ? 'cloudflare_workers_free_plan_confirmed'
            : 'cloudflare_free_plan_unconfirmed',
          supportsStreaming: true,
          supportsTools,
          supportsVision: lower.includes('vision') || lower.includes('scout') || lower.includes('gemma'),
          supportsJsonMode: true,
          supportsReasoning: lower.includes('deepseek-r1') || lower.includes('qwq') || lower.includes('gpt-oss') || lower.includes('qwen3'),
          codingCapability: inferCodingCapabilityTier(modelId, supportsTools),
          availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            notes: 'Cloudflare Workers Free Plan: 10,000 Neurons/day hard cap resetting at 00:00 UTC.',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: this.getEndpointBaseUrl(),
        };
      });
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
      source: eligible ? 'cloudflare_workers_free_plan_confirmed' : 'cloudflare_free_plan_unconfirmed',
      reason: eligible
        ? 'Cloudflare Workers Free Plan (10,000 Neurons/day) verified.'
        : 'Confirm CLOUDFLARE_FREE_PLAN_CONFIRMED=true after verifying Workers Free Plan (no paid overage billing).',
    };
  }
}
