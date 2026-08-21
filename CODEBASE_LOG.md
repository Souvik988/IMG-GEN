# Shotlin MVP - Persistent Codebase Log

This file is the permanent development memory for the Shotlin MVP.

Every coding agent must read this file before making changes and update it after meaningful changes.

Do not store passwords, API keys, access tokens or secrets here.

---

## 1. Project Goal

Build the Shotlin Zero-Prompt Garment Image Generation MVP.

Customer flow: Upload Garment → Choose Character → Age/Height/Pose → Environment → Resolution → Aspect Ratio/Image Count → Generate → Quality Review → Retry if Required → Preview → Download.

Source requirement docs live in `docs/` (copies of the three original architecture documents).

---

## 2. Current System Status

**Overall Status:** Operator-grade local workflow studio complete; mock-first verification green

**Currently Working On:** Stage 8 — verification polish and live-provider readiness.

**Provider configuration update (2026-08-19):** Production AI routing is now OpenRouter-only. Vision, QA, and adjudication use `qwen/qwen3.8-27b` through OpenRouter structured outputs; image generation uses `bytedance-seed/seedream-4.5` through OpenRouter's dedicated `/api/v1/images` endpoint with private base64 reference images. `GEMINI_API_KEY` is no longer required or read by the runtime. The database enum retains `gemini` only for historical rows.

**Last Successfully Completed:**

* Stages 0–7 implemented: schema/migrations/seed, domain logic, providers/platform, Nest API, BullMQ worker, customer UI, and admin control room.
* Local Compose stack booted; migrations and seed completed; API and web smoke-tested.
* Frontend is connected to API health, auth, catalog, presigned upload/complete, and job creation paths.
* Fixed local CSS blank/default rendering: concurrent `next build` had clobbered the dev `.next` cache and caused a stale stylesheet 404; stopped dev, cleared generated cache, and restarted cleanly.
* Replaced the static admin shell with a live Workflow Studio: production-version node graph, model/prompt bindings, editable thresholds/settings, versioned prompt draft editing, quality gate, budget controls, live job polling, candidate/review/defect/trace/cost inspector, and API-backed registries.
* Added `/settings` with an admin-protected, server-side OpenRouter `/models` connectivity test. Provider secrets are not persisted or echoed; the worker remains explicitly environment-configured.
* Customer projects and job result pages now read `/api/projects`, poll `/api/jobs/:id`, load signed outputs, and submit feedback instead of rendering demo records.

---

## 3. Current Architecture

Monorepo: pnpm workspaces + turbo. Path: `/Users/sayan/Documents/IMG GEN`.

### Customer Website

* Status: Implemented customer workspace with zero-prompt generator, local reference preview, age/height/pose, character/environment/output selectors, real queue submission, API-backed project archive, polling job result view, signed downloads, feedback, and login screen.
* Important files: `apps/web/src/components/`, `apps/web/src/app/`

### Admin Dashboard

* Status: Implemented live control room with production workflow graph and node inspector, versioned prompt/model/skill registry views, quality rules, budget controls, live run inspector, operational metrics, and explicit admin access gate.
* Important files: `apps/web/src/app/admin/page.tsx`, `apps/web/src/components/workflow-studio.tsx`

### Backend API

* Status: Implemented REST API with auth/session, uploads, customer listings/jobs/projects, admin config/data endpoints, health checks, and server-side OpenRouter connectivity testing.
* Important files: `apps/api/` (NestJS 11 + Fastify, port 4000)

### Workflow Worker

* Status: Implemented fixed workflow engine with input gate, vision, skill selection, prompt compilation, image generation, QA, rules, retry/budget paths, and finalization.
* Important files: `apps/worker/` (BullMQ worker running the generation pipeline)

### Database

* Status: Schema, migration, and seed implemented; Postgres 16 + pgvector runs via docker-compose
* Important files/migrations: `packages/database/` (Drizzle ORM + drizzle-kit)

### AI Workflow

* Status: Implemented deterministic core, mock/OpenRouter/Gemini adapters, storage, queue, and worker orchestration.
* Important files: `packages/core/` (rule engine, cost engine, schemas, selector, compiler), `packages/providers/` (OpenRouter / Gemini / Mock adapters), `packages/platform/` (storage, queue, config)

### Infrastructure

* docker-compose: postgres (pgvector/pgvector:pg16, port 5432), redis (6379), minio (9000/9001, buckets `uploads` + `outputs`)
* Local credentials are in `.env` (not committed); template in `.env.example`

---

## 4. Current AI Workflow

```text
Input → Validation → Vision Analysis → Garment Truth Sheet → Skill Selection
→ Prompt Compiler → Image Generation → Quality Review → Rule Engine
→ PASS / FAIL / UNCERTAIN → Second Review (uncertain) → Retry if FAIL within budget
→ Final Output
```

### Vision Model

Provider: OpenRouter (configurable) / Model: Qwen3.6-35B-A3B (config, not code) / Prompt: Garment Analysis v1

### Prompt Compiler

Provider: deterministic template first / Model: — / Prompt: Compiler v1

### Image Generator

Provider: Google Gemini adapter / Model: Gemini 3.1 Flash Image / Prompt: Image Generation System v1

### Quality Reviewer

Provider: OpenRouter / Model: MiMo-V2.5 / Prompt: Quality Review v1

### Fallback Model

Provider: OpenRouter / Model: GLM-4.6V (second reviewer, uncertain cases only)

**All model IDs / prompts / skills / thresholds / retry / budget limits are database configuration (admin-editable), never hard-coded.**

**Mock mode:** `MOCK_PROVIDERS=true` in `.env` forces deterministic mock adapters so the whole pipeline is testable without API keys. Live keys absent as of 2026-08-19.

---

## 5. Current Skills

Seeded as Production v1 (planned, Stage 1): Garment Analysis, Saree Fidelity, Kurta Fidelity, Dress Fidelity, Generic Garment Fidelity, Character Preservation, Fine Textile Detail, Outdoor Photography, Indoor Photography, Studio Photography, Photorealism, Garment Repair, Anatomy/Character Repair.

---

## 6. Database Changes

### Entry Template

**Date:** 2026-08-19
**Change:** Initial schema being authored (Stage 1)
**Tables/Fields affected:** ~30 tables (users, sessions, assets, characters, environments, workflows/versions/nodes/configs, model_registry, model_price_versions, prompts/versions, skills/versions/rules, jobs family, cost_events, budget_rules, feedback, benchmark tables, admin audit)
**Migration/File:** `packages/database/src/schema.ts`, `packages/database/drizzle/`
**Reason:** Docs 02 §3 schema plan
**Verified:** No (pending)

---

## 7. API / Provider Changes

**Date:** 2026-08-19 — **Provider:** OpenRouter + Google Gemini + Mock — **Change:** initial adapter design (Stage 3) — **Reason:** docs logical-role architecture. No keys present yet; mock mode is the default.

---

## 8. Prompt Changes

Seeded v1 prompt set planned (Stage 1): input quality, garment vision, prompt compiler, image generation system, quality review, repair, second review.

---

## 9. Cost Configuration

### Current Planning Budget

2K successful image: **₹20 maximum internal planning estimate** (warn ₹15)

### Current Actual Measurements

Vision cost: — / Image-generation cost: — / QA cost: — / Average retry cost: — / Average successful-image cost: — / Number of measured jobs: 0

(Filled from real data after live runs; mock runs record cost events with configured prices.)

Planning reference prices seeded into `model_price_versions`: Gemini 3.1 Flash Image 2K USD 0.101/img (1K/4K seeded per admin data), Qwen3.6-35B-A3B USD 0.14/M in + 1.00/M out, MiMo-V2.5 USD 0.105/M in + 0.28/M out, GLM-4.6V USD 0.30/M in + 0.90/M out. FX default 95.78.

---

## 10. Completed Features

* [x] Customer garment upload UI + presigned upload API
* [x] Character selection and character upload API
* [x] Age, height/presence, and pose selection
* [x] Environment, resolution, aspect-ratio, and image-count selection
* [x] Vision analysis and Garment Truth Sheet schema
* [x] Skill selection and deterministic prompt compilation
* [x] Mock/OpenRouter/Gemini provider adapters
* [x] Automatic QA, PASS/FAIL/UNCERTAIN rules, second review, retries, and budget stop
* [x] Preview/master/JPG finalization path
* [x] Workflow, model, prompt, skill, quality, budget, cost, job, character, and environment admin APIs
* [x] Customer UI, job result view, projects archive, and admin control room
* [ ] Full worker E2E acceptance suite and 15-test acceptance checklist
* [ ] Live-provider runs after credentials are supplied

---

## 11. Known Problems

* No AI provider keys yet → live generation untested; mock mode is the verification path.

---

## 12. Important Decisions

**Date:** 2026-08-19
**Decision:** Monorepo layout: `apps/web` (Next.js UI only), `apps/api` (NestJS+Fastify REST), `apps/worker` (BullMQ workflow engine), `packages/{database,core,providers,platform}`.
**Why:** User chose separate NestJS API service; docs require generation outside web request lifecycle.
**Alternatives considered:** single Next.js app with API routes (rejected by user).
**Impact:** all AI calls live in worker; API only validates/persists/enqueues.

**Date:** 2026-08-19
**Decision:** Local infra via docker-compose (Postgres 16 + pgvector, Redis 7, MinIO). Object storage behind S3-compatible abstraction.
**Why:** Self-managed per docs; one command to boot.
**Impact:** migrations must create fresh DB from zero.

**Date:** 2026-08-19
**Decision:** Mock-provider-first. `MOCK_PROVIDERS=true` default in `.env`; OpenRouter/Gemini adapters implemented but dormant until keys provided.
**Why:** Keys not yet available; pipeline must be verifiable end-to-end deterministically.
**Impact:** acceptance tests run in mock mode now; live runs later by flipping env.

**Date:** 2026-08-19
**Decision:** Internal packages compile to CJS `dist/` via tsc; `exports` includes a `development` condition pointing at `src/` used by Vitest. NestJS API built with tsc (emitDecoratorMetadata), dev via concurrently (tsc watch + node --watch).
**Why:** tsx/esbuild cannot emit decorator metadata required by NestJS DI; boring-reliable build graph.
**Impact:** run `pnpm build` before `pnpm dev`/`check`/`test` (turbo handles ordering).

**Date:** 2026-08-19
**Decision:** Auth = email/password (scrypt from node:crypto) with opaque session tokens hashed in `user_sessions`, httpOnly cookie. Roles: customer/admin.
**Why:** MVP-simple, revocable, no external auth dependency.

---

## 13. Files Changed Recently

```text
package.json / pnpm-workspace.yaml / turbo.json / tsconfig.base.json
- Monorepo scaffold and task pipeline
docker-compose.yml
- Postgres+pgvector, Redis, MinIO + bucket init
.env / .env.example
- Local config template (secrets never committed)
apps/{api,worker,web} + packages/{database,core,providers,platform}
- Project skeletons with build/dev/check scripts
CODEBASE_LOG.md
- This log, initialized
docs/
- Copies of the three Shotlin architecture requirement documents
```

---

## 14. Tests and Verification

* `pnpm build` passes for all 7 workspace packages/apps.
* `pnpm check` passes for all workspace packages/apps.
* `pnpm test` passes: 34 core unit tests; API/worker runners pass with `--passWithNoTests` until their E2E suites are added.
* `docker compose config --quiet` passes.
* Docker services healthy: Postgres, Redis, MinIO.
* `pnpm db:migrate` and `pnpm -F @shotlin/database db:seed` pass.
* `pnpm dev` boots API, web, and worker after fixing Nest module guard imports.
* Smoke checks pass: `GET /api/health` returns `status: ok`; web `/` returns 200 and rendered Shotlin copy.
* Current local session: `pnpm dev` running API on 4000, web on 3100, worker on BullMQ/Redis.
* CSS smoke check passes: generated layout stylesheet returns HTTP 200 and contains `.app-frame`, `.rail`, `.display`, and theme variables.

---

## 15. Next Actions

1. Add the full worker/API mock E2E suite for happy path, repair retry, UNCERTAIN second review, budget stop, and input rejection.
2. Walk and record the 15 acceptance tests from the source docs in mock mode.
3. Supply provider keys and re-run live adapter acceptance tests.
4. Add benchmark cases/runs before publishing accuracy claims.

---

## 16. Session Handoff

**What was done:** Stage 0 scaffold (monorepo, infra, skeletons, docs, this log).
**What currently works:** infra definitions; builds pending verification.
**What is partially implemented:** nothing beyond scaffold.
**What is broken:** nothing known.
**What should be done next:** Stage 1 database schema.
**Important warnings for the next agent:** build packages (`pnpm build`) before dev/check/test; `.env` holds local secrets and must never be committed; `MOCK_PROVIDERS=true` until real keys arrive.
