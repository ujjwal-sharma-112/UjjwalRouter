# Provider Adapters

Every provider implements `ProviderAdapter` (`src/providers/base/provider-adapter.ts`), covering authentication validation, dynamic model discovery, metadata normalization, free eligibility verification, context retrieval, chat completion, SSE streaming, tool calling, usage extraction, rate-limit/quota detection, health checking, and error normalization.

## 1. Google Gemini (`src/providers/google/google-gemini-adapter.ts`)

- **Base URL**: `https://generativelanguage.googleapis.com/v1beta`
- **Auth**: `x-goog-api-key` header (never passed in query URLs).
- **Discovery**: Queries `/v1beta/models` (paginated) and extracts exact `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`, and `thinking`.
- **Token Counting**: Native `POST /models/{id}:countTokens`.
- **Free Policy**:
  - Requires `GOOGLE_PROJECT_NO_BILLING=true` confirming the Google AI Studio project has **no billing account linked**.
  - Only verified free-tier families (`gemini-*-flash*`, `gemini-*-flash-lite*`, `gemma-*`) qualify for `FREE_VERIFIED`.
  - Paid-only families (`pro`, `ultra`, `imagen`, `veo`, `*-image*`, `deep-research`, `computer-use`) are classified as `PAID` and blocked.
- **Hermes Support**: Preserves `thoughtSignature` across multi-turn function calling loops and converts OpenAI `tool` messages back to Gemini `functionResponse` parts.

## 2. OpenRouter (`src/providers/openrouter/openrouter-adapter.ts`)

- **Base URL**: `https://openrouter.ai/api/v1`
- **Discovery**: Calls `GET /api/v1/key` and `GET /api/v1/models`.
- **Free Policy**:
  - Strictly enforces `id.endsWith(':free')`. Never strips `:free` or maps to a paid model.
  - Strictly requires `pricing.prompt === 0`, `pricing.completion === 0`, `pricing.request === 0`, and `pricing.image === 0`.
  - Computes `effectiveContextWindow = min(context_length, top_provider.context_length)`.
- **Streaming**: Skips OpenRouter `: OPENROUTER PROCESSING` SSE comments cleanly.

## 3. Groq (`src/providers/groq/groq-adapter.ts`)

- **Base URL**: `https://api.groq.com/openai/v1`
- **Discovery**: Calls `GET /openai/v1/models`, using upstream `context_window` and `max_completion_tokens`, excluding non-chat audio/guard models (`whisper*`, `*tts*`, `*guard*`).
- **Free Policy**: Requires `GROQ_FREE_PLAN_CONFIRMED=true` attesting the organization is on Groq's Free Plan with no billing method attached.
- **Rate Limits**: Tracks `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, and `x-ratelimit-remaining-tokens` headers.

## 4. NVIDIA NIM (`src/providers/nvidia/nvidia-nim-adapter.ts`)

- **Base URL**: `https://integrate.api.nvidia.com/v1`
- **Discovery**: Calls `GET /v1/models` and reads `max_model_len` and `permission[0].allow_sampling`.
- **Free Policy**: Free NVIDIA Developer accounts typically rely on finite prototyping credits (1,000–5,000 credits). Therefore, models default to `TRIAL_ONLY` (`promotionalCredits: true`) and are **rejected** under `STRICT_FREE_ONLY` unless `NVIDIA_HOSTED_FREE_NO_CREDITS_CONFIRMED=true` is explicitly verified. Never confuses downloadable weights with free hosted endpoints.

## 5. Hugging Face Inference Providers (`src/providers/huggingface/huggingface-adapter.ts`)

- **Base URL**: `https://router.huggingface.co/v1`
- **Default State**: **Disabled by default** (`HUGGINGFACE_ENABLED=false`).
- **Free Policy**: Hugging Face free accounts receive finite monthly promotional credits ($0.10/month) rather than permanent zero-cost inference. Discovered models are marked `TRIAL_ONLY` (`PROMOTIONAL_CREDITS`) and blocked by `FreeInferencePolicy`.

## 6. Custom OpenAI-Compatible Providers (`src/providers/custom/custom-openai-adapter.ts`)

- Registered programmatically via `ProviderRegistry.register(new CustomOpenAIAdapter(...))`.
- Enforces SSRF URL validation (HTTPS required; loopback HTTP allowed only when `allowLoopback: true`).
- Defaults all models to `FREE_UNVERIFIED` unless independently verified zero-cost (`zeroCostVerified: true` with explicit `verificationSource`).
