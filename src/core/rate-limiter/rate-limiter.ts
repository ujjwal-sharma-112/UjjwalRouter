import type { RateLimitObservation } from '../../providers/base/types.js';

interface SlidingWindowBucket {
  requestTimestamps: number[];
  tokenSamples: Array<{ timestamp: number; tokens: number }>;
  cooldownUntilMs: number;
  lastObservedHeaders?: RateLimitObservation;
}

export class RateLimiter {
  private readonly buckets = new Map<string, SlidingWindowBucket>();
  private readonly windowMs = 60_000;

  private getBucket(key: string): SlidingWindowBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        requestTimestamps: [],
        tokenSamples: [],
        cooldownUntilMs: 0,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private prune(bucket: SlidingWindowBucket, nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (bucket.requestTimestamps[0] !== undefined && bucket.requestTimestamps[0] <= cutoff) {
      bucket.requestTimestamps.shift();
    }
    while (bucket.tokenSamples[0] !== undefined && bucket.tokenSamples[0].timestamp <= cutoff) {
      bucket.tokenSamples.shift();
    }
  }

  public canAccept(params: {
    key: string;
    estimatedTokens?: number;
    rpmLimit?: number | null;
    tpmLimit?: number | null;
    nowMs?: number;
  }): { allowed: boolean; retryAfterMs: number; reason?: string } {
    const nowMs = params.nowMs ?? Date.now();
    const bucket = this.getBucket(params.key);
    this.prune(bucket, nowMs);

    if (bucket.cooldownUntilMs > nowMs) {
      return {
        allowed: false,
        retryAfterMs: bucket.cooldownUntilMs - nowMs,
        reason: `Rate-limit cooldown active until ${new Date(bucket.cooldownUntilMs).toISOString()}.`,
      };
    }

    const rpmLimit = params.rpmLimit ?? bucket.lastObservedHeaders?.limitRequests ?? null;
    if (rpmLimit !== null && rpmLimit > 0 && bucket.requestTimestamps.length >= rpmLimit) {
      const oldest = bucket.requestTimestamps[0] ?? nowMs;
      return {
        allowed: false,
        retryAfterMs: Math.max(1000, oldest + this.windowMs - nowMs),
        reason: `Local sliding-window RPM limit reached (${bucket.requestTimestamps.length}/${rpmLimit}).`,
      };
    }

    if (bucket.lastObservedHeaders?.remainingRequests === 0 && bucket.lastObservedHeaders.resetRequestsAt) {
      const resetMs = Date.parse(bucket.lastObservedHeaders.resetRequestsAt);
      if (!Number.isNaN(resetMs) && resetMs > nowMs) {
        return {
          allowed: false,
          retryAfterMs: resetMs - nowMs,
          reason: 'Upstream remaining requests reported as 0.',
        };
      }
    }

    const tpmLimit = params.tpmLimit ?? bucket.lastObservedHeaders?.limitTokens ?? null;
    const estTokens = params.estimatedTokens ?? 0;
    if (tpmLimit !== null && tpmLimit > 0 && estTokens > 0) {
      const currentTpm = bucket.tokenSamples.reduce((sum, s) => sum + s.tokens, 0);
      if (currentTpm + estTokens > tpmLimit && currentTpm > 0) {
        const oldest = bucket.tokenSamples[0]?.timestamp ?? nowMs;
        return {
          allowed: false,
          retryAfterMs: Math.max(1000, oldest + this.windowMs - nowMs),
          reason: `Local sliding-window TPM limit would be exceeded (${currentTpm + estTokens}/${tpmLimit}).`,
        };
      }
    }

    return { allowed: true, retryAfterMs: 0 };
  }

  public recordRequest(key: string, estimatedTokens = 0, nowMs = Date.now()): void {
    const bucket = this.getBucket(key);
    this.prune(bucket, nowMs);
    bucket.requestTimestamps.push(nowMs);
    if (estimatedTokens > 0) {
      bucket.tokenSamples.push({ timestamp: nowMs, tokens: estimatedTokens });
    }
  }

  public applyCooldown(key: string, cooldownMs: number, nowMs = Date.now()): void {
    if (cooldownMs <= 0) return;
    const bucket = this.getBucket(key);
    bucket.cooldownUntilMs = Math.max(bucket.cooldownUntilMs, nowMs + cooldownMs);
  }

  public recordHeaders(key: string, headers: RateLimitObservation | undefined, nowMs = Date.now()): void {
    if (!headers) return;
    const bucket = this.getBucket(key);
    bucket.lastObservedHeaders = headers;
    if (headers.retryAfterMs && headers.retryAfterMs > 0) {
      bucket.cooldownUntilMs = Math.max(bucket.cooldownUntilMs, nowMs + headers.retryAfterMs);
    }
  }

  public getCooldownRemainingMs(key: string, nowMs = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    return Math.max(0, bucket.cooldownUntilMs - nowMs);
  }
}
