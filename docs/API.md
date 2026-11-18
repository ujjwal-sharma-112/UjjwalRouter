# HTTP API Reference

Base URL: `http://127.0.0.1:8787`

## Operational Endpoints

### `GET /health`
Unauthenticated liveness probe.
- **Response (`200`)**: `{ "status": "ok", "service": "ujjwalrouter", "strict_free_only": true, "started_at": "...", "timestamp": "..." }`

### `GET /ready`
Readiness probe reflecting whether at least one `FREE_VERIFIED` model is currently eligible.
- **Response (`200` if ready, `503` otherwise)**: `{ "ready": true, "strict_free_only": true, "verified_free_model_count": 3, "enabled_provider_count": 2, "reason": "..." }`

## OpenAI-Compatible Endpoints

Require `Authorization: Bearer <ROUTER_API_KEY>`.

### `GET /v1/models`
Lists active routing profiles (`auto`, `auto-coding`, etc., when supported by at least one eligible model) and all `FREE_VERIFIED` concrete models (`providerId:modelId`). Never returns `PAID`, `TRIAL_ONLY`, or `FREE_UNVERIFIED` models.

### `POST /v1/chat/completions`
Supports standard OpenAI Chat Completions parameters:
- `model`: Routing profile (`auto`, `auto-coding`, `auto-reasoning`, `auto-long`, `auto-fast`, `auto-tools`, `auto-vision`, `auto-json`) or concrete verified ID (e.g., `google:gemini-2.5-flash`).
- `messages`: `system`, `developer`, `user`, `assistant` (with `tool_calls`), `tool` (with `tool_call_id`).
- `tools`, `tool_choice`, `parallel_tool_calls`
- `response_format` (`text`, `json_object`, `json_schema`)
- `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `reasoning_effort`
- `stream`: Boolean. When `true`, returns `text/event-stream` SSE chunks ending with optional `usage` chunk and `data: [DONE]`.

Informational headers returned on success:
- `x-ujjwalrouter-request-id`
- `x-ujjwalrouter-provider`
- `x-ujjwalrouter-model`
- `x-ujjwalrouter-failover-count`
- `x-ujjwalrouter-strict-free: true`

Error responses follow OpenAI schema (`{ "error": { "message", "type", "param", "code" } }`):
- `400 context_length_exceeded` / `invalid_request`
- `401 invalid_api_key`
- `403 free_policy_violation`
- `404 model_not_found`
- `413 payload_too_large`
- `429 rate_limit_exceeded`
- `503 no_eligible_free_models`

## Dashboard Admin Endpoints (`/api/admin/*`)

Protected by `DASHBOARD_ADMIN_TOKEN` (session cookie + `X-CSRF-Token` or Bearer token):
- `GET /api/admin/auth/session`
- `POST /api/admin/auth/login` / `POST /api/admin/auth/logout`
- `GET /api/admin/overview`
- `GET /api/admin/providers` / `POST /api/admin/providers/discover` / `POST /api/admin/providers/:id/credentials` / `POST /api/admin/providers/:id/toggle`
- `GET /api/admin/models`
- `GET /api/admin/routing` / `PUT /api/admin/routing`
- `GET /api/admin/logs`
- `GET /api/admin/analytics`
- `GET /api/admin/settings` / `PUT /api/admin/settings`
- `POST /api/admin/api-keys` / `DELETE /api/admin/api-keys/:id`
