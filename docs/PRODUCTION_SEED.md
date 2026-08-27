# Production database seed

Use the included bootstrap script for a new production database. It applies all
Drizzle migrations, enables the database protections included in migration, and
then loads the complete idempotent application seed dataset.

## Run it

1. Copy `seed-production.env.example` to a private `.env` file, or set the
   variables in your deployment provider's environment settings.
2. Set `DATABASE_URL`, `SEED_ADMIN_EMAIL`, and a unique
   `SEED_ADMIN_PASSWORD` that is at least 16 characters long.
3. From the repository root, run:

   ```sh
   pnpm db:bootstrap
   ```

The initial administrator logs in with `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`.

## Included data

The bootstrap seeds the global budget rule, administrator account, characters,
environment presets, OpenRouter model catalog and price versions, prompts,
skills and rules, the default workflow and node configuration, plus required
cost-event backfills.

It is safe to run again: existing records are preserved. To change the initial
administrator password after it has been created, use the application's admin
password-management flow; re-running the seed deliberately does not overwrite
an existing account.
