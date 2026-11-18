import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppContext } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import type { FetchLike } from '../../src/providers/base/openai-compat-base.js';

function sseBody(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

describe('Milestone 4: Hermes Agent & OpenAI SDK Wire Compatibility', () => {
  let ctx: AppContext;
  let baseUrl: string;
  let client: OpenAI;

  let groqMode: 'ok' | 'rate_limit' | 'exhausted' = 'ok';
  let lastGeminiBody: Record<string, unknown> | null = null;

  const mockFetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Google Gemini discovery & endpoints
    if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?pageSize=')) {
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
          ],
        }),
        { status: 200 }
      );
    }

    if (url.includes(':countTokens')) {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      // Approximate large payload token count proportionally for test realism
      return new Response(
        JSON.stringify({ totalTokens: Math.ceil(bodyStr.length / 3.5) }),
        { status: 200 }
      );
    }

    if (url.includes(':generateContent')) {
      lastGeminiBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const contents = (lastGeminiBody.contents as Array<{ parts?: Array<Record<string, unknown>> }>) ?? [];
      const hasToolResponse = contents.some((c) =>
        (c.parts ?? []).some((p) => 'functionResponse' in p)
      );

      if (!hasToolResponse && Array.isArray(lastGeminiBody.tools)) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'read_file', args: { path: 'src/index.ts' } },
                      thoughtSignature: 'gemini_sig_1',
                    },
                    {
                      functionCall: { name: 'list_dir', args: { path: 'src' } },
                      thoughtSignature: 'gemini_sig_2',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 18, totalTokenCount: 58 },
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Tool results processed cleanly by Gemini.' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90 },
        }),
        { status: 200 }
      );
    }

    if (url.includes(':streamGenerateContent?alt=sse')) {
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] };
      if (Array.isArray(reqBody.tools) && reqBody.tools.length > 0) {
        return sseBody([
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"terminal","args":{"cmd":"uname -a"}}}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"/etc/os-release"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":14,"totalTokenCount":44}}\n\n',
        ]);
      }
      return sseBody([
        'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"stream ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14}}\n\n',
      ]);
    }

    // OpenRouter discovery & chat
    if (url === 'https://openrouter.ai/api/v1/key') {
      return new Response(JSON.stringify({ data: { is_free_tier: true } }), { status: 200 });
    }
    if (url === 'https://openrouter.ai/api/v1/models') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen/qwen3-coder:free',
              name: 'Qwen3 Coder Free',
              context_length: 131_072,
              pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
              top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
              supported_parameters: ['tools', 'response_format'],
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (reqBody.stream) {
        return sseBody([
          ': OPENROUTER PROCESSING\n\n',
          'data: {"id":"or_stream_1","choices":[{"index":0,"delta":{"role":"assistant","content":"Failover "}}]}\n\n',
          'data: {"id":"or_stream_1","choices":[{"index":0,"delta":{"content":"stream ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response(
        JSON.stringify({
          id: 'or_chat_1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OpenRouter failover response' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 }
      );
    }

    // Groq discovery & chat
    if (url === 'https://api.groq.com/openai/v1/models') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'llama-3.3-70b-versatile',
              active: true,
              context_window: 131_072,
              max_completion_tokens: 32_768,
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      if (groqMode === 'rate_limit') {
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      if (groqMode === 'exhausted') {
        return new Response(
          JSON.stringify({ error: { message: 'insufficient_quota: daily free requests exceeded' } }),
          { status: 429 }
        );
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (reqBody.stream) {
        return sseBody([
          'data: {"id":"groq_s1","choices":[{"index":0,"delta":{"role":"assistant","content":"Fast "}}]}\n\n',
          'data: {"id":"groq_s1","choices":[{"index":0,"delta":{"content":"Groq reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response(
        JSON.stringify({
          id: 'groq_c1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Groq normal chat ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
        { status: 200 }
      );
    }

    return new Response('Unhandled URL', { status: 404 });
  };

  beforeAll(async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        HOST: '127.0.0.1',
        PORT: '8787',
        ROUTER_API_KEYS: 'ur_live_hermes_test_key',
        GOOGLE_API_KEY: 'AIzaTestHermes1234567890123',
        GOOGLE_PROJECT_NO_BILLING: 'true',
        OPENROUTER_API_KEY: 'sk-or-v1-hermes-test-12345678',
        GROQ_API_KEY: 'gsk_hermes_test_12345678',
        GROQ_FREE_PLAN_CONFIRMED: 'true',
      },
      true
    );

    ctx = await createApp({ config, fetchFn: mockFetch });
    await ctx.discoveryService.refreshAll();
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `${address}/v1`;
    client = new OpenAI({ baseURL: baseUrl, apiKey: 'ur_live_hermes_test_key' });
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('lists verified free models & routing profiles via OpenAI SDK', async () => {
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('auto-coding');
    expect(ids).toContain('auto-long');
    expect(ids).toContain('google:gemini-2.5-flash');
    expect(ids).toContain('openrouter:qwen/qwen3-coder:free');
    expect(ids).toContain('groq:llama-3.3-70b-versatile');
  });

  it('handles normal chat and streaming with include_usage via OpenAI SDK', async () => {
    groqMode = 'ok';
    const normal = await client.chat.completions.create({
      model: 'groq:llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Hello router' }],
    });
    expect(normal.choices[0]?.message.content).toBe('Groq normal chat ok');
    expect(normal.usage?.total_tokens).toBe(12);

    const stream = await client.chat.completions.create({
      model: 'groq:llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Stream please' }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let assembled = '';
    let finalUsage: OpenAI.Completions.CompletionUsage | undefined;
    for await (const chunk of stream) {
      assembled += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) finalUsage = chunk.usage;
    }
    expect(assembled).toBe('Fast Groq reply');
    expect(finalUsage?.total_tokens).toBe(11);
  });

  it('supports multi-turn Hermes tool calling & parallel tool calls with thoughtSignature preservation', async () => {
    // Turn 1: Assistant calls 2 tools in parallel
    const turn1 = await client.chat.completions.create({
      model: 'google:gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Inspect src/index.ts and list src' }],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
        { type: 'function', function: { name: 'list_dir', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ],
    });

    const toolCalls = turn1.choices[0]?.message.tool_calls;
    expect(turn1.choices[0]?.finish_reason).toBe('tool_calls');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls?.[0]?.function.name).toBe('read_file');
    expect(toolCalls?.[1]?.function.name).toBe('list_dir');

    // Turn 2: Hermes sends assistant tool_calls + tool responses (without explicit name field on tool role)
    const turn2 = await client.chat.completions.create({
      model: 'google:gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Inspect src/index.ts and list src' },
        {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        { role: 'tool', tool_call_id: toolCalls![0]!.id, content: 'export const ok = true;' },
        { role: 'tool', tool_call_id: toolCalls![1]!.id, content: 'index.ts' },
      ],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
        { type: 'function', function: { name: 'list_dir', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ],
    });

    expect(turn2.choices[0]?.message.content).toBe('Tool results processed cleanly by Gemini.');
    // Verify Gemini received thoughtSignature back and matched tool_call_id -> function name!
    const serialized = JSON.stringify(lastGeminiBody);
    expect(serialized).toContain('gemini_sig_1');
    expect(serialized).toContain('"name":"read_file"');
    expect(serialized).toContain('"name":"list_dir"');

    // Turn 2b: Simulate Hermes stripping extra_content/thought_signature when model="auto"
    const strippedToolCalls = toolCalls!.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: tc.function,
    }));
    await client.chat.completions.create({
      model: 'google:gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Inspect src/index.ts and list src' },
        { role: 'assistant', content: null, tool_calls: strippedToolCalls },
        { role: 'tool', tool_call_id: toolCalls![0]!.id, content: 'ok' },
        { role: 'tool', tool_call_id: toolCalls![1]!.id, content: 'ok' },
      ],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
        { type: 'function', function: { name: 'list_dir', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ],
    });
    const restoredSerialized = JSON.stringify(lastGeminiBody);
    expect(restoredSerialized).toContain('gemini_sig_1');
    expect(restoredSerialized).toContain('gemini_sig_2');

    // Turn 2c: Simulate cross-provider tool call history never seen by Gemini -> uses skip_thought_signature_validator
    await client.chat.completions.create({
      model: 'google:gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Run tool from prior OpenRouter turn' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_openrouter_999', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_openrouter_999', content: 'readme content' },
      ],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ],
    });
    expect(JSON.stringify(lastGeminiBody)).toContain('skip_thought_signature_validator');
  });

  it('streams parallel tool call deltas cleanly with distinct indices', async () => {
    const stream = await client.chat.completions.create({
      model: 'google:gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Check OS' }],
      tools: [
        { type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    const acc = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      for (const tc of chunk.choices[0]?.delta?.tool_calls ?? []) {
        const slot = acc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        acc.set(tc.index, slot);
      }
    }

    expect(acc.size).toBe(2);
    expect(acc.get(0)?.name).toBe('terminal');
    expect(acc.get(1)?.name).toBe('read_file');
  });

  it('routes 700K-token long context requests to Gemini 1M and rejects 1.5M context overflow cleanly', async () => {
    const hugePrompt = 'a'.repeat(2_350_000);
    const res = await client.chat.completions.create({
      model: 'auto-long',
      messages: [{ role: 'user', content: hugePrompt }],
    });
    expect(res.model).toBe('google:gemini-2.5-flash');

    const overflowPrompt = 'a'.repeat(4_500_000);
    await expect(
      client.chat.completions.create({
        model: 'auto-long',
        messages: [{ role: 'user', content: overflowPrompt }],
      })
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('clamps oversized client max_tokens (e.g. 921600 from remaining context) instead of rejecting 122K-input requests', async () => {
    const prompt122k = 'a'.repeat(430_000);
    const res = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: prompt122k }],
      max_tokens: 921_600,
    });

    expect(res.model).toBe('google:gemini-2.5-flash');
    expect((lastGeminiBody?.generationConfig as { maxOutputTokens?: number })?.maxOutputTokens).toBe(
      65_536
    );
  });

  it('handles provider exhaustion and pre-stream failover cleanly without paid fallback', async () => {
    // Make Groq exhausted while OpenRouter works; test streaming failover when requesting profile or prioritized list
    ctx.routingEngine.setProviderPriority(['groq', 'openrouter', 'google']);
    groqMode = 'exhausted';

    // Explicit fast request hits Groq first (lowest latency + top priority), fails with quota exhaustion, and fails over to OpenRouter!
    ctx.routingEngine.recordObservedLatency('groq:llama-3.3-70b-versatile', 50);
    ctx.routingEngine.recordObservedLatency('openrouter:qwen/qwen3-coder:free', 100);
    ctx.routingEngine.recordObservedLatency('google:gemini-2.5-flash', 4500);
    ctx.routingEngine.recordObservedLatency('google:gemini-2.5-flash', 4500);
    ctx.routingEngine.recordObservedLatency('google:gemini-2.5-flash', 4500);

    const stream = await client.chat.completions.create({
      model: 'auto-fast',
      messages: [{ role: 'user', content: 'Stream failover test' }],
      stream: true,
    });

    let text = '';
    let selectedModel = '';
    for await (const chunk of stream) {
      selectedModel = chunk.model;
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    expect(text).toBe('Failover stream ok');
    expect(selectedModel).toBe('openrouter:qwen/qwen3-coder:free');
    // Verify Groq model was marked QUOTA_EXHAUSTED in registry
    expect(ctx.registry.getByCanonicalId('groq:llama-3.3-70b-versatile')?.freeEligibility).toBe(
      'QUOTA_EXHAUSTED'
    );
  });
});
