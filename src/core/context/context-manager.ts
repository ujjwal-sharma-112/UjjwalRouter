import type { ModelRecord } from '../policy/types.js';
import type { ProviderAdapter } from '../../providers/base/provider-adapter.js';
import type { NormalizedChatRequest } from '../../providers/base/types.js';
import { estimateRequestTokens, type TokenEstimateBreakdown } from './token-estimator.js';

export interface ContextManagerConfig {
  safetyMarginPct: number;
  safetyMarginTokens: number;
  defaultReservedOutputTokens: number;
}

export interface ModelContextCheckResult {
  fits: boolean;
  effectiveContextWindow: number;
  estimatedInputTokens: number;
  nativeInputTokens: number | null;
  effectiveInputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  requiredTotalTokens: number;
  headroomTokens: number;
  outputBudgetConstrained?: boolean;
  reason: string;
}

/**
 * Clamp a client-supplied max_tokens / max_completion_tokens ceiling so upstream
 * providers never receive an output cap larger than the chosen model supports or
 * larger than the remaining context window headroom.
 */
export function computeOutboundMaxTokens(
  request: NormalizedChatRequest,
  model: ModelRecord,
  estimatedInputTokens?: number
): number | undefined {
  const requested = request.max_completion_tokens ?? request.max_tokens;
  if (typeof requested !== 'number' || requested <= 0) {
    return undefined;
  }

  let cap = model.maxOutputTokens > 0 ? Math.min(requested, model.maxOutputTokens) : requested;

  if (model.effectiveContextWindow > 0) {
    const inputEstimate = estimatedInputTokens ?? estimateRequestTokens(request).estimatedInputTokens;
    const rawRemaining = model.effectiveContextWindow - inputEstimate;
    if (rawRemaining >= 1) {
      // Leave a modest 2% buffer (capped at half the remaining room) so estimation
      // variance never pushes input + max_tokens over the upstream model's context window.
      const safetyBuffer = Math.min(
        Math.max(256, Math.ceil(inputEstimate * 0.02)),
        Math.floor(rawRemaining / 2)
      );
      cap = Math.min(cap, Math.max(1, rawRemaining - safetyBuffer));
    } else {
      cap = 1;
    }
  }

  return Math.max(1, cap);
}

export type ExplicitSummarizationHook = (params: {
  request: NormalizedChatRequest;
  breakdown: TokenEstimateBreakdown;
  maxAvailableContext: number;
}) => Promise<NormalizedChatRequest | null>;

export class ContextManager {
  private readonly config: ContextManagerConfig;

  constructor(config: ContextManagerConfig) {
    this.config = config;
  }

  public computeSafetyMargin(inputTokens: number): number {
    const pctMargin = Math.ceil(inputTokens * this.config.safetyMarginPct);
    return Math.max(pctMargin, this.config.safetyMarginTokens);
  }

  public computeReservedOutputTokens(request: NormalizedChatRequest, model: ModelRecord): number {
    const requested = request.max_completion_tokens ?? request.max_tokens;
    if (typeof requested === 'number' && requested > 0) {
      return Math.min(requested, model.maxOutputTokens > 0 ? model.maxOutputTokens : requested);
    }
    const defaultReserve = this.config.defaultReservedOutputTokens;
    return model.maxOutputTokens > 0 ? Math.min(defaultReserve, model.maxOutputTokens) : defaultReserve;
  }

  public evaluateModelFit(params: {
    request: NormalizedChatRequest;
    model: ModelRecord;
    breakdown?: TokenEstimateBreakdown;
    nativeInputTokens?: number | null;
  }): ModelContextCheckResult {
    const breakdown = params.breakdown ?? estimateRequestTokens(params.request);
    const nativeInputTokens = params.nativeInputTokens ?? null;
    const effectiveInputTokens =
      nativeInputTokens !== null
        ? Math.max(nativeInputTokens, breakdown.estimatedInputTokens)
        : breakdown.estimatedInputTokens;

    const requestedOutput = params.request.max_completion_tokens ?? params.request.max_tokens;
    const idealReservedOutput = this.computeReservedOutputTokens(params.request, params.model);
    const safetyMarginTokens = this.computeSafetyMargin(effectiveInputTokens);
    const availableForOutput =
      params.model.effectiveContextWindow - effectiveInputTokens - safetyMarginTokens;
    const defaultReserve =
      this.config.defaultReservedOutputTokens > 0 ? this.config.defaultReservedOutputTokens : 1024;
    const minViableOutput =
      typeof requestedOutput === 'number' && requestedOutput > 0
        ? Math.min(idealReservedOutput, Math.max(1024, defaultReserve))
        : idealReservedOutput;

    let reservedOutputTokens = idealReservedOutput;
    let outputBudgetConstrained = false;
    let fits = false;

    if (params.model.effectiveContextWindow > 0) {
      if (availableForOutput >= idealReservedOutput) {
        fits = true;
      } else if (
        typeof requestedOutput === 'number' &&
        requestedOutput > minViableOutput &&
        availableForOutput >= minViableOutput
      ) {
        // Oversized client max_tokens ceilings (e.g., remaining 1M context window) clamp safely
        // to the remaining model headroom before reaching upstream providers.
        reservedOutputTokens = availableForOutput;
        outputBudgetConstrained = true;
        fits = true;
      }
    }

    const requiredTotalTokens = effectiveInputTokens + reservedOutputTokens + safetyMarginTokens;
    const headroomTokens = params.model.effectiveContextWindow - requiredTotalTokens;

    return {
      fits,
      effectiveContextWindow: params.model.effectiveContextWindow,
      estimatedInputTokens: breakdown.estimatedInputTokens,
      nativeInputTokens,
      effectiveInputTokens,
      reservedOutputTokens,
      safetyMarginTokens,
      requiredTotalTokens,
      headroomTokens,
      outputBudgetConstrained,
      reason: fits
        ? outputBudgetConstrained
          ? `Fits within ${params.model.effectiveContextWindow} verified context with output clamped to ${reservedOutputTokens} remaining tokens.`
          : `Fits within ${params.model.effectiveContextWindow} verified context (${requiredTotalTokens} required, ${headroomTokens} headroom).`
        : `Requires ${requiredTotalTokens} tokens (input=${effectiveInputTokens}, output=${reservedOutputTokens}, margin=${safetyMarginTokens}), exceeding "${params.model.canonicalId}" verified limit of ${params.model.effectiveContextWindow}.`,
    };
  }

  public async checkWithOptionalNativeCount(params: {
    request: NormalizedChatRequest;
    model: ModelRecord;
    adapter?: ProviderAdapter;
    breakdown?: TokenEstimateBreakdown;
    signal?: AbortSignal;
  }): Promise<ModelContextCheckResult> {
    const breakdown = params.breakdown ?? estimateRequestTokens(params.request);
    let nativeCount: number | null = null;

    // Invoke native countTokens when supported and request is non-trivial or near model limit
    const nearBoundary =
      breakdown.estimatedInputTokens > params.model.effectiveContextWindow * 0.65;
    if (params.adapter?.countTokens && nearBoundary) {
      try {
        nativeCount = await params.adapter.countTokens(params.model, params.request, params.signal);
      } catch {
        nativeCount = null;
      }
    }

    return this.evaluateModelFit({
      request: params.request,
      model: params.model,
      breakdown,
      nativeInputTokens: nativeCount,
    });
  }
}
