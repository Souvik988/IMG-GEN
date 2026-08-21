import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];
export type DbPool = ReturnType<typeof createDb>["pool"];

export function createDb(databaseUrl: string, poolMax = 10) {
  const pool = new Pool({ connectionString: databaseUrl, max: poolMax });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
