# Intelligent Routing Engine & Automatic Failover

## Routing Profiles

`src/core/router/profiles.ts` and `RoutingEngine` (`src/core/router/routing-engine.ts`) support 8 virtual model profiles:

| Profile | Selection Strategy |
| :--- | :--- |
| `auto` | Auto-infers `auto-vision` (if images present), `auto-json` (if `response_format` set), or `auto-tools` (if `tools` passed); otherwise balances provider priority, context, coding quality, availability, and latency. |
| `auto-coding` | Prioritizes `codingCapability` (`high`/`medium`), tool calling, JSON mode, and reasoning. |
| `auto-reasoning` | Prioritizes `supportsReasoning` models. |
| `auto-long` | Requires `effectiveContextWindow >= 128,000` and strongly weights highest verified context + output capacity. |
| `auto-fast` | Heavily weights observed EWMA latency and provider priority for rapid turnaround. |
| `auto-tools` | Strictly requires `supportsTools: true`. |
| `auto-vision` | Strictly requires `supportsVision: true`. |
| `auto-json` | Strictly requires `supportsJsonMode: true`. |

Clients may also specify a concrete canonical ID (e.g., `google:gemini-2.5-flash` or `openrouter:qwen/qwen3-coder:free`). Paid or unverified models are rejected with `HTTP 403`.

## Deterministic Scoring

Each fitting `FREE_VERIFIED` candidate receives an explainable score composed of:
- `providerPriorityScore`: Derived from configurable `providerPriority` ranking.
- `contextCapacityScore`: Normalized log-scale score over `effectiveContextWindow` (weighted highest for `auto-long`, lightly for `auto-fast`).
- `capabilityScore`: Profile-specific weight on coding tier, tools, reasoning, vision, and JSON support.
- `availabilityScore`: `15` for `AVAILABLE`, `5` for `DEGRADED`.
- `latencyScore`: Derived from observed EWMA latency per model.

Selection explanations are stored in SQLite (`requests.routing_explanation`) and displayed in the Dashboard Routing view.

## Automatic Failover & Circuit Breakers (`src/core/failover/`)

`FailoverCoordinator` handles up to `maxAttempts` (default 4) across fitting verified candidates with exponential backoff + jitter:
- **Retried / Failed Over**: HTTP `429` (rate limit), quota exhaustion (`402` or quota messages), HTTP `5xx`, timeouts, connection errors, `404` model unavailability, and upstream context errors.
- **Never Failed Over**: Client/schema errors (`400 invalid_request`, `422`) and `auth_error`.
- **CircuitBreakerRegistry**: Trips a provider `OPEN` after `3` infrastructure failures for `30s`, then probes a single request in `HALF_OPEN`.
- **Stream Replay Protection**: Before writing HTTP `200` headers for SSE streaming, the router pulls the first chunk from the iterator. If the primary provider fails *before* yielding any chunk, failover switches cleanly to the next verified free provider. Once any chunk has been sent to the client, mid-stream failover is strictly forbidden to avoid corrupting or duplicating assistant output.
