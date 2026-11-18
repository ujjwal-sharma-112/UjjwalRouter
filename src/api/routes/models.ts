import type { FastifyInstance } from 'fastify';
import type { ModelRegistry } from '../../core/model-registry/model-registry.js';
import { ROUTING_PROFILES, profileMatchesModel } from '../../core/router/profiles.js';
import type { ApiKeyValidator } from '../../security/auth.js';
import { createBearerAuthHook } from '../../security/auth.js';

export interface ModelsRouteDeps {
  registry: ModelRegistry;
  apiKeyValidator: ApiKeyValidator;
}

export async function registerModelsRoutes(
  app: FastifyInstance,
  deps: ModelsRouteDeps
): Promise<void> {
  const authenticate = createBearerAuthHook(deps.apiKeyValidator);

  app.get('/v1/models', { preHandler: [authenticate] }, async (_request, reply) => {
    const eligibleModels = deps.registry.listEligibleFreeModels();
    const createdTimestamp = Math.floor(Date.now() / 1000);

    const profileEntries = ROUTING_PROFILES.flatMap((profile) => {
      const matching = eligibleModels.filter((model) => profileMatchesModel(profile, model));
      if (matching.length === 0) {
        return [];
      }
      const maxVerifiedContext = Math.max(...matching.map((m) => m.effectiveContextWindow));
      const maxVerifiedOutput = Math.max(...matching.map((m) => m.maxOutputTokens));
      return [
        {
          id: profile,
          object: 'model' as const,
          created: createdTimestamp,
          owned_by: 'ujjwalrouter',
          context_window: maxVerifiedContext,
          max_output_tokens: maxVerifiedOutput,
          free_eligibility: 'FREE_VERIFIED' as const,
          eligible_model_count: matching.length,
        },
      ];
    });

    const concreteEntries = eligibleModels.map((model) => ({
      id: model.canonicalId,
      object: 'model' as const,
      created: model.freeVerifiedAt
        ? Math.floor(Date.parse(model.freeVerifiedAt) / 1000) || createdTimestamp
        : createdTimestamp,
      owned_by: model.providerId,
      provider_model_id: model.id,
      display_name: model.displayName,
      context_window: model.effectiveContextWindow,
      advertised_context_window: model.contextWindow,
      max_output_tokens: model.maxOutputTokens,
      supports_tools: model.supportsTools,
      supports_streaming: model.supportsStreaming,
      supports_vision: model.supportsVision,
      supports_json_mode: model.supportsJsonMode,
      supports_reasoning: model.supportsReasoning,
      free_eligibility: model.freeEligibility,
      free_tier_type: model.freeTierType,
      free_verified_at: model.freeVerifiedAt,
      free_verification_source: model.freeVerificationSource,
    }));

    return reply.code(200).send({
      object: 'list',
      data: [...profileEntries, ...concreteEntries],
    });
  });
}
