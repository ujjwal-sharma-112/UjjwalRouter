import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/database/schema/schema.ts',
  out: './src/database/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/ujjwalrouter.db',
  },
});
