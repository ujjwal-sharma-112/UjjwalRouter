export interface SessionState {
  configured: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  strictFreeOnly: boolean;
}

class DashboardApiClient {
  private csrfToken: string | null = null;

  public setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }

    const res = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      const errMsg =
        (json.error as { message?: string } | undefined)?.message ||
        `Request failed with status ${res.status}`;
      throw new Error(errMsg);
    }

    return json as T;
  }

  public getSession(): Promise<SessionState> {
    return this.request<SessionState>('/api/admin/auth/session');
  }

  public async login(token: string): Promise<SessionState> {
    const res = await this.request<{ authenticated: boolean; csrfToken: string; strictFreeOnly: boolean }>(
      '/api/admin/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      }
    );
    this.csrfToken = res.csrfToken;
    return {
      configured: true,
      authenticated: res.authenticated,
      csrfToken: res.csrfToken,
      strictFreeOnly: res.strictFreeOnly,
    };
  }

  public async logout(): Promise<void> {
    await this.request('/api/admin/auth/logout', { method: 'POST' });
    this.csrfToken = null;
  }
}

export const apiClient = new DashboardApiClient();
