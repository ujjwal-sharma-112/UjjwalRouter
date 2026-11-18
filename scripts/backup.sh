#!/usr/bin/env bash
set -euo pipefail

# Online SQLite backup using sqlite3 .backup command (safe with WAL mode)

DB_PATH="${DATABASE_PATH:-/var/lib/ujjwalrouter/ujjwalrouter.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/ujjwalrouter/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database not found at ${DB_PATH}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 0750 "${BACKUP_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DB="${BACKUP_DIR}/ujjwalrouter-${STAMP}.db"

sqlite3 "${DB_PATH}" ".backup '${DEST_DB}'"
chmod 0600 "${DEST_DB}"

SECRET_FILE="$(dirname "${DB_PATH}")/secrets.enc.json"
if [[ -f "${SECRET_FILE}" ]]; then
  cp "${SECRET_FILE}" "${BACKUP_DIR}/secrets.enc-${STAMP}.json"
  chmod 0600 "${BACKUP_DIR}/secrets.enc-${STAMP}.json"
fi

find "${BACKUP_DIR}" -type f -name "ujjwalrouter-*.db" -mtime "+${KEEP_DAYS}" -delete
find "${BACKUP_DIR}" -type f -name "secrets.enc-*.json" -mtime "+${KEEP_DAYS}" -delete

echo "Backup written to ${DEST_DB}"
