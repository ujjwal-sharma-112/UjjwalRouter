import { FreeInferencePolicy, type PolicyEvaluationOptions } from '../policy/free-inference-policy.js';
import type { ModelAvailabilityStatus, ModelRecord, PolicyEvaluationResult } from '../policy/types.js';
import { computeEffectiveContextWindow } from '../capabilities/context-limits.js';

export interface ModelFilterCriteria {
  providerId?: string;
  minContextWindow?: number;
  requiresTools?: boolean;
  requiresStreaming?: boolean;
  requiresVision?: boolean;
  requiresJsonMode?: boolean;
  requiresReasoning?: boolean;
  codingOnly?: boolean;
  onlyVerifiedFree?: boolean;
  onlyAvailable?: boolean;
}

export interface EvaluatedModelEntry {
  model: ModelRecord;
  policy: PolicyEvaluationResult;
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelRecord>();
  private readonly temporaryUnavailableUntilMs = new Map<string, number>();
  private readonly policy: FreeInferencePolicy;

  constructor(policy: FreeInferencePolicy = new FreeInferencePolicy()) {
    this.policy = policy;
  }

  public upsertModels(records: readonly ModelRecord[]): void {
    const nowMs = Date.now();
    for (const record of records) {
      const effectiveContextWindow = computeEffectiveContextWindow({
        advertisedContextWindow: record.contextWindow,
        providerInputLimit: record.providerInputLimit,
        accountFreeInputLimit: record.accountFreeInputLimit,
      });

      const blockedUntil = this.temporaryUnavailableUntilMs.get(record.canonicalId);
      let availabilityStatus = record.availabilityStatus;
      if (blockedUntil !== undefined) {
        if (blockedUntil > nowMs) {
          availabilityStatus = 'UNAVAILABLE';
        } else {
          this.temporaryUnavailableUntilMs.delete(record.canonicalId);
        }
      }

      this.models.set(record.canonicalId, {
        ...record,
        availabilityStatus,
        effectiveContextWindow,
      });
    }
  }

  public replaceProviderModels(providerId: string, records: readonly ModelRecord[]): void {
    for (const [canonicalId, existing] of this.models.entries()) {
      if (existing.providerId === providerId) {
        this.models.delete(canonicalId);
      }
    }
    this.upsertModels(records);
  }

  public getByCanonicalId(canonicalId: string): ModelRecord | undefined {
    return this.models.get(canonicalId);
  }

  public findByModelId(modelId: string, providerId?: string): ModelRecord[] {
    const results: ModelRecord[] = [];
    for (const model of this.models.values()) {
      if (providerId && model.providerId !== providerId) continue;
      if (model.canonicalId === modelId || model.id === modelId) {
        results.push(model);
      }
    }
    return results;
  }

  public updateAvailability(
    canonicalId: string,
    status: ModelAvailabilityStatus,
    checkedAt: string = new Date().toISOString()
  ): void {
    const existing = this.models.get(canonicalId);
    if (!existing) return;
    this.models.set(canonicalId, {
      ...existing,
      availabilityStatus: status,
      lastCheckedAt: checkedAt,
    });
  }

  public markModelUnavailable(canonicalId: string, durationMs = 21_600_000): void {
    this.temporaryUnavailableUntilMs.set(canonicalId, Date.now() + durationMs);
    this.updateAvailability(canonicalId, 'UNAVAILABLE');
  }

  public markQuotaExhausted(canonicalId: string, resetAt?: string | null): void {
    const existing = this.models.get(canonicalId);
    if (!existing) return;
    this.models.set(canonicalId, {
      ...existing,
      freeEligibility: 'QUOTA_EXHAUSTED',
      availabilityStatus: 'UNAVAILABLE',
      quotaInfo: {
        ...existing.quotaInfo,
        remainingRequests: 0,
        resetAt: resetAt ?? existing.quotaInfo.resetAt ?? null,
      },
      lastCheckedAt: new Date().toISOString(),
    });
  }

  public listAllModels(): ModelRecord[] {
    return Array.from(this.models.values());
  }

  public listEvaluatedModels(options: PolicyEvaluationOptions = {}): EvaluatedModelEntry[] {
    return this.listAllModels().map((model) => ({
      model,
      policy: this.policy.evaluateModel(model, options),
    }));
  }

  public listEligibleFreeModels(options: PolicyEvaluationOptions = {}): ModelRecord[] {
    return this.policy.filterEligibleModels(this.listAllModels(), options);
  }

  public queryModels(
    criteria: ModelFilterCriteria = {},
    policyOptions: PolicyEvaluationOptions = {}
  ): EvaluatedModelEntry[] {
    return this.listEvaluatedModels(policyOptions).filter(({ model, policy }) => {
      if (criteria.providerId && model.providerId !== criteria.providerId) return false;
      if (criteria.onlyVerifiedFree && !policy.allowed) return false;
      if (criteria.onlyAvailable && model.availabilityStatus !== 'AVAILABLE') return false;
      if (criteria.minContextWindow && model.effectiveContextWindow < criteria.minContextWindow) {
        return false;
      }
      if (criteria.requiresTools && !model.supportsTools) return false;
      if (criteria.requiresStreaming && !model.supportsStreaming) return false;
      if (criteria.requiresVision && !model.supportsVision) return false;
      if (criteria.requiresJsonMode && !model.supportsJsonMode) return false;
      if (criteria.requiresReasoning && !model.supportsReasoning) return false;
      if (criteria.codingOnly && model.codingCapability !== 'high' && model.codingCapability !== 'medium') {
        return false;
      }
      return true;
    });
  }

  public clear(): void {
    this.models.clear();
  }
}
