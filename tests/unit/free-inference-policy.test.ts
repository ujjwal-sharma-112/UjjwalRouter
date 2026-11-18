import { describe, expect, it } from 'vitest';
import { FreeInferencePolicy } from '../../src/core/policy/free-inference-policy.js';
import type { ModelRecord } from '../../src/core/policy/types.js';
import { ModelRegistry } from '../../src/core/model-registry/model-registry.js';

function makeValidFreeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 3600_000).toISOString();
  return {
    id: 'gemini-2.5-flash',
    canonicalId: 'google:gemini-2.5-flash',
    providerId: 'google',
    displayName: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    providerInputLimit: 1_048_576,
    accountFreeInputLimit: 1_048_576,
    effectiveContextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputPrice: 0,
    outputPrice: 0,
    requestPrice: 0,
    imagePrice: 0,
    freeEligibility: 'FREE_VERIFIED',
    freeTierType: 'FREE_TIER_RATE_LIMITED',
    billingRequired: false,
    promotionalCredits: false,
    freeVerifiedAt: nowIso,
    verificationExpiresAt: expiresIso,
    freeVerificationSource: 'google_ai_studio_no_billing_attestation',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    codingCapability: 'high',
    availabilityStatus: 'AVAILABLE',
    lastCheckedAt: nowIso,
    quotaInfo: {
      rpmLimit: 15,
      tpmLimit: 250_000,
    },
    providerEnabled: true,
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    ...overrides,
  };
}

describe('FreeInferencePolicy', () => {
  const policy = new FreeInferencePolicy(86_400_000);

  it('allows genuinely FREE_VERIFIED models with zero pricing and valid verification', () => {
    const model = makeValidFreeModel();
    const result = policy.evaluateModel(model);
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('FREE_VERIFIED');
    expect(result.code).toBe('ELIGIBLE_FREE_VERIFIED');
  });

  it('rejects PAID models', () => {
    const model = makeValidFreeModel({
      freeEligibility: 'PAID',
      freeTierType: 'PAID',
    });
    const result = policy.evaluateModel(model);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('PAID_MODEL_REJECTED');
  });

  it('rejects models with FREE_UNVERIFIED status', () => {
    const model = makeValidFreeModel({
      freeEligibility: 'FREE_UNVERIFIED',
      freeTierType: 'UNVERIFIED',
    });
    const result = policy.evaluateModel(model);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('NOT_FREE_VERIFIED');
  });

  it('rejects models requiring billing even if freeEligibility claims FREE_VERIFIED', () => {
    const model = makeValidFreeModel({
      billingRequired: true,
    });
    const result = policy.evaluateModel(model);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('BILLING_REQUIRED');
  });

  it('rejects trial and promotional credit models', () => {
    const trial = makeValidFreeModel({
      freeEligibility: 'TRIAL_ONLY',
      freeTierType: 'TRIAL_CREDITS',
    });
    const promo = makeValidFreeModel({
      promotionalCredits: true,
      freeTierType: 'PROMOTIONAL_CREDITS',
    });
    expect(policy.evaluateModel(trial).allowed).toBe(false);
    expect(policy.evaluateModel(trial).code).toBe('TRIAL_OR_PROMOTIONAL_CREDITS');
    expect(policy.evaluateModel(promo).allowed).toBe(false);
    expect(policy.evaluateModel(promo).code).toBe('TRIAL_OR_PROMOTIONAL_CREDITS');
  });

  it('rejects models with non-zero token, request, or image pricing', () => {
    expect(policy.evaluateModel(makeValidFreeModel({ inputPrice: 0.000001 })).code).toBe(
      'NON_ZERO_PRICING'
    );
    expect(policy.evaluateModel(makeValidFreeModel({ outputPrice: 0.5 })).code).toBe(
      'NON_ZERO_PRICING'
    );
    expect(policy.evaluateModel(makeValidFreeModel({ requestPrice: 0.01 })).code).toBe(
      'NON_ZERO_PRICING'
    );
    expect(policy.evaluateModel(makeValidFreeModel({ imagePrice: 0.02 })).code).toBe(
      'NON_ZERO_PRICING'
    );
  });

  it('rejects OpenRouter models without the :free suffix', () => {
    const model = makeValidFreeModel({
      id: 'meta-llama/llama-3.3-70b-instruct',
      canonicalId: 'openrouter:meta-llama/llama-3.3-70b-instruct',
      providerId: 'openrouter',
      endpointUrl: 'https://openrouter.ai/api/v1',
    });
    const result = policy.evaluateModel(model);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('OPENROUTER_NON_FREE_VARIANT');
  });

  it('rejects models with missing or expired verification', () => {
    const missing = makeValidFreeModel({ freeVerifiedAt: null });
    expect(policy.evaluateModel(missing).code).toBe('MISSING_VERIFICATION');

    const staleTimestamp = new Date(Date.now() - 100_000_000).toISOString();
    const expiredAge = makeValidFreeModel({ freeVerifiedAt: staleTimestamp });
    expect(policy.evaluateModel(expiredAge).code).toBe('EXPIRED_VERIFICATION');

    const pastExpiry = makeValidFreeModel({
      verificationExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(policy.evaluateModel(pastExpiry).code).toBe('EXPIRED_VERIFICATION');
  });

  it('rejects disabled providers, exhausted quotas, and unsafe endpoints', () => {
    expect(policy.evaluateModel(makeValidFreeModel({ providerEnabled: false })).code).toBe(
      'PROVIDER_DISABLED'
    );
    expect(policy.evaluateModel(makeValidFreeModel({ freeEligibility: 'QUOTA_EXHAUSTED' })).code).toBe(
      'QUOTA_EXHAUSTED'
    );
    expect(
      policy.evaluateModel(makeValidFreeModel({ endpointUrl: 'https://evil.example.com/v1' })).code
    ).toBe('UNSAFE_ENDPOINT');
  });

  it('computes effectiveContextWindow as the minimum of verified limits in ModelRegistry', () => {
    const registry = new ModelRegistry(policy);
    registry.upsertModels([
      makeValidFreeModel({
        canonicalId: 'google:capped',
        contextWindow: 2_000_000,
        providerInputLimit: 1_048_576,
        accountFreeInputLimit: 262_144,
        effectiveContextWindow: 2_000_000,
      }),
    ]);

    const stored = registry.getByCanonicalId('google:capped');
    expect(stored?.effectiveContextWindow).toBe(262_144);
  });
});
