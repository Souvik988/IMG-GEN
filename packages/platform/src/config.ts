import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
  const { config } = require("dotenv") as typeof import("dotenv");
  config();
}

const boolFlag = z.preprocess(
  (v) => String(v).toLowerCase(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
);

const INSECURE_SESSION_SECRETS = new Set(["dev-secret", "change-me-to-a-long-random-string", ""]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6381"),
  API_PORT: z.coerce.number().default(4000),
  API_URL: z.string().default("http://localhost:4000"),
  WEB_URL: z.string().url().default("http://localhost:3100"),
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_BUCKET_UPLOADS: z.string().default("uploads"),
  S3_BUCKET_OUTPUTS: z.string().default("outputs"),
  S3_FORCE_PATH_STYLE: boolFlag.default(true),
  SESSION_SECRET: z.string().default("dev-secret"),
  SESSION_TTL_HOURS: z.coerce.number().default(168),
  OPENROUTER_API_KEY: z.string().default(""),
  MOCK_PROVIDERS: boolFlag.default(true),
  USD_INR_RATE: z.coerce.number().default(95.78),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

/** Load + validate the app configuration (cached singleton). */
export function getAppConfig(): AppConfig {
  if (cached) return cached;
  loadRootEnv();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  // A known/default/empty session secret is safe only in local dev — in
  // production it lets anyone forge a valid session cookie. Refuse to boot
  // rather than silently run with a guessable secret.
  if (
    parsed.data.NODE_ENV === "production" &&
    (INSECURE_SESSION_SECRETS.has(parsed.data.SESSION_SECRET) || parsed.data.SESSION_SECRET.length < 32)
  ) {
    throw new Error(
      "Refusing to boot in production: SESSION_SECRET is missing, uses a known default, or is shorter than 32 characters. Set a long random SESSION_SECRET before deploying.",
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: reset cached config. */
export function resetAppConfig(): void {
  cached = null;
}
