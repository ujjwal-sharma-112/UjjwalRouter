export const FREE_ELIGIBILITY_STATUSES = [
  'FREE_VERIFIED',
  'FREE_UNVERIFIED',
  'PAID',
  'TRIAL_ONLY',
  'QUOTA_EXHAUSTED',
  'DISABLED',
] as const;

export type FreeEligibilityStatus = (typeof FREE_ELIGIBILITY_STATUSES)[number];

export type FreeTierType =
  | 'PERMANENT_FREE'
  | 'FREE_TIER_RATE_LIMITED'
  | 'TRIAL_CREDITS'
  | 'PROMOTIONAL_CREDITS'
  | 'PAID'
  | 'UNVERIFIED';

export type ModelAvailabilityStatus =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'COOLDOWN';

export type CodingCapabilityTier = 'high' | 'medium' | 'low' | 'unknown';

export interface ProviderQuotaInfo {
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  monthlyLimit?: number | null;
  remainingRequests?: number | null;
  remainingTokens?: number | null;
  resetAt?: string | null;
  regionRestricted?: boolean;
  notes?: string | null;
}

export interface ModelRecord {
  id: string;
  canonicalId: string;
  providerId: string;
  displayName: string;
  // Context & token limits
  contextWindow: number;
  providerInputLimit: number | null;
  accountFreeInputLimit: number | null;
  effectiveContextWindow: number;
  maxOutputTokens: number;
  // Pricing (must all be 0 for free eligibility)
  inputPrice: number;
  outputPrice: number;
  requestPrice: number;
  imagePrice: number;
  // Free policy metadata
  freeEligibility: FreeEligibilityStatus;
  freeTierType: FreeTierType;
  billingRequired: boolean;
  promotionalCredits: boolean;
  freeVerifiedAt: string | null;
  verificationExpiresAt: string | null;
  freeVerificationSource: string | null;
  // Capabilities
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsReasoning: boolean;
  codingCapability: CodingCapabilityTier;
  // Operational status
  availabilityStatus: ModelAvailabilityStatus;
  lastCheckedAt: string | null;
  quotaInfo: ProviderQuotaInfo;
  providerEnabled: boolean;
  endpointUrl: string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  status: FreeEligibilityStatus;
  reasons: string[];
  code:
    | 'ELIGIBLE_FREE_VERIFIED'
    | 'PROVIDER_DISABLED'
    | 'NOT_FREE_VERIFIED'
    | 'PAID_MODEL_REJECTED'
    | 'BILLING_REQUIRED'
    | 'TRIAL_OR_PROMOTIONAL_CREDITS'
    | 'NON_ZERO_PRICING'
    | 'MISSING_VERIFICATION'
    | 'EXPIRED_VERIFICATION'
    | 'QUOTA_EXHAUSTED'
    | 'OPENROUTER_NON_FREE_VARIANT'
    | 'UNSAFE_ENDPOINT'
    | 'MODEL_UNAVAILABLE';
}
