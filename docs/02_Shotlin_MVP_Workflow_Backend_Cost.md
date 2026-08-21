# SHOTLIN MVP - WORKFLOW, BACKEND, DATA AND COST PLAN

## 1. End-to-End Workflow

```text
CUSTOMER WEBSITE
   |
   |-- Upload garment / design references
   |-- Choose character
   |-- Choose age / height / pose
   |-- Choose environment
   |-- Choose resolution / aspect ratio / count
   |
   v
CREATE JOB
   |
   v
INPUT QUALITY CHECK
   |-- Poor input -> Ask user for a better reference
   |
   v
GARMENT VISION ANALYSIS
   |-- Qwen 3.8 27B through OpenRouter
   |-- Create structured Garment Truth Sheet
   |-- Identify protected garment details
   |
   v
SKILL SELECTION
   |-- Generic garment fidelity
   |-- Specific garment skill
   |-- Character preservation
   |-- Environment skill
   |-- Resolution / photorealism skill
   |
   v
PROMPT COMPILATION
   |-- Combine facts + selections + relevant skills
   |-- Produce compact Generation Specification
   |
   v
IMAGE GENERATION
   |-- Seedream 4.5 through OpenRouter image API
   |-- Send garment refs + character ref + prompt
   |
   v
QUALITY REVIEW
   |-- Qwen 3.8 27B through OpenRouter
   |-- Compare original garment and generated result
   |-- Score fidelity / character / realism / anatomy
   |
   v
SHOTLIN RULE ENGINE
   |-- PASS -> Finalize and deliver
   |-- FAIL -> Build repair instruction -> Retry
   |-- UNCERTAIN -> Qwen 3.8 27B second opinion -> Decision
```

## 2. Core Backend Services

### 2.1 Web Application

Responsibilities:

- customer generation UI
- project history
- result preview and download
- admin dashboard
- authentication and authorization UI

Suggested implementation:

- Next.js + TypeScript
- responsive desktop and mobile web experience

### 2.2 API Service

Responsibilities:

- validate requests
- create jobs
- load workflow configuration
- issue upload URLs
- expose job status
- expose admin configuration
- calculate cost summaries
- protect provider credentials

Suggested implementation:

- Node.js service using NestJS with Fastify, or an equivalent structured TypeScript API framework

### 2.3 Workflow Worker

Responsibilities:

- execute every workflow step
- call vision model
- select skills
- compile prompts
- call image model
- call quality reviewer
- apply retry logic
- write cost events
- finalize output

The worker must be separate from the web request so generation can continue even if the customer closes the browser.

### 2.4 Job Queue

Responsibilities:

- queue generation jobs
- prevent duplicate processing
- retry temporary provider failures
- control concurrency
- support priority later

MVP can use Redis-backed jobs or another reliable queue implementation.

### 2.5 PostgreSQL

Use one self-managed PostgreSQL database as the source of truth.

Stores:

- users
- characters
- environment presets
- jobs
- attempts
- workflow configurations
- workflow versions
- model registry
- prompt versions
- skills
- skill versions
- quality scores
- defects
- cost events
- budgets
- feedback
- benchmark results

### 2.6 Vector Memory

For the MVP, vector search is optional but the schema should support it.

Use PostgreSQL vector support inside the same database for:

- finding relevant Skills
- retrieving approved garment examples
- retrieving similar past failures during testing

Do not make vector retrieval mandatory for the main generation path until it demonstrates better quality in benchmark tests.

### 2.7 Object Storage

Store binary assets outside PostgreSQL:

- garment uploads
- character images
- generated candidates
- final images
- web previews

Use an S3-compatible object storage layer that can be self-hosted or replaced without changing application logic.

Never store provider API keys in object storage or frontend code.

## 3. Database Structure

### Core Identity

- users
- user_sessions
- admin_roles

### Customer Assets

- assets
- garment_references
- characters
- environment_presets

### Workflow

- workflows
- workflow_versions
- workflow_nodes
- workflow_node_configs

### AI Configuration

- model_registry
- model_price_versions
- prompts
- prompt_versions
- skills
- skill_versions
- skill_rules

### Jobs

- jobs
- job_inputs
- job_attempts
- job_step_runs
- generation_candidates
- quality_reviews
- quality_dimensions
- defects
- job_outputs

### Cost & Usage

- usage_events
- cost_events
- budget_rules
- daily_cost_rollups
- model_cost_rollups

### Improvement & Evaluation

- benchmark_cases
- benchmark_runs
- feedback
- workflow_experiments

## 4. Job State Machine

```text
CREATED
  -> VALIDATING
  -> ANALYZING
  -> COMPILING
  -> GENERATING
  -> REVIEWING
  -> RETRYING (optional loop)
  -> FINALIZING
  -> READY
```

Terminal alternatives:

- INPUT_REJECTED
- FAILED
- BUDGET_STOPPED
- MANUAL_REVIEW, if enabled
- CANCELLED

Every state transition is recorded.

## 5. Detailed Workflow Nodes

### Node 1 - Input Quality Check

Inputs:

- garment reference(s)
- optional character reference

Checks:

- supported file format
- file size
- image dimensions
- blur / severe compression
- garment visibility
- enough information to proceed

Output:

- usable: true / false
- reason if false
- recommended additional reference if needed

This node should be cheap. Use deterministic checks first; only call a model if the input is ambiguous.

### Node 2 - Garment Vision Analysis

Default model:

- qwen/qwen3.8-27b through OpenRouter

Inputs:

- garment references
- garment-analysis system prompt

Structured output:

- garment type
- colors
- material appearance
- border
- pattern
- embroidery
- neckline
- sleeves
- length / silhouette
- pallu / drape information
- special details
- protected details
- uncertain details
- confidence

Store this output once in the job. Do not repeatedly re-analyze the same garment for every retry unless the analysis itself is identified as wrong.

### Node 3 - Skill Selector

Inputs:

- garment truth sheet
- user selections

Rules examples:

- saree -> Saree Fidelity Skill
- kurta -> Kurta Fidelity Skill
- outdoor -> Outdoor Photography Skill
- any character reference -> Character Preservation Skill
- complicated textile -> Fine Textile Detail Skill

Outputs:

- ordered skill version IDs

Skill selection should initially be deterministic rules. This is cheaper and easier to debug than an agent choosing Skills freely.

### Node 4 - Prompt Compiler

Inputs:

- fixed image-generation system instructions
- garment truth sheet
- protected details
- selected Skills
- character profile
- age / height / pose
- environment preset
- resolution
- aspect ratio

Output:

- compact structured Generation Specification
- final model-ready prompt

The compiler can initially use the same Qwen model or deterministic templates. Prefer templates when possible. Use an LLM only where wording needs reasoning or adaptation.

### Node 5 - Image Generation

Default model:

- bytedance-seed/seedream-4.5 through OpenRouter's dedicated image API

Inputs:

- main garment reference
- optional detail references
- character reference
- compiled prompt
- resolution
- aspect ratio

Outputs:

- generated image(s)
- provider usage metadata
- model version
- cost event

For 2K, current Google standard image output pricing is USD 0.101 per generated image, before small input-token charges.

### Node 6 - Quality Review

Default model:

- qwen/qwen3.8-27b through OpenRouter

Inputs:

- original garment references
- generated image
- garment truth sheet
- character reference
- user selections

Outputs:

- garment color fidelity score
- pattern fidelity score
- border / embroidery fidelity score
- garment structure fidelity score
- character identity score
- anatomy score
- photorealism score
- environment score
- technical quality score
- critical defects
- minor defects
- concise repair instruction
- reviewer confidence

The quality model recommends; it does not decide final delivery.

### Node 7 - Rule Engine

Example:

PASS if:

- garment fidelity >= configured threshold
- character identity >= configured threshold
- photorealism >= configured threshold
- no hard-fail defect

FAIL if:

- critical garment defect exists
- major anatomy defect exists
- score is below fail threshold

UNCERTAIN if:

- score sits inside configured uncertainty band
- reviewer confidence is low
- model reports contradictory findings

### Node 8 - Uncertain Review

Default optional model:

- qwen/qwen3.8-27b through OpenRouter

Call only for uncertain cases.

Purpose:

- independent second opinion
- reduce false pass / false fail decisions

### Node 9 - Repair & Retry

Inputs:

- previous generation prompt
- QA defects
- original references

Repair instruction principles:

- correct only the identified problem
- preserve approved garment features
- preserve character and environment if already correct
- never use a generic "make it better" prompt

MVP retry policy example:

- Attempt 1: standard generation
- Attempt 2: targeted correction
- Attempt 3: optional stronger correction / fallback model if admin enabled

Admin can set maximum attempts and budget ceiling.

### Node 10 - Finalize

Actions:

- save final master
- create web preview
- record final cost
- update job success metrics
- expose download URLs

## 6. Prompt Architecture

Do not use one giant prompt.

Use four layers:

### Layer A - System Role

Defines non-negotiable model behavior.

Example purpose:

- garment reference is source of truth
- do not creatively redesign protected details
- prioritize photorealism and product fidelity

### Layer B - Skills

Small reusable specialist instructions.

Example:

- Saree Fidelity
- Character Preservation
- Outdoor Photography

### Layer C - Job Facts

Structured facts from the current garment and user selections.

### Layer D - Dynamic Repair

Added only after QA identifies a problem.

This separation reduces contradictory instructions and makes every source of behavior measurable.

## 7. Skills Architecture

A Skill is stored as data, not hard-coded into application code.

Fields:

- skill_id
- name
- category
- version
- instruction
- priority
- activation rules
- enabled
- status
- benchmark score

Example activation:

```text
IF garment.type = saree
THEN load Saree Fidelity Skill

IF environment = outdoor
THEN load Outdoor Photography Skill

IF character.reference exists
THEN load Character Preservation Skill
```

Skill changes are versioned and tested before being marked Production.

## 8. Model Adapter Layer

Every AI call goes through a Shotlin model adapter.

Application code calls logical roles:

- vision_analyzer
- prompt_compiler
- image_generator
- quality_reviewer
- second_reviewer

Admin configuration decides the actual provider/model.

This is how the MVP can replace a model later without changing the customer workflow.

## 9. Budget and Cost Engine

### 9.1 Cost Event

Every provider call writes a cost event containing:

- job ID
- attempt number
- workflow node
- provider
- model
- input tokens
- output tokens
- image count
- resolution
- provider-reported cost, if available
- calculated USD cost
- FX rate
- INR cost
- timestamp

### 9.2 Cost Formula

For text / vision models:

```text
USD Cost =
(input_tokens / 1,000,000 * input_price_per_million)
+
(output_tokens / 1,000,000 * output_price_per_million)
```

For fixed-price image outputs:

```text
Image USD Cost = image_count * image_price_for_resolution
```

Total job cost:

```text
Total Job INR = sum(all provider-call USD costs) * configured USD/INR rate
```

Successful image cost:

```text
Average Cost Per Successful Image =
Total AI Cost / Number of Successfully Delivered Images
```

### 9.3 MVP Model Price Assumptions

Pricing must remain editable in Admin because providers can change rates.

Current planning references:

- Qwen 3.8 27B through OpenRouter: USD 0.45 / 1M input tokens and USD 3.20 / 1M output tokens at the current catalog rates used for seeding.
- Seedream 4.5 through OpenRouter: USD 0.04 per output image at the current catalog rate used for seeding.

### 9.4 Planning Budget

Use:

- INR 20 planning reserve per successfully delivered 2K image

Why reserve above first-pass price:

- retries
- second review
- provider price variation
- input image token charges
- failed generations
- occasional additional reference analysis

This is a business planning number, not a fixed API tariff.

### 9.5 Budget Rules

Default examples:

- Warning when job AI cost reaches INR 15
- Hard stop / admin override when job AI cost reaches INR 20 or configured maximum
- Do not start another retry if estimated next-attempt cost would exceed job ceiling

For premium testing, admin can disable hard stop for benchmark jobs.

## 10. Admin Cost Screen

### Top cards

- Today AI Cost
- Average Cost / Successful 2K Image
- Average Attempts
- Failed Cost
- Budget Variance

### Breakdown table

Columns:

- Model
- Calls
- Successful jobs touched
- Total INR
- Average per call
- Average per successful image

### Job cost trace

Example:

```text
Job 8F31
Vision Analysis         INR 0.16
Image Generation #1    INR 9.67
Quality Review #1      INR 0.10
Image Generation #2    INR 9.67
Quality Review #2      INR 0.10
--------------------------------
Total AI Cost           INR 19.70
Status                  PASS
```

The exact amount should come from provider usage records, not from hard-coded estimates.

## 11. Security Minimums

- Provider API keys exist only on backend
- Signed, expiring asset URLs
- Validate all uploads
- Rate-limit generate endpoint
- Per-user and per-job generation limits
- Admin-only workflow/prompt/model changes
- Audit every production configuration change
- Do not expose internal prompts in customer API responses
- Do not trust model output without schema validation
- Original garment uploads remain unchanged

## 12. Observability

Every job should answer:

- What workflow version ran?
- What model version ran?
- Which prompt and Skills ran?
- How many attempts happened?
- What did each attempt cost?
- Why did QA fail?
- Why was final output accepted?

Without this trace, the team cannot improve the MVP intelligently.

## 13. API Surface

Customer:

- POST /api/uploads
- POST /api/jobs
- GET /api/jobs/:id
- GET /api/jobs/:id/result
- GET /api/projects
- POST /api/jobs/:id/feedback

Admin:

- GET /api/admin/workflow
- PUT /api/admin/workflow/:node
- GET /api/admin/models
- POST /api/admin/models
- PUT /api/admin/models/:id
- GET /api/admin/prompts
- POST /api/admin/prompts
- POST /api/admin/prompts/:id/publish
- GET /api/admin/skills
- POST /api/admin/skills
- POST /api/admin/skills/:id/publish
- GET /api/admin/quality-rules
- PUT /api/admin/quality-rules
- GET /api/admin/costs
- GET /api/admin/jobs

## 14. Required Acceptance Tests

The MVP is not complete until these pass:

1. User can generate without typing a prompt.
2. Bad input can be rejected before expensive generation.
3. Garment Truth Sheet is stored and visible to admin.
4. Admin can change vision model without frontend code change.
5. Admin can change image model without frontend code change.
6. Admin can edit and publish system prompts.
7. Admin can edit and publish Skills.
8. QA automatically returns structured scores.
9. Backend rule engine - not the LLM - makes PASS / FAIL.
10. Failed candidate automatically retries according to policy.
11. Every provider call has a cost event.
12. Dashboard shows cost per successful image.
13. Job stops when configured budget ceiling would be exceeded.
14. Final image can be previewed and downloaded.
15. Every job can be reproduced from stored configuration metadata as far as provider determinism allows.

## 15. Worked 2K Cost Example

For planning only, using an example FX rate of INR 95.78 per USD and current published model rates:

- One Seedream 4.5 output through OpenRouter: USD 0.04 -> about INR 3.83
- One compact Qwen 3.8 garment-analysis call: token-priced through OpenRouter
- One compact Qwen 3.8 QA call: token-priced through OpenRouter

A reasonable first-pass API planning estimate is therefore about INR 5 for one 2K candidate plus review, before retries.

If approximately 20% of jobs require one additional full generation attempt, the average AI cost rises toward roughly INR 12 per successful result. The MVP should nevertheless reserve INR 20 per successful 2K image so it can absorb retries, second reviews, provider variations, and difficult garments without unexpectedly exceeding the business budget.

The dashboard must calculate actual cost from provider usage rather than assuming these example values.

## 16. Pricing Reference Notes

Pricing is changeable and must be stored as versioned Admin configuration.

Reference sources checked for this architecture:

- OpenRouter model catalog: Qwen 3.8 27B is multimodal and supports structured outputs.
- OpenRouter image API: Seedream 4.5 accepts text plus reference images and exposes resolution tiers.
- OpenRouter usage responses: provider-reported usage and cost are stored when returned; configured price versions remain the fallback.

These figures are examples for MVP budgeting, not contractual prices.
