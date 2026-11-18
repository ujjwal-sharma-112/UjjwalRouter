import { validateProviderBaseUrl } from '../../security/ssrf.js';
import type { ModelRecord, PolicyEvaluationResult } from './types.js';

export interface PolicyEvaluationOptions {
  now?: Date;
  maxVerificationAgeMs?: number;
  allowCooldownForInspection?: boolean;
  allowLoopbackCustomEndpoint?: boolean;
}

export class FreeInferencePolicy {
  public readonly strictFreeOnly = true as const;
  private readonly defaultMaxVerificationAgeMs: number;

  constructor(defaultMaxVerificationAgeMs: number = 86_400_000) {
    this.defaultMaxVerificationAgeMs = defaultMaxVerificationAgeMs;
  }

  public evaluateModel(
    model: ModelRecord,
    options: PolicyEvaluationOptions = {}
  ): PolicyEvaluationResult {
    const now = options.now ?? new Date();
    const maxAgeMs = options.maxVerificationAgeMs ?? this.defaultMaxVerificationAgeMs;
    const reasons: string[] = [];

    if (!model.providerEnabled) {
      return {
        allowed: false,
        status: 'DISABLED',
        code: 'PROVIDER_DISABLED',
        reasons: [`Provider "${model.providerId}" is disabled.`],
      };
    }

    if (model.freeEligibility === 'PAID') {
      return {
        allowed: false,
        status: 'PAID',
        code: 'PAID_MODEL_REJECTED',
        reasons: [`Model "${model.canonicalId}" is classified as PAID and rejected by STRICT_FREE_ONLY.`],
      };
    }

    if (model.freeEligibility === 'QUOTA_EXHAUSTED') {
      return {
        allowed: false,
        status: 'QUOTA_EXHAUSTED',
        code: 'QUOTA_EXHAUSTED',
        reasons: [`Model "${model.canonicalId}" free quota is exhausted.`],
      };
    }

    if (model.billingRequired) {
      return {
        allowed: false,
        status: 'PAID',
        code: 'BILLING_REQUIRED',
        reasons: [`Model "${model.canonicalId}" requires an active billing account.`],
      };
    }

    if (
      model.promotionalCredits ||
      model.freeEligibility === 'TRIAL_ONLY' ||
      model.freeTierType === 'TRIAL_CREDITS' ||
      model.freeTierType === 'PROMOTIONAL_CREDITS'
    ) {
      return {
        allowed: false,
        status: 'TRIAL_ONLY',
        code: 'TRIAL_OR_PROMOTIONAL_CREDITS',
        reasons: [
          `Model "${model.canonicalId}" relies on trial or promotional credits, which do not qualify under STRICT_FREE_ONLY.`,
        ],
      };
    }

    if (
      !Number.isFinite(model.inputPrice) ||
      !Number.isFinite(model.outputPrice) ||
      !Number.isFinite(model.requestPrice) ||
      !Number.isFinite(model.imagePrice) ||
      model.inputPrice !== 0 ||
      model.outputPrice !== 0 ||
      model.requestPrice !== 0 ||
      model.imagePrice !== 0
    ) {
      return {
        allowed: false,
        status: 'PAID',
        code: 'NON_ZERO_PRICING',
        reasons: [
          `Model "${model.canonicalId}" has non-zero or unknown pricing (input=${model.inputPrice}, output=${model.outputPrice}, request=${model.requestPrice}, image=${model.imagePrice}).`,
        ],
      };
    }

    if (model.providerId === 'openrouter' && !model.id.endsWith(':free')) {
      return {
        allowed: false,
        status: 'PAID',
        code: 'OPENROUTER_NON_FREE_VARIANT',
        reasons: [
          `OpenRouter model "${model.id}" does not carry the explicit ":free" variant suffix and is prohibited.`,
        ],
      };
    }

    if (model.freeEligibility !== 'FREE_VERIFIED') {
      return {
        allowed: false,
        status: model.freeEligibility,
        code: 'NOT_FREE_VERIFIED',
        reasons: [
          `Model "${model.canonicalId}" eligibility is "${model.freeEligibility}"; only FREE_VERIFIED models may serve requests.`,
        ],
      };
    }

    if (!model.freeVerifiedAt || !model.freeVerificationSource) {
      return {
        allowed: false,
        status: 'FREE_UNVERIFIED',
        code: 'MISSING_VERIFICATION',
        reasons: [
          `Model "${model.canonicalId}" lacks a verification timestamp or verification source.`,
        ],
      };
    }

    const verifiedAtMs = Date.parse(model.freeVerifiedAt);
    if (Number.isNaN(verifiedAtMs)) {
      return {
        allowed: false,
        status: 'FREE_UNVERIFIED',
        code: 'MISSING_VERIFICATION',
        reasons: [`Model "${model.canonicalId}" has an invalid freeVerifiedAt timestamp.`],
      };
    }

    if (now.getTime() - verifiedAtMs > maxAgeMs) {
      return {
        allowed: false,
        status: 'FREE_UNVERIFIED',
        code: 'EXPIRED_VERIFICATION',
        reasons: [
          `Model "${model.canonicalId}" free eligibility verification expired (verified at ${model.freeVerifiedAt}).`,
        ],
      };
    }

    if (model.verificationExpiresAt) {
      const expiresAtMs = Date.parse(model.verificationExpiresAt);
      if (Number.isNaN(expiresAtMs) || now.getTime() >= expiresAtMs) {
        return {
          allowed: false,
          status: 'FREE_UNVERIFIED',
          code: 'EXPIRED_VERIFICATION',
          reasons: [
            `Model "${model.canonicalId}" verification lease expired at ${model.verificationExpiresAt}.`,
          ],
        };
      }
    }

    try {
      validateProviderBaseUrl(model.endpointUrl, {
        providerId: model.providerId === 'custom' ? undefined : model.providerId,
        allowLoopback:
          options.allowLoopbackCustomEndpoint ??
          (model.providerId === 'custom' || model.providerId === 'ollama'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Endpoint failed URL policy check';
      return {
        allowed: false,
        status: 'DISABLED',
        code: 'UNSAFE_ENDPOINT',
        reasons: [`Model "${model.canonicalId}" rejected due to endpoint validation failure: ${message}`],
      };
    }

    if (model.availabilityStatus === 'UNAVAILABLE') {
      return {
        allowed: false,
        status: 'FREE_VERIFIED',
        code: 'MODEL_UNAVAILABLE',
        reasons: [`Model "${model.canonicalId}" is currently unavailable.`],
      };
    }

    if (model.availabilityStatus === 'COOLDOWN' && !options.allowCooldownForInspection) {
      return {
        allowed: false,
        status: 'FREE_VERIFIED',
        code: 'MODEL_UNAVAILABLE',
        reasons: [`Model "${model.canonicalId}" is temporarily in cooldown.`],
      };
    }

    reasons.push(
      `Verified zero-cost inference via "${model.freeVerificationSource}" at ${model.freeVerifiedAt}.`
    );

    return {
      allowed: true,
      status: 'FREE_VERIFIED',
      code: 'ELIGIBLE_FREE_VERIFIED',
      reasons,
    };
  }

  public filterEligibleModels(
    models: readonly ModelRecord[],
    options: PolicyEvaluationOptions = {}
  ): ModelRecord[] {
    return models.filter((model) => this.evaluateModel(model, options).allowed);
  }
}
