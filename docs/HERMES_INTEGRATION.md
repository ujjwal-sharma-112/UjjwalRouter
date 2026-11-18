# Hermes Agent Integration

Hermes Agent is the primary target client for UjjwalRouter. The router implements the exact OpenAI Chat Completions wire contract Hermes uses, including `stream_options: { include_usage: true }`, tool-call delta normalization (preventing duplicate function name concatenation), parallel tool calls, `thought_signature` preservation for Gemini multi-turn tool loops, and OpenAI-formatted JSON errors.

## Default Endpoint

```text
http://127.0.0.1:8787/v1
```

## Safe Configuration Procedure (With Backup & Rollback)

Never edit `~/.hermes/config.yaml` without backing it up first.

1. Generate or copy a router client API key (`ur_live_...`) from `ROUTER_API_KEYS` (in `.env` or `/etc/ujjwalrouter/ujjwalrouter.env`) or via the Dashboard **Settings** page.
2. Add the key to `~/.hermes/.env`:

```bash
# Append safely without printing secrets
echo 'UJJWALROUTER_API_KEY=ur_live_your_generated_key' >> ~/.hermes/.env
```

3. Preview the Hermes configuration snippet:

```bash
./scripts/hermes-setup.sh --show-snippet
```

4. Back up and apply automatically with `./scripts/hermes-setup.sh`:

```bash
./scripts/hermes-setup.sh --apply auto-coding
```

This creates a timestamped backup (`~/.hermes/config.yaml.bak-ujjwalrouter-<UTC_STAMP>`) before updating `model.base_url`, `model.default`, `model.provider: custom`, and `model.api_mode: chat_completions`.

### Manual `~/.hermes/config.yaml` Example

```yaml
model:
  base_url: http://127.0.0.1:8787/v1
  default: auto-coding
  provider: custom
  api_mode: chat_completions

providers:
  ujjwalrouter:
    base_url: http://127.0.0.1:8787/v1
    key_env: UJJWALROUTER_API_KEY
    api_mode: chat_completions
```

## Rollback Procedure

To restore your exact previous Hermes configuration:

```bash
./scripts/hermes-setup.sh --rollback ~/.hermes/config.yaml.bak-ujjwalrouter-<UTC_STAMP>
```

## Verified Hermes Compatibility Coverage

`tests/hermes/hermes-compatibility.test.ts` exercises the actual `openai` SDK against a live local UjjwalRouter HTTP listener for:
- `GET /v1/models`
- Non-streaming & SSE streaming with `stream_options.include_usage`
- Multi-turn single and parallel tool calling (`tool` role + `thoughtSignature`)
- Streaming parallel tool-call deltas
- 700K-token routing to verified 1M Gemini Free Tier & clean 400 rejection on overflow
- Pre-stream failover upon upstream 429 quota exhaustion
