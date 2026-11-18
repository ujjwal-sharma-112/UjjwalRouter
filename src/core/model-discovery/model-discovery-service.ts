import type { Logger } from 'pino';
import type { ModelRegistry } from '../model-registry/model-registry.js';
import type { FreeInferencePolicy } from '../policy/free-inference-policy.js';
import type { ProviderRegistry } from '../../providers/base/provider-registry.js';
import type { ProviderHealthResult } from '../../providers/base/types.js';

export interface DiscoveryReport {
  refreshedAt: string;
  providers: Array<{
    providerId: string;
    discoveredCount: number;
    eligibleFreeCount: number;
    error?: string;
  }>;
}

export class ModelDiscoveryService {
  private readonly providerRegistry: ProviderRegistry;
  private readonly modelRegistry: ModelRegistry;
  private readonly policy: FreeInferencePolicy;
  private readonly logger?: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastReport: DiscoveryReport | null = null;

  constructor(params: {
    providerRegistry: ProviderRegistry;
    modelRegistry: ModelRegistry;
    policy: FreeInferencePolicy;
    logger?: Logger;
  }) {
    this.providerRegistry = params.providerRegistry;
    this.modelRegistry = params.modelRegistry;
    this.policy = params.policy;
    this.logger = params.logger;
  }

  public getLastReport(): DiscoveryReport | null {
    return this.lastReport;
  }

  public async refreshAll(signal?: AbortSignal): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      refreshedAt: new Date().toISOString(),
      providers: [],
    };

    for (const adapter of this.providerRegistry.getAll()) {
      if (!adapter.isEnabled()) {
        this.modelRegistry.replaceProviderModels(adapter.id, []);
        report.providers.push({
          providerId: adapter.id,
          discoveredCount: 0,
          eligibleFreeCount: 0,
        });
        continue;
      }

      try {
        const discovered = await adapter.discoverModels(signal);
        this.modelRegistry.replaceProviderModels(adapter.id, discovered);
        const eligibleCount = this.policy.filterEligibleModels(discovered).length;
        report.providers.push({
          providerId: adapter.id,
          discoveredCount: discovered.length,
          eligibleFreeCount: eligibleCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Discovery failed';
        this.logger?.warn({ providerId: adapter.id, err: message }, 'Provider model discovery failed');
        report.providers.push({
          providerId: adapter.id,
          discoveredCount: 0,
          eligibleFreeCount: 0,
          error: message,
        });
      }
    }

    this.lastReport = report;
    return report;
  }

  public async checkAllHealth(signal?: AbortSignal): Promise<ProviderHealthResult[]> {
    const results: ProviderHealthResult[] = [];
    for (const adapter of this.providerRegistry.getAll()) {
      results.push(await adapter.healthCheck(signal));
    }
    return results;
  }

  public startPeriodicRefresh(intervalMs: number): void {
    this.stopPeriodicRefresh();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, intervalMs);
    this.timer.unref();
  }

  public stopPeriodicRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
