# Product scope

## Problem

Creating marketing assets requires understanding the product, finding strong screens, writing accurate copy, and composing polished visuals. Astra Hack aims to connect these steps in one workflow.

## Intended outcome

A user supplies access to an app and receives usable creatives grounded in what the agent actually observed.

## Confirmed requirements

- The agent clicks through the app rather than relying on its homepage alone.
- Screenshots and collected product information inform creative generation.
- OpenAI is used with a user-provided API key.
- Visuals should be clean and effective.

## Proposed first version — pending approval

- Browser-accessible web apps, one app per run.
- Static image creatives before video.
- A scoped exploration run with visible progress and configurable limits.
- An evidence gallery and editable product brief.
- Several distinct creative concepts, with regeneration of individual outputs.
- Downloadable images and associated copy.

Native mobile support, ad publishing, scheduled monitoring, billing, and collaborative workspaces are not yet agreed.

## Quality criteria

- Claims trace back to observed evidence or explicit user input.
- No invented features, testimonials, pricing, or performance promises.
- Each creative has a clear message, legible copy, and an intentional call to action.
- Genuine app screenshots remain faithful to the interface when used as product proof.
- Output dimensions and brand rules match the chosen destination.
- Failed generations or incomplete exploration are visible.

“Effective” initially means meeting the creative brief and human review criteria. Conversion performance requires later measurement; it is not guaranteed by image generation.

## Coverage expectations

“Entire app” means all agreed, reachable screens and meaningful states within the run's access and limits. The system must report visited, skipped, blocked, and failed areas instead of claiming exhaustive coverage without evidence. Authenticated roles, hidden routes, and unbounded data can limit coverage.

## Proposed demo acceptance

Given an agreed demo app, the system explores the selected flows, records evidence, generates a product brief with source references, and returns at least one approved-format creative that can be downloaded. Exact scope, number of variations, runtime, and budget await user decisions.
