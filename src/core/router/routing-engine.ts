import type { ModelRecord } from '../policy/types.js';
import type { FreeInferencePolicy } from '../policy/free-inference-policy.js';
import type { ModelRegistry } from '../model-registry/model-registry.js';
import type { ContextManager } from '../context/context-manager.js';
import { estimateRequestTokens, type TokenEstimateBreakdown } from '../context/token-estimator.js';
import type { NormalizedChatRequest } from '../../providers/base/types.js';
import type { ProviderRegistry } from '../../providers/base/provider-registry.js';
import { DEFAULT_PROVIDER_PRIORITY } from '../../providers/base/provider-registry.js';
import { isRoutingProfile, profileMatchesModel, type RoutingProfile } from './profiles.js';
import {
  scoreModelIntelligence,
  type RequestComplexityContext,
} from './intelligence-scorer.js';
import { OpenAIErrorResponse } from '../../api/errors/openai-error.js';

export interface ScoreBreakdown {
  providerPriorityScore: number;
  contextCapacityScore: number;
  capabilityScore: number;
  intelligenceScore: number;
  availabilityScore: number;
  latencyScore: number;
  reliabilityPenalty: number;
  totalScore: number;
}

export interface ScoredCandidate {
  model: ModelRecord;
  score: number;
  breakdown: ScoreBreakdown;
  reason: string;
}

export interface RoutingPlan {
  requestedModel: string;
  profile: RoutingProfile | 'explicit';
  tokenBreakdown: TokenEstimateBreakdown;
  candidates: ScoredCandidate[];
  explanation: string;
}

export interface RoutingPreferences {
  providerPriority: string[]; // ordered highest priority first, e.g. ['google', 'openrouter', 'groq']
}

function hasMultimodalImages(request: NormalizedChatRequest): boolean {
  return request.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url')
  );
}

const FAILURE_PENALTY_HALF_LIFE_MS = 600_000;

interface FailurePenaltyState {
  penalty: number;
  updatedAtMs: number;
}

function defaultProviderBaselineLatencyMs(providerId: string): number {
  switch (providerId) {
    case 'groq':
    case 'sambanova':
      return 300;
    case 'ollama':
      return 600;
    case 'google':
    case 'mistral':
    case 'cloudflare':
    case 'cohere':
      return 1100;
    case 'openrouter':
      return 3200;
    default:
      return 1600;
  }
}

export class RoutingEngine {
  private readonly registry: ModelRegistry;
  private readonly policy: FreeInferencePolicy;
  private readonly contextManager: ContextManager;
  private readonly providerRegistry?: ProviderRegistry;
  private readonly latencyEwmaMs = new Map<string, number>();
  private readonly failurePenalties = new Map<string, FailurePenaltyState>();
  private preferences: RoutingPreferences;

  constructor(params: {
    registry: ModelRegistry;
    policy: FreeInferencePolicy;
    contextManager: ContextManager;
    providerRegistry?: ProviderRegistry;
    preferences?: Partial<RoutingPreferences>;
  }) {
    this.registry = params.registry;
    this.policy = params.policy;
    this.contextManager = params.contextManager;
    this.providerRegistry = params.providerRegistry;
    this.preferences = {
      providerPriority: params.preferences?.providerPriority ?? [...DEFAULT_PROVIDER_PRIORITY],
    };
  }

  public setProviderPriority(priority: string[]): void {
    this.preferences = {
      ...this.preferences,
      providerPriority: [...priority],
    };
  }

  public getProviderPriority(): string[] {
    return [...this.preferences.providerPriority];
  }

  public recordObservedLatency(canonicalId: string, latencyMs: number): void {
    const prev = this.latencyEwmaMs.get(canonicalId);
    const next = prev === undefined ? latencyMs : prev * 0.65 + latencyMs * 0.35;
    this.latencyEwmaMs.set(canonicalId, Math.round(next));

    // A fast clean response decays half of any recent failure penalty immediately
    const existingPenalty = this.getActiveFailurePenalty(canonicalId);
    if (existingPenalty > 0) {
      this.failurePenalties.set(canonicalId, {
        penalty: Math.round(existingPenalty * 0.5 * 100) / 100,
        updatedAtMs: Date.now(),
      });
    }
  }

  public recordObservedFailure(canonicalId: string, category: string, elapsedMs?: number): void {
    const current = this.getActiveFailurePenalty(canonicalId);
    const increment =
      category === 'timeout'
        ? 16
        : category === 'model_unavailable' || category === 'upstream_5xx' || category === 'network_error'
          ? 10
          : category === 'rate_limit'
            ? 6
            : 4;
    this.failurePenalties.set(canonicalId, {
      penalty: Math.min(30, current + increment),
      updatedAtMs: Date.now(),
    });
    if (elapsedMs !== undefined && elapsedMs > 0 && category === 'timeout') {
      this.latencyEwmaMs.set(
        canonicalId,
        Math.max(this.latencyEwmaMs.get(canonicalId) ?? 0, elapsedMs)
      );
    }
  }

  private getActiveFailurePenalty(canonicalId: string, nowMs = Date.now()): number {
    const entry = this.failurePenalties.get(canonicalId);
    if (!entry || entry.penalty <= 0.1) return 0;
    const elapsed = Math.max(0, nowMs - entry.updatedAtMs);
    const decayed = entry.penalty * Math.pow(0.5, elapsed / FAILURE_PENALTY_HALF_LIFE_MS);
    return decayed >= 0.2 ? Math.round(decayed * 100) / 100 : 0;
  }

  public getObservedLatency(canonicalId: string): number | undefined {
    return this.latencyEwmaMs.get(canonicalId);
  }

  private inferEffectiveProfile(requested: RoutingProfile, request: NormalizedChatRequest): RoutingProfile {
    if (requested !== 'auto') return requested;
    if (hasMultimodalImages(request)) return 'auto-vision';
    if (request.response_format && request.response_format.type !== 'text') return 'auto-json';
    if (request.tools && request.tools.length > 0) return 'auto-tools';
    return 'auto';
  }

  private scoreModel(
    model: ModelRecord,
    profile: RoutingProfile,
    requiredInputTokens: number,
    complexity: RequestComplexityContext = {},
    outputBudgetConstrained = false
  ): ScoredCandidate {
    const priorityIdx = this.preferences.providerPriority.indexOf(model.providerId);
    const providerPriorityScore =
      priorityIdx >= 0 ? Math.max(1, 20 - priorityIdx * 2) : 0;

    // Context score: normalized log scale rewarding verified 128K -> 1M -> 2M where appropriate
    const ctxNormalized = Math.min(1, Math.log2(Math.max(1024, model.effectiveContextWindow) / 1024) / 11);
    const contextWeight = profile === 'auto-long' ? 38 : profile === 'auto-fast' ? 5 : 16;
    let contextCapacityScore = Math.round(ctxNormalized * contextWeight);
    if (requiredInputTokens > 64_000) {
      contextCapacityScore += Math.round(ctxNormalized * 14);
    }

    let capabilityScore = 0;
    const codingPoints =
      model.codingCapability === 'high' ? 14 : model.codingCapability === 'medium' ? 8 : 2;

    if (profile === 'auto-coding') {
      capabilityScore += codingPoints;
      if (model.supportsTools) capabilityScore += 10;
      if (model.supportsJsonMode) capabilityScore += 5;
      if (model.supportsReasoning) capabilityScore += 5;
    } else if (profile === 'auto-reasoning') {
      capabilityScore += model.supportsReasoning ? 26 : 2;
      capabilityScore += codingPoints * 0.4;
    } else if (profile === 'auto-tools') {
      capabilityScore += model.supportsTools ? 24 : 0;
      capabilityScore += codingPoints * 0.3;
    } else if (profile === 'auto-vision') {
      capabilityScore += model.supportsVision ? 30 : 0;
    } else if (profile === 'auto-json') {
      capabilityScore += model.supportsJsonMode ? 28 : 0;
    } else if (profile === 'auto-long') {
      capabilityScore += model.maxOutputTokens >= 16_384 ? 10 : 4;
      capabilityScore += model.supportsTools ? 6 : 0;
    } else if (profile === 'auto-fast') {
      capabilityScore += codingPoints * 0.2;
    } else {
      capabilityScore += codingPoints * 0.5;
      if (model.supportsTools) capabilityScore += 6;
      if (model.supportsReasoning) capabilityScore += 4;
    }

    const intel = scoreModelIntelligence(model, profile, complexity);
    const intelligenceWeight = profile === 'auto-fast' ? 0.3 : 1.0;
    const intelligenceScore = Math.round(intel.score * intelligenceWeight * 100) / 100;

    const availabilityScore = model.availabilityStatus === 'AVAILABLE' ? 15 : 5;

    const observedLatency = this.latencyEwmaMs.get(model.canonicalId);
    const effectiveLatency = observedLatency ?? defaultProviderBaselineLatencyMs(model.providerId);
    const fastFactor = Math.max(0, 1 - Math.min(effectiveLatency, 4000) / 4000);
    const slowPenalty =
      effectiveLatency > 6000 ? Math.min(18, Math.round((effectiveLatency - 6000) / 2200)) : 0;
    const latencyScore =
      Math.round(fastFactor * (profile === 'auto-fast' ? 38 : 14)) - slowPenalty;

    const reliabilityPenalty = this.getActiveFailurePenalty(model.canonicalId);
    const outputClampPenalty = outputBudgetConstrained ? 15 : 0;

    const totalScore =
      Math.round(
        (providerPriorityScore +
          contextCapacityScore +
          capabilityScore +
          intelligenceScore +
          availabilityScore +
          latencyScore -
          reliabilityPenalty -
          outputClampPenalty) *
          100
      ) / 100;

    const reason = [
      `profile=${profile}`,
      intel.reasonTag,
      `verifiedCtx=${model.effectiveContextWindow}`,
      `coding=${model.codingCapability}`,
      `tools=${model.supportsTools}`,
      `latencyMs=${observedLatency ?? `baseline(${effectiveLatency})`}`,
      ...(outputBudgetConstrained ? ['outputClamped=true'] : []),
      ...(reliabilityPenalty > 0 ? [`penalty=-${reliabilityPenalty}`] : []),
      `score=${totalScore}`,
    ].join(' ');

    return {
      model,
      score: totalScore,
      breakdown: {
        providerPriorityScore,
        contextCapacityScore,
        capabilityScore,
        intelligenceScore,
        availabilityScore,
        latencyScore,
        reliabilityPenalty,
        totalScore,
      },
      reason,
    };
  }

  public async planRoute(
    request: NormalizedChatRequest,
    signal?: AbortSignal
  ): Promise<RoutingPlan> {
    const tokenBreakdown = estimateRequestTokens(request);
    const requiresStreaming = Boolean(request.stream);
    const requiresTools = Boolean(request.tools && request.tools.length > 0);
    const requiresVision = hasMultimodalImages(request);
    const requiresJson = Boolean(request.response_format && request.response_format.type !== 'text');

    if (!isRoutingProfile(request.model)) {
      const explicitMatches = this.registry.findByModelId(request.model);
      if (explicitMatches.length === 0) {
        throw OpenAIErrorResponse.notFound(
          `Model "${request.model}" is not registered or discovered in UjjwalRouter.`
        );
      }

      const policyDecisions = explicitMatches.map((model) => ({
        model,
        decision: this.policy.evaluateModel(model),
      }));

      const eligible = policyDecisions.filter((d) => d.decision.allowed).map((d) => d.model);
      if (eligible.length === 0) {
        const firstRejection = policyDecisions[0]!.decision;
        throw OpenAIErrorResponse.forbidden(
          `Requested model "${request.model}" is blocked by STRICT_FREE_ONLY: ${firstRejection.reasons.join('; ')}`,
          firstRejection.code.toLowerCase()
        );
      }

      const capable = eligible.filter((m) => {
        if (requiresStreaming && !m.supportsStreaming) return false;
        if (requiresVision && !m.supportsVision) return false;
        return true;
      });

      if (capable.length === 0) {
        throw OpenAIErrorResponse.badRequest(
          `Requested model "${request.model}" does not support required capabilities (${[
            requiresStreaming ? 'streaming' : '',
            requiresVision ? 'vision' : '',
          ]
            .filter(Boolean)
            .join(', ')}).`,
          'model',
          'unsupported_model_capability'
        );
      }

      const fitting: ScoredCandidate[] = [];
      const contextFailures: string[] = [];

      for (const model of capable) {
        const adapter = this.providerRegistry?.get(model.providerId);
        const check = await this.contextManager.checkWithOptionalNativeCount({
          request,
          model,
          adapter,
          breakdown: tokenBreakdown,
          signal,
        });
        if (check.fits) {
          fitting.push(
            this.scoreModel(
              model,
              'auto',
              check.effectiveInputTokens,
              {},
              Boolean(check.outputBudgetConstrained)
            )
          );
        } else {
          contextFailures.push(check.reason);
        }
      }

      if (fitting.length === 0) {
        throw OpenAIErrorResponse.contextLengthExceeded(
          contextFailures[0] ??
            `Input (~${tokenBreakdown.estimatedInputTokens} tokens) exceeds context window of "${request.model}".`
        );
      }

      fitting.sort((a, b) => b.score - a.score || a.model.canonicalId.localeCompare(b.model.canonicalId));

      return {
        requestedModel: request.model,
        profile: 'explicit',
        tokenBreakdown,
        candidates: fitting,
        explanation: `Explicit verified free model selected: ${fitting[0]!.model.canonicalId} (${fitting[0]!.reason}).`,
      };
    }

    const effectiveProfile = this.inferEffectiveProfile(request.model, request);
    const eligibleModels = this.registry.listEligibleFreeModels();

    if (eligibleModels.length === 0) {
      throw OpenAIErrorResponse.noFreeModelsAvailable(
        'No FREE_VERIFIED models are currently available under STRICT_FREE_ONLY.'
      );
    }

    const capabilityFiltered = eligibleModels.filter((model) => {
      if (requiresStreaming && !model.supportsStreaming) return false;
      if (requiresTools && !model.supportsTools) return false;
      if (requiresVision && !model.supportsVision) return false;
      if (requiresJson && !model.supportsJsonMode) return false;
      return profileMatchesModel(effectiveProfile, model);
    });

    const strictProfile =
      effectiveProfile === 'auto-long' ||
      effectiveProfile === 'auto-tools' ||
      effectiveProfile === 'auto-vision' ||
      effectiveProfile === 'auto-json';

    const pool =
      capabilityFiltered.length > 0 || strictProfile
        ? capabilityFiltered
        : eligibleModels.filter((model) => {
            if (requiresStreaming && !model.supportsStreaming) return false;
            if (requiresTools && !model.supportsTools) return false;
            if (requiresVision && !model.supportsVision) return false;
            if (requiresJson && !model.supportsJsonMode) return false;
            return true;
          });

    if (pool.length === 0) {
      throw OpenAIErrorResponse.noFreeModelsAvailable(
        `No FREE_VERIFIED model satisfies request requirements for profile "${request.model}" (streaming=${requiresStreaming}, tools=${requiresTools}, vision=${requiresVision}, json=${requiresJson}).`
      );
    }

    const fitting: ScoredCandidate[] = [];
    const contextReasons: string[] = [];
    const complexity: RequestComplexityContext = {
      estimatedInputTokens: tokenBreakdown.estimatedInputTokens,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      hasResponseFormat: requiresJson,
    };

    for (const model of pool) {
      const adapter = this.providerRegistry?.get(model.providerId);
      const check = await this.contextManager.checkWithOptionalNativeCount({
        request,
        model,
        adapter,
        breakdown: tokenBreakdown,
        signal,
      });
      if (check.fits) {
        fitting.push(
          this.scoreModel(
            model,
            effectiveProfile,
            check.effectiveInputTokens,
            complexity,
            Boolean(check.outputBudgetConstrained)
          )
        );
      } else {
        contextReasons.push(check.reason);
      }
    }

    if (fitting.length === 0) {
      const maxAvailableCtx = Math.max(...pool.map((m) => m.effectiveContextWindow));
      throw OpenAIErrorResponse.contextLengthExceeded(
        `Request requires ~${tokenBreakdown.estimatedInputTokens} input tokens plus output/safety margin, exceeding maximum verified free context (${maxAvailableCtx} tokens). ${contextReasons[0] ?? ''}`
      );
    }

    fitting.sort((a, b) => b.score - a.score || a.model.canonicalId.localeCompare(b.model.canonicalId));

    const winner = fitting[0]!;
    return {
      requestedModel: request.model,
      profile: effectiveProfile,
      tokenBreakdown,
      candidates: fitting,
      explanation: `Selected ${winner.model.canonicalId} for "${effectiveProfile}" among ${fitting.length} fitting FREE_VERIFIED model(s): ${winner.reason}`,
    };
  }
}
