import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

function normalizeBindParam(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

function normalizeParams(params: unknown[]): SQLInputValue[] {
  return params.map(normalizeBindParam);
}

export class NodeSqliteStatement {
  private readonly stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
  }

  public run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const res = this.stmt.run(...normalizeParams(params));
    return {
      changes: Number(res.changes),
      lastInsertRowid: Number(res.lastInsertRowid),
    };
  }

  public all(...params: unknown[]): unknown[] {
    this.stmt.setReturnArrays(false);
    return this.stmt.all(...normalizeParams(params));
  }

  public get(...params: unknown[]): unknown {
    this.stmt.setReturnArrays(false);
    return this.stmt.get(...normalizeParams(params));
  }

  public raw(): {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  } {
    return {
      all: (...params: unknown[]) => {
        this.stmt.setReturnArrays(true);
        return this.stmt.all(...normalizeParams(params));
      },
      get: (...params: unknown[]) => {
        this.stmt.setReturnArrays(true);
        return this.stmt.get(...normalizeParams(params));
      },
    };
  }
}

export type TransactionFn<TArgs extends unknown[], TResult> = ((...args: TArgs) => TResult) & {
  deferred: (...args: TArgs) => TResult;
  immediate: (...args: TArgs) => TResult;
  exclusive: (...args: TArgs) => TResult;
};

export class NodeSqliteClient {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
  }

  public prepare(sql: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  public exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  public pragma(pragmaExpression: string): void {
    this.db.exec(`PRAGMA ${pragmaExpression};`);
  }

  public transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): TransactionFn<TArgs, TResult> {
    const runWithBehavior = (behavior: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') => {
      return (...args: TArgs): TResult => {
        if (this.inTransaction) {
          return fn(...args);
        }
        this.inTransaction = true;
        this.db.exec(`BEGIN ${behavior};`);
        try {
          const result = fn(...args);
          this.db.exec('COMMIT;');
          return result;
        } catch (err) {
          try {
            this.db.exec('ROLLBACK;');
          } catch {
            // ignore rollback errors if transaction already aborted
          }
          throw err;
        } finally {
          this.inTransaction = false;
        }
      };
    };

    const base = runWithBehavior('DEFERRED') as TransactionFn<TArgs, TResult>;
    base.deferred = runWithBehavior('DEFERRED');
    base.immediate = runWithBehavior('IMMEDIATE');
    base.exclusive = runWithBehavior('EXCLUSIVE');
    return base;
  }

  public close(): void {
    this.db.close();
  }
}
