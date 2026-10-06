# Astra Hack

Turn a working app into clean, product-grounded marketing creatives.

An agent explores a supplied example app, clicks through its screens and flows, captures screenshots and observations, and uses that evidence with OpenAI to generate creative assets.

## Status

Planning only. No application has been implemented. Requirements below distinguish the confirmed idea from proposed implementation choices.

## Confirmed direction

- Explore an example app through browser interaction.
- Capture screenshots and useful information across the app.
- Generate clean, effective creatives from collected evidence.
- Use an OpenAI API key supplied by the user.

## Proposed journey

1. Supply an app URL, access details, brand guidance, and creative goal.
2. Explore reachable screens and interactions within an agreed scope.
3. Review a coverage report, screenshots, and a grounded product brief.
4. Generate creative concepts and selected image variations.
5. Review, revise, and download the results.

Approval steps, formats, deployment, and stack are still to be decided.

## Documentation

- [Product scope and quality](docs/PRODUCT.md)
- [Workflow and proposed architecture](docs/WORKFLOW.md)
- [Questions and decisions](docs/QUESTIONS.md)

## Credentials

Provide API credentials through a secure runtime configuration or secret store when implementation is ready. Never commit API keys, session cookies, login passwords, or real customer screenshots. Model selection and API access must be verified before implementation.
