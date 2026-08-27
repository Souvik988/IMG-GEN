#!/usr/bin/env node

/**
 * Production database bootstrap for Shotlin.
 *
 * Applies all schema migrations, then creates the administrator and the
 * complete idempotent application seed dataset.
 */
import { spawnSync } from "node:child_process";

function requireValue(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

try {
  requireValue("DATABASE_URL");
  const adminPassword = requireValue("SEED_ADMIN_PASSWORD");
  if (adminPassword.length < 16) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 16 characters long.");
  }

  process.env.NODE_ENV = "production";
  console.log("Applying database migrations...");
  run("pnpm", ["--filter", "@shotlin/database", "db:migrate"]);
  console.log("Loading administrator and application seed data...");
  run("pnpm", ["--filter", "@shotlin/database", "db:seed"]);
  console.log("Production database bootstrap complete.");
} catch (error) {
  console.error(`Database bootstrap failed: ${error.message}`);
  process.exitCode = 1;
}
