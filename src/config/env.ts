import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const booleanString = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    const normalized = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    throw new Error(`Invalid boolean value: ${val}`);
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Mandatory free-only enforcement. Cannot be disabled via dashboard or ordinary config.
  STRICT_FREE_ONLY: booleanString.default(true).transform((val) => {
    if (!val) {
      throw new Error(
        'STRICT_FREE_ONLY=false is prohibited: UjjwalRouter strictly enforces zero-cost inference and never permits paid fallback.'
      );
    }
    return true as const;
  }),

  ROUTER_API_KEYS: z.string().default(''),
  DASHBOARD_ADMIN_TOKEN: z.string().default(''),
  SECRET_ENCRYPTION_KEY: z.string().default(''),

  DATABASE_PATH: z.string().trim().min(1).default('./data/ujjwalrouter.db'),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  DISCOVERY_REFRESH_INTERVAL_MS: z.coerce.number().int().min(10000).default(900000),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(10000).default(300000),
  VERIFICATION_MAX_AGE_MS: z.coerce.number().int().min(60000).default(86400000),

  DEFAULT_ROUTING_PROFILE: z
    .enum([
      'auto',
      'auto-coding',
      'auto-reasoning',
      'auto-long',
      'auto-fast',
      'auto-tools',
      'auto-vision',
      'auto-json',
    ])
    .default('auto'),

  CONTEXT_SAFETY_MARGIN_PCT: z.coerce.number().min(0).max(0.5).default(0.05),
  CONTEXT_SAFETY_MARGIN_TOKENS: z.coerce.number().int().min(0).max(100000).default(1024),
  DEFAULT_RESERVED_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(131072).default(4096),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(104857600).default(10485760),
  RATE_LIMIT_MAX_PER_MIN: z.coerce.number().int().min(1).max(10000).default(120),
  ALLOWED_CORS_ORIGINS: z.string().default('http://127.0.0.1:8787,http://localhost:8787,http://127.0.0.1:5173,http://localhost:5173'),
  ALLOW_PUBLIC_BIND: booleanString.default(false),

  // Provider credentials and explicit non-billing entitlement attestations
  GOOGLE_API_KEY: z.string().default(''),
  GOOGLE_PROJECT_NO_BILLING: booleanString.default(false),

  OPENROUTER_API_KEY: z.string().default(''),

  GROQ_API_KEY: z.string().default(''),
  GROQ_FREE_PLAN_CONFIRMED: booleanString.default(false),

  MISTRAL_API_KEY: z.string().default(''),
  MISTRAL_FREE_PLAN_CONFIRMED: booleanString.default(false),

  SAMBANOVA_API_KEY: z.string().default(''),
  SAMBANOVA_FREE_TIER_CONFIRMED: booleanString.default(false),

  CLOUDFLARE_API_TOKEN: z.string().default(''),
  CLOUDFLARE_ACCOUNT_ID: z.string().default(''),
  CLOUDFLARE_FREE_PLAN_CONFIRMED: booleanString.default(false),

  COHERE_API_KEY: z.string().default(''),
  COHERE_FREE_PLAN_CONFIRMED: booleanString.default(false),

  OLLAMA_ENABLED: booleanString.default(false),
  OLLAMA_BASE_URL: z.string().trim().min(1).default('http://127.0.0.1:11434'),

  NVIDIA_API_KEY: z.string().default(''),
  NVIDIA_HOSTED_FREE_NO_CREDITS_CONFIRMED: booleanString.default(false),

  HUGGINGFACE_ENABLED: booleanString.default(false),
  HF_TOKEN: z.string().default(''),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  strictFreeOnly: true;
  routerApiKeys: string[];
  dashboardAdminToken: string;
  secretEncryptionKey: string;
  databasePath: string;
  logRetentionDays: number;
  discoveryRefreshIntervalMs: number;
  healthCheckIntervalMs: number;
  verificationMaxAgeMs: number;
  defaultRoutingProfile:
    | 'auto'
    | 'auto-coding'
    | 'auto-reasoning'
    | 'auto-long'
    | 'auto-fast'
    | 'auto-tools'
    | 'auto-vision'
    | 'auto-json';
  contextSafetyMarginPct: number;
  contextSafetyMarginTokens: number;
  defaultReservedOutputTokens: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  maxRequestBodyBytes: number;
  rateLimitMaxPerMin: number;
  allowedCorsOrigins: string[];
  allowPublicBind: boolean;
  providers: {
    google: {
      apiKey: string;
      projectNoBillingConfirmed: boolean;
    };
    openrouter: {
      apiKey: string;
    };
    groq: {
      apiKey: string;
      freePlanConfirmed: boolean;
    };
    mistral: {
      apiKey: string;
      freePlanConfirmed: boolean;
    };
    sambanova: {
      apiKey: string;
      freeTierConfirmed: boolean;
    };
    cloudflare: {
      apiToken: string;
      accountId: string;
      freePlanConfirmed: boolean;
    };
    cohere: {
      apiKey: string;
      freePlanConfirmed: boolean;
    };
    ollama: {
      enabled: boolean;
      baseUrl: string;
    };
    nvidia: {
      apiKey: string;
      hostedFreeNoCreditsConfirmed: boolean;
    };
    huggingface: {
      enabled: boolean;
      token: string;
    };
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env, skipDotenv = false): AppConfig {
  if (!skipDotenv) {
    loadDotenv({ quiet: true } as Parameters<typeof loadDotenv>[0]);
  }

  const parsed = envSchema.parse(rawEnv);

  if (!parsed.ALLOW_PUBLIC_BIND && !isLoopbackHost(parsed.HOST)) {
    throw new Error(
      `Refusing to bind non-loopback host "${parsed.HOST}" unless ALLOW_PUBLIC_BIND=true is explicitly set.`
    );
  }

  const routerApiKeys = parsed.ROUTER_API_KEYS.split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  const allowedCorsOrigins = parsed.ALLOWED_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    strictFreeOnly: true,
    routerApiKeys,
    dashboardAdminToken: parsed.DASHBOARD_ADMIN_TOKEN.trim(),
    secretEncryptionKey: parsed.SECRET_ENCRYPTION_KEY.trim(),
    databasePath: parsed.DATABASE_PATH,
    logRetentionDays: parsed.LOG_RETENTION_DAYS,
    discoveryRefreshIntervalMs: parsed.DISCOVERY_REFRESH_INTERVAL_MS,
    healthCheckIntervalMs: parsed.HEALTH_CHECK_INTERVAL_MS,
    verificationMaxAgeMs: parsed.VERIFICATION_MAX_AGE_MS,
    defaultRoutingProfile: parsed.DEFAULT_ROUTING_PROFILE,
    contextSafetyMarginPct: parsed.CONTEXT_SAFETY_MARGIN_PCT,
    contextSafetyMarginTokens: parsed.CONTEXT_SAFETY_MARGIN_TOKENS,
    defaultReservedOutputTokens: parsed.DEFAULT_RESERVED_OUTPUT_TOKENS,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    firstByteTimeoutMs: parsed.FIRST_BYTE_TIMEOUT_MS,
    maxRequestBodyBytes: parsed.MAX_REQUEST_BODY_BYTES,
    rateLimitMaxPerMin: parsed.RATE_LIMIT_MAX_PER_MIN,
    allowedCorsOrigins,
    allowPublicBind: parsed.ALLOW_PUBLIC_BIND,
    providers: {
      google: {
        apiKey: parsed.GOOGLE_API_KEY.trim(),
        projectNoBillingConfirmed: parsed.GOOGLE_PROJECT_NO_BILLING,
      },
      openrouter: {
        apiKey: parsed.OPENROUTER_API_KEY.trim(),
      },
      groq: {
        apiKey: parsed.GROQ_API_KEY.trim(),
        freePlanConfirmed: parsed.GROQ_FREE_PLAN_CONFIRMED,
      },
      mistral: {
        apiKey: parsed.MISTRAL_API_KEY.trim(),
        freePlanConfirmed: parsed.MISTRAL_FREE_PLAN_CONFIRMED,
      },
      sambanova: {
        apiKey: parsed.SAMBANOVA_API_KEY.trim(),
        freeTierConfirmed: parsed.SAMBANOVA_FREE_TIER_CONFIRMED,
      },
      cloudflare: {
        apiToken: parsed.CLOUDFLARE_API_TOKEN.trim(),
        accountId: parsed.CLOUDFLARE_ACCOUNT_ID.trim(),
        freePlanConfirmed: parsed.CLOUDFLARE_FREE_PLAN_CONFIRMED,
      },
      cohere: {
        apiKey: parsed.COHERE_API_KEY.trim(),
        freePlanConfirmed: parsed.COHERE_FREE_PLAN_CONFIRMED,
      },
      ollama: {
        enabled: parsed.OLLAMA_ENABLED,
        baseUrl: parsed.OLLAMA_BASE_URL.trim(),
      },
      nvidia: {
        apiKey: parsed.NVIDIA_API_KEY.trim(),
        hostedFreeNoCreditsConfirmed: parsed.NVIDIA_HOSTED_FREE_NO_CREDITS_CONFIRMED,
      },
      huggingface: {
        enabled: parsed.HUGGINGFACE_ENABLED,
        token: parsed.HF_TOKEN.trim(),
      },
    },
  };
}
