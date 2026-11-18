# UjjwalRouter

**Maximum Verified Free Context. Zero Paid Inference. No Silent Fallback.**

UjjwalRouter is a self-hosted, free-only multi-provider LLM router designed for **Arch Linux** and **Hermes Agent** (plus any OpenAI-compatible coding client). It exposes one unified OpenAI-compatible API endpoint (`http://127.0.0.1:8787/v1`) and routes requests across genuinely zero-cost upstream providers while strictly blocking paid endpoints, promotional/trial credits, unverified keys, and silent context truncation.

## Key Features

- **Immutable Free-Only Enforcement (`STRICT_FREE_ONLY=true`)**: Only `FREE_VERIFIED` models with zero token/request/image pricing, no billing requirement, no trial/promotional credits, and valid non-expired verification may serve requests.
- **Fail-Closed Guarantee**: If all verified free models are exhausted or unavailable, UjjwalRouter returns a structured HTTP error (`429` or `503`). It never falls back to paid models.
- **Multi-Provider Adapter Architecture**:
  - **Google Gemini API** (`generativelanguage.googleapis.com/v1beta`, native REST + `countTokens` + streaming + function calling + `thoughtSignature` preservation)
  - **OpenRouter** (`openrouter.ai/api/v1`, strict `:free` suffix and zero-price verification + `/key` check)
  - **Groq** (`api.groq.com/openai/v1`, Free Plan attestation + rate-limit header tracking)
  - **NVIDIA NIM** (`integrate.api.nvidia.com/v1`, held in `TRIAL_ONLY` by default under `STRICT_FREE_ONLY` unless verified non-credit)
  - **Hugging Face Inference Providers** (`router.huggingface.co/v1`, disabled by default because $0.10/mo promotional credits are excluded)
  - **Custom OpenAI-Compatible** (`CustomOpenAIAdapter`, defaults to `FREE_UNVERIFIED` with SSRF protection)
- **Context-Aware & Task-Aware Routing**: Supports `auto`, `auto-coding`, `auto-reasoning`, `auto-long`, `auto-fast`, `auto-tools`, `auto-vision`, and `auto-json`. Routes 128K–2M requests strictly according to the lowest verified applicable limit.
- **Automatic Failover & Circuit Breakers**: Bounded retries with exponential jitter backoff, rate-limit cooldowns, quota exhaustion tracking, and no replay after partial streamed chunks.
- **SQLite + Drizzle Persistence & Web Dashboard**: 15-table SQLite schema (WAL mode), Recharts analytics, request logs without leaking prompts, and dark-first MUI control plane.

## Quick Start (Local Development on Arch Linux)

```bash
cp .env.example .env
# Generate local auth & encryption secrets:
#   ROUTER_API_KEYS=ur_live_$(openssl rand -hex 24)
#   DASHBOARD_ADMIN_TOKEN=$(openssl rand -hex 32)
#   SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)
# Add provider credentials (e.g., OPENROUTER_API_KEY, GOOGLE_API_KEY + GOOGLE_PROJECT_NO_BILLING=true)

npm install
npm run db:migrate
npm run build
npm start
```

Open the dashboard at `http://127.0.0.1:8787` and point Hermes Agent at `http://127.0.0.1:8787/v1`.

## Documentation Index

- [Architecture](docs/ARCHITECTURE.md)
- [Providers](docs/PROVIDERS.md)
- [Free-Only Policy](docs/FREE_POLICY.md)
- [Context Management](docs/CONTEXT_MANAGEMENT.md)
- [Routing Engine & Failover](docs/ROUTING.md)
- [Hermes Agent Integration](docs/HERMES_INTEGRATION.md)
- [Arch Linux Installation](docs/ARCH_LINUX_INSTALLATION.md)
- [Security Architecture](docs/SECURITY.md)
- [HTTP API Reference](docs/API.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
