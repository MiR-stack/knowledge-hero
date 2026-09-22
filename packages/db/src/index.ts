import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export interface CreateDbOptions {
  /** Disable prepared statements — required for PgBouncer transaction pooling. */
  prepare?: boolean;
  max?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const client = postgres(connectionString, {
    prepare: options.prepare ?? false,
    max: options.max ?? 10,
  });
  return drizzle(client, { schema });
}

export function createPostgresClient(connectionString: string, options: CreateDbOptions = {}) {
  return postgres(connectionString, {
    prepare: options.prepare ?? false,
    max: options.max ?? 10,
  });
}

export type Db = ReturnType<typeof createDb>;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type PostgresClient = ReturnType<typeof createPostgresClient>;

export * from "./schema/index.js";
export { loadSupplementalSql } from "./supplemental-sql.js";
