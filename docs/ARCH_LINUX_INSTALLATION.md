# Arch Linux Installation & Operations

UjjwalRouter runs natively on Arch Linux using Node.js 22+, SQLite, and systemd without Docker.

## Prerequisites

```bash
sudo pacman -S --needed nodejs npm sqlite openssl
node -v   # Must be v22+
```

## 1. System-Wide systemd Installation (Recommended)

Run the installer script from the repository root:

```bash
sudo ./scripts/install.sh
```

What `scripts/install.sh` performs:
- Builds the TypeScript backend and React dashboard (`npm run build`).
- Creates an unprivileged system user `ujjwalrouter` (`--no-create-home`, `/usr/bin/nologin`).
- Installs application artifacts to `/opt/ujjwalrouter`.
- Creates `/etc/ujjwalrouter/ujjwalrouter.env` (`0640`, owned by `root:ujjwalrouter`) with freshly generated `ROUTER_API_KEYS`, `DASHBOARD_ADMIN_TOKEN`, and `SECRET_ENCRYPTION_KEY`.
- Runs Drizzle SQLite migrations against `/var/lib/ujjwalrouter/ujjwalrouter.db` (`0750` directory, `0600` DB).
- Installs, enables, and starts `/etc/systemd/system/ujjwalrouter.service`.

### Adding Provider Credentials

Edit `/etc/ujjwalrouter/ujjwalrouter.env` securely as root:

```bash
sudoedit /etc/ujjwalrouter/ujjwalrouter.env
```

Configure at least two free-tier providers (for example `OPENROUTER_API_KEY=...`, plus `GOOGLE_API_KEY=...` with `GOOGLE_PROJECT_NO_BILLING=true` after verifying no billing is attached to that AI Studio project, and/or `GROQ_API_KEY=...` with `GROQ_FREE_PLAN_CONFIRMED=true`), then restart:

```bash
sudo systemctl restart ujjwalrouter
```

## 2. Service Management & Logs

```bash
systemctl status ujjwalrouter
journalctl -u ujjwalrouter -f
./scripts/health-check.sh
```

## 3. Backups

Use `scripts/backup.sh` for safe online WAL backups via `sqlite3 .backup`:

```bash
sudo ./scripts/backup.sh
```

Backups are stored in `/var/lib/ujjwalrouter/backups/` with `0600` permissions and pruned after 14 days (`KEEP_DAYS=14`).

## 4. Updating

Pull updates in your checkout and re-run `sudo ./scripts/install.sh` (existing `/etc/ujjwalrouter/ujjwalrouter.env` and `/var/lib/ujjwalrouter/ujjwalrouter.db` are preserved and migrated).

## 5. Uninstalling

```bash
sudo ./scripts/uninstall.sh          # Removes service and /opt/ujjwalrouter; keeps config/DB
sudo ./scripts/uninstall.sh --purge  # Also deletes /etc/ujjwalrouter, /var/lib/ujjwalrouter, and service user
```
