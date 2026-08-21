# SHOTLIN MVP - PRODUCT ARCHITECTURE PLAN

## 1. Purpose

This MVP proves one core product promise:

> A non-technical user can upload a garment or garment design, select a character and a few visual options, click Generate, and receive a realistic image where the garment design is preserved as faithfully as possible - without writing a prompt.

The MVP deliberately excludes the larger Supercomputer, Canvas Studio, campaign automation, collaboration, and advanced agent systems. The first product must make this single flow reliable, measurable, affordable, and easy to control from an admin dashboard.

## 2. Product Principle

The customer sees a simple form. The complexity stays in the backend.

Customer experience:

1. Upload garment/design reference.
2. Choose character.
3. Choose age, height appearance, and pose.
4. Choose environment.
5. Choose resolution, aspect ratio, and number of outputs.
6. Click Generate.
7. Receive an automatically reviewed result.
8. Download approved image.

The customer never needs to understand prompts, models, skills, providers, thresholds, retries, or generation cost.

## 3. Supported Garment Inputs

The first MVP accepts:

- Saree
- Kurta / kurti
- Dress
- Shirt / top
- Menswear garment
- Other garment photograph
- Hand-drawn garment design
- Digital garment sketch
- Optional close-up reference images for borders, embroidery, patterns, sleeves, neckline, pallu, logos, or labels

The system should encourage multiple reference images for complicated garments because additional detail views can improve fidelity.

## 4. Customer Website

### 4.1 Generate Page

The Generate page is the main MVP screen.

#### Section A - Garment

Controls:

- Upload main garment image
- Add optional detail references
- Input type: Photo / Drawing / Design Reference

System behavior:

- Show upload preview
- Detect obviously unusable files before generation
- Preserve original file unchanged

#### Section B - Character

Controls:

- Choose saved character from visual cards
- Upload own character image
- Choose gender presentation
- Age appearance
- Approximate height appearance
- Body build, if enabled by admin
- Pose: Auto / Standing / Walking / Close-up

Age and height are visual appearance targets, not real-world biometric measurements.

#### Section C - Environment

Simple buttons:

- Outdoor Natural
- Outdoor Premium
- Indoor Premium
- Studio Commercial
- Festive
- Cinematic Fashion
- Clean / Minimal

The user sees only names and preview thumbnails. Each button maps to an admin-controlled environment skill and prompt preset.

#### Section D - Output

Controls:

- Resolution: 1K / 2K / 4K
- Aspect ratio: Portrait / Square / Landscape / custom presets
- Output count: 1 / 2 / 4

For MVP business planning, 2K is the default recommended output.

#### Section E - Generate

Before submission, show a compact summary:

- garment reference
- character
- age / height appearance
- environment
- resolution
- aspect ratio
- output count

The button text is simply: Generate.

### 4.2 Generation Status

The user should see understandable states, not backend terminology:

- Checking references
- Preparing garment details
- Creating image
- Checking quality
- Improving result, if needed
- Finalizing
- Ready

Never expose failed internal candidates to the user unless an admin enables a debugging mode.

### 4.3 Result Page

Display:

- Large preview
- Requested resolution
- Character used
- Environment used
- Download PNG
- Download JPG
- Generate another
- Optional simple feedback: Good / Needs Improvement

The web preview should be optimized for fast viewing. The downloadable master should remain at the requested generation resolution.

### 4.4 Project History

Minimal history page:

- Thumbnail
- Date
- Garment type
- Character
- Resolution
- Status
- Final cost to Shotlin
- Download

This is useful for both customer convenience and MVP cost tracking.

## 5. Admin Dashboard

The admin dashboard is the control center of the MVP.

Primary navigation:

1. Overview
2. Workflow
3. Models
4. Prompts
5. Skills
6. Quality Rules
7. Budget & Cost
8. Jobs
9. Characters
10. Environment Presets
11. Settings

### 5.1 Overview

Show:

- Jobs today
- Successful images
- Failed jobs
- First-pass acceptance rate
- Average attempts per successful image
- Average AI cost per successful image
- Cost today
- 1K / 2K / 4K distribution
- Garment categories generated
- Most common QA failures

The dashboard should always distinguish "generation attempts" from "successful delivered images".

### 5.2 Workflow

The MVP workflow is visually represented as connected nodes:

```text
Input
  -> Input Quality Check
  -> Garment Vision Analysis
  -> Skill Selection
  -> Prompt Compilation
  -> Image Generation
  -> Quality Review
  -> Decision
       -> Pass -> Finalize -> Deliver
       -> Fail -> Repair Instruction -> Retry
       -> Uncertain -> Second Review -> Decision
```

Each node is configurable.

Admin can:

- enable / disable node
- choose model
- choose prompt version
- choose skill set
- set threshold
- set retry behavior
- set cost ceiling
- test node
- view recent runs

For the first MVP, the visual workflow can be fixed in structure while still allowing configuration. Drag-and-drop workflow restructuring can come later; the important MVP capability is editable node configuration.

### 5.3 Models

Model registry fields:

- Friendly name
- Provider
- Model ID
- Role: Vision / Generation / QA / Second Review
- Enabled
- Input price
- Output price
- Fixed image output cost by resolution, where applicable
- Max image references
- Supports 1K / 2K / 4K
- Notes
- Last tested date
- Success metrics

Recommended initial stack:

- Garment vision + prompt intelligence: qwen/qwen3.8-27b through OpenRouter
- Image generation: Seedream 4.5 through OpenRouter's dedicated image API
- Quality reviewer: qwen/qwen3.8-27b through OpenRouter
- Optional uncertain-case reviewer: qwen/qwen3.8-27b through OpenRouter

Every model selection must be editable so a future model can replace the current one without redesigning the customer website.

### 5.4 Prompts

Prompt categories:

1. Input quality prompt
2. Garment vision system prompt
3. Prompt compiler system prompt
4. Image generation fixed system instructions
5. Quality review prompt
6. Repair prompt
7. Second-review prompt

Each prompt has:

- Name
- Version
- Status: Draft / Test / Production / Archived
- Prompt text
- Variables used
- Linked workflow nodes
- Notes
- Test result
- Created / updated metadata

Publishing a prompt creates a new immutable production version. Existing historical jobs continue to point to the version that produced them.

### 5.5 Skills

A Skill is a small reusable instruction module for a specific job.

Initial Skills:

- Generic Garment Fidelity
- Saree Fidelity
- Kurta Fidelity
- Dress Fidelity
- Character Preservation
- Photorealism
- Outdoor Photography
- Indoor Photography
- Studio Photography
- Fine Textile Detail
- Garment Repair
- Anatomy / Character Repair

Each Skill contains:

- Name
- Purpose
- Instruction text
- Applicable garment types
- Applicable environments
- Priority
- Version
- Enabled status
- Quality metrics

The Skill Selector loads only relevant Skills for the current job. A saree outdoor job does not load kurta or indoor rules.

### 5.6 Quality Rules

Admin controls:

- Garment fidelity minimum
- Character identity minimum
- Photorealism minimum
- Anatomy minimum
- Technical image quality minimum
- Hard-fail defects
- Uncertain range
- Max retries
- Second-review policy
- Human-review policy, if enabled

Example default policy:

- Garment fidelity >= 94
- Character identity >= 90
- Photorealism >= 92
- Critical garment defects = 0
- Major anatomy defects = 0

The AI reviewer produces observations and scores. The backend rule engine makes the final PASS / FAIL decision.

### 5.7 Budget & Cost

This screen is mandatory for the MVP.

Show:

- Cost per workflow node
- Cost per attempt
- Cost per successful image
- Average retries
- Average cost by resolution
- Daily cost
- Monthly cost
- Cost by model
- Cost by provider
- Cost by garment category
- Failed-generation cost

Admin settings:

- Planning budget per successful 1K image
- Planning budget per successful 2K image
- Planning budget per successful 4K image
- Maximum cost per job
- Maximum retry count
- Warning threshold
- Hard stop threshold
- USD to INR conversion setting
- Optional markup target for future pricing

For the current MVP, use INR 20 as the planning reserve for one successfully delivered 2K image. This is intentionally higher than the expected first-pass API cost so retries and uncertainty are covered.

### 5.8 Jobs

Each job displays:

- Job ID
- User
- Garment references
- Character
- User selections
- Workflow version
- Prompt versions
- Skill versions
- Model versions
- Every attempt
- Cost of every node
- QA scores
- Detected defects
- Retry reason
- Final decision
- Final downloadable asset

This page is essential for diagnosing why the MVP succeeds or fails.

## 6. MVP Success Metrics

The system should measure:

- First-pass acceptance rate
- Final acceptance rate
- Average attempts per successful image
- Average cost per successful 2K image
- Garment fidelity pass rate
- Character consistency pass rate
- Photorealism pass rate
- Human-review rate, if used
- User positive-feedback rate
- Failure rate by garment category

Do not claim 99% accuracy until a defined benchmark demonstrates it. The product goal can be 99%, but the dashboard must show measured results from real tests.

## 7. What Is Explicitly Out of Scope

Not part of this MVP:

- Full Creative Supercomputer
- Multi-agent campaign planning
- Canva / Photoshop-style editor
- Layer-based AI editing
- Video generation
- Campaign batch generation
- Advanced collaboration
- Full drag-and-drop workflow authoring
- Daily autonomous optimization agent
- Enterprise SSO
- Mobile application

The MVP succeeds when this one zero-prompt garment generation flow works reliably, measurably, and economically.
