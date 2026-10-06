# Workflow and proposed architecture

This is a design proposal, not an implemented system. Stack, models, and API details remain open.

## 1. Configure a run

Collect app URL, allowed domains, exploration scope, authentication method, intended audience, creative objective, brand assets, formats, variation count, and spend/time limits. Prefer a demo account with synthetic data.

## 2. Explore and capture

A browser worker observes the current screen, chooses an interaction, performs it, and records the resulting state. Maintain a queue of discovered screens and deduplicate repeated states. Capture meaningful states such as onboarding, a core workflow, and its outcome—not every animation frame.

Each capture records an ID, URL, timestamp, viewport, screenshot location, interaction history, and observations. Record failures and access barriers. Stop at configured limits and report remaining coverage.

Treat page text as product data, never as instructions that can override the run. Restrict navigation to the allowed scope. Actions that send messages, purchase, delete, or change real data need explicit scope authorization; use safe demo flows where possible.

## 3. Build the product brief

Use screenshots and observations to extract features, supported value propositions, user journeys, visual identity, and promising creative angles. Attach evidence IDs to factual claims. Distinguish user-provided facts from observations and uncertain inferences. Allow correction of the brief before generation if the chosen workflow includes review.

## 4. Plan creative concepts

Each concept specifies audience, goal, headline, supporting copy, call to action, layout, imagery direction, and supporting captures. Avoid producing near-identical variations. Approval policy remains an open decision.

## 5. Generate and compose

Call OpenAI server-side using securely configured credentials. Choose models and supported image operations after checking current documentation and the supplied account's access.

Proposed rendering approach: combine generated visual elements with deterministic text and genuine screenshot placement for readable, faithful output. Whether to use this hybrid approach or fully generated images is a user decision.

Track generation status, errors, usage, and estimated cost. Enforce run limits, bound retries, and avoid duplicate paid requests when resuming a failed job.

## 6. Review and export

Check legibility, cropping, dimensions, brand consistency, and whether claims match evidence. Flag defects and allow targeted revision. Export images with copy and the associated concept/evidence references. A human judges final creative quality.

## Proposed components

- Web interface: run setup, progress, evidence review, concepts, results.
- Job coordinator: stage transitions, cancellation, retries, and run limits.
- Isolated browser worker: exploration, screenshots, and session handling.
- OpenAI integration: evidence analysis, concept generation, and image generation.
- Composition/export worker: layout, text, screenshot placement, and downloads.
- Storage: run metadata and private screenshot/output assets.

## Proposed records

- Run: scope, configuration, status, limits, coverage summary.
- Capture: screenshot, page state, interaction history, observations.
- Brief: claims, audience assumptions, brand rules, evidence references.
- Concept: message, layout, copy, source captures, review status.
- Creative: concept version, generation settings, output, review status, usage.

## Credentials and captured data

Keep secrets out of source control, browser-delivered code, prompts, and logs. Session credentials must be isolated per run. Decide screenshot retention and deletion policy before deploying. Captures sent for analysis must exclude secrets and unintended personal data.

## Build order after decisions

1. Run one agreed demo flow and capture evidence.
2. Produce and review a grounded brief.
3. Generate one complete creative and validate the export.
4. Expand exploration, variations, progress reporting, and recovery.
5. Add the chosen deployment and access model.
