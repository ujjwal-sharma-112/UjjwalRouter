import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import type { ModelDiscoveryService, DiscoveryReport } from '../core/model-discovery/model-discovery-service.js';
import type { ModelRegistry } from '../core/model-registry/model-registry.js';
import type { ProviderRegistry } from '../providers/base/provider-registry.js';
import type { ProviderHealthResult } from '../providers/base/types.js';
import type { RouterRepository } from '../database/repositories/router-repository.js';
import type { ApiKeyValidator } from '../security/auth.js';
import { createStaticKeyValidator } from '../security/auth.js';

export class RouterLifecycleService {
  private readonly config: AppConfig;
  private readonly repository: RouterRepository;
  private readonly providerRegistry: ProviderRegistry;
  private readonly modelRegistry: ModelRegistry;
  private readonly discoveryService: ModelDiscoveryService;
  private readonly logger?: Logger;
  private healthTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    config: AppConfig;
    repository: RouterRepository;
    providerRegistry: ProviderRegistry;
    modelRegistry: ModelRegistry;
    discoveryService: ModelDiscoveryService;
    logger?: Logger;
  }) {
    this.config = params.config;
    this.repository = params.repository;
    this.providerRegistry = params.providerRegistry;
    this.modelRegistry = params.modelRegistry;
    this.discoveryService = params.discoveryService;
    this.logger = params.logger;
  }

  public syncProvidersToDb(): void {
    const adapters = this.providerRegistry.getAll();
    adapters.forEach((adapter, idx) => {
      this.repository.upsertProvider(adapter.getInfo(), idx + 1);
    });
  }

  public async refreshDiscoveryAndPersist(signal?: AbortSignal): Promise<DiscoveryReport> {
    this.syncProvidersToDb();
    const report = await this.discoveryService.refreshAll(signal);

    for (const adapter of this.providerRegistry.getAll()) {
      const modelsForProvider = this.modelRegistry
        .listAllModels()
        .filter((m) => m.providerId === adapter.id);
      this.repository.syncProviderModels(adapter.id, modelsForProvider);
    }

    return report;
  }

  public async runHealthChecksAndPersist(signal?: AbortSignal): Promise<ProviderHealthResult[]> {
    this.syncProvidersToDb();
    const results = await this.discoveryService.checkAllHealth(signal);
    for (const res of results) {
      this.repository.recordProviderHealth(res);
    }
    return results;
  }

  public runRetentionCleanup(): { deletedRequests: number; deletedChecks: number; deletedAudit: number } {
    const rawDays = this.repository.getSetting('log_retention_days');
    const days = rawDays ? Math.max(1, Number.parseInt(rawDays, 10) || this.config.logRetentionDays) : this.config.logRetentionDays;
    return this.repository.pruneOldLogs(days);
  }

  public startBackgroundTasks(): void {
    this.stopBackgroundTasks();
    const discoveryInterval = this.config.discoveryRefreshIntervalMs;
    const healthInterval = this.config.healthCheckIntervalMs;

    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscoveryAndPersist().catch((err) => {
        this.logger?.warn({ err }, 'Periodic discovery refresh failed');
      });
    }, discoveryInterval);
    this.discoveryTimer.unref();

    this.healthTimer = setInterval(() => {
      void this.runHealthChecksAndPersist().catch((err) => {
        this.logger?.warn({ err }, 'Periodic health check failed');
      });
      this.runRetentionCleanup();
    }, healthInterval);
    this.healthTimer.unref();
  }

  public stopBackgroundTasks(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

export function createCombinedApiKeyValidator(
  configuredStaticKeys: string[],
  repository: RouterRepository
): ApiKeyValidator {
  const staticValidator = createStaticKeyValidator(configuredStaticKeys);

  return async (rawToken: string) => {
    const staticMatch = await staticValidator(rawToken);
    if (staticMatch.valid) {
      return staticMatch;
    }
    return repository.validateDbApiKey(rawToken);
  };
}
