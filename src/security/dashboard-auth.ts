import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constantTimeTokenEqual } from './secrets.js';
import { extractBearerToken } from './auth.js';

export const DASHBOARD_SESSION_COOKIE = 'ur_dash_session';

interface SessionPayload {
  sub: 'admin';
  csrf: string;
  exp: number;
}

export class DashboardSessionManager {
  private readonly adminToken: string;
  private readonly signingSecret: Buffer;
  private readonly sessionTtlMs: number;

  constructor(adminToken: string, signingKeyMaterial?: string, sessionTtlMs = 12 * 3600_000) {
    this.adminToken = adminToken.trim();
    const seed = signingKeyMaterial?.trim() || adminToken.trim() || crypto.randomBytes(32).toString('hex');
    this.signingSecret = crypto.createHash('sha256').update(`ur-dash:${seed}`, 'utf8').digest();
    this.sessionTtlMs = sessionTtlMs;
  }

  public isConfigured(): boolean {
    return this.adminToken.length > 0;
  }

  public verifyAdminToken(candidate: string): boolean {
    if (!this.isConfigured() || !candidate) return false;
    return constantTimeTokenEqual(candidate.trim(), this.adminToken);
  }

  public createSessionCookie(): { cookieValue: string; csrfToken: string; maxAgeSeconds: number } {
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const payload: SessionPayload = {
      sub: 'admin',
      csrf: csrfToken,
      exp: Date.now() + this.sessionTtlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', this.signingSecret).update(encoded).digest('base64url');
    return {
      cookieValue: `${encoded}.${sig}`,
      csrfToken,
      maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  public verifySessionCookie(cookieValue: string | undefined): SessionPayload | null {
    if (!cookieValue) return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 2) return null;
    const [encoded, providedSig] = parts as [string, string];
    const expectedSig = crypto
      .createHmac('sha256', this.signingSecret)
      .update(encoded)
      .digest('base64url');

    if (!constantTimeTokenEqual(providedSig, expectedSig)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      if (payload.sub !== 'admin' || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  public createAuthHook() {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!this.isConfigured()) {
        await reply.code(503).send({
          error: {
            message: 'DASHBOARD_ADMIN_TOKEN is not configured. Set DASHBOARD_ADMIN_TOKEN in .env to enable dashboard access.',
            type: 'service_unavailable_error',
            code: 'dashboard_auth_unconfigured',
          },
        });
        return;
      }

      // Support Bearer token (for CLI/tests) OR HttpOnly session cookie + CSRF header (for browsers)
      const bearer = extractBearerToken(request.headers.authorization);
      if (bearer && this.verifyAdminToken(bearer)) {
        return;
      }

      const rawCookie = (request.cookies as Record<string, string | undefined> | undefined)?.[
        DASHBOARD_SESSION_COOKIE
      ];
      const session = this.verifySessionCookie(rawCookie);
      if (!session) {
        await reply.code(401).send({
          error: {
            message: 'Dashboard authentication required.',
            type: 'authentication_error',
            code: 'dashboard_unauthorized',
          },
        });
        return;
      }

      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const csrfHeader = request.headers['x-csrf-token'];
        const providedCsrf = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
        if (!providedCsrf || !constantTimeTokenEqual(providedCsrf, session.csrf)) {
          await reply.code(403).send({
            error: {
              message: 'Invalid or missing CSRF token.',
              type: 'permission_error',
              code: 'csrf_validation_failed',
            },
          });
          return;
        }
      }
    };
  }
}
