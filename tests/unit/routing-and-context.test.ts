import { describe, expect, it } from 'vitest';
import {
  ContextManager,
  computeOutboundMaxTokens,
} from '../../src/core/context/context-manager.js';
import { estimateRequestTokens } from '../../src/core/context/token-estimator.js';
import { ModelRegistry } from '../../src/core/model-registry/model-registry.js';
import { FreeInferencePolicy } from '../../src/core/policy/free-inference-policy.js';
import type { ModelRecord } from '../../src/core/policy/types.js';
import { RoutingEngine } from '../../src/core/router/routing-engine.js';
import { buildOpenAICompatPayload } from '../../src/providers/base/openai-compat-base.js';
import { resolveProviderPriorityList } from '../../src/providers/base/provider-factory.js';

function makeModel(overrides: Partial<ModelRecord>): ModelRecord {
  const now = new Date().toISOString();
  return {
    id: 'model-a',
    canonicalId: 'openrouter:model-a:free',
    providerId: 'openrouter',
    displayName: 'Model A',
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
    freeVerificationSource: 'verified_source',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    codingCapability: 'medium',
    availabilityStatus: 'AVAILABLE',
    lastCheckedAt: now,
    quotaInfo: { rpmLimit: 20 },
    providerEnabled: true,
    endpointUrl: 'https://openrouter.ai/api/v1',
    ...overrides,
  };
}

describe('Milestone 3: TokenEstimator, ContextManager & RoutingEngine', () => {
  const policy = new FreeInferencePolicy();
  const contextManager = new ContextManager({
    safetyMarginPct: 0.05,
    safetyMarginTokens: 1024,
    defaultReservedOutputTokens: 4096,
  });

  it('estimates tokens across system, messages, tools, tool results, and images', () => {
    const est = estimateRequestTokens({
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are a helpful coding assistant.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this screenshot and fix the bug.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'console.log("hello world");' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    });

    expect(est.systemTokens).toBeGreaterThan(5);
    expect(est.imageTokens).toBe(1100);
    expect(est.toolDefinitionTokens).toBeGreaterThan(20);
    expect(est.toolResultTokens).toBeGreaterThan(5);
    expect(est.estimatedInputTokens).toBeGreaterThan(1150);
  });

  it('routes 700K-token requests ONLY to verified 1M+ context models and rejects if none fit', async () => {
    const registry = new ModelRegistry(policy);
    registry.upsertModels([
      makeModel({
        id: 'llama-3.3-70b-versatile',
        canonicalId: 'groq:llama-3.3-70b-versatile',
        providerId: 'groq',
        contextWindow: 131_072,
        providerInputLimit: 131_072,
        accountFreeInputLimit: 131_072,
        effectiveContextWindow: 131_072,
        endpointUrl: 'https://api.groq.com/openai/v1',
      }),
      makeModel({
        id: 'gemini-2.5-flash',
        canonicalId: 'google:gemini-2.5-flash',
        providerId: 'google',
        contextWindow: 1_048_576,
        providerInputLimit: 1_048_576,
        accountFreeInputLimit: 1_048_576,
        effectiveContextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsVision: true,
        supportsReasoning: true,
        codingCapability: 'high',
        endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      }),
    ]);

    const engine = new RoutingEngine({ registry, policy, contextManager });

    // ~700K tokens prompt (~2.4M chars)
    const hugePrompt = 'x'.repeat(2_400_000);
    const plan = await engine.planRoute({
      model: 'auto-long',
      messages: [{ role: 'user', content: hugePrompt }],
    });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.model.canonicalId).toBe('google:gemini-2.5-flash');

    // ~1.2M tokens prompt exceeds even 1M free context -> must reject cleanly, never truncate
    const tooHugePrompt = 'x'.repeat(4_200_000);
    await expect(
      engine.planRoute({
        model: 'auto-long',
        messages: [{ role: 'user', content: tooHugePrompt }],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      body: { error: { code: 'context_length_exceeded' } },
    });
  });

  it('selects best coding, fast, and reasoning models deterministically and rejects paid explicit models', async () => {
    const registry = new ModelRegistry(policy);
    registry.upsertModels([
      makeModel({
        id: 'llama-3.1-8b-instant',
        canonicalId: 'groq:llama-3.1-8b-instant',
        providerId: 'groq',
        contextWindow: 131_072,
        codingCapability: 'low',
        supportsReasoning: false,
        endpointUrl: 'https://api.groq.com/openai/v1',
      }),
      makeModel({
        id: 'qwen/qwen3-coder:free',
        canonicalId: 'openrouter:qwen/qwen3-coder:free',
        providerId: 'openrouter',
        contextWindow: 262_144,
        providerInputLimit: 262_144,
        accountFreeInputLimit: 262_144,
        effectiveContextWindow: 262_144,
        codingCapability: 'high',
        supportsTools: true,
        supportsReasoning: true,
        endpointUrl: 'https://openrouter.ai/api/v1',
      }),
      makeModel({
        id: 'anthropic/claude-opus',
        canonicalId: 'openrouter:anthropic/claude-opus',
        providerId: 'openrouter',
        freeEligibility: 'PAID',
        freeTierType: 'PAID',
        inputPrice: 15,
        outputPrice: 75,
        billingRequired: true,
        endpointUrl: 'https://openrouter.ai/api/v1',
      }),
    ]);

    const engine = new RoutingEngine({ registry, policy, contextManager });
    engine.recordObservedLatency('groq:llama-3.1-8b-instant', 120);
    engine.recordObservedLatency('openrouter:qwen/qwen3-coder:free', 2400);

    const codingPlan = await engine.planRoute({
      model: 'auto-coding',
      messages: [{ role: 'user', content: 'Refactor TypeScript AST parser' }],
      tools: [{ type: 'function', function: { name: 'edit_file', parameters: {} } }],
    });
    expect(codingPlan.candidates[0]?.model.canonicalId).toBe('openrouter:qwen/qwen3-coder:free');

    const fastPlan = await engine.planRoute({
      model: 'auto-fast',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    expect(fastPlan.candidates[0]?.model.canonicalId).toBe('groq:llama-3.1-8b-instant');

    await expect(
      engine.planRoute({
        model: 'openrouter:anthropic/claude-opus',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { error: { type: 'free_policy_violation' } },
    });
  });

  it('ranks high-benchmark flagship models above nano models and demotes stalled slow OpenRouter models in favor of fast backups', async () => {
    const registry = new ModelRegistry(policy);
    registry.upsertModels([
      makeModel({
        id: 'liquid/lfm-2.5-2.6b:free',
        canonicalId: 'openrouter:liquid/lfm-2.5-2.6b:free',
        providerId: 'openrouter',
        contextWindow: 524_288,
        providerInputLimit: 524_288,
        accountFreeInputLimit: 524_288,
        effectiveContextWindow: 524_288,
        codingCapability: 'low',
        supportsTools: true,
        supportsReasoning: false,
      }),
      makeModel({
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        canonicalId: 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free',
        providerId: 'openrouter',
        contextWindow: 1_000_000,
        providerInputLimit: 1_000_000,
        accountFreeInputLimit: 1_000_000,
        effectiveContextWindow: 1_000_000,
        codingCapability: 'high',
        supportsTools: true,
        supportsReasoning: true,
      }),
      makeModel({
        id: 'DeepSeek-V3-0324',
        canonicalId: 'sambanova:DeepSeek-V3-0324',
        providerId: 'sambanova',
        contextWindow: 131_072,
        providerInputLimit: 131_072,
        accountFreeInputLimit: 131_072,
        effectiveContextWindow: 131_072,
        codingCapability: 'high',
        supportsTools: true,
        supportsReasoning: true,
        endpointUrl: 'https://api.sambanova.ai/v1',
      }),
      makeModel({
        id: 'devstral-medium-latest',
        canonicalId: 'mistral:devstral-medium-latest',
        providerId: 'mistral',
        contextWindow: 131_072,
        providerInputLimit: 131_072,
        accountFreeInputLimit: 131_072,
        effectiveContextWindow: 131_072,
        codingCapability: 'high',
        supportsTools: true,
        supportsReasoning: false,
        endpointUrl: 'https://api.mistral.ai/v1',
      }),
    ]);

    const engine = new RoutingEngine({ registry, policy, contextManager });
    // Even with a single provider, 550B flagship vastly outranks 2.6B nano model on coding/tool tasks
    const initialPlan = await engine.planRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'Refactor database connection pooling cleanly' }],
      tools: [{ type: 'function', function: { name: 'edit_file', parameters: {} } }],
    });
    const rankedIds = initialPlan.candidates.map((c) => c.model.canonicalId);
    expect(rankedIds.indexOf('sambanova:DeepSeek-V3-0324')).toBeLessThan(
      rankedIds.indexOf('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free')
    );
    expect(rankedIds.indexOf('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free')).toBeLessThan(
      rankedIds.indexOf('openrouter:liquid/lfm-2.5-2.6b:free')
    );

    // Timeout and slow latency push slow OpenRouter model well below fast healthy backups
    engine.recordObservedFailure('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'timeout', 26_000);
    engine.recordObservedLatency('mistral:devstral-medium-latest', 900);
    const afterStallPlan = await engine.planRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'Implement fix' }],
      tools: [{ type: 'function', function: { name: 'edit_file', parameters: {} } }],
    });
    expect(afterStallPlan.candidates[0]?.model.providerId).toMatch(/sambanova|mistral/);
    expect(afterStallPlan.candidates[afterStallPlan.candidates.length - 1]?.model.canonicalId).toBe(
      'openrouter:liquid/lfm-2.5-2.6b:free'
    );

    // Legacy priority auto-migrates so fast native backups precede openrouter
    const migrated = resolveProviderPriorityList(
      JSON.stringify(['google', 'openrouter', 'groq', 'nvidia', 'custom'])
    );
    expect(migrated.migrated).toBe(true);
    expect(migrated.priority.indexOf('groq')).toBeLessThan(migrated.priority.indexOf('openrouter'));
    expect(migrated.priority.indexOf('sambanova')).toBeLessThan(migrated.priority.indexOf('openrouter'));
    expect(migrated.priority.indexOf('mistral')).toBeLessThan(migrated.priority.indexOf('openrouter'));
  });

  it('clamps oversized client max_tokens ceilings cleanly while still rejecting genuine input overflows', async () => {
    const gemini = makeModel({
      id: 'gemini-2.5-flash',
      canonicalId: 'google:gemini-2.5-flash',
      providerId: 'google',
      contextWindow: 1_048_576,
      providerInputLimit: 1_048_576,
      accountFreeInputLimit: 1_048_576,
      effectiveContextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      codingCapability: 'high',
      supportsTools: true,
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    const groq = makeModel({
      id: 'llama-3.3-70b-versatile',
      canonicalId: 'groq:llama-3.3-70b-versatile',
      providerId: 'groq',
      contextWindow: 131_072,
      providerInputLimit: 131_072,
      accountFreeInputLimit: 131_072,
      effectiveContextWindow: 131_072,
      maxOutputTokens: 32_768,
      codingCapability: 'high',
      supportsTools: true,
      endpointUrl: 'https://api.groq.com/openai/v1',
    });

    const registry = new ModelRegistry(policy);
    registry.upsertModels([gemini, groq]);
    const engine = new RoutingEngine({ registry, policy, contextManager });

    // ~122K tokens input paired with 921,600 max_tokens ceiling (e.g. client remaining 1M budget)
    const prompt122k = 'x'.repeat(425_000);
    const req122k = {
      model: 'auto',
      messages: [{ role: 'user' as const, content: prompt122k }],
      max_tokens: 921_600,
    };

    const plan = await engine.planRoute(req122k);
    expect(plan.candidates[0]?.model.canonicalId).toBe('google:gemini-2.5-flash');
    expect(computeOutboundMaxTokens(req122k, gemini)).toBe(65_536);

    const groqPayload = buildOpenAICompatPayload(groq, req122k, false);
    expect(groqPayload.max_tokens).toBeLessThanOrEqual(groq.maxOutputTokens);
    expect(groqPayload.max_tokens).toBeLessThan(12_000);
    expect(groqPayload.max_tokens).toBeGreaterThan(0);

    // Genuine input overflow against a 131K-only pool must still reject cleanly
    const onlySmallRegistry = new ModelRegistry(policy);
    onlySmallRegistry.upsertModels([groq]);
    const smallEngine = new RoutingEngine({ registry: onlySmallRegistry, policy, contextManager });
    await expect(
      smallEngine.planRoute({
        model: 'auto',
        messages: [{ role: 'user', content: 'x'.repeat(460_000) }],
        max_tokens: 921_600,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      body: { error: { code: 'context_length_exceeded' } },
    });
  });
});
