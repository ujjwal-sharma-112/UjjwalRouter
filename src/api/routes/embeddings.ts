import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { EmbeddingCoordinator } from '../../core/embeddings/embedding-coordinator.js';
import type { UsageSink } from '../../core/usage/usage-tracker.js';
import { createBearerAuthHook, type ApiKeyValidator } from '../../security/auth.js';
import { OpenAIErrorResponse } from '../errors/openai-error.js';
import { embeddingRequestSchema } from '../schemas/embeddings.js';

export interface EmbeddingsRouteDeps {
  embeddingCoordinator: EmbeddingCoordinator;
  apiKeyValidator: ApiKeyValidator;
  usageSink?: UsageSink;
  allowedCorsOrigins: string[];
}

export async function registerEmbeddingsRoutes(
  app: FastifyInstance,
  deps: EmbeddingsRouteDeps
): Promise<void> {
  const authenticate = createBearerAuthHook(deps.apiKeyValidator);

  app.post('/v1/embeddings', { preHandler: [authenticate] }, async (request, reply) => {
    const requestId = `emb_${crypto.randomUUID()}`;
    const startMs = Date.now();

    const parsedBody = embeddingRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      const firstIssue = parsedBody.error.issues[0];
      const path = firstIssue?.path.join('.') || 'body';
      throw OpenAIErrorResponse.badRequest(
        `Invalid embeddings request at "${path}": ${firstIssue?.message ?? 'validation failed'}`,
        path
      );
    }

    try {
      const response = await deps.embeddingCoordinator.execute(
        parsedBody.data,
        request.raw ? AbortSignal.timeout(60_000) : undefined
      );

      const latencyMs = Date.now() - startMs;

      if (deps.usageSink) {
        deps.usageSink.recordRequest({
          requestId,
          timestamp: new Date().toISOString(),
          requestedModel: parsedBody.data.model || 'auto',
          effectiveProfile: 'embeddings',
          selectedProvider: response.model.split(':')[0] || 'ollama',
          selectedModel: response.model,
          estimatedInputTokens: response.usage.prompt_tokens,
          actualInputTokens: response.usage.prompt_tokens,
          actualOutputTokens: 0,
          latencyMs,
          failoverCount: 0,
          stream: false,
          status: 'success',
          attempts: [],
        });
      }

      return reply.code(200).send(response);
    } catch (err: unknown) {
      const latencyMs = Date.now() - startMs;

      if (deps.usageSink) {
        deps.usageSink.recordRequest({
          requestId,
          timestamp: new Date().toISOString(),
          requestedModel: parsedBody.data.model || 'auto',
          effectiveProfile: 'embeddings',
          selectedProvider: null,
          selectedModel: null,
          estimatedInputTokens: 0,
          actualInputTokens: 0,
          actualOutputTokens: 0,
          latencyMs,
          failoverCount: 0,
          stream: false,
          status: 'error',
          errorCode: err instanceof OpenAIErrorResponse ? err.body.error.code : 'embedding_failed',
          errorMessage: err instanceof Error ? err.message : String(err),
          attempts: [],
        });
      }

      if (err instanceof OpenAIErrorResponse) {
        return reply.code(err.statusCode).send(err.body);
      }

      throw err;
    }
  });
}
