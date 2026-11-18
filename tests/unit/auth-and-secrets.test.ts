import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { redactSecrets } from '../../src/logging/logger.js';
import {
  constantTimeTokenEqual,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  maskSecret,
} from '../../src/security/secrets.js';
import { validateProviderBaseUrl } from '../../src/security/ssrf.js';

describe('Config & Security Primitives', () => {
  it('enforces STRICT_FREE_ONLY=true and refuses disabling it', () => {
    const cfg = loadConfig({}, true);
    expect(cfg.strictFreeOnly).toBe(true);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8787);

    expect(() => loadConfig({ STRICT_FREE_ONLY: 'false' }, true)).toThrow(/STRICT_FREE_ONLY/);
  });

  it('refuses binding non-loopback hosts without ALLOW_PUBLIC_BIND=true', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' }, true)).toThrow(/non-loopback/);
    const allowed = loadConfig({ HOST: '0.0.0.0', ALLOW_PUBLIC_BIND: 'true' }, true);
    expect(allowed.host).toBe('0.0.0.0');
  });

  it('generates secure random API keys and compares them in constant time', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.startsWith('ur_live_')).toBe(true);
    expect(k1).not.toBe(k2);
    expect(constantTimeTokenEqual(k1, k1)).toBe(true);
    expect(constantTimeTokenEqual(k1, k2)).toBe(false);
    expect(maskSecret(k1)).not.toBe(k1);
  });

  it('encrypts and decrypts secrets with AES-256-GCM', () => {
    const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const ciphertext = encryptSecret('my-provider-secret-value', masterKey);
    expect(ciphertext).not.toContain('my-provider-secret-value');
    expect(decryptSecret(ciphertext, masterKey)).toBe('my-provider-secret-value');
  });

  it('redacts bearer tokens and provider key patterns from logs', () => {
    const raw =
      'Authorization: Bearer ur_live_secretToken123456 and key=AIzaSyDummySecretValue1234567890 and nvapi-abc1234567890xyz';
    const sanitized = redactSecrets(raw);
    expect(sanitized).not.toContain('ur_live_secretToken123456');
    expect(sanitized).not.toContain('AIzaSyDummySecretValue1234567890');
    expect(sanitized).not.toContain('nvapi-abc1234567890xyz');
  });

  it('blocks SSRF metadata and private IP endpoints', () => {
    expect(() => validateProviderBaseUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => validateProviderBaseUrl('https://10.0.0.5/v1')).toThrow();
    expect(() => validateProviderBaseUrl('https://evil.com/v1', { providerId: 'openrouter' })).toThrow();
    expect(
      validateProviderBaseUrl('https://openrouter.ai/api/v1', { providerId: 'openrouter' }).hostname
    ).toBe('openrouter.ai');
  });
});
