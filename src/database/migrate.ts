import { loadConfig } from '../config/env.js';
import { openDatabase, runMigrations } from './connection.js';

function main(): void {
  const config = loadConfig();
  const conn = openDatabase(config.databasePath);
  try {
    runMigrations(conn);
    console.log(`Database migrations applied successfully to ${config.databasePath}`);
  } finally {
    conn.close();
  }
}

main();
