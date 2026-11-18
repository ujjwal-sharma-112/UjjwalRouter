import crypto from 'node:crypto';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { ModelRecord } from '../../core/policy/types.js';
import type { RequestExecutionLog, UsageSink } from '../../core/usage/usage-tracker.js';
import type { ProviderAdapterInfo, ProviderHealthResult } from '../../providers/base/types.js';
import { ROUTING_PROFILES } from '../../core/router/profiles.js';
import { generateApiKey, hashApiKey } from '../../security/secrets.js';
import type { RouterDatabase } from '../connection.js';
import {
  apiKeys,
  auditLogs,
  dailyUsage,
  freeEligibilityChecks,
  modelCapabilities,
  models,
  providerHealth,
  providerQuotas,
  providers,
  requestAttempts,
  requests,
  routingProfiles,
  routingRules,
  settings,
  usageRecords,
} from '../schema/schema.js';

export interface RequestLogFilter {
  status?: 'success' | 'error';
  providerId?: string;
  model?: string;
  profile?: string;
  limit?: number;
  offset?: number;
}

export interface AnalyticsSummary {
  totals: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
    failoverEvents: number;
    rateLimitEvents: number;
  };
  requestsOverTime: Array<{
    date: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    failovers: number;
    rateLimits: number;
    avgLatencyMs: number;
  }>;
  byProvider: Array<{
    providerId: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
  byModel: Array<{
    modelId: string;
    providerId: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
}

const PROFILE_DESCRIPTIONS: Record<string, { name: string; desc: string }> = {
  auto: { name: 'Auto (Balanced Free)', desc: 'Balanced selection across all verified free models.' },
  'auto-coding': { name: 'Auto Coding', desc: 'Prioritizes coding quality, tool calling, and structured outputs.' },
  'auto-reasoning': { name: 'Auto Reasoning', desc: 'Prioritizes reasoning-capable free models.' },
  'auto-long': { name: 'Auto Long Context', desc: 'Prioritizes maximum verified context window (128K-2M).' },
  'auto-fast': { name: 'Auto Fast', desc: 'Prioritizes lowest latency and highest free throughput.' },
  'auto-tools': { name: 'Auto Tools', desc: 'Requires verified function/tool calling support.' },
  'auto-vision': { name: 'Auto Vision', desc: 'Requires verified multimodal image input support.' },
  'auto-json': { name: 'Auto JSON', desc: 'Requires verified JSON / structured output support.' },
};

export class RouterRepository implements UsageSink {
  private readonly db: RouterDatabase;

  constructor(db: RouterDatabase) {
    this.db = db;
  }

  public seedDefaults(defaults: {
    defaultRoutingProfile: string;
    logRetentionDays: number;
    contextSafetyMarginPct: number;
    healthCheckIntervalMs: number;
    providerPriority: string[];
  }): void {
    const now = new Date().toISOString();

    for (const profile of ROUTING_PROFILES) {
      const meta = PROFILE_DESCRIPTIONS[profile] ?? { name: profile, desc: profile };
      this.db
        .insert(routingProfiles)
        .values({
          id: profile,
          displayName: meta.name,
          description: meta.desc,
          enabled: true,
          isDefault: profile === defaults.defaultRoutingProfile,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: routingProfiles.id,
          set: {
            isDefault: profile === defaults.defaultRoutingProfile,
            updatedAt: now,
          },
        })
        .run();
    }

    // STRICT_FREE_ONLY is permanently locked immutable in settings
    this.db
      .insert(settings)
      .values({
        key: 'strict_free_only',
        value: 'true',
        immutable: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: 'true', immutable: true, updatedAt: now },
      })
      .run();

    const mutableDefaults: Array<[string, string]> = [
      ['default_routing_profile', defaults.defaultRoutingProfile],
      ['log_retention_days', String(defaults.logRetentionDays)],
      ['context_safety_margin_pct', String(defaults.contextSafetyMarginPct)],
      ['health_check_interval_ms', String(defaults.healthCheckIntervalMs)],
      ['provider_priority', JSON.stringify(defaults.providerPriority)],
    ];

    for (const [key, value] of mutableDefaults) {
      this.db
        .insert(settings)
        .values({ key, value, immutable: false, updatedAt: now })
        .onConflictDoNothing()
        .run();
    }
  }

  public upsertProvider(info: ProviderAdapterInfo, priority = 100): void {
    const now = new Date().toISOString();
    this.db
      .insert(providers)
      .values({
        id: info.id,
        displayName: info.displayName,
        endpointUrl: info.endpointUrl,
        enabled: info.enabled,
        configured: info.configured,
        priority,
        freeTierNotes: info.notes ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providers.id,
        set: {
          displayName: info.displayName,
          endpointUrl: info.endpointUrl,
          enabled: info.enabled,
          configured: info.configured,
          freeTierNotes: info.notes ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  public syncProviderModels(providerId: string, modelList: readonly ModelRecord[]): void {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.delete(models).where(eq(models.providerId, providerId)).run();

      for (const m of modelList) {
        tx.insert(models)
          .values({
            canonicalId: m.canonicalId,
            modelId: m.id,
            providerId: m.providerId,
            displayName: m.displayName,
            contextWindow: m.contextWindow,
            providerInputLimit: m.providerInputLimit,
            accountFreeInputLimit: m.accountFreeInputLimit,
            effectiveContextWindow: m.effectiveContextWindow,
            maxOutputTokens: m.maxOutputTokens,
            inputPrice: m.inputPrice,
            outputPrice: m.outputPrice,
            requestPrice: m.requestPrice,
            imagePrice: m.imagePrice,
            freeEligibility: m.freeEligibility,
            freeTierType: m.freeTierType,
            billingRequired: m.billingRequired,
            promotionalCredits: m.promotionalCredits,
            freeVerifiedAt: m.freeVerifiedAt,
            verificationExpiresAt: m.verificationExpiresAt,
            freeVerificationSource: m.freeVerificationSource,
            availabilityStatus: m.availabilityStatus,
            lastCheckedAt: m.lastCheckedAt ?? now,
          })
          .run();

        tx.insert(modelCapabilities)
          .values({
            canonicalId: m.canonicalId,
            supportsStreaming: m.supportsStreaming,
            supportsTools: m.supportsTools,
            supportsVision: m.supportsVision,
            supportsJsonMode: m.supportsJsonMode,
            supportsReasoning: m.supportsReasoning,
            codingCapability: m.codingCapability,
            updatedAt: now,
          })
          .run();

        tx.insert(freeEligibilityChecks)
          .values({
            providerId: m.providerId,
            canonicalModelId: m.canonicalId,
            eligible: m.freeEligibility === 'FREE_VERIFIED',
            freeEligibility: m.freeEligibility,
            freeTierType: m.freeTierType,
            billingRequired: m.billingRequired,
            promotionalCredits: m.promotionalCredits,
            verificationSource: m.freeVerificationSource ?? 'unknown',
            reason: m.quotaInfo.notes ?? m.freeEligibility,
            checkedAt: now,
          })
          .run();
      }
    });
  }

  public recordProviderHealth(result: ProviderHealthResult): void {
    this.db
      .insert(providerHealth)
      .values({
        providerId: result.providerId,
        healthy: result.healthy,
        status: result.status,
        latencyMs: result.latencyMs,
        message: result.message,
        checkedAt: result.checkedAt,
      })
      .run();

    if (result.quotaInfo) {
      this.db
        .insert(providerQuotas)
        .values({
          providerId: result.providerId,
          rpmLimit: result.quotaInfo.rpmLimit ?? null,
          rpdLimit: result.quotaInfo.rpdLimit ?? null,
          tpmLimit: result.quotaInfo.tpmLimit ?? null,
          monthlyLimit: result.quotaInfo.monthlyLimit ?? null,
          remainingRequests: result.quotaInfo.remainingRequests ?? null,
          remainingTokens: result.quotaInfo.remainingTokens ?? null,
          resetAt: result.quotaInfo.resetAt ?? null,
          notes: result.quotaInfo.notes ?? null,
          updatedAt: result.checkedAt,
        })
        .onConflictDoUpdate({
          target: providerQuotas.providerId,
          set: {
            rpmLimit: result.quotaInfo.rpmLimit ?? null,
            rpdLimit: result.quotaInfo.rpdLimit ?? null,
            tpmLimit: result.quotaInfo.tpmLimit ?? null,
            monthlyLimit: result.quotaInfo.monthlyLimit ?? null,
            remainingRequests: result.quotaInfo.remainingRequests ?? null,
            remainingTokens: result.quotaInfo.remainingTokens ?? null,
            resetAt: result.quotaInfo.resetAt ?? null,
            notes: result.quotaInfo.notes ?? null,
            updatedAt: result.checkedAt,
          },
        })
        .run();
    }
  }

  public getLatestProviderHealth(): Array<{
    providerId: string;
    healthy: boolean;
    status: string;
    latencyMs: number;
    message: string;
    checkedAt: string;
  }> {
    const rows = this.db
      .select()
      .from(providerHealth)
      .orderBy(desc(providerHealth.id))
      .limit(100)
      .all();

    const latestByProvider = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByProvider.has(row.providerId)) {
        latestByProvider.set(row.providerId, row);
      }
    }
    return Array.from(latestByProvider.values());
  }

  public recordRequest(entry: RequestExecutionLog): void {
    const dateKey = entry.timestamp.slice(0, 10);
    const providerKey = entry.selectedProvider ?? 'none';
    const modelKey = entry.selectedModel ?? entry.requestedModel;
    const rateLimitHits = entry.attempts.filter((a) => a.errorCategory === 'rate_limit').length;

    this.db.transaction((tx) => {
      tx.insert(requests)
        .values({
          id: entry.requestId,
          timestamp: entry.timestamp,
          requestedModel: entry.requestedModel,
          effectiveProfile: entry.effectiveProfile,
          selectedProvider: entry.selectedProvider,
          selectedModel: entry.selectedModel,
          estimatedInputTokens: entry.estimatedInputTokens,
          actualInputTokens: entry.actualInputTokens,
          actualOutputTokens: entry.actualOutputTokens,
          latencyMs: entry.latencyMs,
          failoverCount: entry.failoverCount,
          stream: entry.stream,
          status: entry.status,
          errorCode: entry.errorCode ?? null,
          errorMessage: entry.errorMessage ? entry.errorMessage.slice(0, 500) : null,
          routingExplanation: entry.routingExplanation ?? null,
        })
        .run();

      for (const attempt of entry.attempts) {
        tx.insert(requestAttempts)
          .values({
            requestId: entry.requestId,
            attemptNumber: attempt.attemptNumber,
            providerId: attempt.providerId,
            modelId: attempt.modelId,
            canonicalModelId: attempt.canonicalId,
            outcome: attempt.outcome,
            latencyMs: attempt.latencyMs,
            errorCategory: attempt.errorCategory ?? null,
            statusCode: attempt.statusCode ?? null,
            reason: attempt.reason.slice(0, 500),
            timestamp: attempt.timestamp,
          })
          .run();
      }

      if (entry.selectedProvider && entry.selectedModel && entry.status === 'success') {
        tx.insert(usageRecords)
          .values({
            requestId: entry.requestId,
            providerId: entry.selectedProvider,
            canonicalModelId: entry.selectedModel,
            inputTokens: entry.actualInputTokens,
            outputTokens: entry.actualOutputTokens,
            totalTokens: entry.actualInputTokens + entry.actualOutputTokens,
            recordedAt: entry.timestamp,
          })
          .run();
      }

      tx.insert(dailyUsage)
        .values({
          dateKey,
          providerId: providerKey,
          canonicalModelId: modelKey,
          requestCount: 1,
          successCount: entry.status === 'success' ? 1 : 0,
          errorCount: entry.status === 'error' ? 1 : 0,
          failoverCount: entry.failoverCount,
          rateLimitCount: rateLimitHits,
          inputTokens: entry.actualInputTokens || entry.estimatedInputTokens,
          outputTokens: entry.actualOutputTokens,
          totalLatencyMs: entry.latencyMs,
        })
        .onConflictDoUpdate({
          target: [dailyUsage.dateKey, dailyUsage.providerId, dailyUsage.canonicalModelId],
          set: {
            requestCount: sql`${dailyUsage.requestCount} + 1`,
            successCount: sql`${dailyUsage.successCount} + ${entry.status === 'success' ? 1 : 0}`,
            errorCount: sql`${dailyUsage.errorCount} + ${entry.status === 'error' ? 1 : 0}`,
            failoverCount: sql`${dailyUsage.failoverCount} + ${entry.failoverCount}`,
            rateLimitCount: sql`${dailyUsage.rateLimitCount} + ${rateLimitHits}`,
            inputTokens: sql`${dailyUsage.inputTokens} + ${entry.actualInputTokens || entry.estimatedInputTokens}`,
            outputTokens: sql`${dailyUsage.outputTokens} + ${entry.actualOutputTokens}`,
            totalLatencyMs: sql`${dailyUsage.totalLatencyMs} + ${entry.latencyMs}`,
          },
        })
        .run();
    });
  }

  public queryRequestLogs(filter: RequestLogFilter = {}): {
    total: number;
    items: Array<typeof requests.$inferSelect>;
  } {
    const conditions = [];
    if (filter.status) conditions.push(eq(requests.status, filter.status));
    if (filter.providerId) conditions.push(eq(requests.selectedProvider, filter.providerId));
    if (filter.model) conditions.push(eq(requests.selectedModel, filter.model));
    if (filter.profile) conditions.push(eq(requests.effectiveProfile, filter.profile));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);

    const countRow = this.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(whereClause)
      .get();

    const items = this.db
      .select()
      .from(requests)
      .where(whereClause)
      .orderBy(desc(requests.timestamp))
      .limit(limit)
      .offset(offset)
      .all();

    return {
      total: countRow?.count ?? 0,
      items,
    };
  }

  public getAnalytics(days = 30): AnalyticsSummary {
    const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .select()
      .from(dailyUsage)
      .where(gte(dailyUsage.dateKey, sinceDate))
      .all();

    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalLatency = 0;
    let failoverEvents = 0;
    let rateLimitEvents = 0;

    const byDateMap = new Map<
      string,
      {
        date: string;
        requests: number;
        errors: number;
        inputTokens: number;
        outputTokens: number;
        failovers: number;
        rateLimits: number;
        totalLatencyMs: number;
      }
    >();
    const byProviderMap = new Map<
      string,
      {
        providerId: string;
        requests: number;
        errors: number;
        inputTokens: number;
        outputTokens: number;
        totalLatencyMs: number;
      }
    >();
    const byModelMap = new Map<
      string,
      {
        modelId: string;
        providerId: string;
        requests: number;
        errors: number;
        inputTokens: number;
        outputTokens: number;
        totalLatencyMs: number;
      }
    >();

    for (const row of rows) {
      totalRequests += row.requestCount;
      successfulRequests += row.successCount;
      failedRequests += row.errorCount;
      totalInputTokens += row.inputTokens;
      totalOutputTokens += row.outputTokens;
      totalLatency += row.totalLatencyMs;
      failoverEvents += row.failoverCount;
      rateLimitEvents += row.rateLimitCount;

      const dEntry = byDateMap.get(row.dateKey) ?? {
        date: row.dateKey,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        failovers: 0,
        rateLimits: 0,
        totalLatencyMs: 0,
      };
      dEntry.requests += row.requestCount;
      dEntry.errors += row.errorCount;
      dEntry.inputTokens += row.inputTokens;
      dEntry.outputTokens += row.outputTokens;
      dEntry.failovers += row.failoverCount;
      dEntry.rateLimits += row.rateLimitCount;
      dEntry.totalLatencyMs += row.totalLatencyMs;
      byDateMap.set(row.dateKey, dEntry);

      if (row.providerId !== 'none') {
        const pEntry = byProviderMap.get(row.providerId) ?? {
          providerId: row.providerId,
          requests: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalLatencyMs: 0,
        };
        pEntry.requests += row.requestCount;
        pEntry.errors += row.errorCount;
        pEntry.inputTokens += row.inputTokens;
        pEntry.outputTokens += row.outputTokens;
        pEntry.totalLatencyMs += row.totalLatencyMs;
        byProviderMap.set(row.providerId, pEntry);
      }

      const mKey = `${row.providerId}::${row.canonicalModelId}`;
      const mEntry = byModelMap.get(mKey) ?? {
        modelId: row.canonicalModelId,
        providerId: row.providerId,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalLatencyMs: 0,
      };
      mEntry.requests += row.requestCount;
      mEntry.errors += row.errorCount;
      mEntry.inputTokens += row.inputTokens;
      mEntry.outputTokens += row.outputTokens;
      mEntry.totalLatencyMs += row.totalLatencyMs;
      byModelMap.set(mKey, mEntry);
    }

    return {
      totals: {
        totalRequests,
        successfulRequests,
        failedRequests,
        totalInputTokens,
        totalOutputTokens,
        avgLatencyMs: totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0,
        failoverEvents,
        rateLimitEvents,
      },
      requestsOverTime: Array.from(byDateMap.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => ({
          date: d.date,
          requests: d.requests,
          errors: d.errors,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          failovers: d.failovers,
          rateLimits: d.rateLimits,
          avgLatencyMs: d.requests > 0 ? Math.round(d.totalLatencyMs / d.requests) : 0,
        })),
      byProvider: Array.from(byProviderMap.values()).map((p) => ({
        providerId: p.providerId,
        requests: p.requests,
        errors: p.errors,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        avgLatencyMs: p.requests > 0 ? Math.round(p.totalLatencyMs / p.requests) : 0,
      })),
      byModel: Array.from(byModelMap.values())
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20)
        .map((m) => ({
          modelId: m.modelId,
          providerId: m.providerId,
          requests: m.requests,
          errors: m.errors,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          avgLatencyMs: m.requests > 0 ? Math.round(m.totalLatencyMs / m.requests) : 0,
        })),
    };
  }

  public createApiKey(name: string): { id: string; name: string; rawKey: string; keyPrefix: string; createdAt: string } {
    const rawKey = generateApiKey('ur_live');
    const id = `key_${crypto.randomUUID()}`;
    const keyPrefix = rawKey.slice(0, 14);
    const keyHash = hashApiKey(rawKey);
    const createdAt = new Date().toISOString();

    this.db
      .insert(apiKeys)
      .values({
        id,
        name,
        keyPrefix,
        keyHash,
        enabled: true,
        createdAt,
        lastUsedAt: null,
      })
      .run();

    this.recordAuditLog('admin', 'api_key.created', id, `Created API key "${name}" (${keyPrefix}...)`);
    return { id, name, rawKey, keyPrefix, createdAt };
  }

  public validateDbApiKey(rawToken: string): { valid: boolean; keyId?: string; keyName?: string } {
    const digest = hashApiKey(rawToken);
    const row = this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, digest), eq(apiKeys.enabled, true)))
      .get();

    if (!row) return { valid: false };

    this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.id))
      .run();

    return { valid: true, keyId: row.id, keyName: row.name };
  }

  public listApiKeys(): Array<{
    id: string;
    name: string;
    keyPrefix: string;
    enabled: boolean;
    createdAt: string;
    lastUsedAt: string | null;
  }> {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        enabled: apiKeys.enabled,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt))
      .all();
  }

  public revokeApiKey(id: string): boolean {
    const result = this.db.update(apiKeys).set({ enabled: false }).where(eq(apiKeys.id, id)).run();
    if (result.changes > 0) {
      this.recordAuditLog('admin', 'api_key.revoked', id, 'Revoked API key');
      return true;
    }
    return false;
  }

  public getSetting(key: string): string | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? row.value : null;
  }

  public getAllSettings(): Array<{ key: string; value: string; immutable: boolean; updatedAt: string }> {
    return this.db.select().from(settings).all();
  }

  public updateSetting(key: string, value: string, actor = 'admin'): void {
    if (key === 'strict_free_only') {
      throw new Error('strict_free_only is immutable and cannot be disabled.');
    }
    const existing = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (existing?.immutable) {
      throw new Error(`Setting "${key}" is immutable.`);
    }
    const now = new Date().toISOString();
    this.db
      .insert(settings)
      .values({ key, value, immutable: false, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: now },
      })
      .run();
    this.recordAuditLog(actor, 'setting.updated', key, `Updated setting "${key}" to "${value}"`);
  }

  public upsertRoutingRule(rule: {
    id: string;
    profileId: string;
    providerId?: string | null;
    weight: number;
    minContextWindow?: number | null;
    requiresTools?: boolean;
    enabled?: boolean;
  }): void {
    const now = new Date().toISOString();
    this.db
      .insert(routingRules)
      .values({
        id: rule.id,
        profileId: rule.profileId,
        providerId: rule.providerId ?? null,
        weight: rule.weight,
        minContextWindow: rule.minContextWindow ?? null,
        requiresTools: rule.requiresTools ?? false,
        enabled: rule.enabled ?? true,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: routingRules.id,
        set: {
          weight: rule.weight,
          minContextWindow: rule.minContextWindow ?? null,
          requiresTools: rule.requiresTools ?? false,
          enabled: rule.enabled ?? true,
        },
      })
      .run();
  }

  public listRoutingProfiles() {
    return this.db.select().from(routingProfiles).all();
  }

  public recordAuditLog(actor: string, action: string, target: string, details: string): void {
    this.db
      .insert(auditLogs)
      .values({
        timestamp: new Date().toISOString(),
        actor,
        action,
        target,
        details: details.slice(0, 1000),
      })
      .run();
  }

  public listAuditLogs(limit = 100) {
    return this.db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit).all();
  }

  public pruneOldLogs(retentionDays: number): { deletedRequests: number; deletedChecks: number; deletedAudit: number } {
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const reqRes = this.db.delete(requests).where(lt(requests.timestamp, cutoffIso)).run();
    const chkRes = this.db
      .delete(freeEligibilityChecks)
      .where(lt(freeEligibilityChecks.checkedAt, cutoffIso))
      .run();
    this.db.delete(providerHealth).where(lt(providerHealth.checkedAt, cutoffIso)).run();
    const audRes = this.db.delete(auditLogs).where(lt(auditLogs.timestamp, cutoffIso)).run();

    return {
      deletedRequests: reqRes.changes,
      deletedChecks: chkRes.changes,
      deletedAudit: audRes.changes,
    };
  }
}
