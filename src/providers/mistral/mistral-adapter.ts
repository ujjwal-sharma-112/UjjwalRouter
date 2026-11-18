import crypto from 'node:crypto';
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

export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

const MISTRAL_TOOL_ID_RE = /^[A-Za-z0-9]{9}$/;
const MISTRAL_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface MistralModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  max_context_length?: number;
  deprecation?: string | null;
  deprecate?: boolean;
  capabilities?: {
    completion_chat?: boolean;
    function_calling?: boolean;
    vision?: boolean;
    classification?: boolean;
  };
}

export interface MistralAdapterOptions extends OpenAICompatAdapterBaseOptions {
  apiKey: string;
  freePlanConfirmed: boolean;
}

/**
 * Mistral rejects tool call IDs outside ^[A-Za-z0-9]{9}$. Maps arbitrary cross-provider
 * IDs deterministically so multi-turn assistant/tool pairs always agree.
 */
export function normalizeMistralToolCallId(rawId: string): string {
  if (MISTRAL_TOOL_ID_RE.test(rawId)) return rawId;
  const hash = crypto.createHash('sha256').update(rawId).digest();
  let num = hash.readBigUInt64BE(0);
  let out = '';
  for (let i = 0; i < 9; i += 1) {
    const rem = Number(num % 62n);
    num /= 62n;
    out += MISTRAL_ID_ALPHABET[rem] ?? '0';
  }
  return out;
}

function isNonChatMistralModel(entry: MistralModelEntry): boolean {
  const lower = entry.id.toLowerCase();
  if (entry.deprecate || entry.deprecation) return true;
  if (entry.capabilities && entry.capabilities.completion_chat === false) return true;
  return (
    lower.includes('embed') ||
    lower.includes('moderation') ||
    lower.includes('ocr') ||
    lower.includes('voxtral')
  );
}

/**
 * Adapter for Mistral AI La Plateforme Experiment (Free) Plan (api.mistral.ai/v1).
 */
export class MistralAdapter extends OpenAICompatProviderBase {
  public readonly id = 'mistral';
  public readonly displayName = 'Mistral AI';

  private readonly freePlanConfirmed: boolean;

  constructor(options: MistralAdapterOptions) {
    super(options);
    this.freePlanConfirmed = options.freePlanConfirmed;
  }

  protected getEndpointBaseUrl(): string {
    return MISTRAL_BASE_URL;
  }

  protected getCapabilitySource(): string {
    return 'mistral_v1_models_api';
  }

  protected getAdapterNotes(): string {
    return this.freePlanConfirmed
      ? 'Mistral Experiment/Free Plan verified (~1 RPS rate-limited, no billing attached).'
      : 'Mistral Experiment/Free Plan needs no billing card; confirm MISTRAL_FREE_PLAN_CONFIRMED=true in .env or Dashboard.';
  }

  protected override prepareChatRequest(
    _model: ModelRecord,
    request: NormalizedChatRequest
  ): NormalizedChatRequest {
    const hasNonMistralIds = request.messages.some(
      (msg) =>
        (msg.tool_call_id && !MISTRAL_TOOL_ID_RE.test(msg.tool_call_id)) ||
        (Array.isArray(msg.tool_calls) && msg.tool_calls.some((tc) => !MISTRAL_TOOL_ID_RE.test(tc.id)))
    );
    if (!hasNonMistralIds) return request;

    return {
      ...request,
      messages: request.messages.map((msg) => ({
        ...msg,
        ...(msg.tool_call_id ? { tool_call_id: normalizeMistralToolCallId(msg.tool_call_id) } : {}),
        ...(Array.isArray(msg.tool_calls)
          ? {
              tool_calls: msg.tool_calls.map((tc) => ({
                ...tc,
                id: normalizeMistralToolCallId(tc.id),
              })),
            }
          : {}),
      })),
    };
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'MISTRAL_API_KEY is not configured.' };
    }
    const probe = await this.performHealthProbe();
    if (!probe.valid) return probe;
    return {
      valid: true,
      reason: this.freePlanConfirmed
        ? 'Mistral key valid and Free/Experiment Plan confirmed.'
        : 'Mistral key valid; confirm MISTRAL_FREE_PLAN_CONFIRMED=true to activate under STRICT_FREE_ONLY.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const url = `${MISTRAL_BASE_URL}/models`;
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

    const payload = (await res.json()) as { data?: MistralModelEntry[] };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    const seen = new Set<string>();
    const records: ModelRecord[] = [];
    for (const entry of entries) {
      if (!entry.id || seen.has(entry.id) || isNonChatMistralModel(entry)) continue;
      seen.add(entry.id);

      const contextWindow =
        typeof entry.max_context_length === 'number' && entry.max_context_length > 0
          ? entry.max_context_length
          : 0;
      const verified = this.freePlanConfirmed && contextWindow > 0;
      const supportsTools = entry.capabilities?.function_calling ?? true;
      const supportsVision = entry.capabilities?.vision ?? entry.id.toLowerCase().includes('pixtral');
      const lower = entry.id.toLowerCase();

      records.push({
        id: entry.id,
        canonicalId: `${this.id}:${entry.id}`,
        providerId: this.id,
        displayName: `${entry.id} (Mistral)`,
        contextWindow,
        providerInputLimit: contextWindow || null,
        accountFreeInputLimit: contextWindow || null,
        effectiveContextWindow: computeEffectiveContextWindow({ advertisedContextWindow: contextWindow }),
        maxOutputTokens: Math.min(contextWindow || 8192, 32_768),
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
          ? 'mistral_models_api_free_plan_confirmed'
          : 'mistral_free_plan_unconfirmed',
        supportsStreaming: true,
        supportsTools,
        supportsVision,
        supportsJsonMode: true,
        supportsReasoning: lower.includes('magistral') || lower.includes('reasoning'),
        codingCapability: inferCodingCapabilityTier(entry.id, supportsTools),
        availabilityStatus: verified ? 'AVAILABLE' : 'UNAVAILABLE',
        lastCheckedAt: nowIso,
        quotaInfo: {
          rpmLimit: 30,
          notes: 'Mistral Free Experiment Plan (~1 RPS, monthly token allowance, no card required).',
        },
        providerEnabled: this.isEnabled(),
        endpointUrl: MISTRAL_BASE_URL,
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
      source: eligible ? 'mistral_models_api_free_plan_confirmed' : 'mistral_free_plan_unconfirmed',
      reason: eligible
        ? 'Mistral Experiment/Free Plan verified without billing.'
        : 'Confirm MISTRAL_FREE_PLAN_CONFIRMED=true in .env or Dashboard (Experiment plan requires no billing card).',
    };
  }
}
