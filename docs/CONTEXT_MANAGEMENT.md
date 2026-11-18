# Context Management

UjjwalRouter routes across verified context capacities up to 128K, 256K, 512K, 1M, or 2M tokens **strictly when verified upstream**. It never invents context sizes from model names.

## Five Context Limits Tracked Per Model

In `ModelRecord` and `src/core/capabilities/context-limits.ts`, UjjwalRouter distinguishes:
1. `contextWindow`: Advertised model context window.
2. `providerInputLimit`: Provider-enforced input limit (e.g., OpenRouter `top_provider.context_length` or Gemini `inputTokenLimit`).
3. `accountFreeInputLimit`: Account-specific free-tier limit.
4. `effectiveContextWindow`: **Always computed as the minimum** positive value across limits 1–3 (`computeEffectiveContextWindow`).
5. `maxOutputTokens`: Maximum allowed completion tokens (`top_provider.max_completion_tokens`, Gemini `outputTokenLimit`, or Groq `max_completion_tokens`).

## Token Estimation & Preflight (`src/core/context/`)

`estimateRequestTokens()` conservatively estimates input tokens across:
- `system` / `developer` prompts
- `user` / `assistant` messages (including `reasoning_content` and serialized `tool_calls`)
- `tool` definitions (`tools[]` JSON schemas)
- `tool` results (`role: 'tool'`)
- Image inputs (`258` tokens for `low` detail, `1100` tokens for `auto`/`high` detail)

`ContextManager` adds:
- `reservedOutputTokens`: Requested `max_completion_tokens` / `max_tokens` (or `DEFAULT_RESERVED_OUTPUT_TOKENS`, default 4096).
- `safetyMarginTokens`: `max(ceil(estimatedInput * CONTEXT_SAFETY_MARGIN_PCT), CONTEXT_SAFETY_MARGIN_TOKENS)` (default 5% or 1024 tokens).
- **Native Token Counting**: When an adapter implements `countTokens` (e.g., Google Gemini `:countTokens`) and the heuristic estimate exceeds 65% of the candidate's `effectiveContextWindow`, `ContextManager` queries the provider's native token count and uses `max(heuristic, nativeCount)`.

## No Silent Truncation

If `effectiveInputTokens + reservedOutputTokens + safetyMarginTokens > effectiveContextWindow`:
- That candidate model is excluded.
- If no verified free model can fit the request, UjjwalRouter returns `HTTP 400 context_length_exceeded`.
- UjjwalRouter **never silently drops or truncates** conversation history.

## Context Window vs. Cross-Request Conversation Memory

A model's context window (e.g., 1M tokens) measures the **single-request payload capacity** (system prompt + conversation history + tools + reserved output). It is **not** persistent server-side state across separate HTTP calls: stateless OpenAI-compatible clients like Hermes Agent must supply the active conversation window or apply client-side compaction/summarization when a session exceeds the model's verified effective context.
