# Security Architecture

## Defense-in-Depth Controls

1. **Localhost-First Networking**:
   - Binds strictly to `127.0.0.1:8787` by default (`src/config/env.ts`).
   - Refuses starting on non-loopback addresses (`0.0.0.0` or LAN IPs) unless `ALLOW_PUBLIC_BIND=true` is explicitly configured.
2. **Client API Authentication (`src/security/auth.ts`, `src/security/secrets.ts`)**:
   - Bearer token authentication required on `/v1/models` and `/v1/chat/completions`.
   - Constant-time comparison via SHA-256 digests + `crypto.timingSafeEqual`.
   - Issued keys stored in SQLite (`api_keys`) as SHA-256 hashes only; raw keys are returned once at creation.
3. **Zero Plaintext Provider Secrets in SQLite (`src/security/secret-store.ts`)**:
   - Provider API keys live in `/etc/ujjwalrouter/ujjwalrouter.env` (`0640`) or an AES-256-GCM encrypted `secrets.enc.json` (`0600`) keyed by `SECRET_ENCRYPTION_KEY`.
   - Dashboard responses return only masked prefixes (`abcd...wxyz`).
4. **Dashboard Session & CSRF Protection (`src/security/dashboard-auth.ts`)**:
   - Cookie-based authentication using HMAC-signed `HttpOnly; SameSite=Lax; Path=/` cookies (`Secure` when served over HTTPS).
   - Mutating admin requests (`POST`, `PUT`, `DELETE`) require an `X-CSRF-Token` header tied to the active session.
   - Logout sends `Clear-Site-Data: "cookies", "storage"`.
5. **SSRF & Endpoint Allowlisting (`src/security/ssrf.ts`)**:
   - Built-in providers validate URLs against strict hostname allowlists (`BUILTIN_PROVIDER_HOST_ALLOWLIST`).
   - Outbound DNS checks (`assertResolvedEndpointSafe`) block cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`), RFC1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, and embedded URL credentials.
6. **Secret Redaction & Privacy (`src/logging/logger.ts`)**:
   - Pino logger redacts `Authorization`, `x-api-key`, `x-goog-api-key`, and cookies.
   - `redactSecrets()` strips Bearer tokens and provider key patterns (`sk-or-v1-...`, `AIza...`, `nvapi-...`, `gsk_...`, `hf_...`, `ur_live_...`) from error strings.
   - Request logs do not store user prompt contents.
7. **HTTP Hardening (`src/app/create-app.ts`)**:
   - `@fastify/helmet` with strict CSP (`object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Cross-Origin-Resource-Policy: same-origin`.
   - Origin-validated CORS allowlist (`ALLOWED_CORS_ORIGINS`), payload limit (`MAX_REQUEST_BODY_BYTES`, 10 MiB default), request timeouts (`REQUEST_TIMEOUT_MS`), and per-minute rate limiting.
8. **systemd Isolation (`ujjwalrouter.service`)**:
   - Unprivileged `ujjwalrouter` user with `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `ReadWritePaths=/var/lib/ujjwalrouter`, and `UMask=0077`.
