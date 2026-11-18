import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import type { ModelRecord } from '../../src/core/policy/types.js';

function makeModel(overrides: Partial<ModelRecord>): ModelRecord {
  const now = new Date().toISOString();
  return {
    id: 'default-model',
    canonicalId: 'openrouter:default:free',
    providerId: 'openrouter',
    displayName: 'Default Model',
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
    verificationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    freeVerificationSource: 'openrouter_catalog_zero_price',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    codingCapability: 'high',
    availabilityStatus: 'AVAILABLE',
    lastCheckedAt: now,
    quotaInfo: { rpmLimit: 20 },
    providerEnabled: true,
    endpointUrl: 'https://openrouter.ai/api/v1',
    ...overrides,
  };
}

describe('Milestone 1 HTTP Endpoints (/health, /ready, /v1/models)', () => {
  it('serves /health, reflects readiness accurately, enforces auth, and excludes paid/unverified models', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_test_key_123456',
      },
      true
    );

    const { app, registry } = await createApp({ config });

    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().strict_free_only).toBe(true);

    const notReadyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(notReadyRes.statusCode).toBe(503);
    expect(notReadyRes.json().ready).toBe(false);

    // Populate registry with one FREE_VERIFIED model, one PAID model, and one TRIAL_ONLY model
    registry.upsertModels([
      makeModel({
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        canonicalId: 'openrouter:meta-llama/llama-3.3-70b-instruct:free',
        displayName: 'Llama 3.3 70B Free',
      }),
      makeModel({
        id: 'anthropic/claude-3.7-sonnet',
        canonicalId: 'openrouter:anthropic/claude-3.7-sonnet',
        freeEligibility: 'PAID',
        freeTierType: 'PAID',
        inputPrice: 3,
        outputPrice: 15,
      }),
      makeModel({
        id: 'hf-trial-model',
        canonicalId: 'huggingface:hf-trial-model',
        providerId: 'huggingface',
        freeEligibility: 'TRIAL_ONLY',
        freeTierType: 'PROMOTIONAL_CREDITS',
        promotionalCredits: true,
        endpointUrl: 'https://router.huggingface.co/v1',
      }),
    ]);

    const readyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json().verified_free_model_count).toBe(1);

    // Unauthenticated /v1/models request must fail with 401
    const unauthRes = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.json().error.code).toBe('invalid_api_key');

    // Invalid key must fail with 401
    const badAuthRes = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(badAuthRes.statusCode).toBe(401);

    // Valid Bearer key returns ONLY FREE_VERIFIED models and eligible routing profiles
    const modelsRes = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer ur_live_test_key_123456' },
    });
    expect(modelsRes.statusCode).toBe(200);
    const body = modelsRes.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('openrouter:meta-llama/llama-3.3-70b-instruct:free');
    expect(ids).toContain('auto');
    expect(ids).toContain('auto-coding');
    expect(ids).not.toContain('openrouter:anthropic/claude-3.7-sonnet');
    expect(ids).not.toContain('huggingface:hf-trial-model');
    // auto-vision should NOT appear because the single eligible model has supportsVision=false
    expect(ids).not.toContain('auto-vision');

    await app.close();
  });
});
