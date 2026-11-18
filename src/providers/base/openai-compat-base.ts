import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { assertResolvedEndpointSafe } from '../../security/ssrf.js';
import { redactSecrets } from '../../logging/logger.js';
import type { ModelRecord } from '../../core/policy/types.js';
import { computeOutboundMaxTokens } from '../../core/context/context-manager.js';
import type { ProviderExecutionOptions } from './provider-adapter.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  NormalizedChatRequest,
  NormalizedProviderError,
  RateLimitObservation,
  StreamToolCallDelta,
  TokenUsage,
} from './types.js';

export type FetchLike = typeof fetch;

export interface StallAndRequestSignalController {
  signal: AbortSignal;
  markFirstByteReceived: () => void;
  cleanup: () => void;
  isStallTimedOut: () => boolean;
}

/**
 * Coordinates an optional initial first-byte/first-token stall timeout alongside
 * an overall request deadline and caller cancellation signal.
 */
export function createStallAndRequestSignal(
  options?: ProviderExecutionOptions
): StallAndRequestSignalController {
  const controller = new AbortController();
  let stallTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;
  let firstByteReceived = false;
  let stallTimedOut = false;

  const onParentAbort = () => {
    controller.abort(options?.signal?.reason);
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  if (options?.timeoutMs && options.timeoutMs > 0) {
    totalTimer = setTimeout(() => {
      const err = new Error(`Upstream request timed out after ${options.timeoutMs}ms`);
      err.name = 'TimeoutError';
      controller.abort(err);
    }, options.timeoutMs);
    totalTimer.unref?.();
  }

  if (options?.firstByteTimeoutMs && options.firstByteTimeoutMs > 0) {
    stallTimer = setTimeout(() => {
      if (!firstByteReceived) {
        stallTimedOut = true;
        const err = new Error(
          `Upstream stalled before delivering first response token within ${options.firstByteTimeoutMs}ms`
        );
        err.name = 'TimeoutError';
        controller.abort(err);
      }
    }, options.firstByteTimeoutMs);
    stallTimer.unref?.();
  }

  const markFirstByteReceived = () => {
    firstByteReceived = true;
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const cleanup = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (options?.signal) {
      options.signal.removeEventListener('abort', onParentAbort);
    }
  };

  return {
    signal: controller.signal,
    markFirstByteReceived,
    cleanup,
    isStallTimedOut: () => stallTimedOut,
  };
}

export function parseRateLimitHeaders(headers: Headers): RateLimitObservation | null {
  const toInt = (val: string | null): number | null => {
    if (!val) return null;
    const parsed = Number.parseInt(val, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseDurationMs = (val: string | null): number | null => {
    if (!val) return null;
    const trimmed = val.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Math.round(Number(trimmed) * 1000);
    }
    const msMatch = trimmed.match(/^(\d+(?:\.\d+)?)ms$/i);
    if (msMatch?.[1]) return Math.round(Number(msMatch[1]));
    const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)s$/i);
    if (secMatch?.[1]) return Math.round(Number(secMatch[1]) * 1000);
    const minMatch = trimmed.match(/^(\d+(?:\.\d+)?)m(\d+(?:\.\d+)?)s$/i);
    if (minMatch?.[1] && minMatch?.[2]) {
      return Math.round((Number(minMatch[1]) * 60 + Number(minMatch[2])) * 1000);
    }
    return null;
  };

  const limitRequests = toInt(headers.get('x-ratelimit-limit-requests'));
  const remainingRequests = toInt(headers.get('x-ratelimit-remaining-requests'));
  const limitTokens = toInt(headers.get('x-ratelimit-limit-tokens'));
  const remainingTokens = toInt(headers.get('x-ratelimit-remaining-tokens'));
  const retryAfterMs = parseDurationMs(headers.get('retry-after'));
  const resetReqMs = parseDurationMs(headers.get('x-ratelimit-reset-requests'));
  const resetTokMs = parseDurationMs(headers.get('x-ratelimit-reset-tokens'));

  if (
    limitRequests === null &&
    remainingRequests === null &&
    limitTokens === null &&
    remainingTokens === null &&
    retryAfterMs === null
  ) {
    return null;
  }

  return {
    limitRequests,
    remainingRequests,
    limitTokens,
    remainingTokens,
    retryAfterMs,
    resetRequestsAt: resetReqMs !== null ? new Date(Date.now() + resetReqMs).toISOString() : null,
    resetTokensAt: resetTokMs !== null ? new Date(Date.now() + resetTokMs).toISOString() : null,
  };
}

export function detectStandardQuotaExhaustion(statusCode: number, bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  if (statusCode === 402) return true;
  if (
    lower.includes('insufficient_quota') ||
    lower.includes('quota exceeded') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('daily limit reached') ||
    lower.includes('requests per day') ||
    lower.includes('credit balance') ||
    lower.includes('credits exhausted') ||
    lower.includes('out of credits') ||
    lower.includes('payment required')
  ) {
    return true;
  }
  return false;
}

export function normalizeStandardHttpError(params: {
  providerId: string;
  error: unknown;
  statusCode?: number;
  headers?: Headers;
  bodyText?: string;
  knownSecrets?: string[];
}): NormalizedProviderError {
  const { providerId, error, headers, bodyText = '', knownSecrets = [] } = params;
  const statusCode = params.statusCode ?? 0;
  const rateHeaders = headers ? parseRateLimitHeaders(headers) : null;
  const rawMessage =
    bodyText || (error instanceof Error ? error.message : String(error ?? 'Unknown error'));
  const redactedFull = redactSecrets(rawMessage, knownSecrets);
  const safeMessage = redactedFull.slice(0, 500);
  const lower = redactedFull.toLowerCase();

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return {
      providerId,
      category: 'timeout',
      statusCode: 504,
      retryable: true,
      cooldownMs: 45_000,
      markQuotaExhausted: false,
      message: `${providerId} request timed out: ${safeMessage}`,
    };
  }

  if (statusCode === 0) {
    return {
      providerId,
      category: 'network_error',
      statusCode: 502,
      retryable: true,
      cooldownMs: 10_000,
      markQuotaExhausted: false,
      message: `${providerId} network failure: ${safeMessage}`,
    };
  }

  if (detectStandardQuotaExhaustion(statusCode, safeMessage)) {
    return {
      providerId,
      category: 'quota_exhausted',
      statusCode,
      retryable: true,
      cooldownMs: 3_600_000,
      markQuotaExhausted: true,
      message: `${providerId} free quota exhausted: ${safeMessage}`,
    };
  }

  if (statusCode === 429) {
    const cooldownMs = rateHeaders?.retryAfterMs ?? 30_000;
    return {
      providerId,
      category: 'rate_limit',
      statusCode: 429,
      retryable: true,
      cooldownMs,
      markQuotaExhausted: false,
      retryAfterMs: cooldownMs,
      message: `${providerId} rate limited (HTTP 429): ${safeMessage}`,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    if (lower.includes('billing') || lower.includes('payment') || lower.includes('upgrade')) {
      return {
        providerId,
        category: 'billing_required',
        statusCode,
        retryable: true,
        cooldownMs: 3_600_000,
        markQuotaExhausted: true,
        message: `${providerId} rejected request because billing is required: ${safeMessage}`,
      };
    }
    if (
      statusCode === 403 &&
      (lower.includes('gate free endpoints') ||
        lower.includes('only available on') ||
        lower.includes('agentic harness') ||
        lower.includes('failed_routing_step') ||
        lower.includes('routing_funnel') ||
        lower.includes('not available in your region') ||
        lower.includes('country, region, or territory') ||
        lower.includes('no endpoints found') ||
        lower.includes('requires moderation'))
    ) {
      return {
        providerId,
        category: 'model_unavailable',
        statusCode: 403,
        retryable: true,
        cooldownMs: 21_600_000,
        markQuotaExhausted: false,
        message: `${providerId} model gated/unavailable (HTTP 403): ${safeMessage}`,
      };
    }
    return {
      providerId,
      category: 'auth_error',
      statusCode,
      retryable: false,
      cooldownMs: 60_000,
      markQuotaExhausted: false,
      message: `${providerId} authentication/permission failed (HTTP ${statusCode}): ${safeMessage}`,
    };
  }

  if (
    statusCode === 400 &&
    (lower.includes('context') ||
      lower.includes('maximum') ||
      lower.includes('token') ||
      lower.includes('too long'))
  ) {
    return {
      providerId,
      category: 'context_length_exceeded',
      statusCode: 400,
      retryable: true,
      cooldownMs: 0,
      markQuotaExhausted: false,
      message: `${providerId} rejected context length: ${safeMessage}`,
    };
  }

  if (statusCode === 400 || statusCode === 422) {
    if (
      lower.includes('provider returned error') ||
      lower.includes('no endpoints found') ||
      lower.includes('does not support') ||
      lower.includes('not supported') ||
      lower.includes('unsupported parameter') ||
      lower.includes('unsupported value') ||
      lower.includes('is unsupported') ||
      lower.includes('unknown parameter') ||
      lower.includes('unrecognized request argument') ||
      lower.includes('extra inputs are not permitted') ||
      lower.includes('unknown field') ||
      lower.includes('unrecognized field') ||
      lower.includes('unexpected field') ||
      lower.includes('additional properties') ||
      lower.includes('reasoning_effort') ||
      lower.includes('thought_signature') ||
      lower.includes('extra_content') ||
      lower.includes('reasoning_content') ||
      lower.includes('stream_options') ||
      lower.includes('parallel_tool_calls')
    ) {
      return {
        providerId,
        category: 'model_unavailable',
        statusCode,
        retryable: true,
        cooldownMs: 120_000,
        markQuotaExhausted: false,
        message: `${providerId} upstream model/provider rejected request (HTTP ${statusCode}): ${safeMessage}`,
      };
    }

    return {
      providerId,
      category: 'invalid_request',
      statusCode,
      retryable: false,
      cooldownMs: 0,
      markQuotaExhausted: false,
      message: `${providerId} invalid request (HTTP ${statusCode}): ${safeMessage}`,
    };
  }

  if (statusCode === 413) {
    const isTpmRateLimit =
      lower.includes('tokens per minute') ||
      lower.includes('tpm') ||
      lower.includes('rate limit') ||
      lower.includes('limit ');
    return {
      providerId,
      category: isTpmRateLimit ? 'rate_limit' : 'context_length_exceeded',
      statusCode: 413,
      retryable: true,
      cooldownMs: isTpmRateLimit ? 30_000 : 0,
      markQuotaExhausted: false,
      message: `${providerId} request size/TPM limit exceeded (HTTP 413): ${safeMessage}`,
    };
  }

  if (statusCode === 404) {
    return {
      providerId,
      category: 'model_unavailable',
      statusCode: 404,
      retryable: true,
      cooldownMs: 120_000,
      markQuotaExhausted: false,
      message: `${providerId} model unavailable (HTTP 404): ${safeMessage}`,
    };
  }

  if (statusCode >= 500) {
    return {
      providerId,
      category: 'upstream_5xx',
      statusCode,
      retryable: true,
      cooldownMs: 15_000,
      markQuotaExhausted: false,
      message: `${providerId} upstream error (HTTP ${statusCode}): ${safeMessage}`,
    };
  }

  return {
    providerId,
    category: 'unknown',
    statusCode,
    retryable: false,
    cooldownMs: 0,
    markQuotaExhausted: false,
    message: `${providerId} error (HTTP ${statusCode}): ${safeMessage}`,
  };
}

export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];

  const readWithAbort = async (): Promise<{ value?: Uint8Array; done: boolean }> => {
    if (!signal) return reader.read();
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Stream aborted'), { name: 'TimeoutError' });
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error('Stream timed out'), { name: 'TimeoutError' })
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        (res) => {
          signal.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  };

  try {
    while (true) {
      const { value, done } = await readWithAbort();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          if (dataLines.length > 0) {
            yield dataLines.join('\n');
            dataLines = [];
          }
          continue;
        }

        // Ignore SSE comments such as ": OPENROUTER PROCESSING"
        if (line.startsWith(':')) continue;

        if (line.startsWith('data:')) {
          const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
          dataLines.push(payload);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) {
        dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      }
    }
    if (dataLines.length > 0) {
      yield dataLines.join('\n');
    }
  } finally {
    reader.releaseLock();
  }
}

export function extractStandardUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? prompt + completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number.isFinite(total) ? total : prompt + completion,
  };
}

export function buildOpenAICompatPayload(
  model: ModelRecord,
  request: NormalizedChatRequest,
  stream: boolean,
  payloadOptions: { omitStreamOptions?: boolean } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: request.messages.map((msg) => {
      // Standard OpenAI-compatible providers universally accept 'system'
      const role = msg.role === 'developer' ? 'system' : msg.role;
      const sanitizedToolCalls =
        role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
          ? msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }))
          : undefined;

      const wireMsg: Record<string, unknown> = {
        role,
        content:
          role === 'assistant' && sanitizedToolCalls
            ? msg.content ?? null
            : msg.content ?? '',
      };

      if (role !== 'tool' && typeof msg.name === 'string' && msg.name.length > 0) {
        wireMsg.name = msg.name;
      }
      if (role === 'tool' && typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > 0) {
        wireMsg.tool_call_id = msg.tool_call_id;
      }
      if (sanitizedToolCalls) {
        wireMsg.tool_calls = sanitizedToolCalls;
      }
      if (
        role === 'assistant' &&
        model.supportsReasoning &&
        typeof msg.reasoning_content === 'string' &&
        msg.reasoning_content.length > 0
      ) {
        wireMsg.reasoning_content = msg.reasoning_content;
      }

      return wireMsg;
    }),
    stream,
  };

  if (stream && !payloadOptions.omitStreamOptions) {
    payload.stream_options = { include_usage: request.stream_options?.include_usage ?? true };
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.top_p !== undefined) payload.top_p = request.top_p;
  const clampedMaxTokens = computeOutboundMaxTokens(request, model);
  if (clampedMaxTokens !== undefined) {
    payload.max_tokens = clampedMaxTokens;
  }
  if (request.stop !== undefined) payload.stop = request.stop;
  if (request.tools !== undefined && request.tools.length > 0) {
    payload.tools = request.tools;
    if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    if (request.parallel_tool_calls !== undefined) {
      payload.parallel_tool_calls = request.parallel_tool_calls;
    }
  }
  if (request.response_format !== undefined) payload.response_format = request.response_format;
  if (request.seed !== undefined) payload.seed = request.seed;
  if (request.presence_penalty !== undefined) payload.presence_penalty = request.presence_penalty;
  if (request.frequency_penalty !== undefined) payload.frequency_penalty = request.frequency_penalty;
  if (request.reasoning_effort !== undefined && model.supportsReasoning) {
    payload.reasoning_effort = request.reasoning_effort;
  }

  return payload;
}

export async function executeOpenAICompatChat(params: {
  providerId: string;
  endpointUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  allowLoopback?: boolean;
  model: ModelRecord;
  request: NormalizedChatRequest;
  options?: ProviderExecutionOptions;
  fetchFn: FetchLike;
  logger?: Logger;
}): Promise<ChatCompletionResponse> {
  const targetUrl = `${params.endpointUrl.replace(/\/$/, '')}/chat/completions`;
  await assertResolvedEndpointSafe(targetUrl, {
    providerId: params.providerId === 'custom' ? undefined : params.providerId,
    allowLoopback: params.allowLoopback,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...params.extraHeaders,
  };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const signalCtrl = createStallAndRequestSignal(params.options);
  try {
    const response = await params.fetchFn(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAICompatPayload(params.model, params.request, false)),
      signal: signalCtrl.signal,
    });
    signalCtrl.markFirstByteReceived();

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const normalized = normalizeStandardHttpError({
        providerId: params.providerId,
        error: new Error(`HTTP ${response.status}`),
        statusCode: response.status,
        headers: response.headers,
        bodyText,
        knownSecrets: params.apiKey ? [params.apiKey] : [],
      });
      const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
      err.normalizedError = normalized;
      throw err;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const rateLimitHeaders = parseRateLimitHeaders(response.headers) ?? undefined;
    const usage = extractStandardUsage(data) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    return {
      id: typeof data.id === 'string' ? data.id : `chatcmpl_${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
      model: params.model.canonicalId,
      choices: choices.map((c: Record<string, unknown>, idx: number) => {
        const msg = (c.message as Record<string, unknown> | undefined) ?? {};
        return {
          index: typeof c.index === 'number' ? c.index : idx,
          message: {
            role: 'assistant',
            content: typeof msg.content === 'string' ? msg.content : null,
            tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined,
            reasoning_content:
              typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
          },
          finish_reason:
            (c.finish_reason as ChatCompletionResponse['choices'][number]['finish_reason']) ?? 'stop',
        };
      }),
      usage,
      rateLimitHeaders,
    };
  } finally {
    signalCtrl.cleanup();
  }
}

export async function* executeOpenAICompatStream(params: {
  providerId: string;
  endpointUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  allowLoopback?: boolean;
  omitStreamOptions?: boolean;
  model: ModelRecord;
  request: NormalizedChatRequest;
  options?: ProviderExecutionOptions;
  fetchFn: FetchLike;
}): AsyncIterable<ChatCompletionStreamChunk> {
  const targetUrl = `${params.endpointUrl.replace(/\/$/, '')}/chat/completions`;
  await assertResolvedEndpointSafe(targetUrl, {
    providerId: params.providerId === 'custom' ? undefined : params.providerId,
    allowLoopback: params.allowLoopback,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...params.extraHeaders,
  };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const signalCtrl = createStallAndRequestSignal(params.options);
  try {
    const response = await params.fetchFn(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildOpenAICompatPayload(params.model, params.request, true, {
          omitStreamOptions: params.omitStreamOptions,
        })
      ),
      signal: signalCtrl.signal,
    });

    if (!response.ok || !response.body) {
      signalCtrl.markFirstByteReceived();
      const bodyText = await response.text().catch(() => '');
      const normalized = normalizeStandardHttpError({
        providerId: params.providerId,
        error: new Error(`HTTP ${response.status}`),
        statusCode: response.status,
        headers: response.headers,
        bodyText,
        knownSecrets: params.apiKey ? [params.apiKey] : [],
      });
      const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
      err.normalizedError = normalized;
      throw err;
    }

    const seenToolNames = new Map<number, string>();
    const fallbackId = `chatcmpl_${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    for await (const rawEvent of parseSseEvents(response.body, signalCtrl.signal)) {
      const trimmed = rawEvent.trim();
      if (!trimmed || trimmed === '[DONE]') {
        if (trimmed === '[DONE]') break;
        continue;
      }

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
        const msg = String(errObj.message ?? 'Upstream stream error');
        const normalized = normalizeStandardHttpError({
          providerId: params.providerId,
          error: new Error(msg),
          statusCode: Number.isFinite(code) ? code : 502,
          bodyText: trimmed,
          knownSecrets: params.apiKey ? [params.apiKey] : [],
        });
        const err = new Error(normalized.message) as Error & { normalizedError?: NormalizedProviderError };
        err.normalizedError = normalized;
        throw err;
      }

      const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const normalizedChoices = rawChoices.map((choice: Record<string, unknown>, idx: number) => {
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
        let toolCalls: StreamToolCallDelta[] | undefined;

        if (Array.isArray(delta.tool_calls)) {
          toolCalls = delta.tool_calls.map((rawTc: Record<string, unknown>, tcArrIdx: number) => {
            const tcIndex = typeof rawTc.index === 'number' ? rawTc.index : tcArrIdx;
            const fn = (rawTc.function as Record<string, unknown> | undefined) ?? undefined;
            const incomingName = typeof fn?.name === 'string' ? fn.name : undefined;
            let normalizedName = incomingName;
            if (incomingName) {
              if (seenToolNames.get(tcIndex) === incomingName) {
                // Some providers (e.g. MiniMax via NIM) resend full function name every delta
                normalizedName = undefined;
              } else {
                seenToolNames.set(tcIndex, incomingName);
              }
            }
            const deltaOut: StreamToolCallDelta = {
              index: tcIndex,
            };
            if (typeof rawTc.id === 'string') deltaOut.id = rawTc.id;
            else if (typeof rawTc.id === 'number') deltaOut.id = String(rawTc.id);
            if (rawTc.type === 'function') deltaOut.type = 'function';
            if (fn) {
              deltaOut.function = {};
              if (normalizedName !== undefined) deltaOut.function.name = normalizedName;
              if (typeof fn.arguments === 'string') deltaOut.function.arguments = fn.arguments;
            }
            if (typeof rawTc.thought_signature === 'string') {
              deltaOut.thought_signature = rawTc.thought_signature;
            }
            if (rawTc.extra_content && typeof rawTc.extra_content === 'object') {
              deltaOut.extra_content = rawTc.extra_content as Record<string, unknown>;
            }
            return deltaOut;
          });
        }

        return {
          index: typeof choice.index === 'number' ? choice.index : idx,
          delta: {
            ...(delta.role === 'assistant' ? { role: 'assistant' as const } : {}),
            ...(typeof delta.content === 'string' || delta.content === null
              ? { content: delta.content as string | null }
              : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            ...(typeof delta.reasoning_content === 'string'
              ? { reasoning_content: delta.reasoning_content }
              : {}),
          },
          finish_reason:
            (choice.finish_reason as ChatCompletionStreamChunk['choices'][number]['finish_reason']) ??
            null,
        };
      });

      const usage = extractStandardUsage(parsed);
      if (normalizedChoices.length > 0 || usage) {
        signalCtrl.markFirstByteReceived();
      }

      yield {
        id: typeof parsed.id === 'string' ? parsed.id : fallbackId,
        object: 'chat.completion.chunk',
        created: typeof parsed.created === 'number' ? parsed.created : created,
        model: params.model.canonicalId,
        choices: normalizedChoices,
        ...(usage ? { usage } : {}),
      };
    }
  } finally {
    signalCtrl.cleanup();
  }
}
