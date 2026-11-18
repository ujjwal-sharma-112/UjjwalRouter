import type { ModelRecord } from '../policy/types.js';
import type { FreeInferencePolicy } from '../policy/free-inference-policy.js';
import type { ContextManager } from '../context/context-manager.js';
import type { RateLimiter } from '../rate-limiter/rate-limiter.js';
import type { QuotaManager } from '../quota-manager/quota-manager.js';
import type { CircuitBreakerRegistry } from './circuit-breaker.js';
import type { ProviderAdapter } from '../../providers/base/provider-adapter.js';
import { createStallAndRequestSignal } from '../../providers/base/openai-compat-base.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  NormalizedChatRequest,
  NormalizedProviderError,
} from '../../providers/base/types.js';
import { OpenAIErrorResponse } from '../../api/errors/openai-error.js';

export interface FailoverAttemptRecord {
  attemptNumber: number;
  providerId: string;
  modelId: string;
  canonicalId: string;
  outcome: 'success' | 'failed' | 'skipped_policy' | 'skipped_circuit' | 'skipped_rate_limit' | 'skipped_quota' | 'skipped_context';
  latencyMs: number;
  errorCategory?: string;
  statusCode?: number;
  reason: string;
  timestamp: string;
}

export interface FailoverConfig {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
}

export function computeExponentialJitterBackoffMs(
  attemptIndex: number,
  baseMs: number,
  maxMs: number,
  randomFn: () => number = Math.random
): number {
  const cap = Math.min(maxMs, baseMs * Math.pow(2, attemptIndex));
  return Math.max(0, Math.floor(randomFn() * cap));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Aborted'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractNormalizedError(adapter: ProviderAdapter, err: unknown): NormalizedProviderError {
  const withNorm = err as { normalizedError?: NormalizedProviderError };
  if (withNorm && withNorm.normalizedError) {
    return withNorm.normalizedError;
  }
  return adapter.normalizeError(err);
}

export class FailoverCoordinator {
  private readonly policy: FreeInferencePolicy;
  private readonly contextManager: ContextManager;
  private readonly rateLimiter: RateLimiter;
  private readonly quotaManager: QuotaManager;
  private readonly circuitBreaker: CircuitBreakerRegistry;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly config: FailoverConfig;
  private readonly onLatencyObserved?: (canonicalId: string, latencyMs: number) => void;
  private readonly onFailureObserved?: (canonicalId: string, category: string, elapsedMs: number) => void;
  private readonly onQuotaExhausted?: (canonicalId: string) => void;
  private readonly onModelUnavailable?: (canonicalId: string, reason: string) => void;

  constructor(params: {
    policy: FreeInferencePolicy;
    contextManager: ContextManager;
    rateLimiter: RateLimiter;
    quotaManager: QuotaManager;
    circuitBreaker: CircuitBreakerRegistry;
    adapters: Map<string, ProviderAdapter>;
    config?: Partial<FailoverConfig>;
    onLatencyObserved?: (canonicalId: string, latencyMs: number) => void;
    onFailureObserved?: (canonicalId: string, category: string, elapsedMs: number) => void;
    onQuotaExhausted?: (canonicalId: string) => void;
    onModelUnavailable?: (canonicalId: string, reason: string) => void;
  }) {
    this.policy = params.policy;
    this.contextManager = params.contextManager;
    this.rateLimiter = params.rateLimiter;
    this.quotaManager = params.quotaManager;
    this.circuitBreaker = params.circuitBreaker;
    this.adapters = params.adapters;
    this.config = {
      maxAttempts: params.config?.maxAttempts ?? 8,
      baseBackoffMs: params.config?.baseBackoffMs ?? 150,
      maxBackoffMs: params.config?.maxBackoffMs ?? 2000,
      requestTimeoutMs: params.config?.requestTimeoutMs ?? 120_000,
      firstByteTimeoutMs: params.config?.firstByteTimeoutMs ?? 25_000,
    };
    this.onLatencyObserved = params.onLatencyObserved;
    this.onFailureObserved = params.onFailureObserved;
    this.onQuotaExhausted = params.onQuotaExhausted;
    this.onModelUnavailable = params.onModelUnavailable;
  }

  private validateCandidateRuntime(
    candidate: ModelRecord,
    request: NormalizedChatRequest,
    estimatedTokens: number,
    audit: FailoverAttemptRecord[],
    attemptCounter: number
  ): ProviderAdapter | null {
    // Independent free-only policy re-check prior to every attempt
    const policyEval = this.policy.evaluateModel(candidate);
    if (!policyEval.allowed) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_policy',
        latencyMs: 0,
        reason: policyEval.reasons.join('; '),
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const ctxCheck = this.contextManager.evaluateModelFit({ request, model: candidate });
    if (!ctxCheck.fits) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_context',
        latencyMs: 0,
        reason: ctxCheck.reason,
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const cb = this.circuitBreaker.canExecute(candidate.providerId);
    if (!cb.allowed) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_circuit',
        latencyMs: 0,
        reason: `Provider circuit breaker is ${cb.state}.`,
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const quota = this.quotaManager.hasQuota({
      key: candidate.canonicalId,
      rpdLimit: candidate.quotaInfo.rpdLimit,
    });
    if (!quota.available) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_quota',
        latencyMs: 0,
        reason: quota.reason ?? 'Quota exhausted.',
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const rate = this.rateLimiter.canAccept({
      key: candidate.canonicalId,
      estimatedTokens,
      rpmLimit: candidate.quotaInfo.rpmLimit,
      tpmLimit: candidate.quotaInfo.tpmLimit,
    });
    if (!rate.allowed) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_rate_limit',
        latencyMs: 0,
        reason: rate.reason ?? 'Rate limit active.',
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const adapter = this.adapters.get(candidate.providerId);
    if (!adapter || !adapter.isEnabled()) {
      audit.push({
        attemptNumber: attemptCounter,
        providerId: candidate.providerId,
        modelId: candidate.id,
        canonicalId: candidate.canonicalId,
        outcome: 'skipped_policy',
        latencyMs: 0,
        reason: `Provider adapter "${candidate.providerId}" unavailable or disabled.`,
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    return adapter;
  }

  private handleAttemptFailure(
    candidate: ModelRecord,
    normalized: NormalizedProviderError
  ): void {
    if (normalized.markQuotaExhausted) {
      this.quotaManager.markExhausted(candidate.canonicalId, null, normalized.message);
      this.onQuotaExhausted?.(candidate.canonicalId);
    }
    if (
      normalized.category === 'model_unavailable' &&
      (normalized.statusCode === 403 || normalized.statusCode === 404)
    ) {
      this.onModelUnavailable?.(candidate.canonicalId, normalized.message);
    }
    if (normalized.cooldownMs > 0) {
      this.rateLimiter.applyCooldown(candidate.canonicalId, normalized.cooldownMs);
    }
    if (
      normalized.category === 'upstream_5xx' ||
      normalized.category === 'network_error' ||
      normalized.category === 'timeout'
    ) {
      this.circuitBreaker.recordFailure(candidate.providerId);
    }
  }

  public async executeChatWithFailover(params: {
    candidates: ModelRecord[];
    request: NormalizedChatRequest;
    estimatedTokens: number;
    signal?: AbortSignal;
  }): Promise<{
    response: ChatCompletionResponse;
    selectedModel: ModelRecord;
    attempts: FailoverAttemptRecord[];
    failoverCount: number;
  }> {
    const audit: FailoverAttemptRecord[] = [];
    let executedAttempts = 0;
    let lastError: NormalizedProviderError | null = null;

    for (const candidate of params.candidates) {
      if (executedAttempts >= this.config.maxAttempts) break;

      const adapter = this.validateCandidateRuntime(
        candidate,
        params.request,
        params.estimatedTokens,
        audit,
        executedAttempts + 1
      );
      if (!adapter) continue;

      if (executedAttempts > 0) {
        const backoff = computeExponentialJitterBackoffMs(
          executedAttempts - 1,
          this.config.baseBackoffMs,
          this.config.maxBackoffMs
        );
        await sleepWithAbort(backoff, params.signal);
      }

      executedAttempts += 1;
      const attemptStart = Date.now();
      this.rateLimiter.recordRequest(candidate.canonicalId, params.estimatedTokens);
      const effectiveFirstByteTimeout =
        params.request.model === 'auto-fast'
          ? Math.min(this.config.firstByteTimeoutMs, 10_000)
          : this.config.firstByteTimeoutMs;
      const attemptSignalCtrl = createStallAndRequestSignal({
        signal: params.signal,
        timeoutMs: this.config.requestTimeoutMs,
        firstByteTimeoutMs: effectiveFirstByteTimeout,
      });

      try {
        const response = await adapter.chatCompletion(candidate, params.request, {
          signal: attemptSignalCtrl.signal,
          timeoutMs: this.config.requestTimeoutMs,
          firstByteTimeoutMs: effectiveFirstByteTimeout,
        });
        attemptSignalCtrl.markFirstByteReceived();
        const latencyMs = Date.now() - attemptStart;
        this.circuitBreaker.recordSuccess(candidate.providerId);
        this.rateLimiter.recordHeaders(candidate.canonicalId, response.rateLimitHeaders);
        this.quotaManager.recordUsage(candidate.canonicalId, response.usage.total_tokens);
        this.onLatencyObserved?.(candidate.canonicalId, latencyMs);

        audit.push({
          attemptNumber: executedAttempts,
          providerId: candidate.providerId,
          modelId: candidate.id,
          canonicalId: candidate.canonicalId,
          outcome: 'success',
          latencyMs,
          reason: 'Completion succeeded.',
          timestamp: new Date().toISOString(),
        });

        return {
          response,
          selectedModel: candidate,
          attempts: audit,
          failoverCount: Math.max(0, executedAttempts - 1),
        };
      } catch (err) {
        const latencyMs = Date.now() - attemptStart;
        const normalized = extractNormalizedError(adapter, err);
        lastError = normalized;

        this.handleAttemptFailure(candidate, normalized);
        this.onFailureObserved?.(candidate.canonicalId, normalized.category, latencyMs);

        audit.push({
          attemptNumber: executedAttempts,
          providerId: candidate.providerId,
          modelId: candidate.id,
          canonicalId: candidate.canonicalId,
          outcome: 'failed',
          latencyMs,
          errorCategory: normalized.category,
          statusCode: normalized.statusCode,
          reason: normalized.message,
          timestamp: new Date().toISOString(),
        });

        // Do not fail over on client/non-retryable invalid request errors
        if (normalized.category === 'invalid_request' || normalized.category === 'auth_error') {
          break;
        }
      } finally {
        attemptSignalCtrl.cleanup();
      }
    }

    throw this.buildFinalError(lastError, audit);
  }

  public async *executeStreamWithFailover(params: {
    candidates: ModelRecord[];
    request: NormalizedChatRequest;
    estimatedTokens: number;
    signal?: AbortSignal;
    onSelected?: (info: { model: ModelRecord; attempts: FailoverAttemptRecord[]; failoverCount: number }) => void;
    onCompleted?: (info: { model: ModelRecord; latencyMs: number; totalTokens: number }) => void;
  }): AsyncIterable<ChatCompletionStreamChunk> {
    const audit: FailoverAttemptRecord[] = [];
    let executedAttempts = 0;
    let lastError: NormalizedProviderError | null = null;

    for (const candidate of params.candidates) {
      if (executedAttempts >= this.config.maxAttempts) break;

      const adapter = this.validateCandidateRuntime(
        candidate,
        params.request,
        params.estimatedTokens,
        audit,
        executedAttempts + 1
      );
      if (!adapter) continue;

      if (executedAttempts > 0) {
        const backoff = computeExponentialJitterBackoffMs(
          executedAttempts - 1,
          this.config.baseBackoffMs,
          this.config.maxBackoffMs
        );
        await sleepWithAbort(backoff, params.signal);
      }

      executedAttempts += 1;
      const attemptStart = Date.now();
      this.rateLimiter.recordRequest(candidate.canonicalId, params.estimatedTokens);
      let emittedAnyChunk = false;
      let observedTotalTokens = 0;
      const effectiveFirstByteTimeout =
        params.request.model === 'auto-fast'
          ? Math.min(this.config.firstByteTimeoutMs, 10_000)
          : this.config.firstByteTimeoutMs;
      const attemptSignalCtrl = createStallAndRequestSignal({
        signal: params.signal,
        timeoutMs: this.config.requestTimeoutMs,
        firstByteTimeoutMs: effectiveFirstByteTimeout,
      });

      try {
        const stream = adapter.streamChatCompletion(candidate, params.request, {
          signal: attemptSignalCtrl.signal,
          timeoutMs: this.config.requestTimeoutMs,
          firstByteTimeoutMs: effectiveFirstByteTimeout,
        });

        for await (const chunk of stream) {
          if (!emittedAnyChunk) {
            emittedAnyChunk = true;
            attemptSignalCtrl.markFirstByteReceived();
            const ttftMs = Date.now() - attemptStart;
            this.circuitBreaker.recordSuccess(candidate.providerId);
            this.onLatencyObserved?.(candidate.canonicalId, ttftMs);
            audit.push({
              attemptNumber: executedAttempts,
              providerId: candidate.providerId,
              modelId: candidate.id,
              canonicalId: candidate.canonicalId,
              outcome: 'success',
              latencyMs: ttftMs,
              reason: 'Stream started.',
              timestamp: new Date().toISOString(),
            });
            params.onSelected?.({
              model: candidate,
              attempts: audit,
              failoverCount: Math.max(0, executedAttempts - 1),
            });
          }

          if (chunk.usage?.total_tokens) {
            observedTotalTokens = chunk.usage.total_tokens;
          }
          yield chunk;
        }

        const totalLatency = Date.now() - attemptStart;
        this.quotaManager.recordUsage(candidate.canonicalId, observedTotalTokens);
        params.onCompleted?.({
          model: candidate,
          latencyMs: totalLatency,
          totalTokens: observedTotalTokens,
        });
        return;
      } catch (err) {
        const latencyMs = Date.now() - attemptStart;
        const normalized = extractNormalizedError(adapter, err);
        lastError = normalized;

        this.handleAttemptFailure(candidate, normalized);
        this.onFailureObserved?.(candidate.canonicalId, normalized.category, latencyMs);

        // Never replay or fail over after partial streamed output has already been delivered
        if (emittedAnyChunk) {
          throw new OpenAIErrorResponse(
            502,
            'server_error',
            'stream_interrupted',
            `Upstream stream interrupted mid-response (${normalized.message}). Partial output already delivered; failover disabled to prevent duplicate/corrupt output.`
          );
        }

        audit.push({
          attemptNumber: executedAttempts,
          providerId: candidate.providerId,
          modelId: candidate.id,
          canonicalId: candidate.canonicalId,
          outcome: 'failed',
          latencyMs,
          errorCategory: normalized.category,
          statusCode: normalized.statusCode,
          reason: normalized.message,
          timestamp: new Date().toISOString(),
        });

        if (normalized.category === 'invalid_request' || normalized.category === 'auth_error') {
          break;
        }
      } finally {
        attemptSignalCtrl.cleanup();
      }
    }

    throw this.buildFinalError(lastError, audit);
  }

  private buildFinalError(
    lastError: NormalizedProviderError | null,
    audit: FailoverAttemptRecord[]
  ): OpenAIErrorResponse {
    if (lastError) {
      if (
        lastError.category === 'invalid_request' ||
        (audit.length === 1 && (lastError.statusCode === 400 || lastError.statusCode === 422))
      ) {
        return OpenAIErrorResponse.badRequest(lastError.message);
      }
      if (lastError.category === 'auth_error') {
        return OpenAIErrorResponse.upstreamError(502, lastError.message, 'upstream_auth_error');
      }
      if (lastError.category === 'rate_limit') {
        return OpenAIErrorResponse.rateLimited(
          `All eligible free providers rate-limited (${lastError.message}).`
        );
      }
      return OpenAIErrorResponse.noFreeModelsAvailable(
        `All eligible free models failed across ${audit.length} attempt(s). Last error: ${lastError.message}`
      );
    }

    return OpenAIErrorResponse.noFreeModelsAvailable(
      'No eligible FREE_VERIFIED models are currently available to satisfy this request under STRICT_FREE_ONLY.'
    );
  }
}
