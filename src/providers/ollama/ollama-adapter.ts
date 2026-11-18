import { computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import {
  assertResolvedEndpointSafe,
  isLoopbackHostname,
  validateProviderBaseUrl,
} from '../../security/ssrf.js';
import {
  OpenAICompatProviderBase,
  type OpenAICompatAdapterBaseOptions,
} from '../base/openai-compat-adapter-base.js';
import type { FreeEligibilityVerification } from '../base/types.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

interface OllamaTagsEntry {
  name?: string;
  model?: string;
  remote_model?: string;
  remote_host?: string;
}

interface OllamaShowResponse {
  parameters?: string;
  model_info?: Record<string, unknown>;
  capabilities?: string[];
}

export interface OllamaAdapterOptions extends OpenAICompatAdapterBaseOptions {
  baseUrl?: string;
  enabled?: boolean;
}

function normalizeOllamaOrigin(rawUrl: string): string {
  return rawUrl.trim().replace(/\/v1\/?$/i, '').replace(/\/$/, '') || DEFAULT_OLLAMA_BASE_URL;
}

function isCloudRelayModel(entry: OllamaTagsEntry, modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return Boolean(
    entry.remote_host ||
      entry.remote_model ||
      lower.includes(':cloud') ||
      lower.endsWith('-cloud')
  );
}

function extractContextFromShow(show: OllamaShowResponse | null): {
  archContext: number;
  configuredNumCtx: number | null;
} {
  if (!show) return { archContext: 0, configuredNumCtx: null };

  let archContext = 0;
  if (show.model_info && typeof show.model_info === 'object') {
    for (const [key, value] of Object.entries(show.model_info)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
        archContext = Math.max(archContext, value);
      }
    }
  }

  let configuredNumCtx: number | null = null;
  if (typeof show.parameters === 'string') {
    const match = show.parameters.match(/\bnum_ctx\s+(\d+)/);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        configuredNumCtx = parsed;
      }
    }
  }

  return { archContext, configuredNumCtx };
}

/**
 * Adapter for strictly local Ollama hardware models (rejects paid :cloud relays).
 */
export class OllamaAdapter extends OpenAICompatProviderBase {
  public readonly id = 'ollama';
  public readonly displayName = 'Local Ollama';

  private readonly originUrl: string;
  private readonly loopbackVerified: boolean;

  constructor(options: OllamaAdapterOptions = {}) {
    const normalizedOrigin = normalizeOllamaOrigin(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    let loopback = false;
    try {
      const parsed = validateProviderBaseUrl(normalizedOrigin, { allowLoopback: true });
      loopback = isLoopbackHostname(parsed.hostname);
    } catch {
      loopback = false;
    }

    super({
      apiKey: options.apiKey,
      enabled: options.enabled ?? false,
      fetchFn: options.fetchFn,
      verificationTtlMs: options.verificationTtlMs,
    });
    this.originUrl = normalizedOrigin;
    this.loopbackVerified = loopback;
  }

  public override isConfigured(): boolean {
    return this.originUrl.length > 0 && this.loopbackVerified;
  }

  protected override allowLoopbackEndpoint(): boolean {
    return true;
  }

  protected getEndpointBaseUrl(): string {
    return `${this.originUrl}/v1`;
  }

  protected getCapabilitySource(): string {
    return 'ollama_local_api_show';
  }

  protected getAdapterNotes(): string {
    if (!this.loopbackVerified) {
      return 'Ollama endpoint must resolve to localhost/loopback for zero-cost local hardware verification.';
    }
    return this.enabledFlag
      ? `Local Ollama (${this.originUrl}) active; strictly excludes paid :cloud models.`
      : `Local Ollama (${this.originUrl}) disabled; enable OLLAMA_ENABLED=true or toggle on for zero-cost local fallback.`;
  }

  protected override async performHealthProbe(
    signal?: AbortSignal
  ): Promise<{ valid: boolean; reason: string }> {
    if (!this.loopbackVerified) {
      return { valid: false, reason: 'Ollama must target localhost/loopback.' };
    }
    const url = `${this.originUrl}/api/tags`;
    await assertResolvedEndpointSafe(url, { allowLoopback: true });
    const res = await this.fetchFn(url, { method: 'GET', signal });
    if (!res.ok) {
      return { valid: false, reason: `Local Ollama returned HTTP ${res.status}` };
    }
    return { valid: true, reason: `Local Ollama reachable at ${this.originUrl}.` };
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.loopbackVerified) {
      return { valid: false, reason: 'Ollama base URL must be loopback (127.0.0.1 / localhost).' };
    }
    return this.performHealthProbe();
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const tagsUrl = `${this.originUrl}/api/tags`;
    await assertResolvedEndpointSafe(tagsUrl, { allowLoopback: true });
    const tagsRes = await this.fetchFn(tagsUrl, { method: 'GET', signal });
    if (!tagsRes.ok) {
      const bodyText = await tagsRes.text().catch(() => '');
      throw new Error(
        this.normalizeError(new Error(`HTTP ${tagsRes.status}`), tagsRes.status, tagsRes.headers, bodyText).message
      );
    }

    const tagsPayload = (await tagsRes.json()) as { models?: OllamaTagsEntry[] };
    const entries = Array.isArray(tagsPayload.models) ? tagsPayload.models : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    const showUrl = `${this.originUrl}/api/show`;
    const records: ModelRecord[] = [];

    const inspected = await Promise.allSettled(
      entries.map(async (entry) => {
        const modelId = (entry.name ?? entry.model ?? '').trim();
        if (!modelId) return null;

        if (isCloudRelayModel(entry, modelId)) {
          return {
            entry,
            modelId,
            cloudPaid: true,
            show: null as OllamaShowResponse | null,
          };
        }

        const showRes = await this.fetchFn(showUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
          signal,
        });
        const show = showRes.ok ? ((await showRes.json()) as OllamaShowResponse) : null;
        return { entry, modelId, cloudPaid: false, show };
      })
    );

    for (const item of inspected) {
      if (item.status !== 'fulfilled' || !item.value) continue;
      const { modelId, cloudPaid, show } = item.value;

      if (cloudPaid) {
        records.push({
          id: modelId,
          canonicalId: `${this.id}:${modelId}`,
          providerId: this.id,
          displayName: `${modelId} (Ollama Cloud - Excluded)`,
          contextWindow: 0,
          providerInputLimit: null,
          accountFreeInputLimit: null,
          effectiveContextWindow: 0,
          maxOutputTokens: 0,
          inputPrice: 0,
          outputPrice: 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility: 'PAID',
          freeTierType: 'PAID',
          billingRequired: true,
          promotionalCredits: false,
          freeVerifiedAt: null,
          verificationExpiresAt: null,
          freeVerificationSource: 'ollama_cloud_paid_model_rejected',
          supportsStreaming: true,
          supportsTools: false,
          supportsVision: false,
          supportsJsonMode: false,
          supportsReasoning: false,
          codingCapability: 'low',
          availabilityStatus: 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: { notes: 'Ollama Cloud models require pay-as-you-go billing and are excluded.' },
          providerEnabled: this.isEnabled(),
          endpointUrl: this.getEndpointBaseUrl(),
        });
        continue;
      }

      const caps = Array.isArray(show?.capabilities) ? show.capabilities : [];
      if (caps.includes('embedding') && !caps.includes('completion') && !caps.includes('chat')) {
        continue;
      }

      const { archContext, configuredNumCtx } = extractContextFromShow(show);
      const effectiveCtx = computeEffectiveContextWindow({
        advertisedContextWindow: archContext,
        providerInputLimit: configuredNumCtx,
      });
      const verified = this.loopbackVerified && effectiveCtx > 0;
      const supportsTools = caps.includes('tools');
      const supportsVision = caps.includes('vision');
      const supportsReasoning = caps.includes('thinking') || modelId.toLowerCase().includes('deepseek-r1') || modelId.toLowerCase().includes('qwen3');

      records.push({
        id: modelId,
        canonicalId: `${this.id}:${modelId}`,
        providerId: this.id,
        displayName: `${modelId} (Local Ollama)`,
        contextWindow: archContext,
        providerInputLimit: configuredNumCtx ?? (archContext || null),
        accountFreeInputLimit: effectiveCtx || null,
        effectiveContextWindow: effectiveCtx,
        maxOutputTokens: Math.min(effectiveCtx || 4096, 8192),
        inputPrice: 0,
        outputPrice: 0,
        requestPrice: 0,
        imagePrice: 0,
        freeEligibility: verified ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
        freeTierType: verified ? 'PERMANENT_FREE' : 'UNVERIFIED',
        billingRequired: false,
        promotionalCredits: false,
        freeVerifiedAt: verified ? nowIso : null,
        verificationExpiresAt: verified ? expiresIso : null,
        freeVerificationSource: verified ? 'ollama_local_hardware_zero_cost' : 'ollama_missing_context_metadata',
        supportsStreaming: true,
        supportsTools,
        supportsVision,
        supportsJsonMode: true,
        supportsReasoning,
        codingCapability: inferCodingCapabilityTier(modelId, supportsTools),
        availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
        lastCheckedAt: nowIso,
        quotaInfo: { notes: 'Local hardware execution via Ollama (zero API cost).' },
        providerEnabled: this.isEnabled(),
        endpointUrl: this.getEndpointBaseUrl(),
      });
    }

    return records;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const isCloud = model.id.toLowerCase().includes(':cloud') || model.id.toLowerCase().endsWith('-cloud');
    const eligible = this.loopbackVerified && !isCloud && model.effectiveContextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: isCloud ? 'PAID' : eligible ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
      freeTierType: isCloud ? 'PAID' : eligible ? 'PERMANENT_FREE' : 'UNVERIFIED',
      billingRequired: isCloud,
      promotionalCredits: false,
      verifiedAt: nowIso,
      expiresAt: eligible ? new Date(Date.now() + this.verificationTtlMs).toISOString() : null,
      source: eligible ? 'ollama_local_hardware_zero_cost' : 'ollama_unverified_or_cloud',
      reason: isCloud
        ? 'Ollama :cloud models require paid usage billing and are blocked.'
        : eligible
          ? 'Local Ollama model running on localhost hardware at zero API cost.'
          : 'Requires localhost Ollama endpoint and verified model context metadata.',
    };
  }
}
