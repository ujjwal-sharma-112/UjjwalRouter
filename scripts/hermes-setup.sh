#!/usr/bin/env bash
set -euo pipefail

# Safely inspect, back up, configure, or roll back Hermes Agent configuration for UjjwalRouter.
# Never modifies ~/.hermes/config.yaml without creating a timestamped backup first.

HERMES_CONFIG="${HOME}/.hermes/config.yaml"
PROFILE="${1:-}"

usage() {
  cat <<EOF
Usage:
  $0 --show-snippet               Print the Hermes custom provider snippet (no changes made)
  $0 --apply [profile]            Back up ~/.hermes/config.yaml and point Hermes to UjjwalRouter
  $0 --rollback <backup-file>     Restore ~/.hermes/config.yaml from a backup file
EOF
}

if [[ "${PROFILE}" == "--show-snippet" || -z "${PROFILE}" ]]; then
  cat <<'EOF'
# Add to ~/.hermes/config.yaml (and store ROUTER_API_KEY in ~/.hermes/.env as UJJWALROUTER_API_KEY):
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
EOF
  exit 0
fi

if [[ "${PROFILE}" == "--rollback" ]]; then
  BACKUP_FILE="${2:-}"
  if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
    echo "Backup file not found: ${BACKUP_FILE}" >&2
    exit 1
  fi
  cp -p "${BACKUP_FILE}" "${HERMES_CONFIG}"
  echo "Restored ${HERMES_CONFIG} from ${BACKUP_FILE}"
  exit 0
fi

if [[ "${PROFILE}" == "--apply" ]]; then
  TARGET_MODEL="${2:-auto-coding}"
  if [[ ! -f "${HERMES_CONFIG}" ]]; then
    echo "Hermes config not found at ${HERMES_CONFIG}" >&2
    exit 1
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_PATH="${HERMES_CONFIG}.bak-ujjwalrouter-${STAMP}"
  cp -p "${HERMES_CONFIG}" "${BACKUP_PATH}"
  echo "Created backup: ${BACKUP_PATH}"

  python3 - "${HERMES_CONFIG}" "${TARGET_MODEL}" <<'PY'
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
target_model = sys.argv[2]
lines = cfg_path.read_text(encoding="utf-8").splitlines(keepends=True)

# Update top-level model.base_url / default / provider / api_mode safely without disturbing other sections
out = []
in_model = False
saw_base_url = saw_default = saw_provider = saw_api_mode = False

for line in lines:
    stripped = line.strip()
    if not line.startswith(" ") and stripped.endswith(":"):
        if in_model:
            if not saw_base_url:
                out.append("  base_url: http://127.0.0.1:8787/v1\n")
            if not saw_default:
                out.append(f"  default: {target_model}\n")
            if not saw_provider:
                out.append("  provider: custom\n")
            if not saw_api_mode:
                out.append("  api_mode: chat_completions\n")
        in_model = (stripped == "model:")
        out.append(line)
        continue

    if in_model and line.startswith("  ") and not line.startswith("    "):
        key = stripped.split(":", 1)[0]
        if key == "base_url":
            out.append("  base_url: http://127.0.0.1:8787/v1\n")
            saw_base_url = True
            continue
        if key == "default":
            out.append(f"  default: {target_model}\n")
            saw_default = True
            continue
        if key == "provider":
            out.append("  provider: custom\n")
            saw_provider = True
            continue
        if key == "api_mode":
            out.append("  api_mode: chat_completions\n")
            saw_api_mode = True
            continue
    out.append(line)

cfg_path.write_text("".join(out), encoding="utf-8")
PY

  echo "Updated ${HERMES_CONFIG} to route via http://127.0.0.1:8787/v1 (model: ${TARGET_MODEL})."
  echo "Ensure OPENAI_API_KEY or custom api_key in ~/.hermes/.env matches a key in UjjwalRouter's ROUTER_API_KEYS."
  echo "To roll back: $0 --rollback ${BACKUP_PATH}"
  exit 0
fi

usage
exit 1
