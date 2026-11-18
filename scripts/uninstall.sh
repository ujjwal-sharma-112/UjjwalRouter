#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/ujjwalrouter"
CONFIG_DIR="/etc/ujjwalrouter"
DATA_DIR="/var/lib/ujjwalrouter"
SERVICE_USER="ujjwalrouter"
SERVICE_FILE="/etc/systemd/system/ujjwalrouter.service"
PURGE_DATA="false"

if [[ "${1:-}" == "--purge" ]]; then
  PURGE_DATA="true"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0 [--purge]" >&2
  exit 1
fi

echo "==> Stopping and disabling ujjwalrouter.service..."
systemctl stop ujjwalrouter.service 2>/dev/null || true
systemctl disable ujjwalrouter.service 2>/dev/null || true

if [[ -f "${SERVICE_FILE}" ]]; then
  rm -f "${SERVICE_FILE}"
  systemctl daemon-reload
fi

if [[ -d "${INSTALL_DIR}" ]]; then
  rm -rf "${INSTALL_DIR}"
  echo "Removed ${INSTALL_DIR}"
fi

if [[ "${PURGE_DATA}" == "true" ]]; then
  rm -rf "${CONFIG_DIR}" "${DATA_DIR}"
  if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    userdel "${SERVICE_USER}" || true
  fi
  echo "Purged configuration, database, and service user."
else
  echo "Preserved ${CONFIG_DIR} and ${DATA_DIR}. Pass --purge to delete them."
fi

echo "==> UjjwalRouter uninstalled."
