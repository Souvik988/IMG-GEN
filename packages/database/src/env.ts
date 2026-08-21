import fs from "node:fs";
import path from "node:path";

/**
 * Find and load the monorepo root `.env` regardless of the package cwd.
 * Values already present in process.env win (never overwritten).
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      const { config } = require("dotenv") as typeof import("dotenv");
      config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to default dotenv resolution.
  const { config } = require("dotenv") as typeof import("dotenv");
  config();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
