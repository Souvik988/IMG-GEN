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

  // The application uses a server-only PostgreSQL connection; it never
  // accesses these tables through Supabase's public Data API. Enforce RLS on
  // every public table after migrations so an accidental Data API exposure
  // cannot disclose customer jobs, assets, sessions, or costs.
  await db.execute(`
    DO $$
    DECLARE table_record record;
    BEGIN
      FOR table_record IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_record.table_name);
      END LOOP;
    END $$;
  `);

  console.log("✓ migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
