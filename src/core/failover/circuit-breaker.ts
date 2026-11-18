export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  lastFailureAtMs: number;
  openedAtMs: number;
  halfOpenInFlight: boolean;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 3,
      resetTimeoutMs: config.resetTimeoutMs ?? 30_000,
    };
  }

  private getOrCreate(key: string): CircuitEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureAtMs: 0,
        openedAtMs: 0,
        halfOpenInFlight: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  public canExecute(key: string, nowMs = Date.now()): { allowed: boolean; state: CircuitState } {
    const entry = this.getOrCreate(key);
    if (entry.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED' };
    }

    if (entry.state === 'OPEN') {
      if (nowMs - entry.openedAtMs >= this.config.resetTimeoutMs) {
        entry.state = 'HALF_OPEN';
        entry.halfOpenInFlight = true;
        return { allowed: true, state: 'HALF_OPEN' };
      }
      return { allowed: false, state: 'OPEN' };
    }

    // HALF_OPEN: allow one probe at a time
    if (!entry.halfOpenInFlight) {
      entry.halfOpenInFlight = true;
      return { allowed: true, state: 'HALF_OPEN' };
    }
    return { allowed: false, state: 'HALF_OPEN' };
  }

  public recordSuccess(key: string): void {
    const entry = this.getOrCreate(key);
    entry.state = 'CLOSED';
    entry.failureCount = 0;
    entry.openedAtMs = 0;
    entry.halfOpenInFlight = false;
  }

  public recordFailure(key: string, nowMs = Date.now()): CircuitState {
    const entry = this.getOrCreate(key);
    entry.failureCount += 1;
    entry.lastFailureAtMs = nowMs;
    entry.halfOpenInFlight = false;

    if (entry.state === 'HALF_OPEN' || entry.failureCount >= this.config.failureThreshold) {
      entry.state = 'OPEN';
      entry.openedAtMs = nowMs;
    }

    return entry.state;
  }

  public getState(key: string, nowMs = Date.now()): CircuitState {
    const entry = this.getOrCreate(key);
    if (entry.state === 'OPEN' && nowMs - entry.openedAtMs >= this.config.resetTimeoutMs) {
      return 'HALF_OPEN';
    }
    return entry.state;
  }
}
