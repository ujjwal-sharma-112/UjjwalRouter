#!/usr/bin/env bash
set -euo pipefail

# UjjwalRouter Native Arch Linux Installer
# Installs to /opt/ujjwalrouter, data in /var/lib/ujjwalrouter, config in /etc/ujjwalrouter/ujjwalrouter.env

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/ujjwalrouter"
CONFIG_DIR="/etc/ujjwalrouter"
ENV_FILE="${CONFIG_DIR}/ujjwalrouter.env"
DATA_DIR="/var/lib/ujjwalrouter"
SERVICE_USER="ujjwalrouter"
SERVICE_FILE="/etc/systemd/system/ujjwalrouter.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo: sudo $0" >&2
  exit 1
fi

for cmd in node npm sqlite3 openssl systemctl tar; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required dependency: ${cmd}" >&2
    echo "On Arch Linux install with: sudo pacman -S --needed nodejs npm sqlite openssl tar" >&2
    exit 1
  fi
done

NODE_BIN="$(command -v node)"
if [[ -x /usr/bin/node ]]; then
  SYS_NODE_MAJOR="$(/usr/bin/node -p "process.versions.node.split('.')[0]")"
  if [[ "${SYS_NODE_MAJOR}" -ge 22 ]]; then
    NODE_BIN="/usr/bin/node"
  fi
fi

NODE_MAJOR="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  echo "Node.js 22+ is required (found $("${NODE_BIN}" -v) at ${NODE_BIN})." >&2
  exit 1
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "==> Creating unprivileged service account '${SERVICE_USER}'..."
  useradd --system --no-create-home --shell /usr/bin/nologin "${SERVICE_USER}"
fi

echo "==> Copying application source to ${INSTALL_DIR}..."
rm -rf "${INSTALL_DIR}.new"
mkdir -p "${INSTALL_DIR}.new" "${CONFIG_DIR}" "${DATA_DIR}"
tar -cf - \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='data' \
  --exclude='backups' \
  --exclude='dist' \
  --exclude='node_modules' \
  --exclude='apps/dashboard/dist' \
  --exclude='apps/dashboard/node_modules' \
  -C "${REPO_DIR}" . | tar -xf - -C "${INSTALL_DIR}.new"

if [[ -d "${INSTALL_DIR}" ]]; then
  rm -rf "${INSTALL_DIR}.old"
  mv "${INSTALL_DIR}" "${INSTALL_DIR}.old"
fi
mv "${INSTALL_DIR}.new" "${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}.old"

# If node comes from /home (e.g. nvm) while ProtectHome=true is enabled, copy binary inside /opt/ujjwalrouter/bin
EXEC_NODE="${NODE_BIN}"
if [[ "${NODE_BIN}" == /home/* ]]; then
  mkdir -p "${INSTALL_DIR}/bin"
  install -m 0755 "${NODE_BIN}" "${INSTALL_DIR}/bin/node"
  EXEC_NODE="${INSTALL_DIR}/bin/node"
fi

echo "==> Installing dependencies and building UjjwalRouter in ${INSTALL_DIR}..."
cd "${INSTALL_DIR}"
npm ci --no-audit --no-fund || npm install --no-audit --no-fund
npm run build

chown -R root:"${SERVICE_USER}" "${INSTALL_DIR}"
chmod -R u=rwX,g=rX,o= "${INSTALL_DIR}"
if [[ -x "${INSTALL_DIR}/bin/node" ]]; then
  chmod 0750 "${INSTALL_DIR}/bin/node"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> Generating initial configuration at ${ENV_FILE}..."
  ROUTER_KEY="ur_live_$(openssl rand -hex 24)"
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  ENC_KEY="$(openssl rand -hex 32)"

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
STRICT_FREE_ONLY=true
HOST=127.0.0.1
PORT=8787
LOG_LEVEL=info
DATABASE_PATH=${DATA_DIR}/ujjwalrouter.db

ROUTER_API_KEYS=${ROUTER_KEY}
DASHBOARD_ADMIN_TOKEN=${ADMIN_TOKEN}
SECRET_ENCRYPTION_KEY=${ENC_KEY}

DEFAULT_ROUTING_PROFILE=auto
LOG_RETENTION_DAYS=30
DISCOVERY_REFRESH_INTERVAL_MS=900000
HEALTH_CHECK_INTERVAL_MS=300000
FIRST_BYTE_TIMEOUT_MS=25000

GOOGLE_API_KEY=
GOOGLE_PROJECT_NO_BILLING=false
GROQ_API_KEY=
GROQ_FREE_PLAN_CONFIRMED=false
SAMBANOVA_API_KEY=
SAMBANOVA_FREE_TIER_CONFIRMED=false
MISTRAL_API_KEY=
MISTRAL_FREE_PLAN_CONFIRMED=false
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_FREE_PLAN_CONFIRMED=false
COHERE_API_KEY=
COHERE_FREE_PLAN_CONFIRMED=false
OLLAMA_ENABLED=false
OLLAMA_BASE_URL=http://127.0.0.1:11434
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
NVIDIA_HOSTED_FREE_NO_CREDITS_CONFIRMED=false
HUGGINGFACE_ENABLED=false
HF_TOKEN=
EOF
  echo "Generated new API credentials inside ${ENV_FILE} (root:${SERVICE_USER}, mode 0640)."
  echo "Add your provider API keys before or after starting."
fi

chown root:"${SERVICE_USER}" "${CONFIG_DIR}" "${ENV_FILE}"
chmod 0750 "${CONFIG_DIR}"
chmod 0640 "${ENV_FILE}"

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
chmod 0750 "${DATA_DIR}"

echo "==> Applying SQLite migrations..."
cd "${INSTALL_DIR}"
DATABASE_PATH="${DATA_DIR}/ujjwalrouter.db" "${EXEC_NODE}" -e "
import('./dist/database/connection.js').then(({ openDatabase, runMigrations }) => {
  const conn = openDatabase(process.env.DATABASE_PATH);
  runMigrations(conn);
  conn.close();
});
"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"

echo "==> Installing systemd unit ${SERVICE_FILE} (using ${EXEC_NODE})..."
sed "s|^ExecStart=.*|ExecStart=${EXEC_NODE} /opt/ujjwalrouter/dist/index.js|" \
  "${INSTALL_DIR}/ujjwalrouter.service" > "${SERVICE_FILE}"
chmod 0644 "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable ujjwalrouter.service
systemctl restart ujjwalrouter.service

echo "==> Installation complete!"
echo "Service status:       systemctl status ujjwalrouter --no-pager"
echo "View logs:            journalctl -u ujjwalrouter -f"
echo "Health check:         ${INSTALL_DIR}/scripts/health-check.sh"
