# SHOTLIN — Remaining MVP Execution Plan

**Status as of this audit:** 2026-08-22
**Audit scope:** full repository (`apps/`, `packages/`, `docs/`, `CODEBASE_LOG.md`) against the SHOTLIN Master Executive Build Directive.

## How to read this document

The directive this plan responds to specifies ~9 phases covering execution
correctness, identity/fidelity, anchor-first orchestration, provider
architecture, admin control plane, customer UX, security/reliability,
benchmarking, and release hardening. That is realistically **weeks of
engineering work for a team**, not a single session. This document is honest
about that: it records exactly what exists today, what was fixed in this
session, and what remains — sized and sequenced so future sessions can pick
up any phase without re-auditing.

---

## 1. What actually exists today (Phase 0 findings)

### Architecture — matches the directive's constraints

pnpm monorepo, Turborepo, Next.js web (customer + admin), NestJS/Fastify API,
PostgreSQL + Drizzle, Redis + BullMQ worker, MinIO locally / S3-compatible in
production intent, Zod schemas, Vitest. No Python rewrite has occurred or is
planned. This foundation is correct and should not change.

### Workflow engine — real, but single-attempt-oriented

Ten-node pipeline exists and runs: `input_check → vision → skill_select →
prompt_compile → image_generate → quality_review → rule_engine →
second_review → retry → finalize`. Each node is a real `NodeRunner` function
in `apps/worker/src/nodes.ts`, driven by `apps/worker/src/processor.ts`
against DB-loaded `workflow_versions` / `workflow_nodes` / `workflow_node_configs`.

### Multi-angle generation — anchor-first generation exists; review was broken until this session

`image_generate` (added this session) generates one anchor image first, then
fans the remaining requested angles out in parallel, each conditioned on the
approved anchor image as an explicit reference — this satisfies the
directive's Section 14 "anchor-first is mandatory" for the *generation* half
of the pipeline.

**Critical finding, fixed in this session (P0-1):** the review pipeline
(`quality_review`, `rule_engine`, `second_review`) was written before
multi-angle generation existed and only ever evaluated
`ctx.candidates[ctx.candidates.length - 1]` — the single most-recently-pushed
candidate. Every other candidate in a multi-image set kept `qualityReview:
null`, and `finalize`'s old filter (`!review || review.criticalDefects.length
=== 0`) treated a `null` review as automatically passing. **Unreviewed,
unapproved images were being delivered to the customer as final output.**
This was caught by comparing the codebase against this directive's Section 9
(P0-5) and Section 27 (P0-1) requirements, not by a bug report — but it was
live in production code this session, including at least one real customer
job (`3b3b324b...`) that generated real paid images under the broken review
path (that job separately never reached `finalize` for other reasons, so
customer-facing harm did not occur in that specific case — but the bug was
real and reachable).

**Fix applied:**
- `quality_review` now reviews every candidate lacking a review, in parallel, each producing its own `PASS`/`FAIL`/`UNCERTAIN` decision via `evaluateRules`.
- `second_review` now re-reviews every candidate whose primary decision was `UNCERTAIN`, not just the last one.
- `rule_engine` rolls per-candidate decisions up into one job-level decision via a new pure function `rollUpSetDecision` (`packages/core/src/candidate-set.ts`): anchor `FAIL` → job `FAIL`; anchor `UNCERTAIN` or any candidate `UNCERTAIN` → job `UNCERTAIN`; anchor `PASS` → job `PASS` (non-anchor `FAIL`s are withheld individually, not retried as a whole set in this pass).
- `finalize` now delivers only candidates whose `decision === "PASS"`, via `selectDeliverableCandidates` (same module) — and throws rather than silently substituting an unreviewed candidate if that set is ever empty.
- `generation_candidates` gained `decision` + `decision_reasons` columns (migration `0003_ambiguous_nico_minoru.sql`) so every candidate's outcome is individually persisted and auditable — a first step toward Section 32's `CandidateSet` abstraction.
- 11 new unit tests in `packages/core/src/candidate-set.test.ts` lock in the exact invariant that was broken: a `null` or `UNCERTAIN` decision can never appear in `selectDeliverableCandidates`'s output. All 59 core tests pass.

**What this fix does NOT do (deliberately, to keep it reviewable):** it does
not implement true per-angle retry (Section 33) — a `FAIL`ed non-anchor angle
is currently withheld, not automatically regenerated. It does not build the
full `CandidateSet` class abstraction from Section 32, only the decision-set
logic that was the actual safety hole. Both are real, correctly-scoped
follow-on work — see Phase 1 below.

### Cost accounting — was silently losing money on every retried job; fixed this session (P0-3)

**Critical finding, confirmed live and fixed:** `jobs.totalCostInr` was only
ever persisted by `finalizeJobCost`, and that was only ever called from the
success (`finalize`) path. On every other exit — `retrying`, `budget_stopped`,
`failed` (max attempts), `manual_review` — the cached total was **never
written**, and the budget check at the start of the *next* attempt
(`currentSpendInr = Number(data.job.totalCostInr ?? 0)`) re-read that same
stale value. The result: a job's true prior spend across earlier failed
attempts was silently discarded every time. Verified against a real job that
had gone through 3 attempts: cached `total_cost_inr` showed **₹13.82**, the
actual `cost_events` ledger summed to **₹33.48** — the cached figure was
missing more than half the real spend. Since the same stale figure also fed
the hard-stop check (`currentSpendInr + ctx.totalCostInr <= hardStop`), a job
could burn through several retries' worth of real spend without the budget
stop ever seeing the true total.

**Fix applied:**
- New `sumCostEventsForJob(db, jobId)` in `apps/worker/src/db.ts` — the actual ledger sum, used to seed `currentSpendInr` at the start of every attempt (`apps/worker/src/processor.ts`) instead of the cached column.
- `finalizeJobCost` is now called at **every** exit point of `runConfiguredWorkflow` — `budget_stopped`, `failed` (max attempts), `retrying`, and both fallback `PASS`/`FAIL`/`manual_review` branches at the bottom of the function — not just the success path.
- One-time reconciliation run against the live database: 6 existing jobs had drifted cached totals; all corrected to match `cost_events` exactly (verified the specific job above now reads ₹33.48 = ₹33.48).

Budget hard-stop was also flat `₹20` per job regardless of requested image
count (fixed this session, unrelated to P0-1/P0-3: now scales as
`hardStopInr × outputCount`, so a 5-image job gets a proportional ceiling
instead of self-aborting after image 1).

### Workflow versioning — DB schema supports it; no draft/publish UI exists

`workflow_versions`, `workflow_nodes`, `workflow_node_configs` exist and jobs
reference a specific `workflow_version_id`. There is no clone-draft /
validate / publish / rollback UI or API (Section 4/P0-4, Sections 45–46).
Production workflow is currently edited in place via direct DB/admin
mutation, not versioned drafts. **Not fixed this session** — real gap, sized
in Phase 1/5 below.

### Execution manifest — does not exist

No `execution_manifests` table, no manifest snapshot/hash on job creation
(Section 8). Jobs reference live FKs (`workflow_version_id`,
`character_id`, `environment_preset_id`) which are themselves versioned, so
historical jobs are *mostly* reproducible today by following those FKs — but
there is no single immutable snapshot object, and nothing stops a
mid-flight config change from affecting a running job's later attempts.
**Not fixed this session** — Phase 1 item.

### Character / garment identity — partial

`characters` table has a text description + attributes. Custom character
upload (built this session) passes a single uploaded photo as
`characterAssetId`, correctly excluded from garment-vision analysis and
correctly passed as a reference into both generation and QA. Garment truth
sheet (`packages/core/src/schemas/garment-truth-sheet.ts`) already has most
of the structured fields Section 17 asks for (colors, material, border,
embroidery, neckline, protected/uncertain details, confidence). **Fully
addressed this session, in two passes:** catalog characters (Priya, Aarav,
etc.) previously had zero image reference at all — only a text
description — even though the `previewAssetId` column existed unused. First
pass: the worker falls back to a catalog character's `previewAssetId` when
no customer upload exists, with an admin endpoint to attach one. Second
pass: the full structured identity pack now exists —
`character_identity_references` table (front/¾/full-body per character,
migration `0007_dry_maria_hill.sql`), the provider contract changed to
accept multiple character reference photos per generation
(`characterReferences: ImageInput[]`, was a single optional field), and the
worker sends *all* of a character's identity-pack photos when present, not
just one. Admin CRUD endpoints and live verification detail in the Phase 2
checklist and session notes below.

### Security — two real gaps found and fixed this session

- `SESSION_SECRET` defaulted to `"dev-secret"` with **no production
  boot check** — an app deployed without setting this env var would run with
  a publicly-known secret, letting anyone forge a valid session cookie.
  **Fixed:** `packages/platform/src/config.ts` now refuses to boot when
  `NODE_ENV=production` and `SESSION_SECRET` is missing, a known placeholder,
  or under 32 characters.
- Session cookie `secure` flag was **hardcoded `false`** — even a production
  HTTPS deployment would send the session cookie without the `Secure` flag.
  **Fixed:** now `NODE_ENV === "production"` (`apps/api/src/auth/auth.module.ts`).

**Third gap found and fixed (this session, continued):** `/api/auth/login`
and `/api/auth/register` had zero rate limiting — a fully unbounded
password-guessing loop against `verifyPassword`. Added
`AuthRateLimitGuard` (`apps/api/src/auth/auth-rate-limit.guard.ts`),
following the same Redis `INCR`+`PEXPIRE` pattern as the existing
`GenerationRateLimitGuard`, but keyed by `request.ip` (20 attempts/15min,
then `429` + `Retry-After`) since there's no authenticated user yet at
login. **Live-verified, zero cost:** 22 consecutive bad-login attempts
against the running dev API returned `401` ×20 then `429` ×2 exactly as
designed; confirmed via the Redis key directly; cleaned up the test key
afterward. Known limits, documented in the guard's own docstring: keys on
`request.ip` (needs Fastify `trustProxy` configured to be trustworthy
behind a reverse proxy — a deployment decision, not guessed at here), and
doesn't rate-limit per-account, so a distributed attacker could still
brute-force one email address within the per-IP budget.

**CSRF/CORS reviewed this session — found already adequately mitigated, not
an open gap.** The session cookie is `sameSite: "lax"`
(`apps/api/src/auth/auth.module.ts`), which blocks the cookie on cross-site
`POST`/`PUT`/`PATCH`/`DELETE` regardless of vector (form submission or
`fetch`/XHR) — the two standard CSRF attacks. The one case Lax allows
(cross-site top-level GET navigation) is harmless: every `@Get()` in
`apps/api/src` was checked and all are read-only, no state-changing GET
exists. The CORS origin allowlist is a strict array, not reflected/wildcard,
adding defense-in-depth on top of the cookie policy. Conclusion: **no CSRF
token layer needed** given this posture — added one would be unjustified
complexity. Two smaller real things tightened while auditing:
`WEB_URL` now validated as a real URL (`packages/platform/src/config.ts`,
fails fast at boot instead of silently misconfiguring CORS), and the
hardcoded `localhost:3100` dev origin is now excluded from the CORS
allowlist when `NODE_ENV === "production"` (`apps/api/src/main.ts`) — not
exploitable as it stood, but a stray allowlist entry with no legitimate
production use is still worth removing. Live-verified both changes are a
no-op for local dev (`NODE_ENV=development` keeps the localhost origin) and
that a real preflight from the dev web origin still succeeds unchanged.

**Upload/decompression-bomb hardening reviewed this session — found and
fixed a real ordering bug, not just a theoretical gap.**
`UploadsService.complete` (`apps/api/src/uploads/uploads.module.ts`)
checked the 25MB size limit *after* already downloading the full object
and running it through sharp's decoder — so an oversized file, or a small
file crafted to decode into a huge bitmap, was fully fetched and decoded
before ever being rejected, on a host repeatedly measured at <1GB free RAM
this session. Fixed by moving the size check to run directly off the cheap
`headObject` response, before any download or decode. Also added an
explicit `limitInputPixels: 50_000_000` to `extractImageMeta`
(`packages/platform/src/image-utils.ts`) — sharp's own default ceiling
(~268MP) is real protection but still large enough to allocate a big raw
bitmap on this box; 50MP comfortably covers any real garment photo while
capping worst case much tighter. Live-verified against the running dev
API: an oversized 26MB garbage upload was rejected via the cheap size
check (proven by the specific rejection reason, not a decode-error
message); a genuine small image still validates through the normal decode
path unchanged. Magic-byte detection was already present before this
session (`extractImageMeta` compares sharp's *detected* format against the
declared `contentType`, rejecting a mismatch) — that part of Section-level
hardening was not a gap.

**Security headers added this session.** No `@fastify/helmet` dependency
pulled in (real install risk on this session's slow network, and mostly
unnecessary for a JSON-only API with no server-rendered HTML) — instead a
small `onSend` hook in `apps/api/src/main.ts` sets `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, and (production-only)
`Strict-Transport-Security`. Live-verified on the running dev API; CORS
preflight confirmed unaffected.

**Presigned URL expiry policy reviewed this session — already reasonable,
no gap.** `presignPut` defaults to 900s (15min, matches the immediate
browser-upload flow it's used for) and every `presignGet` call site
consistently passes an explicit 3600s (1hr, reasonable for viewing job
results/thumbnails in a browser session) — no call site found with an
unreasonably long or unbounded expiry. While auditing this, also checked
the adjacent question of whether any customer-facing job endpoint leaks
another user's data by ID (classic IDOR): `JobsController`
(`apps/api/src/jobs/jobs.module.ts`) routes every read/write through a
private `getOwnedJob(userId, jobId)` helper that filters
`and(eq(jobs.id, jobId), eq(jobs.userId, userId))` — confirmed already
correctly enforced, not a gap.

**Admin audit log for mutations — was a wiring gap, not a missing
feature.** Corrected from this doc's earlier note; see session addendum
above for the full finding (`admin_audit_events` + `AdminService.audit()`
already existed and covered 6 of 8 admin controllers — the 2 missing
ones, including this session's own character-photo endpoint, are now
wired up too, live-verified).

**Structured logging correlation — also a wiring gap, now closed.**
`createLogger` (`packages/platform/src/logger.ts`) already existed — a
small JSON-line logger with `scope`/`message`/`meta` — but was never
imported anywhere. Every worker log call was a plain `console.log` with
`jobId` string-interpolated into the message text and no `attemptId`,
`candidateId`, or `stepRunId` at all. Wired `createLogger` into all 3
worker files (18 live call sites — the ~5 calls inside the dead legacy
comment block in `processor.ts` were left alone, matching this session's
established precedent), passing whatever correlation IDs are actually in
scope at each site. Also fixed a real bug found along the way: the BullMQ
`completed`/`failed` event handlers were logging BullMQ's own job id
(`retry-<jobId>-<n>` for retries) instead of the real DB `jobs.id`.
Live-verified by running `processGenerationJob` directly against a real
job and confirming the exact structured JSON line. Full detail in session
notes above.

Phase 7 is now fully worked through this session — every item either fixed
or confirmed already adequate. The seed script's `SEED_ADMIN_PASSWORD`
fallback (`"shotlin-admin-123"`) is dev-only (never auto-run in production
boot) so it was not treated as equally urgent as the fixes above, but is
worth a final look before any real production deploy.

### Testing — was 8 files, now 8 files with 59 passing tests (was 48)

Unit tests exist for: skill selector, prompt compiler, job state machine,
input validation, cost engine, rule engine, camera angles, and (new this
session) candidate-set decision logic. **Zero integration tests, zero API
tests, zero E2E tests exist** (Section 11/P0-7). No `LIVE_AI_TESTS` flag
exists — live-provider verification in this session was done manually via
the browser against a locally-running stack with real OpenRouter credits,
not via an automated, opt-in test suite. This is a substantial gap —
sized in Phase 1.

### Provider architecture — single provider; capability pre-flight now built

Only `openRouterChatJson` / `openRouterGenerateImage` exist
(`packages/providers/src/openrouter.ts`) plus a `MockProvider`. No FASHN
adapter, no Google/BFL/OpenAI adapter stubs — still not attempted (needs
real credentials and confirmed intent to add a second provider, neither of
which exist). **Capability pre-flight validation built this session**:
`model_registry.capabilities` already existed as a jsonb column with the
right shape, admin-editable, seeded with real values, but nothing ever
read it — an admin-configured incompatible model/resolution/reference-count
combination just failed live at the provider. `packages/core/src/model-capabilities.ts`
now checks reference count, resolution, and multi-output support against
a model's declared capabilities *before* the request is built, wired into
both `generateImage` call sites in the worker. Verified against the real
production model row read live from the DB, not a fixture. Full detail in
session notes above.

### Admin control plane — Workflow Studio exists, most of Section 44's sections don't

Overview, Workflow graph view, Models, Prompts, Skills, Quality rules, Budget
controls, and a Run Inspector already exist
(`apps/web/src/components/workflow-studio.tsx`). Missing: draft/publish
lifecycle, benchmark suite UI, character identity pack management, cost
dashboard with the specific breakdowns in Section 48 (spend by garment type,
by camera angle, etc.), quality dashboard per Section 49. **Not built this
session** — Phase 5 item.

### Benchmark system — does not exist

No `benchmark_suites` / `benchmark_cases` / `benchmark_runs` /
`benchmark_results` tables, no benchmark dataset, no champion/challenger
tooling. The vision/generation/QA model choices currently in `model_registry`
(`qwen/...`, `bytedance-seed/seedream-4.5`, etc.) are operator choices made
during this session's live debugging, not benchmark-selected. **Not built
this session** — this is genuinely the largest remaining item (Section
50–53) and requires a curated dataset the team has to assemble; it cannot be
fabricated from inside a coding session.

---

## 2. What changed in this session, concretely

| File | Change |
|---|---|
| `apps/worker/src/nodes.ts` | Per-candidate QA (P0-1 fix): `quality_review`, `second_review`, `rule_engine`, `finalize` rewritten to evaluate/roll up/filter the full candidate set instead of only the last-pushed candidate |
| `packages/core/src/candidate-set.ts` (new) | `rollUpSetDecision`, `selectDeliverableCandidates` — pure, unit-tested functions carrying the actual safety invariant |
| `packages/core/src/candidate-set.test.ts` (new) | 11 tests locking in the P0-1 invariant |
| `packages/database/src/schema.ts` | `generation_candidates.decision` / `.decision_reasons` columns; migration `0003_ambiguous_nico_minoru.sql` |
| `packages/platform/src/config.ts` | `NODE_ENV` added; production boot now refuses an insecure `SESSION_SECRET` |
| `apps/api/src/auth/auth.module.ts` | Session cookie `secure` flag now environment-aware instead of hardcoded `false` |
| `.env` / `.env.example` | `NODE_ENV` documented; `SESSION_SECRET` requirement documented |
| `apps/worker/src/nodes.ts` | Anchor QA gate (P0-1/Phase 3): anchor is reviewed before fan-out spends on remaining angles; fan-out skipped on confident anchor `FAIL` |
| `apps/worker/src/db.ts`, `apps/worker/src/processor.ts` | Cost ledger fix (P0-3): `sumCostEventsForJob` reads the true ledger sum for budget enforcement; `finalizeJobCost` now called at every attempt-processing exit, not just success |
| *(database, one-time)* | Reconciled 6 jobs whose cached `total_cost_inr` had drifted from the `cost_events` ledger under the old bug |
| `apps/web/src/components/generator.tsx` | Removed "Estimated internal reserve ₹..." from customer-facing UI (Section 78) — this was leaking internal cost data to customers, including a hardcoded version that predated this session |
| *(earlier in this session, before this audit)* `apps/worker/src/nodes.ts`, `packages/core/src/camera-angles.ts`, `apps/api/src/jobs/jobs.module.ts`, `apps/web/src/components/generator.tsx`, `apps/web/src/app/jobs/[id]/page.tsx` | Multi-angle generation (1–5 images), character-upload wiring fix, home-page thumbnail fix, multi-angle result-gallery fix |

---

## 3. Phased plan for what remains

Sequencing follows the directive's own Section 126 order. Each phase lists
concrete files/modules, not abstract goals.

### Phase 1 — Correctness foundation (highest priority; partially done)

- [x] Per-candidate QA, no unreviewed candidate reaches finalize (**this session**)
- [x] `cost_events` as the actual source of truth for job spend, and every attempt-processing exit path persists it (**this session** — see P0-3 finding above; this was a live, confirmed bug, not a theoretical gap)
- [x] **Persistent structured `RetryPlan` + true per-angle retry (this session).** New `retry_plans` table (migration `0004_careful_iron_man.sql`) records every repair attempt — scope (`full_set`/`single_angle`), failed candidate/angle, defect codes, reviewer explanation, repair instruction, protected attributes, and outcome. `runRetry` (whole-set path, anchor failed) now correctly identifies the anchor specifically rather than "whichever candidate was pushed last," and persists a plan for it. New capability: `runFinalize` now regenerates a single failed non-anchor angle once (reusing the approved anchor + the reviewer's repair instruction) instead of permanently withholding it — capped at one retry per angle per job, budget-aware. **Live-verified for the whole-set/anchor-gate path**; the single-angle retry branch itself has not yet been observed firing on a real job (needs an anchor-passes-but-one-angle-fails outcome, which is probabilistic, and live testing paused on an OpenRouter account limit) — typechecked and logically sound, pending a live case.
- [x] **Execution manifest snapshot creation (this session).** New `execution_manifests` table (migration `0005_conscious_lake.sql`) + `JobsService.createExecutionManifest` in `apps/api/src/jobs/jobs.module.ts`, called inside the same DB transaction as job creation. Snapshots: workflow version/nodes/configs, enabled models by role, resolved production skill versions + a hash of their instructions, quality thresholds, budget rules, and FX rate — plus a sha256 `manifestHash` over the canonicalized snapshot. Typechecks clean, every field name was cross-referenced against the actual schema by hand (not guessed). **Not yet live-verified** — creating a real job immediately triggers the live worker queue and real OpenRouter spend, so this is deferred until live testing resumes (see session notes).
  - **Scoping note:** this pass only covers *creation* — the worker still reads live config via `loadJobData` rather than reading from the manifest. Making the worker actually execute from the frozen manifest (so a mid-flight admin edit to models/prompts/thresholds truly cannot affect a running job) is the remaining half of Section 8 and is a larger, riskier change that needs live verification to be confident it doesn't change existing job behavior.
- [x] **Workflow draft/publish/rollback lifecycle (this session).** Full clone-to-draft → validate → publish → rollback flow built on the `workflow_versions.status` column (already existed, unused for this before). `WorkflowController` rewritten (`apps/api/src/admin/admin-config.controllers.ts`): `POST /draft` clones production's nodes+configs, `PUT /versions/:id/order` and `PUT /versions/:id/:nodeKey` now 400 unless the target is a `draft` (this is the actual production-read-only enforcement, and also fixed a latent bug where node lookup wasn't scoped by version at all), `POST /versions/:id/validate` (dependency-graph + required-node checks, shared with publish so they can't disagree), `POST /versions/:id/publish` and `/rollback` (transactional production/archived swap), `DELETE /versions/:id` (discard an unpublished draft — added after live-testing showed the flow needed an undo). Frontend (`workflow-studio.tsx`) got a version-switcher strip, contextual Create/Publish/Discard/Rollback buttons, and the node inspector + reorder controls are now actually disabled (`<fieldset disabled>`) outside a draft. **Live-verified twice** — once via `curl` through the full lifecycle including every rejection path, and once through the actual running browser UI (which caught a real bug the curl pass missed: `apiFetch` sent `Content-Type: application/json` on bodyless requests, which Fastify rejects outright — fixed centrally in the shared helper). Full detail in session notes above. **Phase 1 is now fully complete.**
- [x] **Idempotency / worker restart audit (this session, partially).** Traced the full crash-recovery path in `apps/worker/src/processor.ts`. Finding: every *normal* exception is already correctly handled by an existing `try/finally` — cost is persisted, the job reaches a terminal/manual_review state, and the Redis lock is released. The only real gap is a **hard process crash** (OOM kill, container restart — exactly this session's own Docker/memory incidents), where that `finally` never runs: the attempt row stays at `status='running'` forever, silently inflating `getPreviousAttempts`'s count and never surfacing as failed to an operator. Fixed: `markStaleRunningAttemptsFailed` (`apps/worker/src/db.ts`) marks any attempt still `running` past the lock's own 15-minute TTL as failed, called right after lock acquisition (a successfully-acquired lock proves no one else is currently working the job, so a stale "running" row is provably orphaned, not a race). **Live-verified with a real, zero-cost test**: inserted a synthetic 20-minute-old `running` attempt directly via SQL, ran the function against the live database, confirmed it was correctly marked `failed`; inserted a fresh `running` attempt and confirmed it was correctly left untouched. Both test rows cleaned up afterward.
  - **Scoping note — what this does NOT cover:** provider-request-ID deduplication (Section 66's literal "duplicate paid generation" concern) is not implemented — if a crash happens *after* a provider call succeeds but *before* its cost event/candidate commit to the DB, that specific paid image is simply lost (not double-charged, since the new attempt makes fresh calls, but the old one's spend is real and already correctly counted by the P0-3 ledger fix). True idempotency (skip re-generating if a provider request ID is already known-complete) needs the provider adapter to expose stable request IDs before a crash-safe retry could actually resume rather than restart — a larger, provider-facing change, not attempted this session. Also not attempted: tuning BullMQ's own `attempts`/backoff (currently the default `attempts: 1`, meaning BullMQ itself won't automatically redeliver a job its own stall-detection marks failed) — this needs live-tested tuning to avoid retry storms and wasn't safe to guess at blind.

### Phase 2 — Identity/fidelity foundation

- [x] **`character_identity_references` table + full identity pack (this session).** New table (migration `0007_dry_maria_hill.sql`, front/¾/full-body roles, unique per character+role). Provider contract changed from a single optional `characterReference` to `characterReferences: ImageInput[]` (`packages/providers/src/types.ts`, `openrouter.ts`) so multiple identity photos actually reach the generator in one request — this was the one genuinely load-bearing change, not just plumbing. Worker's `resolveCharacterReferences` (renamed from `resolveCharacterReference`) now sends every identity-pack photo when present, falling back to the single `previewAssetId` otherwise, same priority as before. Admin CRUD (`GET/PUT/DELETE /admin/characters/:id/identity-references/:role`) with the same `assertUsableAsset` validation gate as the single-photo version, upsert-on-role so re-attaching replaces rather than duplicates. **Live-verified 3 ways**: full CRUD cycle via `curl` (attach, list, invalid-role rejection, upsert-replaces-not-duplicates, delete); the worker's exact resolution query traced in a temporary script confirming both photos resolve through the real DB→asset→MinIO chain to actual bytes; `pnpm test` at the repo root, all 10 tasks passing including the updated provider test (now asserts 3 `input_references` from 2 garment + 2 character photos). All test data cleaned up afterward. Full detail in session notes above.
- [x] **Catalog character reference photo actually used (this session, Section 10/37).** Audit found `characters.previewAssetId` was a real schema column nothing ever wrote to — every seeded catalog character (Priya, Aarav, Ishita, Rohan, Meera, Kabir) has always been text-description-only, while a customer's own uploaded character photo genuinely was used as a generation reference. Both `characterRef` construction sites in `apps/worker/src/nodes.ts` (`runImageGenerate`, `retryFailedAngle`) checked only `ctx.job.characterAssetId`. Fixed by extracting a shared `resolveCharacterReference(ctx, deps)` helper that falls back to `ctx.character?.previewAssetId` when no customer upload exists, replacing both duplicated blocks. Also found the fix would have been *inert*: `AdminCharactersController`'s create/update endpoints (`apps/api/src/admin/admin-data.controllers.ts`) never accepted `previewAssetId`, so there was no way to attach a photo to a catalog character even though the generic `/uploads` flow already supports `kind: "character_reference"`. Added `previewAssetId` to both endpoint schemas with an `assertUsableAsset` guard (404 on missing asset, 400 on one that hasn't passed upload validation). **Live-verified, zero cost:** confirmed via direct SQL that all catalog characters currently have `previewAssetId = NULL` (bug was real); round-tripped the new admin endpoint against the running API (bad asset id → 404, real usable asset → 200); followed the DB row to its actual MinIO object via `mc stat` and confirmed the file genuinely exists at the exact bucket/key `resolveCharacterReference` would fetch. Test attachment reverted afterward. `apps/worker` + `apps/api` typecheck clean; core suite still 67/67.
  - **Scoping note:** no admin UI exists yet to drive the new endpoint — an operator has to call `/uploads` then `/admin/characters/:id` directly until a form is built in the Workflow Studio. This is still the single-photo version, not the full front/¾/full-body identity pack above. End-to-end proof that this improves visual consistency needs a live generation against a character with a real portrait attached — deferred with everything else pending the OpenRouter key limit.
- [x] **Detail-reference role tagging (this session, Section 15–16).** The API already accepted up to 5 detail asset IDs, but every detail photo was undifferentiated `role: "detail"` with no sub-tag, *and* the customer UI had zero detail-upload capability at all — this backend capacity was completely unreachable. New `detail_kind` enum + nullable `job_inputs.detail_kind` column (migration `0008_spooky_trauma.sql`); API's `detailAssetIds: string[]` → `detailReferences: Array<{assetId, kind}>`; `generator.tsx` now has an actual upload UI (up to 5 photos, per-photo kind dropdown, remove control) reusing the existing presign flow. **Explicitly not built**: nothing in vision analysis or prompt compilation reads the tag yet — the worker still fetches all detail photos as one undifferentiated list. Using it for a real per-detail cross-check against the Garment Truth Sheet is Section 18's fuller vision-model-dependent piece, correctly still deferred. Live-verified: Zod schema checked in isolation, and a real file uploaded through the actual browser UI (presign → PUT → complete, not mocked) with tag-change and remove all confirmed working; test asset cleaned up afterward. Full detail in session notes above.
- [x] **Hard-fail defect codes wired up (this session, Section 29).** Audit found `hardFailDefectCodes` was a genuinely dead feature: the type existed, but all 3 call sites hardcoded `[]`, and the rule engine's own logic had a redundant unreachable branch (`hardFailDefectCodes.length === 0` always short-circuited true, so *any* critical defect already auto-failed — meaning the blocklist as originally written could never actually do anything beyond what already happened for free). Rewrote `evaluateRules` (`packages/core/src/rule-engine.ts`) so the real value of the list is checking **minor** defects too — a defect the reviewer itself classified as minor still hard-fails if its code is on the list, which is the actual point of an admin-configurable override ("this defect type is always unacceptable regardless of what the reviewer thinks"). Added `budget_rules.hard_fail_defect_codes` (migration `0006_aromatic_gamma_corps.sql`), wired all 3 worker call sites to read it, seeded the live DB and `seed.ts` with the directive's own Section 29 code list, and exposed it for admin editing via `GET/PUT /admin/quality-rules`. **Fully verified**: 4 new unit tests (rule logic), and a live, zero-cost, end-to-end check — logged into the running API and confirmed `GET /admin/quality-rules` returns the seeded list correctly. 67/67 core tests pass.
  - **Scoping note:** this is the "any protected detail mismatch hard-fails" mechanism operating on defect *codes* the reviewer already assigns — it does not yet cross-reference against the Garment Truth Sheet's own `protectedDetails` list (Section 18's fuller vision, where the *system* — not just the reviewer's self-reported severity — independently verifies specific extracted attributes were preserved). That semantic cross-check is a larger, vision-analysis-dependent feature and remains open.
- [x] **Priority-aware prompt budgeting (this session).** Found and fixed a real, concrete bug in `packages/core/src/prompt-compiler.ts`: the old implementation assembled `system + facts + skills + repair` into one string and end-sliced at `maxChars` on overflow. Since the repair instruction (Layer D — the actual correction text for a retry) was appended *last*, it was the *first* thing silently dropped on any overflow, directly contradicting the directive's "NEVER DROP: ...retry repair delta." Rewritten to reserve budget for facts + repair first (the mandatory layers) and spend only what's left on skills (Layer B, the lowest-priority/most-decorative layer) — skills are omitted whole, never partially, when the budget is tight. Only in the edge case where facts+repair alone exceed `maxChars` does the compiler fall back to truncation, and it now explicitly flags this via `budget.mandatoryLayerPreserved: false` rather than looking identical to the common "skills got trimmed" case. Added the diagnostic metadata shape the directive asks for (`totalBudget`, `usedBudget`, `includedLayers`, `omittedSkills`, `compressedLayers`, `mandatoryLayerPreserved`), and surfaced it in the `prompt_compile` node's `outputRef` plus a warning log when mandatory content is ever compressed. **Fully unit-tested** (9 tests, up from 5; all existing tests pass unchanged — this was a pure internal rewrite, same external contract): a new test specifically reproduces the old bug's exact scenario (skills would overflow the budget, facts+repair fit comfortably) and proves the repair instruction now survives intact.

### Phase 3 — Anchor-first orchestration hardening

- [x] Anchor-then-fan-out generation order (**already existed, built this session**)
- [x] **Gate fan-out on anchor QA (this session).** `gateOnAnchorReview` in `apps/worker/src/nodes.ts` reviews the anchor immediately after it generates, using the same quality_reviewer model/prompt/pricing the normal `quality_review` step would use, and only proceeds to fan-out if the anchor did not confidently `FAIL`. Verified live: a real job's attempt 1 had a `FAIL`ed anchor and correctly generated **zero** fan-out angles (only 1 candidate persisted, vs. the 3 that would have generated before this fix) — direct, confirmed cost savings. The gate writes the anchor's real `qualityReview`/`decision`, so the later `quality_review` step recognizes it's already reviewed and skips re-billing it (verified via `quality_reviews` table: every candidate across the test job has exactly one `primary` review, never two).
  - **Scoping note:** the gate only stops fan-out on a confident `FAIL`, not `UNCERTAIN` — resolving `UNCERTAIN` may need a second opinion, and looping back into `image_generate` afterward to fan out is a bigger control-flow change than this pass makes. An anchor that comes back `UNCERTAIN` still proceeds to fan-out today.
- [ ] Per-angle repair (see Phase 1 item above — same underlying gap)

### Phase 4 — Provider/model architecture

- [x] **Model capability pre-flight validation (this session).** `model_registry.capabilities` already existed (right shape, admin-editable, seeded) but nothing read it. `packages/core/src/model-capabilities.ts` (`parseModelCapabilities` + `checkModelCapabilities`, 13 tests) now checks reference count/resolution/multi-output support before every `generateImage` call in `apps/worker/src/nodes.ts`, rejecting with a specific reason instead of spending on a request doomed to fail. Directly motivated by this session's own identity-pack work increasing typical reference counts. Live-verified against the real production model row. Full detail in session notes above.
- [ ] FASHN adapter interface (implementation optional / credential-gated)
- [x] **Contract tests for the OpenRouter adapter (this session).** Found a genuinely dangerous gap while starting this: `packages/providers/src/openrouter.accounting.test.ts` already had 4 real, well-written, zero-cost tests, but `package.json`'s `test` script was a no-op `echo` — `pnpm test` at the repo root reported success without running a single assertion. Wired up `vitest.config.ts` + the `vitest` devDependency (same pattern as `@shotlin/core`) so the script actually runs. Then closed the real coverage gap: `openRouterGenerateImage` (the function that spends real money every call, including the seedream-4.5 1K→2K pixel-minimum workaround) had zero tests — added 9 mocked-`fetch` tests covering that workaround, character-reference merging, count clamping, both image-response shapes, and the error paths. All pass against the real implementation unchanged. Live-verified via `pnpm test` at the repo root — 10/10 workspace tasks pass. `@shotlin/database`'s test script is the same no-op stub (lower priority, little pure logic to test there); `@shotlin/api`/`@shotlin/worker` have vitest wired but no test files yet.

### Phase 5 — Admin control plane

- [x] **Cost dashboard breakdowns (this session, Section 48).** `AdminService.costSummary()` already computed the full aggregate breakdown (today/all-time, by model, by provider, 14-day trend, cost per delivered image by resolution, spend on undelivered jobs) via real SQL, exposed at `GET /admin/costs` — but nothing in the frontend ever called it. New `CostSummaryPanel` in `workflow-studio.tsx`, mounted in the Budget & cost tab above the existing per-job history. Also fixed a real gap while wiring it up: `byModel` returned raw UUIDs with no name (every other cost endpoint already resolved names); added the same resolution, handling the nullable-model (deterministic-step) case correctly. Live-verified against real spend data from this session's own test jobs — numbers cross-checked against the per-job table. **Quality dashboard (Section 49) confirmed already built**: Overview tab already renders `topDefects`/`firstPassAcceptance`/`resolutionMix`, verified via live browser check earlier this session — not a gap.
- [ ] Benchmark suite UI (blocked on Phase 8's dataset existing)
- [ ] Character/garment identity pack management screens

### Phase 6 — Customer experience

- [x] Detail-reference role picker in the upload UI — see Phase 2 checklist above (same session item, tracked there in full).
- [x] **Camera-angle picker UI (this session).** `generator.tsx` now shows toggle chips (Front/3/4 Left/3/4 Right/Side Profile/Back) whenever set size > 1, opt-in — leave alone for the server default, or pick specific angles up to the count. Imports `CAMERA_ANGLES`/`resolveAngleSet` directly from `@shotlin/core` rather than duplicating the vocabulary/default-set logic client-side, so the live preview can never drift from what the server actually resolves. A first pass *did* duplicate the logic and live-testing caught the exact drift this was meant to avoid (one non-default pick collapsing the preview instead of top-filling to the requested count) — fixed before it shipped by switching to the shared import. Live-verified in the browser (picker visibility, top-up behavior, cap enforcement, reset). Job creation itself not triggered (live, non-mocked OpenRouter key).
- [x] **"Estimated internal reserve ₹..." checked this session — already resolved, stale checklist entry.** Grepped the entire `apps/web/src` customer-facing tree for `reserve`/`₹`/`cost`/`budget`: no cost or reserve figure appears anywhere outside the admin app (`apps/web/src/app/admin/*`, `workflow-studio.tsx`). The only trace is a code comment in `generator.tsx` — nothing rendered. Whatever earlier note flagged this as still-shown was outdated by the time this session reached it.
- [ ] Structured feedback reasons (Section 60) — currently Good/Needs Improvement only

### Phase 7 — Security/reliability/observability

- [x] **Login/register rate limiting (this session).** `AuthRateLimitGuard` (`apps/api/src/auth/auth-rate-limit.guard.ts`), 20 attempts/IP/15min, `429`+`Retry-After` beyond that. Live-verified against the running dev API (401×20 then 429×2). Per-IP only, not per-account — see session notes above for the full scoping caveat.
- [x] **CSRF/CORS review (this session).** Found already adequately mitigated by `sameSite: "lax"` + no state-changing GET endpoints + a strict (non-wildcard) CORS allowlist — no CSRF token layer needed. Tightened `WEB_URL` validation and removed the dev-only origin from the production CORS allowlist. Full detail in session notes above.
- [x] **Upload hardening (this session).** Found a real bug, not just a gap: the 25MB size check ran after the full object was already downloaded and decoded, not before. Reordered to check the cheap `headObject` size first; added an explicit `limitInputPixels` ceiling to the decoder. Magic-byte validation already existed (detected format vs. declared content-type comparison). Live-verified on the running API. Full detail in session notes above.
- [x] **Security headers (this session).** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, production-only `Strict-Transport-Security` via a small `onSend` hook in `apps/api/src/main.ts` — no new dependency pulled in given the network conditions this session and the API being JSON-only (no HTML to protect with a full CSP). Live-verified on the running API.
- [x] **Presigned URL expiry + IDOR spot-check (this session).** Reviewed and found already reasonable — no change needed. Full detail in session notes above.
- [x] **Admin audit log for mutations (this session).** Was already built and wired to 6 of 8 admin controllers; the 2 missing (`AdminCharactersController`, `AdminEnvironmentsController`) are now wired too. Live-verified. Full detail in session notes above.
- [x] **Structured logging correlation (this session).** `createLogger` already existed but was never wired up anywhere — same class of gap as the admin audit log. Wired into all 3 worker files (18 live call sites), with `jobId`/`attemptId`/`candidateId`/`stepRunId`/`angleKey` as structured fields wherever in scope. Also fixed BullMQ event handlers logging the wrong id for retries. Live-verified. **Phase 7 complete.**

### Phase 8 — Benchmark + model optimization

- [ ] Cannot be done inside a coding session — requires a curated 100–200+ case dataset with human-labeled ground truth, which is a data/product task, not an engineering task. Architecture (Phase 5's benchmark tables/UI) can be built ahead of the dataset existing.

### Phase 9 — Release hardening

- [ ] Full gate checklist from Section 85 — not attempted; most gates depend on Phases 1–7 being substantially complete first.

---

## 4. Definition of Done for Phase 1 (the immediate next unit of work)

Phase 1 is "done" when, in addition to this session's P0-1 fix:
1. `GET` any job's cost reflects `SUM(cost_events)` for that job, not a
   potentially-stale cached column.
2. A `RetryPlan` record exists per failed attempt with defect codes,
   protected attributes, and repair instructions, queryable independently of
   worker in-memory state.
3. A worker process kill mid-attempt, on restart, does not create a second
   provider bill for work already paid for.
4. A non-anchor angle that fails QA is retried individually (not withheld
   permanently) at least once within budget, without regenerating the
   already-passed angles.
5. `pnpm build`, `pnpm -F @shotlin/core test`, `pnpm -F @shotlin/worker
   test` (once worker tests exist) all pass.

---

## 5. Honest assessment

The codebase is a real, working MVP with a genuine multi-node workflow
engine, real cost tracking per provider call, and (as of this session) a
correctly-enforced no-unreviewed-candidate-ships invariant. It is **not**
close to the full directive's definition of a production-hardened,
benchmark-validated, execution-manifested, capability-registry-driven
system — that gap is large and mostly requires product/data decisions
(benchmark dataset curation, security posture sign-off, provider
diversification budget) as much as engineering time.

Two of the three items originally listed here (anchor QA gate, cost ledger
as source of truth) are now done and verified live against real jobs. The
highest-leverage remaining items, in order:
1. Persistent structured `RetryPlan` + true per-angle retry (Phase 1) — a
   `FAIL`ed non-anchor angle is currently withheld, not regenerated; this is
   the next correctness/cost gap in the same family as the two fixes above.
2. Execution manifest (Phase 1) — unblocks safe workflow editing (Phase 5)
   without risking already-running jobs.
3. Idempotency audit for worker restart safety (Section 66) — confirm a
   process crash mid-attempt cannot double-bill; not yet reviewed.
