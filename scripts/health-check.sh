#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${UJJWALROUTER_URL:-http://127.0.0.1:8787}"
TMP_READY="$(mktemp /tmp/ujjwalrouter-ready-XXXXXX.json)"
trap 'rm -f "${TMP_READY}"' EXIT

echo "==> Checking systemd unit (if installed)..."
if systemctl list-unit-files ujjwalrouter.service >/dev/null 2>&1; then
  systemctl is-active ujjwalrouter.service || true
fi

echo "==> Checking /health at ${BASE_URL}/health..."
HEALTH_JSON="$(curl -fsS --max-time 5 "${BASE_URL}/health")"
echo "${HEALTH_JSON}"

echo "==> Checking /ready at ${BASE_URL}/ready..."
READY_CODE="$(curl -sS -o "${TMP_READY}" -w "%{http_code}" --max-time 5 "${BASE_URL}/ready")"
cat "${TMP_READY}"
echo ""

if [[ "${READY_CODE}" != "200" ]]; then
  echo "Readiness returned HTTP ${READY_CODE} (no FREE_VERIFIED models active yet)." >&2
  exit 1
fi

echo "UjjwalRouter is healthy and ready."
