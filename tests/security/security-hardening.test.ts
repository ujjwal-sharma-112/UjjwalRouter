import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import { FreeInferencePolicy } from '../../src/core/policy/free-inference-policy.js';
import type { ModelRecord } from '../../src/core/policy/types.js';
import { redactSecrets } from '../../src/logging/logger.js';
import { assertResolvedEndpointSafe, validateProviderBaseUrl } from '../../src/security/ssrf.js';

function baseModel(overrides: Partial<ModelRecord>): ModelRecord {
  const now = new Date().toISOString();
  return {
    id: 'test-model:free',
    canonicalId: 'openrouter:test-model:free',
    providerId: 'openrouter',
    displayName: 'Test Model',
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
    freeVerificationSource: 'test_verification',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: false,
    codingCapability: 'high',
    availabilityStatus: 'AVAILABLE',
    lastCheckedAt: now,
    quotaInfo: {},
    providerEnabled: true,
    endpointUrl: 'https://openrouter.ai/api/v1',
    ...overrides,
  };
}

describe('Milestone 7: Security Hardening Suite', () => {
  it('rejects paid models, paid endpoints, trial credits, missing entitlements, and expired verifications', async () => {
    const config = loadConfig(
      {
        LOG_LEVEL: 'silent',
        ROUTER_API_KEYS: 'ur_live_sec_test_123456',
        MAX_REQUEST_BODY_BYTES: '4096',
      },
      true
    );
    const ctx = await createApp({ config });

    const paidModel = baseModel({
      id: 'openai/gpt-4.1',
      canonicalId: 'openrouter:openai/gpt-4.1',
      freeEligibility: 'PAID',
      freeTierType: 'PAID',
      inputPrice: 2,
      outputPrice: 8,
      billingRequired: true,
    });
    const trialModel = baseModel({
      id: 'meta/llama-3.3-70b-instruct',
      canonicalId: 'nvidia:meta/llama-3.3-70b-instruct',
      providerId: 'nvidia',
      freeEligibility: 'TRIAL_ONLY',
      freeTierType: 'TRIAL_CREDITS',
      promotionalCredits: true,
      endpointUrl: 'https://integrate.api.nvidia.com/v1',
    });
    const unverifiedModel = baseModel({
      id: 'gemini-2.5-flash',
      canonicalId: 'google:gemini-2.5-flash',
      providerId: 'google',
      freeEligibility: 'FREE_UNVERIFIED',
      freeTierType: 'UNVERIFIED',
      billingRequired: true,
      freeVerifiedAt: null,
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    const expiredModel = baseModel({
      id: 'expired/model:free',
      canonicalId: 'openrouter:expired/model:free',
      freeVerifiedAt: new Date(Date.now() - 200_000_000).toISOString(),
      verificationExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const badEndpointModel = baseModel({
      id: 'evil/model:free',
      canonicalId: 'openrouter:evil/model:free',
      endpointUrl: 'https://paid-proxy.attacker.example/v1',
    });

    ctx.registry.upsertModels([
      paidModel,
      trialModel,
      unverifiedModel,
      expiredModel,
      badEndpointModel,
    ]);

    for (const modelId of [
      paidModel.canonicalId,
      trialModel.canonicalId,
      unverifiedModel.canonicalId,
      expiredModel.canonicalId,
      badEndpointModel.canonicalId,
    ]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer ur_live_sec_test_123456' },
        payload: { model: modelId, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.type).toBe('free_policy_violation');
    }

    // Fail-closed auto profile when NO free verified models exist
    const autoRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ur_live_sec_test_123456' },
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(autoRes.statusCode).toBe(503);
    expect(autoRes.json().error.code).toBe('no_eligible_free_models');

    // Invalid auth rejected with 401
    const badAuth = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer wrong' },
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(badAuth.statusCode).toBe(401);

    // Oversized request rejected with 413
    const hugeRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ur_live_sec_test_123456' },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'x'.repeat(10_000) }],
      },
    });
    expect(hugeRes.statusCode).toBe(413);
    expect(hugeRes.json().error.code).toBe('payload_too_large');

    await ctx.app.close();
  });

  it('blocks SSRF targets, embedded credentials, and non-allowlisted provider hosts', async () => {
    expect(() => validateProviderBaseUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => validateProviderBaseUrl('http://metadata.google.internal/computeMetadata')).toThrow();
    expect(() => validateProviderBaseUrl('https://127.0.0.1:8080/v1')).toThrow();
    expect(() => validateProviderBaseUrl('https://user:pass@openrouter.ai/api/v1')).toThrow();
    expect(() =>
      validateProviderBaseUrl('https://evil.com/v1', { providerId: 'google' })
    ).toThrow();
    await expect(assertResolvedEndpointSafe('https://192.168.1.50/v1')).rejects.toThrow();
  });

  it('redacts sensitive provider secrets from error strings and policy checks', () => {
    const policy = new FreeInferencePolicy(60_000);
    const stale = baseModel({
      freeVerifiedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(policy.evaluateModel(stale).code).toBe('EXPIRED_VERIFICATION');

    const leaked = 'Upstream failed with Bearer sk-or-v1-abcdef1234567890abcdef and ?key=AIzaSy1234567890abcdef12345';
    const cleaned = redactSecrets(leaked);
    expect(cleaned).not.toContain('sk-or-v1-abcdef1234567890abcdef');
    expect(cleaned).not.toContain('AIzaSy1234567890abcdef12345');
  });
});
