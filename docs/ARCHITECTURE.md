# System Architecture

UjjwalRouter follows a modular TypeScript monorepo architecture built on Fastify, Drizzle ORM (SQLite), and React/Vite/MUI.

## Directory Structure

```text
src/
  app/                 Fastify bootstrap, security middleware, route wiring, SPA serving
  config/              Zod-validated environment loader (STRICT_FREE_ONLY=true invariant)
  core/
    capabilities/      Effective context window calculation
    context/           Conservative token estimator and context preflight manager
    failover/          CircuitBreakerRegistry & FailoverCoordinator
    model-discovery/   Periodic provider discovery and health orchestrator
    model-registry/    Dynamic in-memory + DB-synced model & capability registry
    policy/            Central FreeInferencePolicy & eligibility status types
    quota-manager/     Daily request/token tracking & exhaustion lockouts
    rate-limiter/      Sliding-window RPM/TPM & header-driven cooldowns
    router/            Deterministic RoutingEngine & 8 task profiles
    usage/             Execution log interface and in-memory ring buffer
  providers/
    base/              ProviderAdapter contract, OpenAI-compat SSE/HTTP base, ProviderRegistry
    google/            Native Google Gemini v1beta adapter
    openrouter/        OpenRouter :free + /key entitlement adapter
    groq/              Groq OpenAI-compat adapter
    nvidia/            NVIDIA NIM adapter (strictly guarded against trial credits)
    huggingface/       Hugging Face adapter (disabled by default)
    custom/            Extensible SSRF-guarded custom OpenAI-compatible adapter
  api/
    errors/            OpenAI-compatible JSON error formatter
    routes/            /health, /ready, /v1/models, /v1/chat/completions, /api/admin/*
    schemas/           Zod schemas for OpenAI Chat Completions requests
  database/
    schema/            15 Drizzle SQLite tables
    migrations/        Generated SQL migrations
    repositories/      RouterRepository (atomic transactions, analytics, retention)
  services/            RouterLifecycleService (discovery, health, retention timers)
  security/            Bearer auth, constant-time compare, AES-256-GCM secrets, SSRF guard, CSRF/session auth
  logging/             Pino logger with secret/header redaction

apps/dashboard/        React + Vite + MUI + Recharts dark-first control plane
tests/                 Unit, provider mock, integration, security, and Hermes tests
scripts/               Arch Linux systemd install, uninstall, backup, health-check, Hermes helper
```

## Request Lifecycle

1. **Ingress & Auth (`src/security/auth.ts`)**: `POST /v1/chat/completions` validates the Bearer token against `ROUTER_API_KEYS` and SHA-256 hashes in `api_keys`.
2. **Validation (`src/api/schemas/chat-completions.ts`)**: Validates OpenAI-compatible payload within `MAX_REQUEST_BODY_BYTES`.
3. **Routing & Context Preflight (`src/core/router/routing-engine.ts`, `src/core/context/context-manager.ts`)**:
   - Filters `ModelRegistry` strictly through `FreeInferencePolicy.evaluateModel()`.
   - Estimates input tokens (system, messages, tool definitions, tool results, images) + reserved output + safety margin (invoking native `countTokens` where supported near model boundaries).
   - Scores fitting candidates deterministically for the requested profile.
4. **Failover Execution (`src/core/failover/failover-coordinator.ts`)**:
   - Re-evaluates `FreeInferencePolicy`, context fit, `CircuitBreakerRegistry`, `QuotaManager`, and `RateLimiter` before every attempt.
   - For streaming, fetches the first SSE chunk before writing HTTP `200` headers so pre-stream failures fail over seamlessly or return clean HTTP error codes (`429`/`503`). Never replays after partial streamed output is sent.
5. **Telemetry (`src/database/repositories/router-repository.ts`)**: Records request metadata, per-attempt audit trail, token usage, and daily rollups in SQLite without logging prompts or secrets.
