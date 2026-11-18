import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import type { FetchLike } from '../../src/providers/base/openai-compat-base.js';

describe('Milestone: Embeddings Route (POST /v1/embeddings)', () => {
  it('enforces bearer authentication on /v1/embeddings', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
      },
      true
    );

    const { app } = await createApp({ config });

    const unauthRes = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { input: 'hello world' },
    });

    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.json().error.code).toBe('invalid_api_key');
  });

  it('rejects invalid request payloads with 400 Bad Request', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
      },
      true
    );

    const { app } = await createApp({ config });

    const badRes = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        input: '', // empty string is rejected by schema
      },
    });

    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.type).toBe('invalid_request_error');
  });

  it('routes to local Ollama and handles model aliasing (text-embedding-3-small -> nomic-embed-text)', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      },
      true
    );

    const mockFetch: FetchLike = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('11434/v1/embeddings')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.model).toBe('nomic-embed-text');
        expect(body.input).toBe('Hello world');

        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                object: 'embedding',
                index: 0,
                embedding: [0.1, 0.2, 0.3],
              },
            ],
            model: 'nomic-embed-text',
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const { app } = await createApp({ config, fetchFn: mockFetch });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'text-embedding-3-small',
        input: 'Hello world',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.model).toBe('nomic-embed-text');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.usage.prompt_tokens).toBe(3);
  });

  it('handles multi-input batching array', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OLLAMA_ENABLED: 'true',
      },
      true
    );

    const mockFetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.input).toEqual(['chunk A', 'chunk B']);

      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: [0.1, 0.1] },
            { object: 'embedding', index: 1, embedding: [0.2, 0.2] },
          ],
          model: 'nomic-embed-text',
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const { app } = await createApp({ config, fetchFn: mockFetch });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'auto',
        input: ['chunk A', 'chunk B'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].index).toBe(0);
    expect(body.data[1].index).toBe(1);
  });

  it('falls back to Google Gemini free tier when Ollama is unavailable', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OLLAMA_ENABLED: 'true',
        GOOGLE_API_KEY: 'test-google-key',
        GOOGLE_PROJECT_NO_BILLING: 'true',
      },
      true
    );

    const mockFetch: FetchLike = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('11434')) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      }

      if (urlStr.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            embeddings: [{ values: [0.5, 0.6, 0.7] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    };

    const { app } = await createApp({ config, fetchFn: mockFetch });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'auto',
        input: 'Test fallback to Gemini',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('google:text-embedding-004');
    expect(body.data[0].embedding).toEqual([0.5, 0.6, 0.7]);
  });

  it('falls back to OpenRouter free tier when both Ollama and Gemini fail', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OLLAMA_ENABLED: 'true',
        GOOGLE_API_KEY: 'test-google-key',
        OPENROUTER_API_KEY: 'sk-or-v1-test',
      },
      true
    );

    const mockFetch: FetchLike = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('11434')) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      }
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        return new Response('Quota exceeded', { status: 429 });
      }
      if (urlStr.includes('openrouter.ai/api/v1/embeddings')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [0.9, 0.8] }],
            model: 'nvidia/nemotron-3.5-embed-1b:free',
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const { app } = await createApp({ config, fetchFn: mockFetch });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'auto',
        input: 'Test fallback to OpenRouter free',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('nvidia/nemotron-3.5-embed-1b:free');
    expect(body.data[0].embedding).toEqual([0.9, 0.8]);
  });

  it('strictly rejects paid embedding models with 403 Forbidden', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OPENROUTER_API_KEY: 'sk-or-v1-test',
      },
      true
    );

    const { app } = await createApp({ config });

    const paidRes = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'openrouter:openai/text-embedding-3-large',
        input: 'Attempting to use a paid model',
      },
    });

    expect(paidRes.statusCode).toBe(403);
    expect(paidRes.json().error.code).toBe('free_policy_violation');
    expect(paidRes.json().error.message).toContain('paid model');
  });

  it('returns 503 service unavailable when all free providers fail', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_valid_key_123',
        OLLAMA_ENABLED: 'true',
      },
      true
    );

    const mockFetch: FetchLike = async () => {
      throw new Error('Connection refused');
    };

    const { app } = await createApp({ config, fetchFn: mockFetch });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: 'Bearer ur_live_valid_key_123',
      },
      payload: {
        model: 'auto',
        input: 'Should fail-closed',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('no_eligible_free_models');
  });
});
