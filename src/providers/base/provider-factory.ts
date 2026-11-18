import type { AppConfig } from '../../config/env.js';
import type { RouterRepository } from '../../database/repositories/router-repository.js';
import type { EncryptedSecretStore } from '../../security/secret-store.js';
import { CloudflareAdapter } from '../cloudflare/cloudflare-adapter.js';
import { CohereAdapter } from '../cohere/cohere-adapter.js';
import { GoogleGeminiAdapter } from '../google/google-gemini-adapter.js';
import { GroqAdapter } from '../groq/groq-adapter.js';
import { HuggingFaceAdapter } from '../huggingface/huggingface-adapter.js';
import { MistralAdapter } from '../mistral/mistral-adapter.js';
import { NvidiaNimAdapter } from '../nvidia/nvidia-nim-adapter.js';
import { OllamaAdapter } from '../ollama/ollama-adapter.js';
import { OpenRouterAdapter } from '../openrouter/openrouter-adapter.js';
import { SambaNovaAdapter } from '../sambanova/sambanova-adapter.js';
import type { FetchLike } from './openai-compat-base.js';
import type { ProviderAdapter } from './provider-adapter.js';
import { DEFAULT_PROVIDER_PRIORITY } from './provider-registry.js';

export const BUILTIN_PROVIDER_IDS = [
  'google',
  'groq',
  'sambanova',
  'mistral',
  'cloudflare',
  'cohere',
  'ollama',
  'openrouter',
  'nvidia',
  'huggingface',
] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

export interface ProviderUiMetadata {
  requiresApiKey: boolean;
  requiresEntitlementConfirmation: boolean;
  requiresAccountId: boolean;
  supportsBaseUrl: boolean;
}

export const PROVIDER_UI_METADATA: Record<BuiltinProviderId, ProviderUiMetadata> = {
  google: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  groq: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  sambanova: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  mistral: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  cloudflare: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: true,
    supportsBaseUrl: false,
  },
  cohere: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  ollama: {
    requiresApiKey: false,
    requiresEntitlementConfirmation: false,
    requiresAccountId: false,
    supportsBaseUrl: true,
  },
  openrouter: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: false,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  nvidia: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: true,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
  huggingface: {
    requiresApiKey: true,
    requiresEntitlementConfirmation: false,
    requiresAccountId: false,
    supportsBaseUrl: false,
  },
};

export function isBuiltinProviderId(id: string): id is BuiltinProviderId {
  return (BUILTIN_PROVIDER_IDS as readonly string[]).includes(id);
}

function readPersistedBooleanSetting(
  repository: RouterRepository,
  key: string,
  envFallback: boolean
): boolean {
  const stored = repository.getSetting(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return envFallback;
}

export function getEffectiveProviderSecret(
  config: AppConfig,
  secretStore: EncryptedSecretStore,
  providerId: string
): string {
  const stored = secretStore.getSecret(`${providerId.toUpperCase()}_API_KEY`);
  if (stored) return stored;

  switch (providerId) {
    case 'google':
      return config.providers.google.apiKey;
    case 'groq':
      return config.providers.groq.apiKey;
    case 'sambanova':
      return config.providers.sambanova.apiKey;
    case 'mistral':
      return config.providers.mistral.apiKey;
    case 'cloudflare':
      return secretStore.getSecret('CLOUDFLARE_API_TOKEN') || config.providers.cloudflare.apiToken;
    case 'cohere':
      return config.providers.cohere.apiKey;
    case 'openrouter':
      return config.providers.openrouter.apiKey;
    case 'nvidia':
      return config.providers.nvidia.apiKey;
    case 'huggingface':
      return config.providers.huggingface.token;
    default:
      return '';
  }
}

export function getEffectiveEntitlementConfirmation(
  config: AppConfig,
  repository: RouterRepository,
  providerId: string
): boolean {
  const key = `provider_confirmed:${providerId}`;
  switch (providerId) {
    case 'google':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.google.projectNoBillingConfirmed
      );
    case 'groq':
      return readPersistedBooleanSetting(repository, key, config.providers.groq.freePlanConfirmed);
    case 'sambanova':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.sambanova.freeTierConfirmed
      );
    case 'mistral':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.mistral.freePlanConfirmed
      );
    case 'cloudflare':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.cloudflare.freePlanConfirmed
      );
    case 'cohere':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.cohere.freePlanConfirmed
      );
    case 'nvidia':
      return readPersistedBooleanSetting(
        repository,
        key,
        config.providers.nvidia.hostedFreeNoCreditsConfirmed
      );
    default:
      return true;
  }
}

export function resolveEffectiveProvidersConfig(
  config: AppConfig,
  secretStore: EncryptedSecretStore,
  repository: RouterRepository
): AppConfig {
  return {
    ...config,
    providers: {
      google: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'google'),
        projectNoBillingConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'google'),
      },
      groq: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'groq'),
        freePlanConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'groq'),
      },
      sambanova: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'sambanova'),
        freeTierConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'sambanova'),
      },
      mistral: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'mistral'),
        freePlanConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'mistral'),
      },
      cloudflare: {
        apiToken: getEffectiveProviderSecret(config, secretStore, 'cloudflare'),
        accountId:
          secretStore.getSecret('CLOUDFLARE_ACCOUNT_ID') ||
          repository.getSetting('provider_account_id:cloudflare') ||
          config.providers.cloudflare.accountId,
        freePlanConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'cloudflare'),
      },
      cohere: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'cohere'),
        freePlanConfirmed: getEffectiveEntitlementConfirmation(config, repository, 'cohere'),
      },
      ollama: {
        enabled: readPersistedBooleanSetting(
          repository,
          'provider_enabled:ollama',
          config.providers.ollama.enabled
        ),
        baseUrl:
          repository.getSetting('provider_base_url:ollama') || config.providers.ollama.baseUrl,
      },
      openrouter: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'openrouter'),
      },
      nvidia: {
        apiKey: getEffectiveProviderSecret(config, secretStore, 'nvidia'),
        hostedFreeNoCreditsConfirmed: getEffectiveEntitlementConfirmation(
          config,
          repository,
          'nvidia'
        ),
      },
      huggingface: {
        enabled: readPersistedBooleanSetting(
          repository,
          'provider_enabled:huggingface',
          config.providers.huggingface.enabled
        ),
        token: getEffectiveProviderSecret(config, secretStore, 'huggingface'),
      },
    },
  };
}

export function buildProviderAdapter(params: {
  providerId: BuiltinProviderId;
  effectiveConfig: AppConfig;
  enabledOverride?: boolean;
  fetchFn?: FetchLike;
}): ProviderAdapter {
  const { providerId, effectiveConfig, enabledOverride, fetchFn } = params;
  const p = effectiveConfig.providers;

  switch (providerId) {
    case 'google':
      return new GoogleGeminiAdapter({
        apiKey: p.google.apiKey,
        projectNoBillingConfirmed: p.google.projectNoBillingConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'groq':
      return new GroqAdapter({
        apiKey: p.groq.apiKey,
        freePlanConfirmed: p.groq.freePlanConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'sambanova':
      return new SambaNovaAdapter({
        apiKey: p.sambanova.apiKey,
        freeTierConfirmed: p.sambanova.freeTierConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'mistral':
      return new MistralAdapter({
        apiKey: p.mistral.apiKey,
        freePlanConfirmed: p.mistral.freePlanConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'cloudflare':
      return new CloudflareAdapter({
        apiToken: p.cloudflare.apiToken,
        accountId: p.cloudflare.accountId,
        freePlanConfirmed: p.cloudflare.freePlanConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'cohere':
      return new CohereAdapter({
        apiKey: p.cohere.apiKey,
        freePlanConfirmed: p.cohere.freePlanConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'ollama':
      return new OllamaAdapter({
        baseUrl: p.ollama.baseUrl,
        enabled: enabledOverride ?? p.ollama.enabled,
        fetchFn,
      });
    case 'openrouter':
      return new OpenRouterAdapter({
        apiKey: p.openrouter.apiKey,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'nvidia':
      return new NvidiaNimAdapter({
        apiKey: p.nvidia.apiKey,
        hostedFreeNoCreditsConfirmed: p.nvidia.hostedFreeNoCreditsConfirmed,
        enabled: enabledOverride,
        fetchFn,
      });
    case 'huggingface':
      return new HuggingFaceAdapter({
        token: p.huggingface.token,
        enabled: enabledOverride ?? p.huggingface.enabled,
        fetchFn,
      });
  }
}

const LEGACY_PRIORITY = ['google', 'openrouter', 'groq', 'nvidia', 'custom'];

/**
 * Merges newly supported providers into an existing saved priority list while upgrading legacy defaults.
 */
export function resolveProviderPriorityList(savedRaw: string | null | undefined): {
  priority: string[];
  migrated: boolean;
} {
  if (!savedRaw) {
    return { priority: [...DEFAULT_PROVIDER_PRIORITY], migrated: false };
  }
  try {
    const parsed = JSON.parse(savedRaw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { priority: [...DEFAULT_PROVIDER_PRIORITY], migrated: false };
    }
    const items = parsed.map(String);
    const isExactLegacy =
      items.length === LEGACY_PRIORITY.length &&
      items.every((val, idx) => val === LEGACY_PRIORITY[idx]);
    if (isExactLegacy) {
      return { priority: [...DEFAULT_PROVIDER_PRIORITY], migrated: true };
    }
    const missing = DEFAULT_PROVIDER_PRIORITY.filter((id) => !items.includes(id));
    if (missing.length === 0) {
      return { priority: items, migrated: false };
    }
    const customIdx = items.indexOf('custom');
    const merged = [...items];
    if (customIdx >= 0) {
      merged.splice(customIdx, 0, ...missing);
    } else {
      merged.push(...missing);
    }
    return { priority: merged, migrated: true };
  } catch {
    return { priority: [...DEFAULT_PROVIDER_PRIORITY], migrated: false };
  }
}
