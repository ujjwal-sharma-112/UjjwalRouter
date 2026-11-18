import { describe, expect, it } from 'vitest';
import { FreeInferencePolicy } from '../../src/core/policy/free-inference-policy.js';
import { ModelRegistry } from '../../src/core/model-registry/model-registry.js';
import { ModelDiscoveryService } from '../../src/core/model-discovery/model-discovery-service.js';
import { ProviderRegistry } from '../../src/providers/base/provider-registry.js';
import { GoogleGeminiAdapter } from '../../src/providers/google/google-gemini-adapter.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter/openrouter-adapter.js';
import { GroqAdapter } from '../../src/providers/groq/groq-adapter.js';
import { NvidiaNimAdapter } from '../../src/providers/nvidia/nvidia-nim-adapter.js';
import { HuggingFaceAdapter } from '../../src/providers/huggingface/huggingface-adapter.js';
import { MistralAdapter, normalizeMistralToolCallId } from '../../src/providers/mistral/mistral-adapter.js';
import { SambaNovaAdapter } from '../../src/providers/sambanova/sambanova-adapter.js';
import { CloudflareAdapter } from '../../src/providers/cloudflare/cloudflare-adapter.js';
import { CohereAdapter } from '../../src/providers/cohere/cohere-adapter.js';
import { OllamaAdapter } from '../../src/providers/ollama/ollama-adapter.js';
import { CustomOpenAIAdapter } from '../../src/providers/custom/custom-openai-adapter.js';
import { buildOpenAICompatPayload, type FetchLike } from '../../src/providers/base/openai-compat-base.js';
import type { ChatCompletionStreamChunk } from '../../src/providers/base/types.js';

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(ev));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Milestone 2 Provider Adapters & Model Discovery', () => {
  it('GoogleGeminiAdapter discovers free Flash vs paid Pro, uses x-goog-api-key, and supports native chat + streaming + tools', async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const seenUrls: string[] = [];

    const mockFetch: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      seenUrls.push(url);
      seenHeaders.push((init?.headers as Record<string, string>) ?? {});

      if (url.includes('/v1beta/models?pageSize=')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
                thinking: true,
              },
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith(':countTokens')) {
        return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 });
      }

      if (url.endsWith(':generateContent')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'read_file', args: { path: 'README.md' } },
                      thoughtSignature: 'sig_abc_123',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 25,
              candidatesTokenCount: 12,
              totalTokenCount: 37,
            },
          }),
          { status: 200 }
        );
      }

      if (url.includes(':streamGenerateContent?alt=sse')) {
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true},{"text":"Hello "}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Hermes!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14}}\n\n',
        ]);
      }

      return new Response('Not found', { status: 404 });
    };

    const unconfirmed = new GoogleGeminiAdapter({
      apiKey: 'AIzaTestKey123456789012345',
      projectNoBillingConfirmed: false,
      fetchFn: mockFetch,
    });
    const unconfirmedModels = await unconfirmed.discoverModels();
    expect(unconfirmedModels.find((m) => m.id === 'gemini-2.5-flash')?.freeEligibility).toBe(
      'FREE_UNVERIFIED'
    );

    const confirmed = new GoogleGeminiAdapter({
      apiKey: 'AIzaTestKey123456789012345',
      projectNoBillingConfirmed: true,
      fetchFn: mockFetch,
    });
    const models = await confirmed.discoverModels();
    const flash = models.find((m) => m.id === 'gemini-2.5-flash')!;
    const pro = models.find((m) => m.id === 'gemini-2.5-pro')!;

    expect(flash.freeEligibility).toBe('FREE_VERIFIED');
    expect(flash.effectiveContextWindow).toBe(1_048_576);
    expect(pro.freeEligibility).toBe('PAID');
    expect(pro.billingRequired).toBe(true);

    // Ensure key is passed via header, never URL query parameter
    expect(seenUrls.every((u) => !u.includes('AIzaTestKey'))).toBe(true);
    expect(seenHeaders[0]?.['x-goog-api-key']).toBe('AIzaTestKey123456789012345');

    const count = await confirmed.countTokens(flash, {
      model: flash.canonicalId,
      messages: [{ role: 'user', content: 'Count these tokens' }],
    });
    expect(count).toBe(42);

    const chat = await confirmed.chatCompletion(flash, {
      model: flash.canonicalId,
      messages: [
        { role: 'system', content: 'You are a coding assistant' },
        { role: 'user', content: 'Read README.md' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
          },
        },
      ],
    });
    expect(chat.choices[0]?.finish_reason).toBe('tool_calls');
    expect(chat.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(chat.choices[0]?.message.tool_calls?.[0]?.thought_signature).toBe('sig_abc_123');
    expect(chat.usage.total_tokens).toBe(37);

    const chunks: ChatCompletionStreamChunk[] = [];
    for await (const chunk of confirmed.streamChatCompletion(flash, {
      model: flash.canonicalId,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.choices[0]?.delta.content === 'Hello ')).toBe(true);
    expect(chunks.some((c) => c.choices[0]?.delta.reasoning_content === 'Thinking...')).toBe(true);
    expect(chunks[chunks.length - 1]?.usage?.total_tokens).toBe(14);
  });

  it('OpenRouterAdapter enforces :free suffix, zero pricing, context min(), SSE comments, and tool-name dedup', async () => {
    const mockFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/key')) {
        return new Response(
          JSON.stringify({ data: { is_free_tier: true, limit_remaining: null } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'qwen/qwen3-coder:free',
                name: 'Qwen3 Coder (free)',
                context_length: 262_144,
                pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
                top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
                supported_parameters: ['tools', 'response_format', 'temperature'],
              },
              {
                id: 'qwen/qwen3-coder',
                name: 'Qwen3 Coder (paid)',
                context_length: 262_144,
                pricing: { prompt: '0.0000002', completion: '0.000001' },
                supported_parameters: ['tools'],
              },
              {
                id: 'fake/nonzero-free:free',
                name: 'Fake Non-Zero Free',
                context_length: 32_768,
                pricing: { prompt: '0.000001', completion: '0' },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/chat/completions')) {
        return sseResponse([
          ': OPENROUTER PROCESSING\n\n',
          'data: {"id":"or-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"run_cmd","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
          'data: {"id":"or-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"run_cmd","arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":15,"completion_tokens":8,"total_tokens":23}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('Not found', { status: 404 });
    };

    const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-v1-test-123456', fetchFn: mockFetch });
    const models = await adapter.discoverModels();

    const freeModel = models.find((m) => m.id === 'qwen/qwen3-coder:free')!;
    const paidModel = models.find((m) => m.id === 'qwen/qwen3-coder')!;
    const fakeFree = models.find((m) => m.id === 'fake/nonzero-free:free')!;

    expect(freeModel.freeEligibility).toBe('FREE_VERIFIED');
    // Takes lower of advertised 262144 and top_provider 131072
    expect(freeModel.effectiveContextWindow).toBe(131_072);
    expect(paidModel.freeEligibility).toBe('PAID');
    expect(fakeFree.freeEligibility).toBe('PAID');

    await expect(
      adapter.chatCompletion(paidModel, { model: paidModel.id, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/non-:free/);

    const streamChunks: ChatCompletionStreamChunk[] = [];
    for await (const chunk of adapter.streamChatCompletion(freeModel, {
      model: freeModel.canonicalId,
      messages: [{ role: 'user', content: 'run ls' }],
      stream: true,
    })) {
      streamChunks.push(chunk);
    }

    // Second chunk must NOT repeat function.name="run_cmd" so clients don't concatenate "run_cmdrun_cmd"
    expect(streamChunks[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe('run_cmd');
    expect(streamChunks[1]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBeUndefined();
    expect(streamChunks[1]?.usage?.total_tokens).toBe(23);
  });

  it('Groq, NVIDIA NIM, HuggingFace, and Custom adapters enforce strict entitlement boundaries', async () => {
    const groqFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'llama-3.3-70b-versatile', active: true, context_window: 131_072, max_completion_tokens: 32_768 },
            { id: 'whisper-large-v3', active: true, context_window: 0 },
          ],
        }),
        { status: 200 }
      );

    const groqConfirmed = new GroqAdapter({
      apiKey: 'gsk_test_1234567890',
      freePlanConfirmed: true,
      fetchFn: groqFetch,
    });
    const groqModels = await groqConfirmed.discoverModels();
    expect(groqModels).toHaveLength(1); // whisper filtered out
    expect(groqModels[0]?.freeEligibility).toBe('FREE_VERIFIED');
    expect(groqModels[0]?.effectiveContextWindow).toBe(131_072);

    const nvidiaFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'meta/llama-3.3-70b-instruct', max_model_len: 131_072, permission: [{ allow_sampling: true }] },
          ],
        }),
        { status: 200 }
      );

    const nvidiaDefault = new NvidiaNimAdapter({
      apiKey: 'nvapi-test-123456',
      hostedFreeNoCreditsConfirmed: false,
      fetchFn: nvidiaFetch,
    });
    const nimModels = await nvidiaDefault.discoverModels();
    expect(nimModels[0]?.freeEligibility).toBe('TRIAL_ONLY');
    expect(nimModels[0]?.promotionalCredits).toBe(true);

    const hfDefault = new HuggingFaceAdapter({ token: 'hf_test_123456' });
    expect(hfDefault.isEnabled()).toBe(false);

    const hfEnabled = new HuggingFaceAdapter({
      token: 'hf_test_123456',
      enabled: true,
      fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-ai/DeepSeek-V3' }] }), { status: 200 }),
    });
    const hfModels = await hfEnabled.discoverModels();
    expect(hfModels[0]?.freeEligibility).toBe('TRIAL_ONLY');
    expect(hfModels[0]?.promotionalCredits).toBe(true);

    const customAdapter = new CustomOpenAIAdapter({
      id: 'local-ollama',
      displayName: 'Local Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowLoopback: true,
      fetchFn: async () =>
        new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder:32b', context_window: 32_768 }] }), { status: 200 }),
    });
    const customModels = await customAdapter.discoverModels();
    expect(customModels[0]?.freeEligibility).toBe('FREE_UNVERIFIED');

    // Discovery service aggregates and FreeInferencePolicy keeps ONLY FREE_VERIFIED models
    const policy = new FreeInferencePolicy();
    const modelRegistry = new ModelRegistry(policy);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(groqConfirmed);
    providerRegistry.register(nvidiaDefault);
    providerRegistry.register(hfEnabled);
    providerRegistry.register(customAdapter);

    const discovery = new ModelDiscoveryService({
      providerRegistry,
      modelRegistry,
      policy,
    });
    const report = await discovery.refreshAll();
    expect(report.providers.find((p) => p.providerId === 'groq')?.eligibleFreeCount).toBe(1);
    expect(report.providers.find((p) => p.providerId === 'nvidia')?.eligibleFreeCount).toBe(0);
    expect(report.providers.find((p) => p.providerId === 'huggingface')?.eligibleFreeCount).toBe(0);
    expect(report.providers.find((p) => p.providerId === 'local-ollama')?.eligibleFreeCount).toBe(0);
    expect(modelRegistry.listEligibleFreeModels().map((m) => m.canonicalId)).toEqual([
      'groq:llama-3.3-70b-versatile',
    ]);
  });

  it('classifies OpenRouter model-gated HTTP 403 as retryable model_unavailable without loosening real auth failures', () => {
    const adapter = new OpenRouterAdapter({
      apiKey: 'sk-or-v1-test-secret',
      enabled: true,
    });

    const gatedBody = JSON.stringify({
      error: {
        message:
          'thinkingmachines/inkling-2-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps',
        code: 403,
        metadata: {
          routing_funnel: [{ step: 'Initial Endpoints', endpoint_count: 1 }],
          failed_routing_step: 'Gate Free Endpoints by Agentic Harness',
        },
      },
    });

    const gatedErr = adapter.normalizeError(new Error('HTTP 403'), 403, new Headers(), gatedBody);
    expect(gatedErr.category).toBe('model_unavailable');
    expect(gatedErr.statusCode).toBe(403);
    expect(gatedErr.retryable).toBe(true);
    expect(gatedErr.markQuotaExhausted).toBe(false);
    expect(gatedErr.cooldownMs).toBe(21_600_000);

    const keyAuthErr = adapter.normalizeError(
      new Error('HTTP 403'),
      403,
      new Headers(),
      JSON.stringify({ error: { message: 'User not found or invalid API key sk-or-v1-test-secret', code: 403 } })
    );
    expect(keyAuthErr.category).toBe('auth_error');
    expect(keyAuthErr.retryable).toBe(false);
    expect(keyAuthErr.message).not.toContain('sk-or-v1-test-secret');

    const unauthErr = adapter.normalizeError(new Error('HTTP 401'), 401, new Headers(), 'Invalid API key');
    expect(unauthErr.category).toBe('auth_error');
    expect(unauthErr.retryable).toBe(false);
  });

  it('classifies OpenRouter Phala sub-provider HTTP 400 and SSE error envelopes as retryable model_unavailable and sanitizes OpenAI-compat messages', async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: 'sk-or-v1-test-secret',
      enabled: true,
      fetchFn: async () =>
        sseResponse([
          'data: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"The request was rejected as invalid\\",\\"type\\":\\"invalid_request_error\\",\\"code\\":null,\\"param\\":null}}","provider_name":"Phala","is_byok":false}}}\n\n',
        ]),
    });

    const phalaBody = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message: 'The request was rejected as invalid',
              type: 'invalid_request_error',
              code: null,
              param: null,
            },
          }),
          provider_name: 'Phala',
          is_byok: false,
        },
      },
      user_id: 'user_test',
    });

    const phalaErr = adapter.normalizeError(new Error('HTTP 400'), 400, new Headers(), phalaBody);
    expect(phalaErr.category).toBe('model_unavailable');
    expect(phalaErr.statusCode).toBe(400);
    expect(phalaErr.retryable).toBe(true);
    expect(phalaErr.cooldownMs).toBe(120_000);

    const directClientErr = adapter.normalizeError(
      new Error('HTTP 400'),
      400,
      new Headers(),
      JSON.stringify({ error: { message: 'Invalid JSON body: messages must not be empty' } })
    );
    expect(directClientErr.category).toBe('invalid_request');
    expect(directClientErr.retryable).toBe(false);

    // Streaming SSE {"error": ...} preserves metadata.provider_name for error normalization
    let caughtStreamErr: { normalizedError?: { category?: string; statusCode?: number; retryable?: boolean } } | null =
      null;
    try {
      const dummyModel = (await new GroqAdapter({
        apiKey: 'gsk_test',
        freePlanConfirmed: true,
        fetchFn: async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', active: true, context_window: 131_072 }] }),
            { status: 200 }
          ),
      }).discoverModels())[0]!;
      for await (const _chunk of adapter.streamChatCompletion(
        { ...dummyModel, id: 'xingchen-agi/xing4.0-29b-a4b:free', providerId: 'openrouter', canonicalId: 'openrouter:xingchen-agi/xing4.0-29b-a4b:free' },
        { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }
      )) {
        // should throw
      }
    } catch (err) {
      caughtStreamErr = err as { normalizedError?: { category?: string; statusCode?: number; retryable?: boolean } };
    }
    expect(caughtStreamErr?.normalizedError?.category).toBe('model_unavailable');
    expect(caughtStreamErr?.normalizedError?.statusCode).toBe(400);
    expect(caughtStreamErr?.normalizedError?.retryable).toBe(true);

    // Payload builder strips Gemini thought_signature / extra_content, null reasoning_content, tool-role name, and empty tool_calls
    const nonReasoningModel = {
      id: 'xingchen-agi/xing4.0-29b-a4b:free',
      canonicalId: 'openrouter:xingchen-agi/xing4.0-29b-a4b:free',
      providerId: 'openrouter',
      displayName: 'Xing4.0',
      contextWindow: 262_144,
      providerInputLimit: 262_144,
      accountFreeInputLimit: 262_144,
      effectiveContextWindow: 262_144,
      maxOutputTokens: 32_768,
      inputPrice: 0,
      outputPrice: 0,
      requestPrice: 0,
      imagePrice: 0,
      freeEligibility: 'FREE_VERIFIED' as const,
      freeTierType: 'PERMANENT_FREE' as const,
      billingRequired: false,
      promotionalCredits: false,
      freeVerifiedAt: new Date().toISOString(),
      verificationExpiresAt: null,
      freeVerificationSource: 'test',
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
      supportsJsonMode: true,
      supportsReasoning: false,
      codingCapability: 'high' as const,
      availabilityStatus: 'AVAILABLE' as const,
      lastCheckedAt: new Date().toISOString(),
      quotaInfo: {},
      providerEnabled: true,
      endpointUrl: 'https://openrouter.ai/api/v1',
    };

    const built = buildOpenAICompatPayload(
      nonReasoningModel,
      {
        model: 'auto',
        messages: [
          { role: 'developer', content: 'System instruction' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                thought_signature: 'sig_abc',
                extra_content: { google: { thought_signature: 'sig_abc' } },
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                  thought_signature: 'fn_sig',
                } as unknown as { name: string; arguments: string },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: null },
          { role: 'assistant', content: 'Done', reasoning_content: 'stale thoughts', tool_calls: [] },
        ],
      },
      false
    );

    expect(built.messages).toEqual([
      { role: 'system', content: 'System instruction' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '' },
      { role: 'assistant', content: 'Done' },
    ]);
  });

  it('supports Mistral, SambaNova, Cloudflare, Cohere, Ollama local, and Groq billing/413/timeout semantics', async () => {
    // 1. Mistral: parses capabilities, respects freePlanConfirmed, and normalizes tool IDs to 9 alphanumeric chars
    let mistralBody: Record<string, unknown> | null = null;
    const mistralFetch: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'devstral-medium-latest',
                max_context_length: 131_072,
                capabilities: { completion_chat: true, function_calling: true, vision: false },
              },
              { id: 'mistral-embed', max_context_length: 8192, capabilities: { completion_chat: false } },
            ],
          }),
          { status: 200 }
        );
      }
      mistralBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'm-1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200 }
      );
    };

    const mistralUnconfirmed = new MistralAdapter({
      apiKey: 'mistral-test-key',
      freePlanConfirmed: false,
      fetchFn: mistralFetch,
    });
    const mUnconf = await mistralUnconfirmed.discoverModels();
    expect(mUnconf).toHaveLength(1);
    expect(mUnconf[0]?.freeEligibility).toBe('FREE_UNVERIFIED');
    expect(mUnconf[0]?.billingRequired).toBe(false);

    const mistralConfirmed = new MistralAdapter({
      apiKey: 'mistral-test-key',
      freePlanConfirmed: true,
      fetchFn: mistralFetch,
    });
    const mConf = await mistralConfirmed.discoverModels();
    expect(mConf[0]?.freeEligibility).toBe('FREE_VERIFIED');
    expect(mConf[0]?.effectiveContextWindow).toBe(131_072);

    await mistralConfirmed.chatCompletion(mConf[0]!, {
      model: mConf[0]!.canonicalId,
      messages: [
        { role: 'user', content: 'run tool' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_gemini_0_abcd1234', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_gemini_0_abcd1234', content: 'files' },
      ],
    });
    const sentMessages = (mistralBody as { messages?: Array<{ tool_calls?: Array<{ id: string }>; tool_call_id?: string }> } | null)?.messages ?? [];
    const expectedMappedId = normalizeMistralToolCallId('call_gemini_0_abcd1234');
    expect(expectedMappedId).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(sentMessages[1]?.tool_calls?.[0]?.id).toBe(expectedMappedId);
    expect(sentMessages[2]?.tool_call_id).toBe(expectedMappedId);

    // 2. SambaNova: rejects unconfirmed accounts as TRIAL_ONLY, rejects non-zero pricing, verifies zero-priced Free Tier
    const sambaFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'DeepSeek-V3-0324',
              context_length: 131_072,
              max_completion_tokens: 16_384,
              pricing: { prompt: 0, completion: 0 },
            },
            {
              id: 'Paid-Model',
              context_length: 131_072,
              pricing: { prompt: 0.5, completion: 1.5 },
            },
          ],
        }),
        { status: 200 }
      );
    const sambaUnconfirmed = new SambaNovaAdapter({
      apiKey: 'sn-test-key',
      freeTierConfirmed: false,
      fetchFn: sambaFetch,
    });
    const snUnconf = await sambaUnconfirmed.discoverModels();
    expect(snUnconf.find((m) => m.id === 'DeepSeek-V3-0324')?.freeEligibility).toBe('TRIAL_ONLY');

    const sambaConfirmed = new SambaNovaAdapter({
      apiKey: 'sn-test-key',
      freeTierConfirmed: true,
      fetchFn: sambaFetch,
    });
    const snConf = await sambaConfirmed.discoverModels();
    expect(snConf.find((m) => m.id === 'DeepSeek-V3-0324')?.freeEligibility).toBe('FREE_VERIFIED');
    expect(snConf.find((m) => m.id === 'Paid-Model')?.freeEligibility).toBe('PAID');

    // 3. Cloudflare Workers AI: requires accountId + freePlanConfirmed and discovers @cf/* models
    const cfAdapter = new CloudflareAdapter({
      accountId: '023e105f4ecef8ad9ca31a8372d0c353',
      apiToken: 'cf-test-token',
      freePlanConfirmed: true,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            result: [
              {
                id: '@cf/qwen/qwen2.5-coder-32b-instruct',
                name: '@cf/qwen/qwen2.5-coder-32b-instruct',
                context_length: 32_768,
                max_output_tokens: 8_192,
              },
              { id: 'openai/gpt-paid', name: 'openai/gpt-paid', context_length: 128_000 },
            ],
          }),
          { status: 200 }
        ),
    });
    const cfModels = await cfAdapter.discoverModels();
    expect(cfModels).toHaveLength(1);
    expect(cfModels[0]?.freeEligibility).toBe('FREE_VERIFIED');
    expect(cfModels[0]?.codingCapability).toBe('high');

    // 4. Cohere: discovers via api.cohere.com, executes without stream_options, clamps reasoning_effort to 'high', and normalizes 422 parameter errors as retryable failover
    let cohereStreamPayload: Record<string, unknown> | null = null;
    const cohereAdapter = new CohereAdapter({
      apiKey: 'cohere-test-key',
      freePlanConfirmed: true,
      fetchFn: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/models')) {
          return new Response(
            JSON.stringify({
              models: [
                { name: 'command-a-03-2025', endpoints: ['chat'], context_length: 256_000, features: ['tools'] },
                { name: 'command-a-reasoning-08-2025', endpoints: ['chat'], context_length: 256_000, features: ['tools'] },
                { name: 'embed-v4.0', endpoints: ['embed'], context_length: 512 },
              ],
            }),
            { status: 200 }
          );
        }
        cohereStreamPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
      },
    });
    const cohereModels = await cohereAdapter.discoverModels();
    expect(cohereModels).toHaveLength(2);
    expect(cohereModels[0]?.effectiveContextWindow).toBe(256_000);
    const cohereReasoningModel = cohereModels.find((m) => m.id === 'command-a-reasoning-08-2025')!;
    expect(cohereReasoningModel.supportsReasoning).toBe(true);

    for await (const _chunk of cohereAdapter.streamChatCompletion(cohereReasoningModel, {
      model: cohereReasoningModel.canonicalId,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
      stream: true,
    })) {
      // consume stream
    }
    expect(cohereStreamPayload).not.toHaveProperty('stream_options');
    expect(cohereStreamPayload?.reasoning_effort).toBe('high');

    for await (const _chunk of cohereAdapter.streamChatCompletion(cohereReasoningModel, {
      model: cohereReasoningModel.canonicalId,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
      stream: true,
    })) {
      // consume stream
    }
    expect(cohereStreamPayload).not.toHaveProperty('reasoning_effort');

    const cohere422 = cohereAdapter.normalizeError(
      new Error('HTTP 422'),
      422,
      new Headers(),
      JSON.stringify({
        error: {
          message: "unprocessable entity: reasoning_effort 'medium' and 'low' are not supported. Use 'high' instead",
          type: 'Unprocessable Entity',
          code: 422,
        },
      })
    );
    expect(cohere422.category).toBe('model_unavailable');
    expect(cohere422.statusCode).toBe(422);
    expect(cohere422.retryable).toBe(true);

    // 5. Local Ollama: accepts loopback zero-cost local weights, marks :cloud relays as PAID
    const ollamaAdapter = new OllamaAdapter({
      baseUrl: 'http://127.0.0.1:11434',
      enabled: true,
      fetchFn: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [{ name: 'qwen2.5-coder:32b' }, { name: 'gemma4:31b-cloud' }],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            model_info: { 'qwen2.context_length': 131_072 },
            parameters: 'num_ctx 65536',
            capabilities: ['completion', 'tools'],
          }),
          { status: 200 }
        );
      },
    });
    const ollamaModels = await ollamaAdapter.discoverModels();
    expect(ollamaModels.find((m) => m.id === 'qwen2.5-coder:32b')?.freeEligibility).toBe('FREE_VERIFIED');
    expect(ollamaModels.find((m) => m.id === 'qwen2.5-coder:32b')?.effectiveContextWindow).toBe(65_536);
    expect(ollamaModels.find((m) => m.id === 'gemma4:31b-cloud')?.freeEligibility).toBe('PAID');

    // 6. Groq: unconfirmed does NOT claim billingRequired, and HTTP 413 TPM excess normalizes as retryable rate_limit
    const groqUnconf = new GroqAdapter({ apiKey: 'gsk_test_123', freePlanConfirmed: false, fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', active: true, context_window: 131_072 }] }), { status: 200 }) });
    const gUnconfModels = await groqUnconf.discoverModels();
    expect(gUnconfModels[0]?.freeEligibility).toBe('FREE_UNVERIFIED');
    expect(gUnconfModels[0]?.billingRequired).toBe(false);
    const tpm413 = groqUnconf.normalizeError(
      new Error('HTTP 413'),
      413,
      new Headers(),
      'Request too large for model llama-3.3-70b-versatile on tokens per minute (TPM): Limit 6000'
    );
    expect(tpm413.category).toBe('rate_limit');
    expect(tpm413.retryable).toBe(true);

    // 7. firstByteTimeoutMs aborts OpenRouter keepalive-only streams that emit zero tokens
    const stalledStreamFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/key')) {
        return new Response(JSON.stringify({ data: { is_free_tier: true } }), { status: 200 });
      }
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'slow/model:free', context_length: 131_072, pricing: { prompt: '0', completion: '0' } }],
          }),
          { status: 200 }
        );
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
          // never emits content chunks
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const stalledOr = new OpenRouterAdapter({ apiKey: 'sk-or-v1-test', fetchFn: stalledStreamFetch });
    const [stalledModel] = await stalledOr.discoverModels();
    await expect(async () => {
      for await (const _chunk of stalledOr.streamChatCompletion(
        stalledModel!,
        { model: stalledModel!.canonicalId, messages: [{ role: 'user', content: 'hi' }], stream: true },
        { firstByteTimeoutMs: 40, timeoutMs: 2_000 }
      )) {
        // should stall-abort
      }
    }).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
