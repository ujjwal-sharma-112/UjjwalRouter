import crypto from 'node:crypto';

export function generateApiKey(prefix: string = 'ur_live'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function deriveEncryptionKey(rawKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  if (!masterKey) {
    throw new Error('SECRET_ENCRYPTION_KEY is required to encrypt secrets');
  }
  const key = deriveEncryptionKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload: string, masterKey: string): string {
  if (!masterKey) {
    throw new Error('SECRET_ENCRYPTION_KEY is required to decrypt secrets');
  }
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const key = deriveEncryptionKey(masterKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
