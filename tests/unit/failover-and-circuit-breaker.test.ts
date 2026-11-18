import { describe, expect, it } from 'vitest';
import { ContextManager } from '../../src/core/context/context-manager.js';
import { CircuitBreakerRegistry } from '../../src/core/failover/circuit-breaker.js';
import { FailoverCoordinator } from '../../src/core/failover/failover-coordinator.js';
import { FreeInferencePolicy } from '../../src/core/policy/free-inference-policy.js';
import type { ModelRecord } from '../../src/core/policy/types.js';
import { ModelRegistry } from '../../src/core/model-registry/model-registry.js';
import { QuotaManager } from '../../src/core/quota-manager/quota-manager.js';
import { RateLimiter } from '../../src/core/rate-limiter/rate-limiter.js';
import { normalizeStandardHttpError } from '../../src/providers/base/openai-compat-base.js';
import type { ProviderAdapter } from '../../src/providers/base/provider-adapter.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  NormalizedChatRequest,
  NormalizedProviderError,
} from '../../src/providers/base/types.js';

function makeCandidate(providerId: string, modelId: string, overrides: Partial<ModelRecord> = {}): ModelRecord {
  const now = new Date().toISOString();
  return {
    id: modelId,
    canonicalId: `${providerId}:${modelId}`,
    providerId,
    displayName: modelId,
    contextWindow: 131_072,
    providerInputLimit: 131_072,
    accountFreeInputLimit: 131_072,
    effectiveContextWindow: 131_072,
    maxOutputTokens: 8_192,
    inputPrice: 0,
    outputPrice: 0,
    requestPrice: 0,
    imagePrice: 0,
    freeEligibility: 'FREE_VERIFIED',
    freeTierType: 'PERMANENT_FREE',
    billingRequired: false,
    promotionalCredits: false,
    freeVerifiedAt: now,
    verificationExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    freeVerificationSource: 'verified',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    codingCapability: 'high',
    availabilityStatus: 'AVAILABLE',
    lastCheckedAt: now,
    quotaInfo: { rpmLimit: 30, rpdLimit: 1000 },
    providerEnabled: true,
    endpointUrl:
      providerId === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : 'https://openrouter.ai/api/v1',
    ...overrides,
  };
}

function makeMockAdapter(
  providerId: string,
  behavior: {
    chat?: () => Promise<ChatCompletionResponse>;
    stream?: () => AsyncIterable<ChatCompletionStreamChunk>;
    error?: NormalizedProviderError;
  }
): ProviderAdapter {
  return {
    id: providerId,
    displayName: providerId,
    getInfo: () => ({
      id: providerId,
      displayName: providerId,
      enabled: true,
      configured: true,
      endpointUrl: 'https://openrouter.ai/api/v1',
      supportsDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsNativeTokenCount: false,
    }),
    isConfigured: () => true,
    isEnabled: () => true,
    validateAuthentication: async () => ({ valid: true, reason: 'ok' }),
    discoverModels: async () => [],
    getModelMetadata: async () => null,
    verifyFreeEligibility: async () => ({
      providerId,
      modelId: 'm',
      eligible: true,
      freeEligibility: 'FREE_VERIFIED',
      freeTierType: 'PERMANENT_FREE',
      billingRequired: false,
      promotionalCredits: false,
      verifiedAt: new Date().toISOString(),
      expiresAt: null,
      source: 'mock',
      reason: 'ok',
    }),
    getContextCapabilities: (m) => ({
      advertisedContextWindow: m.contextWindow,
      providerInputLimit: m.providerInputLimit,
      accountFreeInputLimit: m.accountFreeInputLimit,
      effectiveContextWindow: m.effectiveContextWindow,
      maxOutputTokens: m.maxOutputTokens,
      source: 'mock',
    }),
    chatCompletion: async () => {
      if (behavior.chat) return behavior.chat();
      throw Object.assign(new Error(behavior.error?.message ?? 'fail'), {
        normalizedError: behavior.error,
      });
    },
    streamChatCompletion: () => {
      if (behavior.stream) return behavior.stream();
      async function* failGen(): AsyncIterable<ChatCompletionStreamChunk> {
        throw Object.assign(new Error(behavior.error?.message ?? 'stream fail'), {
          normalizedError: behavior.error,
        });
      }
      return failGen();
    },
    extractUsage: () => null,
    detectRateLimit: () => null,
    detectQuotaExhaustion: () => false,
    healthCheck: async () => ({
      providerId,
      healthy: true,
      status: 'healthy',
      latencyMs: 5,
      checkedAt: new Date().toISOString(),
      message: 'ok',
    }),
    normalizeError: (err) =>
      behavior.error ??
      normalizeStandardHttpError({
        providerId,
        error: err,
        statusCode: 502,
      }),
  };
}

describe('Milestone 3: FailoverCoordinator & CircuitBreaker', () => {
  const policy = new FreeInferencePolicy();
  const contextManager = new ContextManager({
    safetyMarginPct: 0.05,
    safetyMarginTokens: 100,
    defaultReservedOutputTokens: 512,
  });

  const baseReq: NormalizedChatRequest = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  it('fails over from HTTP 429 rate-limited provider to second verified free provider and never falls back to paid candidate', async () => {
    const rateLimiter = new RateLimiter();
    const quotaManager = new QuotaManager();
    const circuitBreaker = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 1000 });

    const c1 = makeCandidate('groq', 'llama-3.3-70b-versatile');
    const cPaid = makeCandidate('openrouter', 'paid-model', {
      freeEligibility: 'PAID',
      inputPrice: 1,
    });
    const c2 = makeCandidate('openrouter', 'qwen/qwen3-coder:free');

    const adapters = new Map<string, ProviderAdapter>([
      [
        'groq',
        makeMockAdapter('groq', {
          error: {
            providerId: 'groq',
            category: 'rate_limit',
            statusCode: 429,
            retryable: true,
            cooldownMs: 5000,
            markQuotaExhausted: false,
            message: '429 rate limited',
          },
        }),
      ],
      [
        'openrouter',
        makeMockAdapter('openrouter', {
          chat: async () => ({
            id: 'chatcmpl_1',
            object: 'chat.completion',
            created: 1700000000,
            model: c2.canonicalId,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        }),
      ],
    ]);

    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter,
      quotaManager,
      circuitBreaker,
      adapters,
      config: { baseBackoffMs: 1, maxBackoffMs: 5 },
    });

    const result = await coordinator.executeChatWithFailover({
      candidates: [c1, cPaid, c2],
      request: baseReq,
      estimatedTokens: 20,
    });

    expect(result.selectedModel.canonicalId).toBe(c2.canonicalId);
    expect(result.response.choices[0]?.message.content).toBe('Recovered!');
    expect(result.failoverCount).toBe(1);
    expect(result.attempts.some((a) => a.canonicalId === cPaid.canonicalId && a.outcome === 'skipped_policy')).toBe(
      true
    );
  });

  it('does NOT fail over on client 400 invalid_request errors', async () => {
    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter: new RateLimiter(),
      quotaManager: new QuotaManager(),
      circuitBreaker: new CircuitBreakerRegistry(),
      adapters: new Map([
        [
          'groq',
          makeMockAdapter('groq', {
            error: {
              providerId: 'groq',
              category: 'invalid_request',
              statusCode: 400,
              retryable: false,
              cooldownMs: 0,
              markQuotaExhausted: false,
              message: 'Invalid tool schema',
            },
          }),
        ],
        [
          'openrouter',
          makeMockAdapter('openrouter', {
            chat: async () => {
              throw new Error('Should not have called second provider');
            },
          }),
        ],
      ]),
      config: { baseBackoffMs: 1, maxBackoffMs: 5 },
    });

    await expect(
      coordinator.executeChatWithFailover({
        candidates: [
          makeCandidate('groq', 'llama-3.3-70b-versatile'),
          makeCandidate('openrouter', 'qwen/qwen3-coder:free'),
        ],
        request: baseReq,
        estimatedTokens: 20,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('opens circuit breaker after threshold failures and prevents replay after partial stream chunk delivery', async () => {
    const circuitBreaker = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    circuitBreaker.recordFailure('groq');
    expect(circuitBreaker.getState('groq')).toBe('CLOSED');
    circuitBreaker.recordFailure('groq');
    expect(circuitBreaker.getState('groq')).toBe('OPEN');
    expect(circuitBreaker.canExecute('groq').allowed).toBe(false);

    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter: new RateLimiter(),
      quotaManager: new QuotaManager(),
      circuitBreaker: new CircuitBreakerRegistry(),
      adapters: new Map([
        [
          'openrouter',
          makeMockAdapter('openrouter', {
            stream: async function* () {
              yield {
                id: 's1',
                object: 'chat.completion.chunk',
                created: 1700000000,
                model: 'openrouter:m1:free',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial ' }, finish_reason: null }],
              };
              throw Object.assign(new Error('Upstream reset'), {
                normalizedError: {
                  providerId: 'openrouter',
                  category: 'network_error',
                  statusCode: 502,
                  retryable: true,
                  cooldownMs: 1000,
                  markQuotaExhausted: false,
                  message: 'Upstream reset',
                } satisfies NormalizedProviderError,
              });
            },
          }),
        ],
        [
          'groq',
          makeMockAdapter('groq', {
            stream: async function* () {
              throw new Error('MUST NOT REPLAY TO GROQ AFTER PARTIAL OUTPUT');
            },
          }),
        ],
      ]),
      config: { baseBackoffMs: 1, maxBackoffMs: 5 },
    });

    const received: ChatCompletionStreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of coordinator.executeStreamWithFailover({
        candidates: [
          makeCandidate('openrouter', 'm1:free'),
          makeCandidate('groq', 'm2'),
        ],
        request: { ...baseReq, stream: true },
        estimatedTokens: 20,
      })) {
        received.push(chunk);
      }
    }).rejects.toMatchObject({
      body: { error: { code: 'stream_interrupted' } },
    });
    expect(received).toHaveLength(1);
  });

  it('marks OpenRouter model-gated 403 unavailable without tripping circuit breaker and fails over up to 8 candidates', async () => {
    const circuitBreaker = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const registry = new ModelRegistry(policy);

    const gated1 = makeCandidate('openrouter', 'thinkingmachines/inkling-2-small:free');
    const gated2 = makeCandidate('openrouter', 'gated-2:free');
    const gated3 = makeCandidate('openrouter', 'gated-3:free');
    const gated4 = makeCandidate('openrouter', 'gated-4:free');
    const gated5 = makeCandidate('openrouter', 'gated-5:free');
    const healthy = makeCandidate('openrouter', 'qwen/qwen3-coder:free');
    registry.upsertModels([gated1, gated2, gated3, gated4, gated5, healthy]);

    const openrouterAdapter: ProviderAdapter = {
      ...makeMockAdapter('openrouter', {}),
      chatCompletion: async (model) => {
        if (model.id !== healthy.id) {
          throw Object.assign(new Error('openrouter model gated/unavailable (HTTP 403)'), {
            normalizedError: {
              providerId: 'openrouter',
              category: 'model_unavailable',
              statusCode: 403,
              retryable: true,
              cooldownMs: 21_600_000,
              markQuotaExhausted: false,
              message: `${model.id} is only available on agentic harnesses`,
            } satisfies NormalizedProviderError,
          });
        }
        return {
          id: 'chat-ok',
          object: 'chat.completion',
          created: 1700000000,
          model: model.canonicalId,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Routed cleanly' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    };

    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter: new RateLimiter(),
      quotaManager: new QuotaManager(),
      circuitBreaker,
      adapters: new Map([['openrouter', openrouterAdapter]]),
      config: { baseBackoffMs: 1, maxBackoffMs: 5 },
      onModelUnavailable: (canonicalId) => {
        registry.markModelUnavailable(canonicalId);
      },
    });

    const result = await coordinator.executeChatWithFailover({
      candidates: [gated1, gated2, gated3, gated4, gated5, healthy],
      request: baseReq,
      estimatedTokens: 20,
    });

    expect(result.selectedModel.canonicalId).toBe(healthy.canonicalId);
    expect(result.failoverCount).toBe(5);
    expect(result.response.choices[0]?.message.content).toBe('Routed cleanly');
    expect(circuitBreaker.getState('openrouter')).toBe('CLOSED');
    expect(registry.getByCanonicalId(gated1.canonicalId)?.availabilityStatus).toBe('UNAVAILABLE');

    // Periodic model discovery preserves temporary unavailability across replaceProviderModels / upsertModels
    registry.replaceProviderModels('openrouter', [
      makeCandidate('openrouter', 'thinkingmachines/inkling-2-small:free'),
      makeCandidate('openrouter', 'qwen/qwen3-coder:free'),
    ]);
    expect(registry.getByCanonicalId(gated1.canonicalId)?.availabilityStatus).toBe('UNAVAILABLE');
    expect(registry.listEligibleFreeModels({ onlyAvailable: true }).map((m) => m.canonicalId)).toEqual([
      healthy.canonicalId,
    ]);
  });

  it('cools down and fails over on OpenRouter upstream sub-provider 400 without permanently quarantining the model', async () => {
    const circuitBreaker = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const rateLimiter = new RateLimiter();
    const registry = new ModelRegistry(policy);

    const phalaModel = makeCandidate('openrouter', 'xingchen-agi/xing4.0-29b-a4b:free');
    const healthyModel = makeCandidate('openrouter', 'nvidia/nemotron-3.5-super-vl:free');
    registry.upsertModels([phalaModel, healthyModel]);

    let phalaCalls = 0;
    let onModelUnavailableCalls = 0;

    const openrouterAdapter: ProviderAdapter = {
      ...makeMockAdapter('openrouter', {}),
      chatCompletion: async (model) => {
        if (model.id === phalaModel.id) {
          phalaCalls += 1;
          throw Object.assign(new Error('openrouter upstream model/provider rejected request (HTTP 400)'), {
            normalizedError: {
              providerId: 'openrouter',
              category: 'model_unavailable',
              statusCode: 400,
              retryable: true,
              cooldownMs: 120_000,
              markQuotaExhausted: false,
              message: 'Provider returned error (Phala)',
            } satisfies NormalizedProviderError,
          });
        }
        return {
          id: 'chat-ok-2',
          object: 'chat.completion',
          created: 1700000000,
          model: model.canonicalId,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered after Phala 400' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    };

    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter,
      quotaManager: new QuotaManager(),
      circuitBreaker,
      adapters: new Map([['openrouter', openrouterAdapter]]),
      config: { baseBackoffMs: 1, maxBackoffMs: 5 },
      onModelUnavailable: (canonicalId) => {
        onModelUnavailableCalls += 1;
        registry.markModelUnavailable(canonicalId);
      },
    });

    const first = await coordinator.executeChatWithFailover({
      candidates: [phalaModel, healthyModel],
      request: baseReq,
      estimatedTokens: 20,
    });

    expect(first.selectedModel.canonicalId).toBe(healthyModel.canonicalId);
    expect(first.failoverCount).toBe(1);
    expect(first.response.choices[0]?.message.content).toBe('Recovered after Phala 400');
    expect(circuitBreaker.getState('openrouter')).toBe('CLOSED');
    expect(onModelUnavailableCalls).toBe(0);
    expect(registry.getByCanonicalId(phalaModel.canonicalId)?.availabilityStatus).toBe('AVAILABLE');
    expect(rateLimiter.getCooldownRemainingMs(phalaModel.canonicalId)).toBeGreaterThan(0);

    // Subsequent call within cooldown skips Phala model immediately without issuing an upstream call
    const second = await coordinator.executeChatWithFailover({
      candidates: [phalaModel, healthyModel],
      request: baseReq,
      estimatedTokens: 20,
    });
    expect(second.selectedModel.canonicalId).toBe(healthyModel.canonicalId);
    expect(phalaCalls).toBe(1);
  });

  it('aborts stalled pre-first-token OpenRouter streams via firstByteTimeoutMs and fails over cleanly to fast backup', async () => {
    const rateLimiter = new RateLimiter();
    const circuitBreaker = new CircuitBreakerRegistry({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    const stalledModel = makeCandidate('openrouter', 'nvidia/nemotron-3.5-super-vl:free');
    const fastBackup = makeCandidate('groq', 'llama-3.3-70b-versatile');

    const observedFailures: Array<{ id: string; category: string }> = [];

    const hungOpenRouter: ProviderAdapter = {
      ...makeMockAdapter('openrouter', {}),
      streamChatCompletion: (_m, _req, opts) => {
        async function* stalledStream(): AsyncIterable<ChatCompletionStreamChunk> {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              const err = new Error('Upstream stalled');
              err.name = 'TimeoutError';
              reject(err);
            };
            if (opts?.signal?.aborted) {
              onAbort();
              return;
            }
            opts?.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return stalledStream();
      },
    };

    const fastGroq: ProviderAdapter = {
      ...makeMockAdapter('groq', {
        stream: async function* () {
          yield {
            id: 'fast-1',
            object: 'chat.completion.chunk',
            created: 1700000000,
            model: fastBackup.canonicalId,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Fast backup response' }, finish_reason: 'stop' }],
          };
        },
      }),
    };

    const coordinator = new FailoverCoordinator({
      policy,
      contextManager,
      rateLimiter,
      quotaManager: new QuotaManager(),
      circuitBreaker,
      adapters: new Map([
        ['openrouter', hungOpenRouter],
        ['groq', fastGroq],
      ]),
      config: { baseBackoffMs: 1, maxBackoffMs: 5, firstByteTimeoutMs: 50, requestTimeoutMs: 5_000 },
      onFailureObserved: (id, category) => {
        observedFailures.push({ id, category });
      },
    });

    const received: ChatCompletionStreamChunk[] = [];
    for await (const chunk of coordinator.executeStreamWithFailover({
      candidates: [stalledModel, fastBackup],
      request: { ...baseReq, stream: true },
      estimatedTokens: 20,
    })) {
      received.push(chunk);
    }

    expect(received.map((c) => c.choices[0]?.delta.content).join('')).toBe('Fast backup response');
    expect(observedFailures).toEqual([{ id: stalledModel.canonicalId, category: 'timeout' }]);
    expect(rateLimiter.getCooldownRemainingMs(stalledModel.canonicalId)).toBeGreaterThan(0);
  });
});
