import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import { openDatabase, runMigrations } from '../../src/database/connection.js';
import { RouterRepository } from '../../src/database/repositories/router-repository.js';
import { requests } from '../../src/database/schema/schema.js';
import { EncryptedSecretStore } from '../../src/security/secret-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Milestone 5: SQLite Persistence, Migrations, Analytics & Retention', () => {
  it('applies Drizzle migrations, creates all 15 tables, persists requests/analytics/audit logs, and enforces immutable strict_free_only', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ujjwalrouter-db-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'router.db');

    const conn = openDatabase(dbPath);
    runMigrations(conn);

    const tableRows = conn.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all() as Array<{ name: string }>;
    const tableNames = tableRows.map((r) => r.name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'providers',
        'models',
        'model_capabilities',
        'free_eligibility_checks',
        'provider_health',
        'provider_quotas',
        'routing_profiles',
        'routing_rules',
        'requests',
        'request_attempts',
        'usage_records',
        'daily_usage',
        'api_keys',
        'settings',
        'audit_logs',
      ])
    );

    const repo = new RouterRepository(conn.db);
    repo.seedDefaults({
      defaultRoutingProfile: 'auto',
      logRetentionDays: 30,
      contextSafetyMarginPct: 0.05,
      healthCheckIntervalMs: 300_000,
      providerPriority: ['google', 'openrouter', 'groq'],
    });

    // Strict free-only setting cannot be modified
    expect(() => repo.updateSetting('strict_free_only', 'false')).toThrow(/immutable/);
    expect(repo.getSetting('strict_free_only')).toBe('true');

    // Create DB-backed API key and verify only hash is stored
    const createdKey = repo.createApiKey('hermes-local');
    expect(createdKey.rawKey.startsWith('ur_live_')).toBe(true);
    expect(repo.validateDbApiKey(createdKey.rawKey).valid).toBe(true);
    const keyRow = conn.sqlite
      .prepare('SELECT key_hash FROM api_keys WHERE id = ?')
      .get(createdKey.id) as { key_hash: string };
    expect(keyRow.key_hash).not.toBe(createdKey.rawKey);
    expect(repo.revokeApiKey(createdKey.id)).toBe(true);
    expect(repo.validateDbApiKey(createdKey.rawKey).valid).toBe(false);

    // Record requests & verify analytics + retention pruning
    const recentIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 45 * 86_400_000).toISOString();

    repo.recordRequest({
      requestId: 'req_recent',
      timestamp: recentIso,
      requestedModel: 'auto-coding',
      effectiveProfile: 'auto-coding',
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter:qwen/qwen3-coder:free',
      estimatedInputTokens: 100,
      actualInputTokens: 120,
      actualOutputTokens: 45,
      latencyMs: 320,
      failoverCount: 1,
      stream: false,
      status: 'success',
      routingExplanation: 'Picked coder model',
      attempts: [
        {
          attemptNumber: 1,
          providerId: 'groq',
          modelId: 'llama-3.3-70b-versatile',
          canonicalId: 'groq:llama-3.3-70b-versatile',
          outcome: 'failed',
          latencyMs: 120,
          errorCategory: 'rate_limit',
          statusCode: 429,
          reason: '429 rate limit',
          timestamp: recentIso,
        },
        {
          attemptNumber: 2,
          providerId: 'openrouter',
          modelId: 'qwen/qwen3-coder:free',
          canonicalId: 'openrouter:qwen/qwen3-coder:free',
          outcome: 'success',
          latencyMs: 200,
          reason: 'ok',
          timestamp: recentIso,
        },
      ],
    });

    conn.db
      .insert(requests)
      .values({
        id: 'req_old',
        timestamp: oldIso,
        requestedModel: 'auto',
        effectiveProfile: 'auto',
        selectedProvider: 'groq',
        selectedModel: 'groq:llama-3.3-70b-versatile',
        estimatedInputTokens: 50,
        actualInputTokens: 50,
        actualOutputTokens: 10,
        latencyMs: 100,
        failoverCount: 0,
        stream: false,
        status: 'success',
      })
      .run();

    const logsBefore = repo.queryRequestLogs({ limit: 10 });
    expect(logsBefore.total).toBe(2);

    const analytics = repo.getAnalytics(30);
    expect(analytics.totals.totalRequests).toBe(1);
    expect(analytics.totals.failoverEvents).toBe(1);
    expect(analytics.totals.rateLimitEvents).toBe(1);
    expect(analytics.totals.totalInputTokens).toBe(120);

    const pruned = repo.pruneOldLogs(30);
    expect(pruned.deletedRequests).toBe(1);
    expect(repo.queryRequestLogs({ limit: 10 }).total).toBe(1);
    expect(repo.listAuditLogs(20).length).toBeGreaterThanOrEqual(2);

    conn.close();
  });

  it('authenticates HTTP requests with DB-issued API keys and encrypts secrets separately from SQLite', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ujjwalrouter-app-db-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'app.db');
    const secretPath = path.join(tmpDir, 'secrets.enc.json');

    const store = new EncryptedSecretStore(
      secretPath,
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    store.setSecret('OPENROUTER_API_KEY', 'sk-or-v1-super-secret-value-999');
    expect(fs.readFileSync(secretPath, 'utf8')).not.toContain('sk-or-v1-super-secret-value-999');
    expect(store.getSecret('OPENROUTER_API_KEY')).toBe('sk-or-v1-super-secret-value-999');

    const config = loadConfig({ LOG_LEVEL: 'silent' }, true);
    const ctx = await createApp({ config, databasePath: dbPath });
    const issued = ctx.repository.createApiKey('hermes-agent');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${issued.rawKey}` },
    });
    expect(res.statusCode).toBe(200);

    await ctx.app.close();
  });
});
