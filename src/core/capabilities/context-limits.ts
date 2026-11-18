import type { ContextCapabilityDetails } from '../../providers/base/types.js';

export function computeEffectiveContextWindow(params: {
  advertisedContextWindow: number;
  providerInputLimit?: number | null;
  accountFreeInputLimit?: number | null;
}): number {
  const candidates = [
    params.advertisedContextWindow,
    params.providerInputLimit ?? null,
    params.accountFreeInputLimit ?? null,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);

  if (candidates.length === 0) {
    return 0;
  }

  return Math.min(...candidates);
}

export function buildContextCapabilityDetails(params: {
  advertisedContextWindow: number;
  providerInputLimit?: number | null;
  accountFreeInputLimit?: number | null;
  maxOutputTokens: number;
  source: string;
}): ContextCapabilityDetails {
  const providerInputLimit = params.providerInputLimit ?? null;
  const accountFreeInputLimit = params.accountFreeInputLimit ?? null;
  return {
    advertisedContextWindow: params.advertisedContextWindow,
    providerInputLimit,
    accountFreeInputLimit,
    effectiveContextWindow: computeEffectiveContextWindow({
      advertisedContextWindow: params.advertisedContextWindow,
      providerInputLimit,
      accountFreeInputLimit,
    }),
    maxOutputTokens: params.maxOutputTokens,
    source: params.source,
  };
}
