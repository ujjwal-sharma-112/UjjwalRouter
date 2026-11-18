import type { ModelRecord } from '../../core/policy/types.js';
import type {
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ContextCapabilityDetails,
  FreeEligibilityVerification,
  NormalizedChatRequest,
  NormalizedProviderError,
  ProviderAdapterInfo,
  ProviderHealthResult,
  RateLimitObservation,
  TokenUsage,
} from './types.js';

export interface ProviderExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  requestId?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  getInfo(): ProviderAdapterInfo;
  isConfigured(): boolean;
  isEnabled(): boolean;

  validateAuthentication(): Promise<{ valid: boolean; reason: string }>;
  discoverModels(signal?: AbortSignal): Promise<ModelRecord[]>;
  getModelMetadata(modelId: string, signal?: AbortSignal): Promise<ModelRecord | null>;
  verifyFreeEligibility(
    model: ModelRecord,
    signal?: AbortSignal
  ): Promise<FreeEligibilityVerification>;
  getContextCapabilities(model: ModelRecord): ContextCapabilityDetails;

  chatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse>;

  streamChatCompletion(
    model: ModelRecord,
    request: NormalizedChatRequest,
    options?: ProviderExecutionOptions
  ): AsyncIterable<ChatCompletionStreamChunk>;

  countTokens?(
    model: ModelRecord,
    request: NormalizedChatRequest,
    signal?: AbortSignal
  ): Promise<number | null>;

  extractUsage(payload: unknown): TokenUsage | null;
  detectRateLimit(statusCode: number, headers: Headers, bodyText: string): RateLimitObservation | null;
  detectQuotaExhaustion(statusCode: number, bodyText: string): boolean;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealthResult>;
  normalizeError(error: unknown, statusCode?: number, headers?: Headers, bodyText?: string): NormalizedProviderError;
}
