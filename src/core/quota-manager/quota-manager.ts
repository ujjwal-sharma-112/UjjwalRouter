interface QuotaState {
  dayKey: string;
  requestsToday: number;
  tokensToday: number;
  exhaustedUntilMs: number;
  exhaustedReason?: string;
}

function getUtcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function getNextUtcMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export class QuotaManager {
  private readonly states = new Map<string, QuotaState>();

  private getState(key: string, nowMs: number): QuotaState {
    const dayKey = getUtcDayKey(nowMs);
    const existing = this.states.get(key);
    if (!existing || existing.dayKey !== dayKey) {
      const fresh: QuotaState = {
        dayKey,
        requestsToday: 0,
        tokensToday: 0,
        exhaustedUntilMs: existing && existing.exhaustedUntilMs > nowMs ? existing.exhaustedUntilMs : 0,
        exhaustedReason: existing && existing.exhaustedUntilMs > nowMs ? existing.exhaustedReason : undefined,
      };
      this.states.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  public hasQuota(params: {
    key: string;
    rpdLimit?: number | null;
    nowMs?: number;
  }): { available: boolean; reason?: string } {
    const nowMs = params.nowMs ?? Date.now();
    const state = this.getState(params.key, nowMs);

    if (state.exhaustedUntilMs > nowMs) {
      return {
        available: false,
        reason:
          state.exhaustedReason ??
          `Quota exhausted until ${new Date(state.exhaustedUntilMs).toISOString()}.`,
      };
    }

    if (params.rpdLimit && params.rpdLimit > 0 && state.requestsToday >= params.rpdLimit) {
      return {
        available: false,
        reason: `Daily free request cap reached (${state.requestsToday}/${params.rpdLimit}).`,
      };
    }

    return { available: true };
  }

  public recordUsage(key: string, totalTokens = 0, nowMs = Date.now()): void {
    const state = this.getState(key, nowMs);
    state.requestsToday += 1;
    state.tokensToday += Math.max(0, totalTokens);
  }

  public markExhausted(key: string, resetAt?: string | null, reason?: string, nowMs = Date.now()): void {
    const state = this.getState(key, nowMs);
    const parsedReset = resetAt ? Date.parse(resetAt) : Number.NaN;
    state.exhaustedUntilMs =
      !Number.isNaN(parsedReset) && parsedReset > nowMs
        ? parsedReset
        : getNextUtcMidnightMs(nowMs);
    state.exhaustedReason = reason ?? 'Upstream reported free quota exhaustion.';
  }

  public getUsageSnapshot(key: string, nowMs = Date.now()): QuotaState {
    return { ...this.getState(key, nowMs) };
  }
}
