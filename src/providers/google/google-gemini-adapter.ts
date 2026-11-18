import crypto from 'node:crypto';
import { buildContextCapabilityDetails, computeEffectiveContextWindow } from '../../core/capabilities/context-limits.js';
import type { FreeEligibilityStatus, ModelRecord } from '../../core/policy/types.js';
import { computeOutboundMaxTokens } from '../../core/context/context-manager.js';
import { inferCodingCapabilityTier } from '../../core/router/intelligence-scorer.js';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import type { ProviderAdapter, ProviderExecutionOptions } from '../base/provider-adapter.js';
import {
  createStallAndRequestSignal,
  detectStandardQuotaExhaustion,
  normalizeStandardHttpError,
  parseRateLimitHeaders,
  parseSseEvents,
  type FetchLike,
} from '../base/openai-compat-base.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ChatMessage,
  ContentPart,
  ContextCapabilityDetails,
  FinishReason,
  FreeEligibilityVerification,
  NormalizedChatRequest,
  NormalizedProviderError,
  ProviderAdapterInfo,
  ProviderHealthResult,
  RateLimitObservation,
  StreamToolCallDelta,
  TokenUsage,
  ToolCall,
} from '../base/types.js';

export const GOOGLE_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = 'skip_thought_signature_validator';
const MAX_CACHED_SIGNATURES = 10_000;

interface GeminiModelMetadata {
  name: string; // e.g. "models/gemini-2.5-flash"
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

export interface GoogleGeminiAdapterOptions {
  apiKey: string;
  projectNoBillingConfirmed: boolean;
  enabled?: boolean;
  fetchFn?: FetchLike;
  verificationTtlMs?: number;
}

type GeminiModelTierClassification = 'FREE_ELIGIBLE' | 'PAID_ONLY' | 'UNVERIFIED';

function stripModelPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

export function classifyGeminiFreeTierModel(modelId: string): GeminiModelTierClassification {
  const lower = stripModelPrefix(modelId).toLowerCase();

  // Explicit paid-only or non-free specialized models in Google AI Studio
  if (
    lower.includes('pro') ||
    lower.includes('ultra') ||
    lower.includes('imagen') ||
    lower.includes('veo') ||
    lower.includes('image') ||
    lower.includes('lyria') ||
    lower.includes('robotics') ||
    lower.includes('computer-use') ||
    lower.includes('deep-research') ||
    lower.includes('aqa') ||
    lower.includes('tts')
  ) {
    return 'PAID_ONLY';
  }

  // Google AI Studio Free Tier eligible models: Gemini Flash, Flash-Lite, and Gemma open models
  if (/^gemini-[0-9.]+-flash(-lite)?/.test(lower) || /^gemini-flash/.test(lower) || /^gemma-/.test(lower)) {
    return 'FREE_ELIGIBLE';
  }

  return 'UNVERIFIED';
}

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === '$schema' || key === 'additionalProperties' || key === '$defs' || key === 'strict') {
      continue;
    }
    output[key] = sanitizeSchemaForGemini(value);
  }
  return output;
}

function extractTextFromContent(content: string | ContentPart[] | null): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function convertMessagePartsToGemini(content: string | ContentPart[] | null): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text });
    } else if (part.type === 'image_url') {
      const url = part.image_url.url;
      const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
      if (dataMatch?.[1] && dataMatch[2]) {
        parts.push({
          inlineData: {
            mimeType: dataMatch[1],
            data: dataMatch[2],
          },
        });
      }
    }
  }
  return parts;
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function hasFunctionResponsePart(content: { parts: Array<Record<string, unknown>> }): boolean {
  return content.parts.some((part) => 'functionResponse' in part);
}

function mergeAlternatingContents(
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>
): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  const merged: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  for (const item of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === item.role) {
      if (item.role === 'user' && hasFunctionResponsePart(prev) !== hasFunctionResponsePart(item)) {
        merged.push({
          role: 'model',
          parts: [{ text: '[The previous turn was interrupted before completion.]' }],
        });
        merged.push({ role: item.role, parts: [...item.parts] });
      } else {
        prev.parts.push(...item.parts);
      }
    } else {
      merged.push({ role: item.role, parts: [...item.parts] });
    }
  }
  return merged;
}

function extractInlineToolCallSignature(tc: ToolCall): string | undefined {
  if (typeof tc.thought_signature === 'string' && tc.thought_signature) {
    return tc.thought_signature;
  }
  const fnExtra = (tc.function as { thought_signature?: unknown } | undefined)?.thought_signature;
  if (typeof fnExtra === 'string' && fnExtra) {
    return fnExtra;
  }
  const extra = tc.extra_content;
  if (extra && typeof extra === 'object') {
    const google = extra.google;
    if (google && typeof google === 'object') {
      const gRec = google as Record<string, unknown>;
      if (typeof gRec.thought_signature === 'string' && gRec.thought_signature) {
        return gRec.thought_signature;
      }
      if (typeof gRec.thoughtSignature === 'string' && gRec.thoughtSignature) {
        return gRec.thoughtSignature;
      }
    }
    if (typeof extra.thought_signature === 'string' && extra.thought_signature) {
      return extra.thought_signature;
    }
  }
  return undefined;
}

function mapGeminiFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

export class GoogleGeminiAdapter implements ProviderAdapter {
  public readonly id = 'google';
  public readonly displayName = 'Google Gemini';

  private readonly apiKey: string;
  private readonly projectNoBillingConfirmed: boolean;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;
  private readonly verificationTtlMs: number;
  // Restores real Gemini thoughtSignature values when OpenAI-compatible clients strip extra_content on virtual profiles like "auto"
  private readonly thoughtSignatureCache = new Map<string, string>();

  constructor(options: GoogleGeminiAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    this.projectNoBillingConfirmed = options.projectNoBillingConfirmed;
    this.enabled = options.enabled ?? this.apiKey.length > 0;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.verificationTtlMs = options.verificationTtlMs ?? 3_600_000;
  }

  private rememberThoughtSignature(callId: string, signature: string | undefined): void {
    if (!callId || !signature) return;
    if (this.thoughtSignatureCache.has(callId)) {
      this.thoughtSignatureCache.delete(callId);
    } else if (this.thoughtSignatureCache.size >= MAX_CACHED_SIGNATURES) {
      const oldestKey = this.thoughtSignatureCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.thoughtSignatureCache.delete(oldestKey);
      }
    }
    this.thoughtSignatureCache.set(callId, signature);
  }

  private resolveThoughtSignature(tc: ToolCall): string | undefined {
    const inline = extractInlineToolCallSignature(tc);
    if (inline) return inline;
    if (tc.id) {
      return this.thoughtSignatureCache.get(tc.id);
    }
    return undefined;
  }

  public getInfo(): ProviderAdapterInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      endpointUrl: GOOGLE_GEMINI_BASE_URL,
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: true,
      notes: this.projectNoBillingConfirmed
        ? 'Google AI Studio non-billing Free Tier confirmed; paid-only Pro/media models excluded.'
        : 'Requires GOOGLE_PROJECT_NO_BILLING=true confirmation that the AI Studio project has no billing account linked.',
    };
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public isEnabled(): boolean {
    return this.enabled && this.isConfigured();
  }

  private getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-goog-api-key': this.apiKey,
    };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  public async validateAuthentication(): Promise<{ valid: boolean; reason: string }> {
    if (!this.isConfigured()) {
      return { valid: false, reason: 'GOOGLE_API_KEY is not configured.' };
    }
    const url = `${GOOGLE_GEMINI_BASE_URL}/models?pageSize=5`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      return { valid: false, reason: `Gemini API key check failed (HTTP ${res.status}).` };
    }
    return {
      valid: true,
      reason: this.projectNoBillingConfirmed
        ? 'Gemini API key valid and project non-billing Free Tier confirmed.'
        : 'Gemini API key valid; awaiting GOOGLE_PROJECT_NO_BILLING=true verification.',
    };
  }

  public async discoverModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    if (!this.isEnabled()) return [];

    const collected: GeminiModelMetadata[] = [];
    let pageToken: string | undefined;

    do {
      const qs = new URLSearchParams({ pageSize: '100' });
      if (pageToken) qs.set('pageToken', pageToken);
      const url = `${GOOGLE_GEMINI_BASE_URL}/models?${qs.toString()}`;
      await assertResolvedEndpointSafe(url, { providerId: this.id });

      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(
          this.normalizeError(new Error(`HTTP ${response.status}`), response.status, response.headers, bodyText).message
        );
      }

      const payload = (await response.json()) as {
        models?: GeminiModelMetadata[];
        nextPageToken?: string;
      };
      if (Array.isArray(payload.models)) {
        collected.push(...payload.models);
      }
      pageToken = payload.nextPageToken;
    } while (pageToken);

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + this.verificationTtlMs).toISOString();

    return collected
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((raw) => {
        const modelId = stripModelPrefix(raw.name);
        const classification = classifyGeminiFreeTierModel(modelId);
        const inputLimit = typeof raw.inputTokenLimit === 'number' && raw.inputTokenLimit > 0 ? raw.inputTokenLimit : 0;
        const outputLimit = typeof raw.outputTokenLimit === 'number' && raw.outputTokenLimit > 0 ? raw.outputTokenLimit : 8192;

        let freeEligibility: FreeEligibilityStatus;
        let billingRequired = true;
        let verificationSource = 'gemini_models_unverified';

        if (classification === 'PAID_ONLY') {
          freeEligibility = 'PAID';
          billingRequired = true;
          verificationSource = 'gemini_paid_only_model_policy';
        } else if (!this.projectNoBillingConfirmed) {
          freeEligibility = 'FREE_UNVERIFIED';
          billingRequired = true;
          verificationSource = 'gemini_project_billing_unverified';
        } else if (classification === 'FREE_ELIGIBLE' && inputLimit > 0) {
          freeEligibility = 'FREE_VERIFIED';
          billingRequired = false;
          verificationSource = 'gemini_v1beta_models_no_billing_confirmed';
        } else {
          freeEligibility = 'FREE_UNVERIFIED';
          billingRequired = true;
          verificationSource = 'gemini_unknown_model_tier_rejected';
        }

        const isGemma = modelId.toLowerCase().startsWith('gemma');
        const isEligible = freeEligibility === 'FREE_VERIFIED';

        return {
          id: modelId,
          canonicalId: `${this.id}:${modelId}`,
          providerId: this.id,
          displayName: raw.displayName ?? modelId,
          contextWindow: inputLimit,
          providerInputLimit: inputLimit || null,
          accountFreeInputLimit: inputLimit || null,
          effectiveContextWindow: computeEffectiveContextWindow({
            advertisedContextWindow: inputLimit,
          }),
          maxOutputTokens: outputLimit,
          inputPrice: 0,
          outputPrice: 0,
          requestPrice: 0,
          imagePrice: 0,
          freeEligibility,
          freeTierType: isEligible ? 'FREE_TIER_RATE_LIMITED' : classification === 'PAID_ONLY' ? 'PAID' : 'UNVERIFIED',
          billingRequired,
          promotionalCredits: false,
          freeVerifiedAt: isEligible ? nowIso : null,
          verificationExpiresAt: isEligible ? expiresIso : null,
          freeVerificationSource: verificationSource,
          supportsStreaming: true,
          supportsTools: !isGemma,
          supportsVision: !isGemma,
          supportsJsonMode: !isGemma,
          supportsReasoning: Boolean(raw.thinking) || modelId.toLowerCase().includes('2.5') || modelId.toLowerCase().includes('3'),
          codingCapability: inferCodingCapabilityTier(modelId, !isGemma),
          availabilityStatus: isEligible ? 'AVAILABLE' : 'UNAVAILABLE',
          lastCheckedAt: nowIso,
          quotaInfo: {
            notes: isEligible
              ? 'Google AI Studio Free Tier (subject to per-project RPM/TPM/RPD limits).'
              : 'Excluded by STRICT_FREE_ONLY until model tier and non-billing project status are verified.',
          },
          providerEnabled: this.isEnabled(),
          endpointUrl: GOOGLE_GEMINI_BASE_URL,
        };
      });
  }

  public async getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null> {
    const models = await this.discoverModels(signal);
    const cleanId = stripModelPrefix(modelId);
    return models.find((m) => m.id === cleanId || m.canonicalId === modelId) ?? null;
  }

  public async verifyFreeEligibility(model: ModelRecord): Promise<FreeEligibilityVerification> {
    const nowIso = new Date().toISOString();
    const classification = classifyGeminiFreeTierModel(model.id);

    if (classification === 'PAID_ONLY') {
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
        source: 'gemini_paid_only_model_policy',
        reason: `Gemini model "${model.id}" is classified as paid-only in Google AI Studio.`,
      };
    }

    if (!this.projectNoBillingConfirmed) {
      return {
        providerId: this.id,
        modelId: model.id,
        eligible: false,
        freeEligibility: 'FREE_UNVERIFIED',
        freeTierType: 'UNVERIFIED',
        billingRequired: true,
        promotionalCredits: false,
        verifiedAt: nowIso,
        expiresAt: null,
        source: 'gemini_project_billing_unverified',
        reason:
          'Google AI Studio project billing status unverified. Confirm no billing is linked via GOOGLE_PROJECT_NO_BILLING=true.',
      };
    }

    const eligible = classification === 'FREE_ELIGIBLE' && model.contextWindow > 0;
    return {
      providerId: this.id,
      modelId: model.id,
      eligible,
      freeEligibility: eligible ? 'FREE_VERIFIED' : 'FREE_UNVERIFIED',
      freeTierType: eligible ? 'FREE_TIER_RATE_LIMITED' : 'UNVERIFIED',
      billingRequired: !eligible,
      promotionalCredits: false,
      verifiedAt: nowIso,
      expiresAt: eligible ? new Date(Date.now() + this.verificationTtlMs).toISOString() : null,
      source: eligible ? 'gemini_v1beta_models_no_billing_confirmed' : 'gemini_unknown_model_tier_rejected',
      reason: eligible
        ? 'Verified Gemini Free Tier eligible model on non-billed Google AI Studio project.'
        : 'Model tier could not be confirmed as free-tier eligible.',
    };
  }

  public getContextCapabilities(model: ModelRecord): ContextCapabilityDetails {
    return buildContextCapabilityDetails({
      advertisedContextWindow: model.contextWindow,
      providerInputLimit: model.providerInputLimit,
      accountFreeInputLimit: model.accountFreeInputLimit,
      maxOutputTokens: model.maxOutputTokens,
      source: 'gemini_v1beta_models_metadata',
    });
  }

  private buildGeminiPayload(model: ModelRecord, request: NormalizedChatRequest): Record<string, unknown> {
    const systemTexts: string[] = [];
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
    const toolCallIdToName = new Map<string, string>();

    for (const msg of request.messages as ChatMessage[]) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const text = extractTextFromContent(msg.content);
        if (text) systemTexts.push(text);
        continue;
      }

      if (msg.role === 'user') {
        const parts = convertMessagePartsToGemini(msg.content);
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Array<Record<string, unknown>> = [];
        const text = extractTextFromContent(msg.content);
        if (text) {
          parts.push({ text });
        }
        if (Array.isArray(msg.tool_calls)) {
          let turnHasRealSignature = false;
          for (let tcIdx = 0; tcIdx < msg.tool_calls.length; tcIdx += 1) {
            const tc = msg.tool_calls[tcIdx]!;
            if (tc.id && tc.function?.name) {
              toolCallIdToName.set(tc.id, tc.function.name);
            }
            const fcPart: Record<string, unknown> = {
              functionCall: {
                name: tc.function.name,
                args: safeParseJsonObject(tc.function.arguments ?? '{}'),
              },
            };
            const sig = this.resolveThoughtSignature(tc);
            if (sig) {
              fcPart.thoughtSignature = sig;
              turnHasRealSignature = true;
            } else if (tcIdx === 0 || !turnHasRealSignature) {
              // Cross-provider or stripped history fallback required by Gemini 2.5/3 thinking models
              fcPart.thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR;
            }
            parts.push(fcPart);
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        continue;
      }

      if (msg.role === 'tool') {
        const fnName =
          msg.name || (msg.tool_call_id ? toolCallIdToName.get(msg.tool_call_id) : undefined) || 'tool';
        const rawText = extractTextFromContent(msg.content);
        const fnResponsePart = {
          functionResponse: {
            name: fnName,
            response: {
              content: rawText,
            },
          },
        };
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && last.parts.some((p) => 'functionResponse' in p)) {
          last.parts.push(fnResponsePart);
        } else {
          contents.push({ role: 'user', parts: [fnResponsePart] });
        }
      }
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    const clampedMaxTokens = computeOutboundMaxTokens(request, model);
    if (clampedMaxTokens !== undefined) {
      generationConfig.maxOutputTokens = clampedMaxTokens;
    }
    if (request.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.seed !== undefined) generationConfig.seed = request.seed;

    if (request.response_format?.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json';
    } else if (request.response_format?.type === 'json_schema') {
      generationConfig.responseMimeType = 'application/json';
      if (request.response_format.json_schema.schema) {
        generationConfig.responseSchema = sanitizeSchemaForGemini(
          request.response_format.json_schema.schema
        );
      }
    }

    const normalizedContents = mergeAlternatingContents(contents);
    const payload: Record<string, unknown> = {
      contents:
        normalizedContents.length > 0
          ? normalizedContents
          : [{ role: 'user', parts: [{ text: '' }] }],
    };

    if (systemTexts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemTexts.join('\n\n') }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description ?? '',
            parameters: sanitizeSchemaForGemini(
              t.function.parameters ?? { type: 'object', properties: {} }
            ),
          })),
        },
      ];

      if (request.tool_choice) {
        if (request.tool_choice === 'none') {
          payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        } else if (request.tool_choice === 'required') {
          payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (request.tool_choice === 'auto') {
          payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        } else if (typeof request.tool_choice === 'object') {
          payload.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [request.tool_choice.function.name],
            },
          };
        }
      }
    }

    return payload;
  }

  public async countTokens(
    model: ModelRecord,
    request: NormalizedChatRequest,
    signal?: AbortSignal
  ): Promise<number | null> {
    if (!this.isEnabled()) return null;
    const modelId = stripModelPrefix(model.id);
    const url = `${GOOGLE_GEMINI_BASE_URL}/models/${encodeURIComponent(modelId)}:countTokens`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });

    const fullPayload = this.buildGeminiPayload(model, request);
    const countBody: Record<string, unknown> = {
      contents: fullPayload.contents,
    };
    if (fullPayload.systemInstruction) countBody.systemInstruction = fullPayload.systemInstruction;
    if (fullPayload.tools) countBody.tools = fullPayload.tools;

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: this.getHeaders('application/json'),
      body: JSON.stringify(countBody),
      signal,
    });

    if (!response.ok) return null;
    const data = (await response.json()) as { totalTokens?: number };
    return typeof data.totalTokens === 'number' ? data.totalTokens : null;
  }

  public async chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    const modelId = stripModelPrefix(model.id);
    const url = `${GOOGLE_GEMINI_BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });

    const signalCtrl = createStallAndRequestSignal(options);
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.getHeaders('application/json'),
        body: JSON.stringify(this.buildGeminiPayload(model, request)),
        signal: signalCtrl.signal,
      });
      signalCtrl.markFirstByteReceived();

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const normalized = this.normalizeError(
          new Error(`HTTP ${response.status}`),
          response.status,
          response.headers,
          bodyText
        );
        const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
        err.normalizedError = normalized;
        throw err;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const first = (candidates[0] as Record<string, unknown> | undefined) ?? {};
      const contentObj = (first.content as Record<string, unknown> | undefined) ?? {};
      const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

      const textChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const toolCalls: ToolCall[] = [];

      for (const part of parts as Array<Record<string, unknown>>) {
        if (typeof part.text === 'string') {
          if (part.thought === true) {
            reasoningChunks.push(part.text);
          } else {
            textChunks.push(part.text);
          }
        }
        if (part.functionCall && typeof part.functionCall === 'object') {
          const fc = part.functionCall as { name?: string; args?: unknown };
          const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined;
          const tc: ToolCall = {
            id: `call_gemini_${toolCalls.length}_${crypto.randomUUID().slice(0, 8)}`,
            type: 'function',
            function: {
              name: fc.name ?? 'unknown_function',
              arguments: JSON.stringify(fc.args ?? {}),
            },
          };
          if (sig) {
            this.rememberThoughtSignature(tc.id, sig);
            tc.thought_signature = sig;
            tc.extra_content = { google: { thought_signature: sig } };
          }
          toolCalls.push(tc);
        }
      }

      const usage = this.extractUsage(data) ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      const finishReason = mapGeminiFinishReason(
        typeof first.finishReason === 'string' ? first.finishReason : undefined,
        toolCalls.length > 0
      );

      return {
        id: `chatcmpl_gemini_${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.canonicalId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: textChunks.length > 0 ? textChunks.join('') : toolCalls.length > 0 ? null : '',
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              ...(reasoningChunks.length > 0 ? { reasoning_content: reasoningChunks.join('') } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage,
        rateLimitHeaders: parseRateLimitHeaders(response.headers) ?? undefined,
      };
    } finally {
      signalCtrl.cleanup();
    }
  }

  public async *streamChatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): AsyncIterable<ChatCompletionStreamChunk> {
    const modelId = stripModelPrefix(model.id);
    const url = `${GOOGLE_GEMINI_BASE_URL}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    await assertResolvedEndpointSafe(url, { providerId: this.id });

    const signalCtrl = createStallAndRequestSignal(options);
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.getHeaders('application/json'),
        body: JSON.stringify(this.buildGeminiPayload(model, request)),
        signal: signalCtrl.signal,
      });

      if (!response.ok || !response.body) {
        signalCtrl.markFirstByteReceived();
        const bodyText = await response.text().catch(() => '');
        const normalized = this.normalizeError(
          new Error(`HTTP ${response.status}`),
          response.status,
          response.headers,
          bodyText
        );
        const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
        err.normalizedError = normalized;
        throw err;
      }

      const streamId = `chatcmpl_gemini_${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      let sentRole = false;
      let emittedToolCalls = 0;
      let lastUsage: TokenUsage | null = null;
      let finalFinishReason: FinishReason = null;

      for await (const rawEvent of parseSseEvents(response.body, signalCtrl.signal)) {
        const trimmed = rawEvent.trim();
        if (!trimmed || trimmed === '[DONE]') continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (parsed.error && typeof parsed.error === 'object') {
          signalCtrl.markFirstByteReceived();
          const errObj = parsed.error as Record<string, unknown>;
          const code = Number(errObj.code ?? 502);
          const msg = String(errObj.message ?? 'Gemini stream error');
          const normalized = this.normalizeError(new Error(msg), code, undefined, msg);
          const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
          err.normalizedError = normalized;
          throw err;
        }

        const usage = this.extractUsage(parsed);
        if (usage) lastUsage = usage;

        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const first = (candidates[0] as Record<string, unknown> | undefined) ?? {};
        const contentObj = (first.content as Record<string, unknown> | undefined) ?? {};
        const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

        let deltaText = '';
        let deltaReasoning = '';
        const toolCallDeltas: StreamToolCallDelta[] = [];

        for (const part of parts as Array<Record<string, unknown>>) {
          if (typeof part.text === 'string') {
            if (part.thought === true) {
              deltaReasoning += part.text;
            } else {
              deltaText += part.text;
            }
          }
          if (part.functionCall && typeof part.functionCall === 'object') {
            const fc = part.functionCall as { name?: string; args?: unknown };
            const tcIndex = emittedToolCalls++;
            const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined;
            const tcId = `call_gemini_${tcIndex}_${crypto.randomUUID().slice(0, 8)}`;
            const tcDelta: StreamToolCallDelta = {
              index: tcIndex,
              id: tcId,
              type: 'function',
              function: {
                name: fc.name ?? 'unknown_function',
                arguments: JSON.stringify(fc.args ?? {}),
              },
            };
            if (sig) {
              this.rememberThoughtSignature(tcId, sig);
              tcDelta.thought_signature = sig;
              tcDelta.extra_content = { google: { thought_signature: sig } };
            }
            toolCallDeltas.push(tcDelta);
          }
        }

        if (typeof first.finishReason === 'string') {
          finalFinishReason = mapGeminiFinishReason(first.finishReason, emittedToolCalls > 0);
        }

        if (deltaText || deltaReasoning || toolCallDeltas.length > 0 || finalFinishReason) {
          signalCtrl.markFirstByteReceived();
          const delta: ChatCompletionStreamChunk['choices'][number]['delta'] = {};
          if (!sentRole) {
            delta.role = 'assistant';
            sentRole = true;
          }
          if (deltaText) delta.content = deltaText;
          if (deltaReasoning) delta.reasoning_content = deltaReasoning;
          if (toolCallDeltas.length > 0) delta.tool_calls = toolCallDeltas;

          yield {
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: model.canonicalId,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finalFinishReason,
              },
            ],
          };
        }
      }

      if (request.stream_options?.include_usage ?? true) {
        yield {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: model.canonicalId,
          choices: [],
          usage: lastUsage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };
      }
    } finally {
      signalCtrl.cleanup();
    }
  }

  public extractUsage(payload: unknown): TokenUsage | null {
    if (!payload || typeof payload !== 'object') return null;
    const meta = (payload as { usageMetadata?: Record<string, unknown> }).usageMetadata;
    if (!meta || typeof meta !== 'object') return null;
    const prompt = Number(meta.promptTokenCount ?? 0);
    const completion =
      Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0);
    const total = Number(meta.totalTokenCount ?? prompt + completion);
    return {
      prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
      completion_tokens: Number.isFinite(completion) ? completion : 0,
      total_tokens: Number.isFinite(total) ? total : prompt + completion,
    };
  }

  public detectRateLimit(_statusCode: number, headers: Headers, _bodyText: string): RateLimitObservation | null {
    return parseRateLimitHeaders(headers);
  }

  public detectQuotaExhaustion(statusCode: number, bodyText: string): boolean {
    const lower = bodyText.toLowerCase();
    if (statusCode === 429 && (lower.includes('perday') || lower.includes('free_tier_requests'))) {
      return lower.includes('limit: 0') || lower.includes('daily');
    }
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
        message: 'Google Gemini API key not configured.',
      };
    }
    try {
      const url = `${GOOGLE_GEMINI_BASE_URL}/models?pageSize=1`;
      await assertResolvedEndpointSafe(url, { providerId: this.id });
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal,
      });
      return {
        providerId: this.id,
        healthy: res.ok,
        status: res.ok ? (this.projectNoBillingConfirmed ? 'healthy' : 'degraded') : 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: res.ok
          ? this.projectNoBillingConfirmed
            ? 'Gemini API reachable and non-billing project confirmed.'
            : 'Gemini API reachable, awaiting GOOGLE_PROJECT_NO_BILLING=true.'
          : `Gemini API returned HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        providerId: this.id,
        healthy: false,
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        checkedAt,
        message: err instanceof Error ? err.message : 'Gemini health check failed.',
      };
    }
  }

  public normalizeError(
    error: unknown,
    statusCode?: number,
    headers?: Headers,
    bodyText?: string
  ): NormalizedProviderError {
    const normalized = normalizeStandardHttpError({
      providerId: this.id,
      error,
      statusCode,
      headers,
      bodyText,
      knownSecrets: this.apiKey ? [this.apiKey] : [],
    });

    const lower = (bodyText ?? '').toLowerCase();
    if (statusCode === 429 && lower.includes('limit: 0')) {
      return {
        ...normalized,
        category: 'billing_required',
        markQuotaExhausted: true,
        cooldownMs: 3_600_000,
        message: `${this.id} free-tier quota limit is 0 for this model/region: ${normalized.message}`,
      };
    }
    return normalized;
  }
}
