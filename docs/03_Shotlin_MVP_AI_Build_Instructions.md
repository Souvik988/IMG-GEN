# SHOTLIN MVP - AI CODING BUILD INSTRUCTIONS

## Mission

Build the Shotlin MVP as a zero-prompt garment-to-character image-generation system with a configurable admin workflow, versioned prompts and Skills, automatic quality review, retry logic, and exact cost tracking.

Do not expand scope beyond the requirements in this document unless a missing implementation detail blocks the core MVP.

## Product Goal

A customer uploads a garment/design reference, selects a character, age/height appearance, pose, environment, resolution, aspect ratio, and output count, then clicks Generate.

The backend automatically:

1. validates inputs
2. analyzes garment details
3. selects relevant Skills
4. compiles the generation prompt
5. generates image(s)
6. independently reviews quality
7. applies deterministic pass/fail rules
8. retries when needed within budget
9. stores and displays the approved result
10. records exact AI cost

## Non-Negotiable Architecture Rules

1. Customer never needs to write a prompt.
2. All AI model IDs are configuration, never hard-coded into UI business logic.
3. All prompts are versioned data.
4. All Skills are versioned data.
5. The backend rule engine owns PASS / FAIL.
6. Every provider call records cost and usage.
7. Every job stores the exact workflow, prompt, Skill, and model versions used.
8. Original uploaded references are immutable.
9. Provider secrets never reach the browser.
10. PostgreSQL is the system of record.
11. Binary assets are stored in object storage.
12. Long-running generation runs in workers, not inside the web request lifecycle.
13. Retry count and cost limits are enforced centrally.
14. Do not build Canvas Studio, Supercomputer, video, or campaign features in this MVP.

## Recommended Technology

- Frontend: Next.js + TypeScript
- API: NestJS/Fastify or equivalent structured TypeScript API
- Database: self-managed PostgreSQL
- Optional vector capability: PostgreSQL vector extension
- Queue/cache: Redis
- Object storage: S3-compatible storage abstraction
- Worker: Node.js/TypeScript job worker
- Image metadata/validation: server-side deterministic image utilities

The architecture must keep provider adapters separate from business logic.

## Initial AI Configuration

Logical role: vision_analyzer
- default: qwen/qwen3.8-27b through OpenRouter
- provider: configurable OpenRouter adapter

Logical role: prompt_compiler
- default: deterministic template first
- optional model: same Qwen vision model when adaptive wording is needed

Logical role: image_generator
- default: Seedream 4.5 through OpenRouter's dedicated image API
- provider: OpenRouter adapter

Logical role: quality_reviewer
- default: qwen/qwen3.8-27b through OpenRouter
- provider: configurable OpenRouter adapter

Logical role: second_reviewer
- default: qwen/qwen3.8-27b through OpenRouter
- call only for uncertain cases

## Build Order

### 1. Foundation

Create:

- repository structure
- environment configuration
- database connection
- authentication
- object-storage abstraction
- Redis / queue connection
- provider secret handling

Deliverable condition:

- app boots
- admin and customer roles work
- API health checks pass

### 2. Database Schema

Implement tables for:

- users
- assets
- characters
- environment_presets
- workflows
- workflow_versions
- workflow_nodes
- model_registry
- model_price_versions
- prompts
- prompt_versions
- skills
- skill_versions
- jobs
- job_inputs
- job_attempts
- job_step_runs
- generation_candidates
- quality_reviews
- defects
- job_outputs
- cost_events
- budget_rules
- feedback

Add migrations and indexes.

Deliverable condition:

- fresh database can be created from migrations
- all core relationships are enforced

### 3. Admin Model Registry

Build admin screen and APIs to:

- add model
- edit provider and model ID
- assign logical role
- enable/disable
- set token prices
- set image price by resolution
- set capabilities

Deliverable condition:

- changing model config changes future jobs without frontend code changes

### 4. Prompt Library

Build:

- prompt list
- prompt editor
- version creation
- Draft / Production / Archived state
- variable validation
- publish action
- rollback to previous production version

Seed prompts:

- garment analysis
- image generation fixed instructions
- quality review
- repair
- second review

### 5. Skill Library

Build:

- Skill list
- Skill editor
- versioning
- activation rules
- priority
- enabled status
- production status

Seed Skills:

- Generic Garment Fidelity
- Saree Fidelity
- Kurta Fidelity
- Dress Fidelity
- Character Preservation
- Fine Textile Detail
- Outdoor Photography
- Indoor Photography
- Studio Photography
- Photorealism
- Garment Repair
- Anatomy / Character Repair

### 6. Workflow Configuration

Create a fixed visual workflow for MVP:

```text
Input
 -> Input Check
 -> Vision
 -> Skill Selector
 -> Prompt Compiler
 -> Image Generator
 -> QA
 -> Rule Engine
 -> Retry / Second Review
 -> Finalize
```

For each configurable node, allow:

- active status
- model
- prompt version
- timeout
- threshold where applicable
- retry behavior
- budget rule

Do not build arbitrary user-created node graphs yet.

### 7. Customer Generate Page

Implement:

- garment upload
- optional detail uploads
- character card selection
- character upload
- age appearance
- height appearance
- pose
- environment card selection
- 1K / 2K / 4K
- aspect ratio
- output count
- generate button

No text prompt field.

### 8. Input Quality Gate

Implement deterministic validation:

- MIME/file type
- dimensions
- size
- corrupted image detection
- obvious blur threshold

Add optional AI usability check only when deterministic checks cannot decide.

### 9. Vision Analyzer Adapter

Implement adapter contract:

```text
analyzeGarment(references, promptVersion, modelConfig)
 -> GarmentTruthSheet
```

GarmentTruthSheet must validate against a strict schema.

Persist raw provider usage and normalized result.

### 10. Skill Selector

Implement deterministic selection rules.

Example:

- detected saree -> Saree Fidelity
- detected kurta -> Kurta Fidelity
- outdoor preset -> Outdoor Photography
- character supplied -> Character Preservation

Persist selected Skill version IDs on the job attempt.

### 11. Prompt Compiler

Build prompt from:

- production system prompt
- structured garment facts
- protected details
- selected Skill instructions
- character selections
- environment preset
- requested output settings

Never concatenate unlimited content. Enforce prompt size limits and deterministic order.

### 12. Image Generator Adapter

Implement logical contract:

```text
generateImage(references, compiledPrompt, resolution, aspectRatio, count, modelConfig)
 -> candidates[]
```

Persist:

- provider request metadata
- model
- resolution
- result assets
- usage
- cost

### 13. Quality Reviewer Adapter

Implement:

```text
reviewCandidate(originalReferences, candidate, truthSheet, character, userSelections)
 -> QualityReview
```

QualityReview strict schema:

- garment fidelity dimensions
- character score
- anatomy score
- realism score
- environment score
- technical score
- critical defects
- minor defects
- repair instruction
- confidence

### 14. Rule Engine

Implement deterministic code, not prompt logic.

Example configurable rules:

- garment >= 94
- character >= 90
- realism >= 92
- hard defects = none

Output:

- PASS
- FAIL
- UNCERTAIN

### 15. Retry Engine

On FAIL:

- create targeted repair context from QA defects
- preserve original garment references
- reuse Garment Truth Sheet
- reuse correct settings
- generate another candidate
- re-run QA

Before retry:

- estimate next attempt cost
- compare with budget ceiling
- stop if budget policy prevents another attempt

### 16. Second Reviewer

Call only when rule engine returns UNCERTAIN.

Store both reviewer outputs and final rule-engine decision.

### 17. Finalization

On PASS:

- mark selected candidate final
- create web preview
- preserve master
- generate signed download link
- write final cost rollup
- mark job READY

### 18. Cost Engine

Every provider adapter must return normalized usage.

Calculate:

- node cost
- attempt cost
- job cost
- successful image cost

Admin-configured USD/INR exchange rate is applied during reporting. Preserve original USD cost and FX rate used.

Default planning reserve:

- INR 20 per successful 2K image

Dashboard must show actual measured cost separately from the planning reserve.

### 19. Admin Budget Screen

Implement:

- current average cost per successful image
- average by 1K / 2K / 4K
- daily spend
- failed spend
- retry spend
- spend by model
- spend by provider
- configured job ceiling
- warning threshold

### 20. Job Inspector

Admin must be able to open any job and inspect:

- customer inputs
- garment truth sheet
- selected Skills
- compiled prompt
- all candidates
- QA result for every candidate
- defect list
- model usage
- cost per step
- final pass/fail reason

This screen is critical for MVP iteration.

## UI Screens Required

Customer:

1. Login
2. Generate
3. Generation Status
4. Result
5. Project History

Admin:

1. Overview
2. Workflow
3. Models
4. Prompts
5. Skills
6. Quality Rules
7. Budget & Cost
8. Jobs
9. Characters
10. Environments
11. Settings

## Seed Workflow Configuration

### Vision node

- role: vision_analyzer
- model: qwen/qwen3.8-27b through OpenRouter
- prompt: Garment Analysis v1
- output: strict GarmentTruthSheet JSON

### Skill selector

- mode: deterministic
- max Skills per job: configurable

### Prompt compiler

- mode: template-first
- optional adaptive LLM: vision_analyzer role

### Image generation

- role: image_generator
- model: bytedance-seed/seedream-4.5 through OpenRouter
- default resolution: 2K
- default count: 1

### QA

- role: quality_reviewer
- model: qwen/qwen3.8-27b through OpenRouter

### Uncertain review

- role: second_reviewer
- model: qwen/qwen3.8-27b through OpenRouter
- enabled only for uncertainty band

### Retry

- maximum attempts: configurable
- default suggested maximum: 2 or 3 total generation attempts depending on budget policy

## Default Cost Configuration

Use editable model-price records.

Planning reference:

- Seedream 4.5 through OpenRouter: USD 0.04 per output image at the current seeded catalog rate
- Qwen 3.8 27B through OpenRouter: USD 0.45/M input, USD 3.20/M output at the current seeded catalog rate

Never assume these prices are permanent. Admin can update them and each cost event stores the price version used.

## Quality Benchmark Before Claims

Create a benchmark set before claiming 99% accuracy.

Recommended categories:

- simple saree
- heavily patterned saree
- embroidered saree
- simple kurta
- embroidered kurta
- printed dress
- complex dress
- drawing / sketch input
- difficult low-contrast garment
- garment with logo/text

For each case, keep:

- reference files
- expected protected details
- human pass/fail label

Run every workflow or prompt change against the same benchmark.

Dashboard should report:

- sample count
- garment fidelity pass rate
- false-pass count
- false-fail count
- average cost
- average attempts

## Definition of Done

The MVP is complete only when a fresh user can:

1. upload a garment without writing a prompt
2. choose a character and visual options
3. generate a result
4. receive only an automatically approved image
5. download it

And an admin can:

1. change models
2. edit/version prompts
3. edit/version Skills
4. change QA thresholds
5. change retry limits
6. change cost ceilings
7. inspect every workflow step
8. see exact cost per successful image

## Coding Agent Instruction

Before writing feature code:

1. Read all three Shotlin MVP documents completely.
2. Produce a repository architecture and implementation checklist mapped to the requirements.
3. Create database schema/migrations before workflow business logic.
4. Create provider adapter interfaces before provider-specific implementations.
5. Build one vertical end-to-end generation path before polishing analytics screens.
6. Add strict runtime schemas to every model output.
7. Add tests for the rule engine and cost engine before enabling automatic delivery.
8. Do not introduce features outside MVP scope.
9. Keep all important behavior configurable from Admin.
10. At completion, verify every Definition of Done item and every Required Acceptance Test.
