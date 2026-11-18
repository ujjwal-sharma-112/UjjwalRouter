import type {
  FreeEligibilityStatus,
  FreeTierType,
  ModelRecord,
  ProviderQuotaInfo,
} from '../../core/policy/types.js';

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  thought_signature?: string;
  extra_content?: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string | null;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        description?: string;
        schema?: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string | null;
    };
    finish_reason: FinishReason;
  }>;
  usage: TokenUsage;
  rateLimitHeaders?: RateLimitObservation;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
  thought_signature?: string;
  extra_content?: Record<string, unknown>;
}

export interface ChatCompletionStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: StreamToolCallDelta[];
      reasoning_content?: string | null;
    };
    finish_reason: FinishReason;
  }>;
  usage?: TokenUsage | null;
}

export interface RateLimitObservation {
  limitRequests?: number | null;
  remainingRequests?: number | null;
  resetRequestsAt?: string | null;
  limitTokens?: number | null;
  remainingTokens?: number | null;
  resetTokensAt?: string | null;
  retryAfterMs?: number | null;
}

export interface ProviderHealthResult {
  providerId: string;
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  latencyMs: number;
  checkedAt: string;
  message: string;
  quotaInfo?: ProviderQuotaInfo;
}

export interface FreeEligibilityVerification {
  providerId: string;
  modelId: string;
  eligible: boolean;
  freeEligibility: FreeEligibilityStatus;
  freeTierType: FreeTierType;
  billingRequired: boolean;
  promotionalCredits: boolean;
  verifiedAt: string;
  expiresAt: string | null;
  source: string;
  reason: string;
  quotaInfo?: ProviderQuotaInfo;
}

export interface ContextCapabilityDetails {
  advertisedContextWindow: number;
  providerInputLimit: number | null;
  accountFreeInputLimit: number | null;
  effectiveContextWindow: number;
  maxOutputTokens: number;
  source: string;
}

export type NormalizedErrorCategory =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_error'
  | 'billing_required'
  | 'invalid_request'
  | 'context_length_exceeded'
  | 'model_unavailable'
  | 'timeout'
  | 'network_error'
  | 'upstream_5xx'
  | 'unknown';

export interface NormalizedProviderError {
  providerId: string;
  category: NormalizedErrorCategory;
  statusCode: number;
  retryable: boolean;
  cooldownMs: number;
  markQuotaExhausted: boolean;
  message: string;
  retryAfterMs?: number | null;
}

export interface ProviderAdapterInfo {
  id: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  endpointUrl: string;
  supportsDiscovery: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsNativeTokenCount: boolean;
  notes?: string;
}
