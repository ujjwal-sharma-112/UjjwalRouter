import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FailoverAttemptRecord, FailoverCoordinator } from '../../core/failover/failover-coordinator.js';
import type { RoutingEngine } from '../../core/router/routing-engine.js';
import type { UsageSink } from '../../core/usage/usage-tracker.js';
import type { NormalizedChatRequest } from '../../providers/base/types.js';
import { createBearerAuthHook, type ApiKeyValidator } from '../../security/auth.js';
import { OpenAIErrorResponse } from '../errors/openai-error.js';
import { chatCompletionRequestSchema } from '../schemas/chat-completions.js';

export interface ChatCompletionsRouteDeps {
  routingEngine: RoutingEngine;
  failoverCoordinator: FailoverCoordinator;
  apiKeyValidator: ApiKeyValidator;
  usageSink?: UsageSink;
  allowedCorsOrigins: string[];
}

export async function registerChatCompletionsRoutes(
  app: FastifyInstance,
  deps: ChatCompletionsRouteDeps
): Promise<void> {
  const authenticate = createBearerAuthHook(deps.apiKeyValidator);

  app.post('/v1/chat/completions', { preHandler: [authenticate] }, async (request, reply) => {
    const requestId = `req_${crypto.randomUUID()}`;
    const startMs = Date.now();

    const parsedBody = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      const firstIssue = parsedBody.error.issues[0];
      const path = firstIssue?.path.join('.') || 'body';
      throw OpenAIErrorResponse.badRequest(
        `Invalid chat completion request at "${path}": ${firstIssue?.message ?? 'validation failed'}`,
        path
      );
    }

    const normalizedRequest: NormalizedChatRequest = {
      model: parsedBody.data.model,
      messages: parsedBody.data.messages.map((m) => ({
        role: m.role,
        content: m.content ?? null,
        name: m.name,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
        reasoning_content: m.reasoning_content,
      })),
      temperature: parsedBody.data.temperature,
      top_p: parsedBody.data.top_p,
      max_tokens: parsedBody.data.max_tokens,
      max_completion_tokens: parsedBody.data.max_completion_tokens,
      stop: parsedBody.data.stop,
      stream: parsedBody.data.stream,
      stream_options: parsedBody.data.stream_options,
      tools: parsedBody.data.tools,
      tool_choice: parsedBody.data.tool_choice,
      parallel_tool_calls: parsedBody.data.parallel_tool_calls,
      response_format: parsedBody.data.response_format,
      reasoning_effort: parsedBody.data.reasoning_effort,
      seed: parsedBody.data.seed,
      presence_penalty: parsedBody.data.presence_penalty,
      frequency_penalty: parsedBody.data.frequency_penalty,
      user: parsedBody.data.user,
    };

    const abortController = new AbortController();
    request.raw.on('close', () => {
      if (!request.raw.complete && !reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    let plan;
    try {
      plan = await deps.routingEngine.planRoute(normalizedRequest, abortController.signal);
    } catch (err) {
      await deps.usageSink?.recordRequest({
        requestId,
        timestamp: new Date().toISOString(),
        requestedModel: normalizedRequest.model,
        effectiveProfile: normalizedRequest.model,
        selectedProvider: null,
        selectedModel: null,
        estimatedInputTokens: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        latencyMs: Date.now() - startMs,
        failoverCount: 0,
        stream: Boolean(normalizedRequest.stream),
        status: 'error',
        errorCode: err instanceof OpenAIErrorResponse ? err.body.error.code : 'routing_error',
        errorMessage: err instanceof Error ? err.message : 'Routing failed',
        attempts: [],
      });
      throw err;
    }

    const candidateModels = plan.candidates.map((c) => c.model);

    if (!normalizedRequest.stream) {
      try {
        const result = await deps.failoverCoordinator.executeChatWithFailover({
          candidates: candidateModels,
          request: normalizedRequest,
          estimatedTokens: plan.tokenBreakdown.estimatedInputTokens,
          signal: abortController.signal,
        });

        await deps.usageSink?.recordRequest({
          requestId,
          timestamp: new Date().toISOString(),
          requestedModel: normalizedRequest.model,
          effectiveProfile: plan.profile,
          selectedProvider: result.selectedModel.providerId,
          selectedModel: result.selectedModel.canonicalId,
          estimatedInputTokens: plan.tokenBreakdown.estimatedInputTokens,
          actualInputTokens:
            result.response.usage.prompt_tokens || plan.tokenBreakdown.estimatedInputTokens,
          actualOutputTokens: result.response.usage.completion_tokens,
          latencyMs: Date.now() - startMs,
          failoverCount: result.failoverCount,
          stream: false,
          status: 'success',
          routingExplanation: plan.explanation,
          attempts: result.attempts,
        });

        return reply
          .code(200)
          .header('x-ujjwalrouter-request-id', requestId)
          .header('x-ujjwalrouter-provider', result.selectedModel.providerId)
          .header('x-ujjwalrouter-model', result.selectedModel.canonicalId)
          .header('x-ujjwalrouter-failover-count', String(result.failoverCount))
          .header('x-ujjwalrouter-strict-free', 'true')
          .send(result.response);
      } catch (err) {
        await deps.usageSink?.recordRequest({
          requestId,
          timestamp: new Date().toISOString(),
          requestedModel: normalizedRequest.model,
          effectiveProfile: plan.profile,
          selectedProvider: null,
          selectedModel: null,
          estimatedInputTokens: plan.tokenBreakdown.estimatedInputTokens,
          actualInputTokens: 0,
          actualOutputTokens: 0,
          latencyMs: Date.now() - startMs,
          failoverCount: 0,
          stream: false,
          status: 'error',
          errorCode: err instanceof OpenAIErrorResponse ? err.body.error.code : 'execution_failed',
          errorMessage: err instanceof Error ? err.message : 'Execution failed',
          routingExplanation: plan.explanation,
          attempts: [],
        });
        throw err;
      }
    }

    // Streaming SSE response
    let selectedProvider: string | null = null;
    let selectedModel: string | null = null;
    let failoverCount = 0;
    let recordedAttempts: FailoverAttemptRecord[] = [];
    let actualInputTokens = 0;
    let actualOutputTokens = 0;

    const streamIterable = deps.failoverCoordinator.executeStreamWithFailover({
      candidates: candidateModels,
      request: normalizedRequest,
      estimatedTokens: plan.tokenBreakdown.estimatedInputTokens,
      signal: abortController.signal,
      onSelected: (info) => {
        selectedProvider = info.model.providerId;
        selectedModel = info.model.canonicalId;
        failoverCount = info.failoverCount;
        recordedAttempts = info.attempts;
      },
    });

    const iterator = streamIterable[Symbol.asyncIterator]();

    // Pull first chunk BEFORE writing 200 headers so pre-stream failover or total rejection
    // cleanly returns standard OpenAI HTTP error status codes (429 / 503 / 502).
    let firstResult: IteratorResult<unknown>;
    try {
      firstResult = await iterator.next();
    } catch (err) {
      await deps.usageSink?.recordRequest({
        requestId,
        timestamp: new Date().toISOString(),
        requestedModel: normalizedRequest.model,
        effectiveProfile: plan.profile,
        selectedProvider,
        selectedModel,
        estimatedInputTokens: plan.tokenBreakdown.estimatedInputTokens,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        latencyMs: Date.now() - startMs,
        failoverCount,
        stream: true,
        status: 'error',
        errorCode: err instanceof OpenAIErrorResponse ? err.body.error.code : 'stream_start_failed',
        errorMessage: err instanceof Error ? err.message : 'Stream failed before first chunk',
        routingExplanation: plan.explanation,
        attempts: recordedAttempts,
      });
      throw err;
    }

    reply.hijack();
    const origin = request.headers.origin;
    const streamHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-ujjwalrouter-request-id': requestId,
      'x-ujjwalrouter-provider': selectedProvider ?? 'unknown',
      'x-ujjwalrouter-model': selectedModel ?? 'unknown',
      'x-ujjwalrouter-failover-count': String(failoverCount),
      'x-ujjwalrouter-strict-free': 'true',
    };
    if (origin && deps.allowedCorsOrigins.includes(origin)) {
      streamHeaders['Access-Control-Allow-Origin'] = origin;
      streamHeaders['Vary'] = 'Origin';
    }
    reply.raw.writeHead(200, streamHeaders);

    const emitChunk = (chunk: {
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    }) => {
      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === 'number' && chunk.usage.prompt_tokens > 0) {
          actualInputTokens = chunk.usage.prompt_tokens;
        }
        if (typeof chunk.usage.completion_tokens === 'number' && chunk.usage.completion_tokens > 0) {
          actualOutputTokens = chunk.usage.completion_tokens;
        }
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    };

    try {
      if (!firstResult.done && firstResult.value) {
        emitChunk(firstResult.value as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null });
      }
      while (!firstResult.done) {
        const next = await iterator.next();
        if (next.done) break;
        emitChunk(next.value);
      }

      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      }

      await deps.usageSink?.recordRequest({
        requestId,
        timestamp: new Date().toISOString(),
        requestedModel: normalizedRequest.model,
        effectiveProfile: plan.profile,
        selectedProvider,
        selectedModel,
        estimatedInputTokens: plan.tokenBreakdown.estimatedInputTokens,
        actualInputTokens: actualInputTokens || plan.tokenBreakdown.estimatedInputTokens,
        actualOutputTokens,
        latencyMs: Date.now() - startMs,
        failoverCount,
        stream: true,
        status: 'success',
        routingExplanation: plan.explanation,
        attempts: recordedAttempts,
      });
    } catch (err) {
      const errorBody =
        err instanceof OpenAIErrorResponse
          ? err.body
          : OpenAIErrorResponse.upstreamError(
              502,
              err instanceof Error ? err.message : 'Stream interrupted'
            ).body;

      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(errorBody)}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      }

      await deps.usageSink?.recordRequest({
        requestId,
        timestamp: new Date().toISOString(),
        requestedModel: normalizedRequest.model,
        effectiveProfile: plan.profile,
        selectedProvider,
        selectedModel,
        estimatedInputTokens: plan.tokenBreakdown.estimatedInputTokens,
        actualInputTokens,
        actualOutputTokens,
        latencyMs: Date.now() - startMs,
        failoverCount,
        stream: true,
        status: 'error',
        errorCode: errorBody.error.code,
        errorMessage: errorBody.error.message,
        routingExplanation: plan.explanation,
        attempts: recordedAttempts,
      });
    }
  });
}
