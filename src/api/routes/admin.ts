import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { ModelRegistry } from '../../core/model-registry/model-registry.js';
import type { RoutingEngine } from '../../core/router/routing-engine.js';
import { ROUTING_PROFILES } from '../../core/router/profiles.js';
import type { RouterRepository } from '../../database/repositories/router-repository.js';
import type { ProviderRegistry } from '../../providers/base/provider-registry.js';
import type { FetchLike } from '../../providers/base/openai-compat-base.js';
import {
  buildProviderAdapter,
  getEffectiveEntitlementConfirmation,
  getEffectiveProviderSecret,
  isBuiltinProviderId,
  PROVIDER_UI_METADATA,
  resolveEffectiveProvidersConfig,
} from '../../providers/base/provider-factory.js';
import type { RouterLifecycleService } from '../../services/router-service.js';
import { maskSecret } from '../../security/secrets.js';
import type { EncryptedSecretStore } from '../../security/secret-store.js';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardSessionManager,
} from '../../security/dashboard-auth.js';

export interface AdminRoutesDeps {
  config: AppConfig;
  repository: RouterRepository;
  secretStore: EncryptedSecretStore;
  registry: ModelRegistry;
  providerRegistry: ProviderRegistry;
  routingEngine: RoutingEngine;
  lifecycleService: RouterLifecycleService;
  sessionManager: DashboardSessionManager;
  fetchFn?: FetchLike;
}

const loginSchema = z.object({
  token: z.string().min(1),
});

const providerCredentialSchema = z.object({
  apiKey: z.string().max(512).optional().default(''),
  accountId: z.string().max(128).optional(),
  baseUrl: z.string().max(512).optional(),
  confirmedFreeEntitlement: z.boolean().optional(),
});

const routingUpdateSchema = z.object({
  defaultRoutingProfile: z.enum(ROUTING_PROFILES).optional(),
  providerPriority: z.array(z.string().min(1)).min(1).max(20).optional(),
});

const settingsUpdateSchema = z
  .object({
    strictFreeOnly: z.boolean().optional(),
    strict_free_only: z.union([z.boolean(), z.string()]).optional(),
    logRetentionDays: z.number().int().min(1).max(3650).optional(),
    contextSafetyMarginPct: z.number().min(0).max(0.5).optional(),
    healthCheckIntervalMs: z.number().int().min(10000).max(86_400_000).optional(),
    defaultRoutingProfile: z.enum(ROUTING_PROFILES).optional(),
    providerPriority: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(64),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRoutesDeps
): Promise<void> {
  const requireAdmin = deps.sessionManager.createAuthHook();

  // Public auth endpoints for dashboard login/session check
  app.get('/api/admin/auth/session', async (request, reply) => {
    const rawCookie = (request.cookies as Record<string, string | undefined> | undefined)?.[
      DASHBOARD_SESSION_COOKIE
    ];
    const session = deps.sessionManager.verifySessionCookie(rawCookie);
    return reply.code(200).send({
      configured: deps.sessionManager.isConfigured(),
      authenticated: Boolean(session),
      csrfToken: session?.csrf ?? null,
      strictFreeOnly: true,
    });
  });

  app.post('/api/admin/auth/login', async (request, reply) => {
    if (!deps.sessionManager.isConfigured()) {
      return reply.code(503).send({
        error: {
          message: 'DASHBOARD_ADMIN_TOKEN is not configured on the server.',
          code: 'dashboard_auth_unconfigured',
        },
      });
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || !deps.sessionManager.verifyAdminToken(parsed.data.token)) {
      deps.repository.recordAuditLog('anonymous', 'dashboard.login_failed', 'auth', 'Invalid admin token');
      return reply.code(401).send({
        error: {
          message: 'Invalid dashboard admin token.',
          code: 'invalid_credentials',
        },
      });
    }

    const session = deps.sessionManager.createSessionCookie();
    const isHttps = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';

    reply.setCookie(DASHBOARD_SESSION_COOKIE, session.cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isHttps,
      maxAge: session.maxAgeSeconds,
    });

    deps.repository.recordAuditLog('admin', 'dashboard.login', 'auth', 'Dashboard session started');
    return reply.code(200).send({
      authenticated: true,
      csrfToken: session.csrfToken,
      strictFreeOnly: true,
    });
  });

  app.post('/api/admin/auth/logout', async (_request, reply) => {
    reply.clearCookie(DASHBOARD_SESSION_COOKIE, { path: '/' });
    reply.header('Clear-Site-Data', '"cookies", "storage"');
    return reply.code(200).send({ authenticated: false });
  });

  // Protected admin API routes
  app.get('/api/admin/overview', { preHandler: [requireAdmin] }, async () => {
    const analytics = deps.repository.getAnalytics(30);
    const eligibleModels = deps.registry.listEligibleFreeModels();
    const allEvaluated = deps.registry.listEvaluatedModels();
    const latestHealth = deps.repository.getLatestProviderHealth();
    const recentLogs = deps.repository.queryRequestLogs({ limit: 15 });
    const defaultProfile =
      deps.repository.getSetting('default_routing_profile') ?? deps.config.defaultRoutingProfile;

    const providers = deps.providerRegistry.getAll().map((adapter) => {
      const info = adapter.getInfo();
      const health = latestHealth.find((h) => h.providerId === info.id);
      return {
        ...info,
        healthy: health?.healthy ?? false,
        healthStatus: health?.status ?? (info.enabled ? 'unknown' : 'disabled'),
        latencyMs: health?.latencyMs ?? null,
        lastCheckedAt: health?.checkedAt ?? null,
        verifiedModelCount: eligibleModels.filter((m) => m.providerId === info.id).length,
      };
    });

    return {
      strictFreeOnly: true,
      defaultRoutingProfile: defaultProfile,
      totals: analytics.totals,
      activeVerifiedModels: eligibleModels.length,
      totalDiscoveredModels: allEvaluated.length,
      providers,
      recentRequests: recentLogs.items,
    };
  });

  app.get('/api/admin/providers', { preHandler: [requireAdmin] }, async () => {
    const latestHealth = deps.repository.getLatestProviderHealth();
    const allModels = deps.registry.listEvaluatedModels();
    const priorityOrder = deps.routingEngine.getProviderPriority();
    const effectiveConfig = resolveEffectiveProvidersConfig(
      deps.config,
      deps.secretStore,
      deps.repository
    );

    return {
      strictFreeOnly: true,
      providerPriority: priorityOrder,
      providers: deps.providerRegistry.getAll().map((adapter) => {
        const info = adapter.getInfo();
        const health = latestHealth.find((h) => h.providerId === info.id);
        const secretVal = getEffectiveProviderSecret(deps.config, deps.secretStore, info.id);
        const storedSecret =
          info.id === 'ollama'
            ? effectiveConfig.providers.ollama.baseUrl
            : secretVal
              ? maskSecret(secretVal)
              : null;

        const modelsForProvider = allModels.filter((e) => e.model.providerId === info.id);
        const verifiedCount = modelsForProvider.filter((e) => e.policy.allowed).length;
        const uiMeta = isBuiltinProviderId(info.id)
          ? PROVIDER_UI_METADATA[info.id]
          : {
              requiresApiKey: true,
              requiresEntitlementConfirmation: true,
              requiresAccountId: false,
              supportsBaseUrl: true,
            };

        return {
          ...info,
          maskedCredential: storedSecret,
          confirmedFreeEntitlement: getEffectiveEntitlementConfirmation(
            deps.config,
            deps.repository,
            info.id
          ),
          ...uiMeta,
          ...(info.id === 'cloudflare' && effectiveConfig.providers.cloudflare.accountId
            ? { maskedAccountId: maskSecret(effectiveConfig.providers.cloudflare.accountId) }
            : {}),
          ...(info.id === 'ollama' ? { baseUrl: effectiveConfig.providers.ollama.baseUrl } : {}),
          healthy: health?.healthy ?? false,
          healthStatus: health?.status ?? (info.enabled ? 'unknown' : 'disabled'),
          healthMessage: health?.message ?? info.notes ?? '',
          latencyMs: health?.latencyMs ?? null,
          lastHealthCheck: health?.checkedAt ?? null,
          priorityRank:
            priorityOrder.indexOf(info.id) >= 0 ? priorityOrder.indexOf(info.id) + 1 : 99,
          totalModels: modelsForProvider.length,
          verifiedModels: verifiedCount,
        };
      }),
    };
  });

  app.post(
    '/api/admin/providers/:id/credentials',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isBuiltinProviderId(id)) {
        return reply.code(404).send({
          error: { message: `Unknown provider "${id}".`, code: 'provider_not_found' },
        });
      }

      const parsed = providerCredentialSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { message: 'Invalid provider configuration payload.', code: 'invalid_request' },
        });
      }

      const meta = PROVIDER_UI_METADATA[id];
      const apiKey = parsed.data.apiKey.trim();
      if (meta.requiresApiKey && !apiKey) {
        return reply.code(400).send({
          error: { message: 'Valid apiKey is required.', code: 'invalid_request' },
        });
      }

      if (apiKey) {
        deps.secretStore.setSecret(`${id.toUpperCase()}_API_KEY`, apiKey);
      }

      if (meta.requiresAccountId) {
        const acctId = parsed.data.accountId?.trim() ?? '';
        if (!acctId && !deps.secretStore.getSecret('CLOUDFLARE_ACCOUNT_ID') && !deps.config.providers.cloudflare.accountId) {
          return reply.code(400).send({
            error: { message: 'Cloudflare Account ID is required.', code: 'invalid_request' },
          });
        }
        if (acctId) {
          deps.secretStore.setSecret('CLOUDFLARE_ACCOUNT_ID', acctId);
        }
      }

      if (id === 'ollama' && parsed.data.baseUrl?.trim()) {
        deps.repository.updateSetting('provider_base_url:ollama', parsed.data.baseUrl.trim());
        deps.repository.updateSetting('provider_enabled:ollama', 'true');
      }

      if (meta.requiresEntitlementConfirmation && parsed.data.confirmedFreeEntitlement !== undefined) {
        deps.repository.updateSetting(
          `provider_confirmed:${id}`,
          parsed.data.confirmedFreeEntitlement ? 'true' : 'false'
        );
      }

      // Preserve disabled default on Hugging Face promotional credits unless explicitly toggled
      if (id === 'huggingface') {
        deps.repository.updateSetting('provider_enabled:huggingface', 'false');
      } else if (id !== 'ollama') {
        deps.repository.updateSetting(`provider_enabled:${id}`, 'true');
      }

      const effectiveConfig = resolveEffectiveProvidersConfig(
        deps.config,
        deps.secretStore,
        deps.repository
      );
      deps.providerRegistry.register(
        buildProviderAdapter({
          providerId: id,
          effectiveConfig,
          fetchFn: deps.fetchFn,
        })
      );

      deps.repository.recordAuditLog(
        'admin',
        'provider.credential_updated',
        id,
        apiKey
          ? `Updated encrypted credential for provider "${id}" (${maskSecret(apiKey)})`
          : `Updated configuration for provider "${id}"`
      );

      const report = await deps.lifecycleService.refreshDiscoveryAndPersist();
      const health = await deps.lifecycleService.runHealthChecksAndPersist();

      return reply.code(200).send({
        updated: true,
        providerId: id,
        maskedCredential: apiKey ? maskSecret(apiKey) : null,
        discovery: report.providers.find((p) => p.providerId === id) ?? null,
        health: health.find((h) => h.providerId === id) ?? null,
      });
    }
  );

  app.post(
    '/api/admin/providers/:id/toggle',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: boolean };
      const adapter = deps.providerRegistry.get(id);
      if (!adapter || !isBuiltinProviderId(id)) {
        return reply.code(404).send({
          error: { message: `Unknown provider "${id}".`, code: 'provider_not_found' },
        });
      }

      const desiredEnabled = Boolean(body.enabled);
      if (id === 'huggingface' && desiredEnabled) {
        deps.repository.recordAuditLog(
          'admin',
          'provider.toggle_blocked',
          id,
          'Attempted to enable Hugging Face promotional credits; policy holds it ineligible under STRICT_FREE_ONLY.'
        );
      }

      deps.repository.updateSetting(`provider_enabled:${id}`, desiredEnabled ? 'true' : 'false');
      const effectiveConfig = resolveEffectiveProvidersConfig(
        deps.config,
        deps.secretStore,
        deps.repository
      );
      deps.providerRegistry.register(
        buildProviderAdapter({
          providerId: id,
          effectiveConfig,
          enabledOverride: desiredEnabled,
          fetchFn: deps.fetchFn,
        })
      );

      deps.repository.recordAuditLog(
        'admin',
        'provider.toggled',
        id,
        `Set provider "${id}" enabled=${desiredEnabled}`
      );
      await deps.lifecycleService.refreshDiscoveryAndPersist();

      return reply.code(200).send({
        providerId: id,
        enabled: deps.providerRegistry.get(id)?.isEnabled() ?? false,
      });
    }
  );

  app.post('/api/admin/providers/discover', { preHandler: [requireAdmin] }, async () => {
    const discovery = await deps.lifecycleService.refreshDiscoveryAndPersist();
    const health = await deps.lifecycleService.runHealthChecksAndPersist();
    deps.repository.recordAuditLog(
      'admin',
      'providers.discovery_refreshed',
      'all',
      'Triggered manual model discovery and health check'
    );
    return { discovery, health };
  });

  app.get('/api/admin/models', { preHandler: [requireAdmin] }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const minContext = q.minContext ? Number.parseInt(q.minContext, 10) : 0;
    const codingOnly = q.coding === 'true';
    const reasoningOnly = q.reasoning === 'true';
    const toolsOnly = q.tools === 'true';
    const verifiedOnly = q.verifiedOnly === 'true';
    const availableOnly = q.availableOnly === 'true';
    const providerId = q.providerId || undefined;

    const evaluated = deps.registry.queryModels({
      providerId,
      minContextWindow: Number.isFinite(minContext) && minContext > 0 ? minContext : undefined,
      codingOnly,
      requiresReasoning: reasoningOnly,
      requiresTools: toolsOnly,
      onlyVerifiedFree: verifiedOnly,
      onlyAvailable: availableOnly,
    });

    return {
      strictFreeOnly: true,
      count: evaluated.length,
      models: evaluated.map(({ model, policy }) => ({
        ...model,
        policyAllowed: policy.allowed,
        policyCode: policy.code,
        policyReasons: policy.reasons,
      })),
    };
  });

  app.get('/api/admin/routing', { preHandler: [requireAdmin] }, async () => {
    const profiles = deps.repository.listRoutingProfiles();
    const defaultProfile =
      deps.repository.getSetting('default_routing_profile') ?? deps.config.defaultRoutingProfile;
    const recentLogs = deps.repository.queryRequestLogs({ limit: 20 });

    return {
      strictFreeOnly: true,
      defaultRoutingProfile: defaultProfile,
      providerPriority: deps.routingEngine.getProviderPriority(),
      profiles,
      recentDecisions: recentLogs.items.map((item) => ({
        requestId: item.id,
        timestamp: item.timestamp,
        requestedModel: item.requestedModel,
        effectiveProfile: item.effectiveProfile,
        selectedProvider: item.selectedProvider,
        selectedModel: item.selectedModel,
        failoverCount: item.failoverCount,
        latencyMs: item.latencyMs,
        status: item.status,
        explanation: item.routingExplanation,
      })),
    };
  });

  app.put('/api/admin/routing', { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = routingUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { message: 'Invalid routing preferences.', code: 'invalid_request' },
      });
    }

    if (parsed.data.defaultRoutingProfile) {
      deps.repository.updateSetting('default_routing_profile', parsed.data.defaultRoutingProfile);
    }
    if (parsed.data.providerPriority) {
      deps.routingEngine.setProviderPriority(parsed.data.providerPriority);
      deps.repository.updateSetting(
        'provider_priority',
        JSON.stringify(parsed.data.providerPriority)
      );
    }

    return {
      strictFreeOnly: true,
      defaultRoutingProfile:
        deps.repository.getSetting('default_routing_profile') ?? deps.config.defaultRoutingProfile,
      providerPriority: deps.routingEngine.getProviderPriority(),
    };
  });

  app.get('/api/admin/logs', { preHandler: [requireAdmin] }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const status = q.status === 'success' || q.status === 'error' ? q.status : undefined;
    const limit = q.limit ? Number.parseInt(q.limit, 10) : 50;
    const offset = q.offset ? Number.parseInt(q.offset, 10) : 0;

    return deps.repository.queryRequestLogs({
      status,
      providerId: q.providerId || undefined,
      model: q.model || undefined,
      profile: q.profile || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
  });

  app.get('/api/admin/analytics', { preHandler: [requireAdmin] }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const days = q.days ? Math.min(365, Math.max(1, Number.parseInt(q.days, 10) || 30)) : 30;
    return deps.repository.getAnalytics(days);
  });

  app.get('/api/admin/settings', { preHandler: [requireAdmin] }, async () => {
    return {
      strictFreeOnly: true,
      strictFreeOnlyImmutable: true,
      host: deps.config.host,
      port: deps.config.port,
      settings: deps.repository.getAllSettings(),
      apiKeys: deps.repository.listApiKeys(),
      auditLogs: deps.repository.listAuditLogs(50),
    };
  });

  app.put('/api/admin/settings', { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { message: 'Invalid settings payload.', code: 'invalid_request' },
      });
    }

    if (
      parsed.data.strictFreeOnly === false ||
      parsed.data.strict_free_only === false ||
      parsed.data.strict_free_only === 'false'
    ) {
      deps.repository.recordAuditLog(
        'admin',
        'policy.tamper_blocked',
        'strict_free_only',
        'Blocked attempt to disable STRICT_FREE_ONLY via settings API'
      );
      return reply.code(403).send({
        error: {
          message: 'STRICT_FREE_ONLY is immutable and cannot be disabled through the dashboard or settings API.',
          code: 'immutable_free_policy',
        },
      });
    }

    if (parsed.data.logRetentionDays !== undefined) {
      deps.repository.updateSetting('log_retention_days', String(parsed.data.logRetentionDays));
    }
    if (parsed.data.contextSafetyMarginPct !== undefined) {
      deps.repository.updateSetting(
        'context_safety_margin_pct',
        String(parsed.data.contextSafetyMarginPct)
      );
    }
    if (parsed.data.healthCheckIntervalMs !== undefined) {
      deps.repository.updateSetting(
        'health_check_interval_ms',
        String(parsed.data.healthCheckIntervalMs)
      );
    }
    if (parsed.data.defaultRoutingProfile !== undefined) {
      deps.repository.updateSetting('default_routing_profile', parsed.data.defaultRoutingProfile);
    }
    if (parsed.data.providerPriority !== undefined) {
      deps.routingEngine.setProviderPriority(parsed.data.providerPriority);
      deps.repository.updateSetting('provider_priority', JSON.stringify(parsed.data.providerPriority));
    }

    return {
      strictFreeOnly: true,
      settings: deps.repository.getAllSettings(),
    };
  });

  app.post('/api/admin/api-keys', { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { message: 'API key name is required.', code: 'invalid_request' },
      });
    }
    const created = deps.repository.createApiKey(parsed.data.name);
    return reply.code(201).send(created);
  });

  app.delete('/api/admin/api-keys/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const revoked = deps.repository.revokeApiKey(id);
    if (!revoked) {
      return reply.code(404).send({
        error: { message: 'API key not found.', code: 'not_found' },
      });
    }
    return { revoked: true, id };
  });
}
