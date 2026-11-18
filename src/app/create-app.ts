import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { Logger } from 'pino';
import path from 'node:path';
import type { AppConfig } from '../config/env.js';
import { createLogger, redactSecrets } from '../logging/logger.js';
import { FreeInferencePolicy } from '../core/policy/free-inference-policy.js';
import { ModelRegistry } from '../core/model-registry/model-registry.js';
import { ContextManager } from '../core/context/context-manager.js';
import { RateLimiter } from '../core/rate-limiter/rate-limiter.js';
import { QuotaManager } from '../core/quota-manager/quota-manager.js';
import { CircuitBreakerRegistry } from '../core/failover/circuit-breaker.js';
import { FailoverCoordinator } from '../core/failover/failover-coordinator.js';
import { RoutingEngine } from '../core/router/routing-engine.js';
import { ModelDiscoveryService } from '../core/model-discovery/model-discovery-service.js';
import { InMemoryUsageTracker, type UsageSink } from '../core/usage/usage-tracker.js';
import {
  createDefaultProviderRegistry,
  DEFAULT_PROVIDER_PRIORITY,
  type ProviderRegistry,
} from '../providers/base/provider-registry.js';
import {
  resolveEffectiveProvidersConfig,
  resolveProviderPriorityList,
} from '../providers/base/provider-factory.js';
import type { ProviderAdapter } from '../providers/base/provider-adapter.js';
import type { FetchLike } from '../providers/base/openai-compat-base.js';
import { openDatabase, runMigrations, type DatabaseConnection } from '../database/connection.js';
import { RouterRepository } from '../database/repositories/router-repository.js';
import {
  createCombinedApiKeyValidator,
  RouterLifecycleService,
} from '../services/router-service.js';
import { EncryptedSecretStore } from '../security/secret-store.js';
import { DashboardSessionManager } from '../security/dashboard-auth.js';
import type { ApiKeyValidator } from '../security/auth.js';
import { OpenAIErrorResponse } from '../api/errors/openai-error.js';
import { registerHealthRoutes } from '../api/routes/health.js';
import { registerModelsRoutes } from '../api/routes/models.js';
import { registerChatCompletionsRoutes } from '../api/routes/chat-completions.js';
import { registerEmbeddingsRoutes } from '../api/routes/embeddings.js';
import { registerAdminRoutes } from '../api/routes/admin.js';
import { EmbeddingCoordinator } from '../core/embeddings/embedding-coordinator.js';

export interface AppContext {
  app: FastifyInstance;
  config: AppConfig;
  logger: Logger;
  dbConn: DatabaseConnection;
  repository: RouterRepository;
  secretStore: EncryptedSecretStore;
  policy: FreeInferencePolicy;
  registry: ModelRegistry;
  providerRegistry: ProviderRegistry;
  adapters: Map<string, ProviderAdapter>;
  contextManager: ContextManager;
  rateLimiter: RateLimiter;
  quotaManager: QuotaManager;
  circuitBreaker: CircuitBreakerRegistry;
  routingEngine: RoutingEngine;
  failoverCoordinator: FailoverCoordinator;
  discoveryService: ModelDiscoveryService;
  lifecycleService: RouterLifecycleService;
  usageTracker: InMemoryUsageTracker;
  embeddingCoordinator: EmbeddingCoordinator;
}

export interface CreateAppOptions {
  config: AppConfig;
  logger?: Logger;
  databasePath?: string;
  policy?: FreeInferencePolicy;
  registry?: ModelRegistry;
  providerRegistry?: ProviderRegistry;
  adapters?: Map<string, ProviderAdapter>;
  apiKeyValidator?: ApiKeyValidator;
  usageSink?: UsageSink;
  fetchFn?: FetchLike;
  onRegisterExtraRoutes?: (ctx: AppContext) => Promise<void> | void;
}

export async function createApp(options: CreateAppOptions): Promise<AppContext> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel);
  const isTestEnv = config.nodeEnv === 'test' || process.env.VITEST === 'true';
  const effectiveDbPath =
    options.databasePath ??
    (isTestEnv && config.databasePath === './data/ujjwalrouter.db'
      ? ':memory:'
      : config.databasePath);

  const dbConn = openDatabase(effectiveDbPath);
  runMigrations(dbConn);

  const repository = new RouterRepository(dbConn.db);
  const defaultPriority = [...DEFAULT_PROVIDER_PRIORITY];
  repository.seedDefaults({
    defaultRoutingProfile: config.defaultRoutingProfile,
    logRetentionDays: config.logRetentionDays,
    contextSafetyMarginPct: config.contextSafetyMarginPct,
    healthCheckIntervalMs: config.healthCheckIntervalMs,
    providerPriority: defaultPriority,
  });

  const secretStorePath =
    effectiveDbPath === ':memory:'
      ? '/tmp/ujjwalrouter-test-secrets.enc.json'
      : path.join(path.dirname(path.resolve(effectiveDbPath)), 'secrets.enc.json');
  const secretStore = new EncryptedSecretStore(secretStorePath, config.secretEncryptionKey);

  const effectiveConfig = resolveEffectiveProvidersConfig(config, secretStore, repository);

  const policy = options.policy ?? new FreeInferencePolicy(effectiveConfig.verificationMaxAgeMs);
  const registry = options.registry ?? new ModelRegistry(policy);

  const providerRegistry =
    options.providerRegistry ?? createDefaultProviderRegistry(effectiveConfig, options.fetchFn);
  if (options.adapters) {
    for (const adapter of options.adapters.values()) {
      providerRegistry.register(adapter);
    }
  }
  const adapters = providerRegistry.getMap();

  const savedPriorityRaw = repository.getSetting('provider_priority');
  const { priority: providerPriority, migrated: priorityMigrated } =
    resolveProviderPriorityList(savedPriorityRaw);
  if (priorityMigrated) {
    repository.updateSetting('provider_priority', JSON.stringify(providerPriority));
  }

  const contextManager = new ContextManager({
    safetyMarginPct: config.contextSafetyMarginPct,
    safetyMarginTokens: config.contextSafetyMarginTokens,
    defaultReservedOutputTokens: config.defaultReservedOutputTokens,
  });

  const rateLimiter = new RateLimiter();
  const quotaManager = new QuotaManager();
  const circuitBreaker = new CircuitBreakerRegistry();
  const usageTracker = new InMemoryUsageTracker();

  const routingEngine = new RoutingEngine({
    registry,
    policy,
    contextManager,
    providerRegistry,
    preferences: { providerPriority },
  });

  const failoverCoordinator = new FailoverCoordinator({
    policy,
    contextManager,
    rateLimiter,
    quotaManager,
    circuitBreaker,
    adapters,
    config: {
      requestTimeoutMs: config.requestTimeoutMs,
      firstByteTimeoutMs: config.firstByteTimeoutMs,
    },
    onLatencyObserved: (canonicalId, latencyMs) => {
      routingEngine.recordObservedLatency(canonicalId, latencyMs);
    },
    onFailureObserved: (canonicalId, category, elapsedMs) => {
      routingEngine.recordObservedFailure(canonicalId, category, elapsedMs);
    },
    onQuotaExhausted: (canonicalId) => {
      registry.markQuotaExhausted(canonicalId);
    },
    onModelUnavailable: (canonicalId) => {
      registry.markModelUnavailable(canonicalId);
    },
  });

  const discoveryService = new ModelDiscoveryService({
    providerRegistry,
    modelRegistry: registry,
    policy,
    logger,
  });

  const lifecycleService = new RouterLifecycleService({
    config,
    repository,
    providerRegistry,
    modelRegistry: registry,
    discoveryService,
    logger,
  });
  lifecycleService.syncProvidersToDb();

  const apiKeyValidator =
    options.apiKeyValidator ?? createCombinedApiKeyValidator(config.routerApiKeys, repository);

  const combinedUsageSink: UsageSink = options.usageSink ?? {
    recordRequest: (entry) => {
      usageTracker.recordRequest(entry);
      repository.recordRequest(entry);
    },
  };

  const startedAt = new Date().toISOString();

  const knownSecrets = [
    ...config.routerApiKeys,
    config.dashboardAdminToken,
    config.secretEncryptionKey,
    effectiveConfig.providers.google.apiKey,
    effectiveConfig.providers.openrouter.apiKey,
    effectiveConfig.providers.groq.apiKey,
    effectiveConfig.providers.nvidia.apiKey,
    effectiveConfig.providers.huggingface.token,
  ].filter(Boolean);

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: config.maxRequestBodyBytes,
    requestTimeout: config.requestTimeoutMs,
  });

  app.addHook('onClose', async () => {
    lifecycleService.stopBackgroundTasks();
    dbConn.close();
  });

  await app.register(cookie);

  await app.register(helmet, {
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.allowedCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS policy'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  await app.register(rateLimit, {
    max: config.rateLimitMaxPerMin,
    timeWindow: '1 minute',
    allowList: ['/health'],
    errorResponseBuilder: (_request, context) => {
      return OpenAIErrorResponse.rateLimited(
        `Local API rate limit exceeded (${context.max} requests per minute).`
      ).body;
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OpenAIErrorResponse) {
      return reply.code(error.statusCode).send(error.body);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode)
        : 500;

    if (statusCode === 413) {
      const payloadErr = OpenAIErrorResponse.payloadTooLarge(
        `Request body exceeds maximum allowed size of ${config.maxRequestBodyBytes} bytes.`
      );
      return reply.code(413).send(payloadErr.body);
    }

    if (statusCode === 400) {
      const badReq = OpenAIErrorResponse.badRequest(
        redactSecrets(errorMessage || 'Malformed request.', knownSecrets)
      );
      return reply.code(400).send(badReq.body);
    }

    if (statusCode === 429) {
      const rateErr = OpenAIErrorResponse.rateLimited(
        redactSecrets(errorMessage || 'Rate limit exceeded.', knownSecrets)
      );
      return reply.code(429).send(rateErr.body);
    }

    const safeMessage =
      statusCode >= 500
        ? 'Internal router error.'
        : redactSecrets(errorMessage || 'Request failed.', knownSecrets);

    logger.error(
      {
        statusCode,
        errMessage: redactSecrets(errorMessage, knownSecrets),
      },
      'Unhandled request error'
    );

    const errResp = OpenAIErrorResponse.upstreamError(statusCode, safeMessage);
    return reply.code(errResp.statusCode).send(errResp.body);
  });

  const sessionManager = new DashboardSessionManager(
    config.dashboardAdminToken,
    config.secretEncryptionKey || config.dashboardAdminToken
  );

  const embeddingCoordinator = new EmbeddingCoordinator({
    ollamaBaseUrl: effectiveConfig.providers.ollama.baseUrl,
    ollamaEnabled: effectiveConfig.providers.ollama.enabled,
    googleApiKey: effectiveConfig.providers.google.apiKey,
    openrouterApiKey: effectiveConfig.providers.openrouter.apiKey,
    fetchFn: options.fetchFn,
    logger,
  });

  await registerHealthRoutes(app, { registry, adapters, startedAt });
  await registerModelsRoutes(app, { registry, apiKeyValidator });
  await registerChatCompletionsRoutes(app, {
    routingEngine,
    failoverCoordinator,
    apiKeyValidator,
    usageSink: combinedUsageSink,
    allowedCorsOrigins: config.allowedCorsOrigins,
  });
  await registerEmbeddingsRoutes(app, {
    embeddingCoordinator,
    apiKeyValidator,
    usageSink: combinedUsageSink,
    allowedCorsOrigins: config.allowedCorsOrigins,
  });
  await registerAdminRoutes(app, {
    config,
    repository,
    secretStore,
    registry,
    providerRegistry,
    routingEngine,
    lifecycleService,
    sessionManager,
    fetchFn: options.fetchFn,
  });

  const dashboardDistDir = path.resolve(process.cwd(), 'apps/dashboard/dist');
  if (fs.existsSync(path.join(dashboardDistDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dashboardDistDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/v1/') || request.url.startsWith('/api/')) {
        return reply.code(404).send(
          OpenAIErrorResponse.notFound(`Endpoint not found: ${request.method} ${request.url}`, null).body
        );
      }
      return reply.sendFile('index.html');
    });
  }

  const ctx: AppContext = {
    app,
    config,
    logger,
    dbConn,
    repository,
    secretStore,
    policy,
    registry,
    providerRegistry,
    adapters,
    contextManager,
    rateLimiter,
    quotaManager,
    circuitBreaker,
    routingEngine,
    failoverCoordinator,
    discoveryService,
    lifecycleService,
    usageTracker,
    embeddingCoordinator,
  };

  if (options.onRegisterExtraRoutes) {
    await options.onRegisterExtraRoutes(ctx);
  }

  return ctx;
}
