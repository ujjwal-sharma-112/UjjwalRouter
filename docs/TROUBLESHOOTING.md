# Troubleshooting

## 1. `/ready` returns `503` (`No FREE_VERIFIED models are currently eligible`)

Check:
- Have you configured at least one provider key in `.env` or `/etc/ujjwalrouter/ujjwalrouter.env`?
- For **Google Gemini**, did you confirm the project has no billing account linked with `GOOGLE_PROJECT_NO_BILLING=true`? Without it, models stay `FREE_UNVERIFIED`.
- For **Groq**, did you set `GROQ_FREE_PLAN_CONFIRMED=true`?
- For **OpenRouter**, verify your key works (`curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key`) and that `:free` models appear in `/api/v1/models`.
- Note: **NVIDIA NIM** (default) and **Hugging Face** are classified `TRIAL_ONLY` and cannot make `/ready` pass.

## 2. `HTTP 403 free_policy_violation` on `POST /v1/chat/completions`

- You requested a paid model, a trial-credit model, an unverified custom model, or an OpenRouter model missing the `:free` suffix.
- Switch to a routing profile like `auto-coding` or pick a `FREE_VERIFIED` model from `GET /v1/models`.

## 3. `HTTP 400 context_length_exceeded`

- The prompt + conversation history + tools + reserved output + safety margin exceeds the highest `effectiveContextWindow` among currently eligible free models.
- UjjwalRouter never silently truncates history. Compact the session in Hermes or verify a 1M-context Gemini Flash model is enabled and `FREE_VERIFIED`.

## 4. `HTTP 401 invalid_api_key` from Hermes Agent

- Verify `ROUTER_API_KEYS` in `.env` / `/etc/ujjwalrouter/ujjwalrouter.env` (or an active key created in Dashboard Settings) matches the API key in `~/.hermes/.env`.
- Remember to restart UjjwalRouter after editing `.env`: `sudo systemctl restart ujjwalrouter`.

## 5. Dashboard Login Fails or Shows Unconfigured

- Ensure `DASHBOARD_ADMIN_TOKEN` is set and non-empty in `.env` / `/etc/ujjwalrouter/ujjwalrouter.env`.
- Inspect service logs: `journalctl -u ujjwalrouter -n 100 --no-pager`.

## 6. Diagnostic Commands

```bash
./scripts/health-check.sh
curl -s http://127.0.0.1:8787/health | jq .
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $ROUTER_API_KEY" | jq '.data[].id'
```
