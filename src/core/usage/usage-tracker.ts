import type { FailoverAttemptRecord } from '../failover/failover-coordinator.js';

export interface RequestExecutionLog {
  requestId: string;
  timestamp: string;
  requestedModel: string;
  effectiveProfile: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  estimatedInputTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  latencyMs: number;
  failoverCount: number;
  stream: boolean;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  routingExplanation?: string;
  attempts: FailoverAttemptRecord[];
}

export interface UsageSink {
  recordRequest(entry: RequestExecutionLog): void | Promise<void>;
}

export class InMemoryUsageTracker implements UsageSink {
  private readonly logs: RequestExecutionLog[] = [];
  private readonly maxLogs: number;

  constructor(maxLogs = 1000) {
    this.maxLogs = maxLogs;
  }

  public recordRequest(entry: RequestExecutionLog): void {
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.length = this.maxLogs;
    }
  }

  public getRecentLogs(limit = 50): RequestExecutionLog[] {
    return this.logs.slice(0, limit);
  }

  public getStats(): {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } {
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const log of this.logs) {
      if (log.status === 'success') successfulRequests += 1;
      else failedRequests += 1;
      totalInputTokens += log.actualInputTokens || log.estimatedInputTokens;
      totalOutputTokens += log.actualOutputTokens;
    }

    return {
      totalRequests: this.logs.length,
      successfulRequests,
      failedRequests,
      totalInputTokens,
      totalOutputTokens,
    };
  }
}
