import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";
import { loadRootEnv, requireEnv } from "./env";

async function main() {
  loadRootEnv();
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url, 1);

  // pgvector is optional for the MVP path but the schema keeps it available.
  await db.execute("CREATE EXTENSION IF NOT EXISTS vector");
  await migrate(db, { migrationsFolder: __dirname + "/../drizzle" });

  console.log("✓ migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
