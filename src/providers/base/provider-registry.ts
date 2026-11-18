import type { AppConfig } from '../../config/env.js';
import type { FetchLike } from '../base/openai-compat-base.js';
import type { ProviderAdapter } from '../base/provider-adapter.js';
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

export const DEFAULT_PROVIDER_PRIORITY: readonly string[] = [
  'google',
  'groq',
  'sambanova',
  'mistral',
  'cloudflare',
  'cohere',
  'ollama',
  'openrouter',
  'nvidia',
  'custom',
];

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  public register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public unregister(providerId: string): boolean {
    return this.adapters.delete(providerId);
  }

  public get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public getAll(): ProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  public getMap(): Map<string, ProviderAdapter> {
    return this.adapters;
  }
}

export function createDefaultProviderRegistry(
  config: AppConfig,
  fetchFn?: FetchLike
): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register(
    new GoogleGeminiAdapter({
      apiKey: config.providers.google.apiKey,
      projectNoBillingConfirmed: config.providers.google.projectNoBillingConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new GroqAdapter({
      apiKey: config.providers.groq.apiKey,
      freePlanConfirmed: config.providers.groq.freePlanConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new SambaNovaAdapter({
      apiKey: config.providers.sambanova.apiKey,
      freeTierConfirmed: config.providers.sambanova.freeTierConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new MistralAdapter({
      apiKey: config.providers.mistral.apiKey,
      freePlanConfirmed: config.providers.mistral.freePlanConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new CloudflareAdapter({
      apiToken: config.providers.cloudflare.apiToken,
      accountId: config.providers.cloudflare.accountId,
      freePlanConfirmed: config.providers.cloudflare.freePlanConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new CohereAdapter({
      apiKey: config.providers.cohere.apiKey,
      freePlanConfirmed: config.providers.cohere.freePlanConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new OllamaAdapter({
      baseUrl: config.providers.ollama.baseUrl,
      enabled: config.providers.ollama.enabled,
      fetchFn,
    })
  );

  registry.register(
    new OpenRouterAdapter({
      apiKey: config.providers.openrouter.apiKey,
      fetchFn,
    })
  );

  registry.register(
    new NvidiaNimAdapter({
      apiKey: config.providers.nvidia.apiKey,
      hostedFreeNoCreditsConfirmed: config.providers.nvidia.hostedFreeNoCreditsConfirmed,
      fetchFn,
    })
  );

  registry.register(
    new HuggingFaceAdapter({
      token: config.providers.huggingface.token,
      enabled: config.providers.huggingface.enabled,
      fetchFn,
    })
  );

  return registry;
}
