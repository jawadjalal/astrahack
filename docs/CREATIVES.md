# Astra — five ad creatives from one prompt

A small Node.js script that takes a product/ad prompt and generates **five distinct square 1024×1024 PNG ads** using OpenAI. No website, app, or computer-use implementation. No dependencies.

## Run

Requires Node.js 22.9 or newer. Put your OpenAI API key in a local `.env` file using `.env.example`, or set `OPENAI_API_KEY` in the environment.

```sh
npm run generate -- --prompt "Your product facts, audience, brand, and ad message"
```

Or read a longer prompt from a file:

```sh
npm run generate -- --prompt-file brief.txt --out artifacts
```

**No API key yet?** Prepare all five prompts without making any API calls:

```sh
npm run generate -- --prompt "Your product and campaign brief" --dry-run
```

Each run creates a unique folder under `artifacts/` with five PNG files and `manifest.json`, which records prompts and completion/failure status. Dry runs create only the manifest, not images. Output folders and `.env` are ignored by Git.

## What it does

Uses five art directions: hero, editorial, benefit, context, and typography. Each incorporates the supplied prompt and asks for a clean product-specific ad without unsupported claims. Sends five image requests, at most two concurrently. Preserves successful images if another request fails; exits unsuccessfully for incomplete sets. No automatic paid retries.

Default model: `gpt-image-2`, configurable with `OPENAI_IMAGE_MODEL`. Calls the [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate). The chosen model must support square PNG generation.

## Verify

```sh
npm run check
npm test
```

Six tests cover five-image generation requests, dry runs, missing keys, partial failure, invalid/non-square responses, and empty prompts. Tests use a mocked provider; real API access and image quality remain unverified until a key is supplied.

[Product scope](PRODUCT.md) · [Workflow](WORKFLOW.md) · [Code integration](INTEGRATION.md) · [Decisions](QUESTIONS.md)
