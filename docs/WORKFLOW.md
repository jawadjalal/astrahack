# Creative workflow

> Earlier planning snapshot for the creative-generation workflow. See the root README for the current MVP and computer-use scope.

Design proposal only. Stack, models, and API details remain undecided.

## 1. Collect inputs

Accept product screenshots, product description, audience, core benefit, call to action, optional brand assets, and visual references. Collect destination, dimensions, variation count, and spend limits.

## 2. Prepare the creative brief

Summarize the supplied materials into a concise brief: audience, objective, supported claims, tone, visual direction, and brand constraints. Distinguish facts from assumptions. Allow edits if the chosen workflow includes review.

## 3. Develop concepts

Produce distinct concepts with a headline, supporting copy, call to action, layout direction, and selected source assets. Approval before generation is still a user decision.

## 4. Generate and compose

Use OpenAI server-side with securely configured credentials. Verify current model capabilities and account access before choosing implementation details.

Proposed approach: generate visual elements, then compose them with deterministic typography and faithful screenshot placement. Whether to use this hybrid approach or fully generated images remains open.

Track job progress, usage, and estimated cost. Bound retries and prevent duplicate paid requests when resuming failed jobs.

## 5. Review and revise

Check text legibility, cropping, dimensions, brand consistency, and factual accuracy. Let users revise copy, visual direction, or individual variations. Final quality is judged through human review.

## 6. Export

Provide downloadable images and associated copy in the agreed formats. Preserve concept versions so users can return to earlier results.

## Proposed components

- Web interface for inputs, creative brief, results, and revisions.
- Job coordinator for generation progress, cancellation, limits, and retries.
- OpenAI integration for interpreting inputs, creating concepts, and generating imagery.
- Composition/export worker for text, screenshots, layout, and downloads.
- Private storage for uploaded assets, briefs, and outputs.

## Proposed records

- Project: product details, audience, brand, and uploaded assets.
- Brief: goal, supported claims, copy constraints, formats, and limits.
- Concept: message, copy, composition, source assets, and version.
- Creative: concept version, output, generation settings, usage, and review status.

## Credentials and assets

Keep credentials out of source control, browser code, prompts, and logs. Decide retention and deletion rules before deployment. Users should supply assets suitable for the intended processing and exclude secrets or unintended personal data.

## Build order

1. Accept a sample brief and supplied assets.
2. Generate one complete creative and validate its export.
3. Add distinct variations and targeted revision.
4. Add progress reporting, cost controls, and failure recovery.
5. Deploy using the agreed access model.
