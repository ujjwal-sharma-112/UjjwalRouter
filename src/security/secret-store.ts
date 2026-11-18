import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret, encryptSecret, maskSecret } from './secrets.js';

interface SecretFilePayload {
  version: 1;
  encryptedData: string;
  updatedAt: string;
}

export class EncryptedSecretStore {
  private readonly filePath: string;
  private readonly masterKey: string;
  private readonly memoryFallback = new Map<string, string>();

  constructor(filePath: string, masterKey: string) {
    this.filePath = path.resolve(filePath);
    this.masterKey = masterKey.trim();
  }

  public isPersistentEncryptionAvailable(): boolean {
    return this.masterKey.length >= 16;
  }

  private readAll(): Record<string, string> {
    if (!this.isPersistentEncryptionAvailable()) {
      return Object.fromEntries(this.memoryFallback.entries());
    }
    if (!fs.existsSync(this.filePath)) {
      return {};
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as SecretFilePayload;
    const json = decryptSecret(parsed.encryptedData, this.masterKey);
    return JSON.parse(json) as Record<string, string>;
  }

  private writeAll(secrets: Record<string, string>): void {
    if (!this.isPersistentEncryptionAvailable()) {
      this.memoryFallback.clear();
      for (const [k, v] of Object.entries(secrets)) {
        this.memoryFallback.set(k, v);
      }
      return;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const encryptedData = encryptSecret(JSON.stringify(secrets), this.masterKey);
    const payload: SecretFilePayload = {
      version: 1,
      encryptedData,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // ignore on virtual fs
    }
  }

  public setSecret(key: string, value: string): void {
    const all = this.readAll();
    if (!value) {
      delete all[key];
    } else {
      all[key] = value;
    }
    this.writeAll(all);
  }

  public getSecret(key: string): string | undefined {
    const all = this.readAll();
    return all[key];
  }

  public getMaskedSecret(key: string): string | null {
    const val = this.getSecret(key);
    return val ? maskSecret(val) : null;
  }

  public listKeys(): string[] {
    return Object.keys(this.readAll());
  }
}
