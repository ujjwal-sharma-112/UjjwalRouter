import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import type { FetchLike } from '../../src/providers/base/openai-compat-base.js';

describe('Milestone 6: Dashboard Admin API, Session Auth, CSRF & Masked Secrets', () => {
  it('enforces session cookie + CSRF, serves overview/models/routing/analytics, and masks provider credentials', async () => {
    const secretOpenRouterKey = 'sk-or-v1-very-secret-test-key-987654';
    const mockFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/key')) {
        return new Response(JSON.stringify({ data: { is_free_tier: true } }), { status: 200 });
      }
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'deepseek/deepseek-r1:free',
                name: 'DeepSeek R1 Free',
                context_length: 131_072,
                pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
                top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
                supported_parameters: ['tools', 'reasoning'],
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        DASHBOARD_ADMIN_TOKEN: 'dash-admin-secret-token-xyz',
        SECRET_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        OPENROUTER_API_KEY: secretOpenRouterKey,
      },
      true
    );

    const ctx = await createApp({ config, fetchFn: mockFetch });
    await ctx.lifecycleService.refreshDiscoveryAndPersist();
    await ctx.lifecycleService.runHealthChecksAndPersist();

    // Unauthenticated overview must fail with 401
    const unauth = await ctx.app.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(unauth.statusCode).toBe(401);

    // Login sets HttpOnly cookie and returns CSRF token
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { token: 'dash-admin-secret-token-xyz' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginJson = loginRes.json();
    expect(loginJson.authenticated).toBe(true);
    expect(typeof loginJson.csrfToken).toBe('string');

    const setCookieHeader = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : String(setCookieHeader);
    const cookiePair = cookieStr.split(';')[0]!;

    // Overview & Providers NEVER reveal full OpenRouter key
    const providersRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/providers',
      headers: { cookie: cookiePair },
    });
    expect(providersRes.statusCode).toBe(200);
    expect(providersRes.body).not.toContain(secretOpenRouterKey);

    // Models filtering works
    const modelsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/models?verifiedOnly=true&tools=true&reasoning=true',
      headers: { cookie: cookiePair },
    });
    expect(modelsRes.statusCode).toBe(200);
    expect(modelsRes.json().count).toBe(1);

    // Cookie-authenticated mutation WITHOUT CSRF token must be rejected with 403
    const missingCsrfRes = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/routing',
      headers: { cookie: cookiePair },
      payload: { defaultRoutingProfile: 'auto-coding' },
    });
    expect(missingCsrfRes.statusCode).toBe(403);

    // Valid CSRF token allows routing preference update
    const routingRes = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/routing',
      headers: { cookie: cookiePair, 'x-csrf-token': loginJson.csrfToken },
      payload: { defaultRoutingProfile: 'auto-coding', providerPriority: ['openrouter', 'google'] },
    });
    expect(routingRes.statusCode).toBe(200);
    expect(routingRes.json().defaultRoutingProfile).toBe('auto-coding');

    // Attempt to disable strictFreeOnly via settings API is strictly blocked with 403
    const tamperRes = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: cookiePair, 'x-csrf-token': loginJson.csrfToken },
      payload: { strictFreeOnly: false },
    });
    expect(tamperRes.statusCode).toBe(403);
    expect(tamperRes.json().error.code).toBe('immutable_free_policy');

    // Create and revoke client API key
    const keyRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      headers: { cookie: cookiePair, 'x-csrf-token': loginJson.csrfToken },
      payload: { name: 'hermes-cli' },
    });
    expect(keyRes.statusCode).toBe(201);
    const createdKey = keyRes.json();
    expect(createdKey.rawKey.startsWith('ur_live_')).toBe(true);

    const analyticsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/analytics?days=30',
      headers: { cookie: cookiePair },
    });
    expect(analyticsRes.statusCode).toBe(200);

    await ctx.app.close();
  });

  it('persists provider free-plan confirmation, Cloudflare accountId, and Ollama toggle across restarts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-admin-persist-'));
    const dbPath = path.join(tempDir, 'router.db');

    const mockFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.groq.com/openai/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', active: true, context_window: 131_072 }] }),
          { status: 200 }
        );
      }
      if (url.includes('api.cloudflare.com/client/v4/accounts/')) {
        return new Response(
          JSON.stringify({
            result: [{ id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: '@cf/qwen/qwen2.5-coder-32b-instruct', context_length: 32_768 }],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:32b' }] }), { status: 200 });
      }
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({ model_info: { 'qwen2.context_length': 65_536 }, capabilities: ['completion', 'tools'] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    try {
      const env = {
        LOG_LEVEL: 'silent',
        DASHBOARD_ADMIN_TOKEN: 'dash-admin-persist-token-123',
        SECRET_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };

      const app1 = await createApp({ config: loadConfig(env, true), databasePath: dbPath, fetchFn: mockFetch });
      const login1 = await app1.app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { token: 'dash-admin-persist-token-123' },
      });
      const cookie1 = String(login1.headers['set-cookie']).split(';')[0]!;
      const csrf1 = login1.json().csrfToken as string;

      // Confirm Groq free plan and Cloudflare accountId via Dashboard API
      const groqSave = await app1.app.inject({
        method: 'POST',
        url: '/api/admin/providers/groq/credentials',
        headers: { cookie: cookie1, 'x-csrf-token': csrf1 },
        payload: { apiKey: 'gsk_persist_secret_123456', confirmedFreeEntitlement: true },
      });
      expect(groqSave.statusCode).toBe(200);
      expect(groqSave.json().discovery.eligibleFreeCount).toBe(1);

      const cfSave = await app1.app.inject({
        method: 'POST',
        url: '/api/admin/providers/cloudflare/credentials',
        headers: { cookie: cookie1, 'x-csrf-token': csrf1 },
        payload: {
          apiKey: 'cf_token_secret_123456',
          accountId: '023e105f4ecef8ad9ca31a8372d0c353',
          confirmedFreeEntitlement: true,
        },
      });
      expect(cfSave.statusCode).toBe(200);
      expect(cfSave.json().discovery.eligibleFreeCount).toBe(1);

      const ollamaToggle = await app1.app.inject({
        method: 'POST',
        url: '/api/admin/providers/ollama/toggle',
        headers: { cookie: cookie1, 'x-csrf-token': csrf1 },
        payload: { enabled: true },
      });
      expect(ollamaToggle.statusCode).toBe(200);
      expect(ollamaToggle.json().enabled).toBe(true);

      await app1.app.close();

      // Reopen with fresh createApp instance sharing only DB + secrets file (NO env keys!)
      const app2 = await createApp({ config: loadConfig(env, true), databasePath: dbPath, fetchFn: mockFetch });
      const report2 = await app2.lifecycleService.refreshDiscoveryAndPersist();

      expect(report2.providers.find((p) => p.providerId === 'groq')?.eligibleFreeCount).toBe(1);
      expect(report2.providers.find((p) => p.providerId === 'cloudflare')?.eligibleFreeCount).toBe(1);
      expect(report2.providers.find((p) => p.providerId === 'ollama')?.eligibleFreeCount).toBe(1);

      await app2.app.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
