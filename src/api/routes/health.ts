import type { FastifyInstance } from 'fastify';
import type { ModelRegistry } from '../../core/model-registry/model-registry.js';
import type { ProviderAdapter } from '../../providers/base/provider-adapter.js';

export interface HealthRouteDeps {
  registry: ModelRegistry;
  adapters: Map<string, ProviderAdapter>;
  startedAt: string;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRouteDeps
): Promise<void> {
  app.get('/health', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      service: 'ujjwalrouter',
      strict_free_only: true,
      started_at: deps.startedAt,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_request, reply) => {
    const eligibleModels = deps.registry.listEligibleFreeModels();
    const enabledProviders = Array.from(deps.adapters.values()).filter((a) => a.isEnabled());
    const ready = eligibleModels.length > 0;

    return reply.code(ready ? 200 : 503).send({
      ready,
      strict_free_only: true,
      verified_free_model_count: eligibleModels.length,
      enabled_provider_count: enabledProviders.length,
      reason: ready
        ? 'At least one FREE_VERIFIED model is available.'
        : 'No FREE_VERIFIED models are currently eligible.',
      timestamp: new Date().toISOString(),
    });
  });
}
