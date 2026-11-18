import type { FastifyReply, FastifyRequest } from 'fastify';
import { constantTimeTokenEqual, hashApiKey } from './secrets.js';
import { OpenAIErrorResponse } from '../api/errors/openai-error.js';

export interface ApiKeyLookupResult {
  valid: boolean;
  keyId?: string;
  keyName?: string;
}

export type ApiKeyValidator = (rawToken: string) => ApiKeyLookupResult | Promise<ApiKeyLookupResult>;

export function createStaticKeyValidator(configuredKeys: string[]): ApiKeyValidator {
  const validHashes = configuredKeys.map((key, index) => ({
    id: `env-key-${index + 1}`,
    name: `env-key-${index + 1}`,
    raw: key,
    hash: hashApiKey(key),
  }));

  return (rawToken: string): ApiKeyLookupResult => {
    for (const candidate of validHashes) {
      if (constantTimeTokenEqual(rawToken, candidate.raw)) {
        return {
          valid: true,
          keyId: candidate.id,
          keyName: candidate.name,
        };
      }
    }
    return { valid: false };
  };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function createBearerAuthHook(validator: ApiKeyValidator) {
  return async function authenticateRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      const err = OpenAIErrorResponse.unauthorized('Missing or malformed Authorization: Bearer <api_key> header.');
      await reply.code(err.statusCode).send(err.body);
      return;
    }

    const result = await validator(token);
    if (!result.valid) {
      const err = OpenAIErrorResponse.unauthorized('Invalid router API key.');
      await reply.code(err.statusCode).send(err.body);
      return;
    }

    (request as FastifyRequest & { authKeyId?: string }).authKeyId = result.keyId ?? 'unknown';
  };
}
