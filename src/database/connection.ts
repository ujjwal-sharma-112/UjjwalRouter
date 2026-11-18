import fs from 'node:fs';
import path from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import { NodeSqliteClient } from './node-sqlite-client.js';
import * as schema from './schema/schema.js';

export type RouterDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseConnection {
  sqlite: NodeSqliteClient;
  db: RouterDatabase;
  close: () => void;
}

export function resolveMigrationsFolder(): string {
  const candidates = [
    path.resolve(process.cwd(), 'src/database/migrations'),
    path.resolve(import.meta.dirname, 'migrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0]!;
}

function createDrizzleNodeSqlite(client: NodeSqliteClient): RouterDatabase {
  const dialect = new SQLiteSyncDialect();
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const schemaConfig = {
    fullSchema: schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  };
  const session = new BetterSQLiteSession(
    client as never,
    dialect,
    schemaConfig as never,
    {}
  );
  return new BaseSQLiteDatabase('sync', dialect, session, schemaConfig as never) as unknown as RouterDatabase;
}

export function openDatabase(databasePath: string): DatabaseConnection {
  if (databasePath !== ':memory:') {
    const parentDir = path.dirname(path.resolve(databasePath));
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o750 });
  }

  const sqlite = new NodeSqliteClient(databasePath);
  if (databasePath !== ':memory:') {
    try {
      fs.chmodSync(databasePath, 0o600);
    } catch {
      // ignore if permissions cannot be altered on virtual filesystems
    }
  }

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const db = createDrizzleNodeSqlite(sqlite);

  return {
    sqlite,
    db,
    close: () => {
      sqlite.close();
    },
  };
}

export function runMigrations(conn: DatabaseConnection, migrationsFolder = resolveMigrationsFolder()): void {
  migrate(conn.db, { migrationsFolder });
}
