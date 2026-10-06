# Questions and decisions

Status: awaiting user answers. Proposed defaults are suggestions, not approved requirements.

## Needed to start

1. What is the first example app URL? Is it a web app or native mobile app?
2. Does it require login, and can we use a demo account with synthetic data? Which roles should be covered?
3. Which screens/flows must the demo cover? Are there interactions the agent must avoid?
4. Who is the target user and creative audience? Is Gradlify a first use case or is this a separate product?
5. Where will creatives be used: Meta, LinkedIn, app stores, website banners, or elsewhere? What formats and variation count?
6. Should visuals use actual screenshots, generated imagery, or a mix? Are logos, fonts, colors, or reference creatives available?
7. What should the ad communicate, and what action should its viewer take?
8. Should users approve the brief and concepts before generation, or should a run be fully automatic?
9. What is the hackathon deadline, and what must work in the final demo?
10. Any preferred stack or hosting? Local demo or deployed product? Single user or multiple users?
11. What is the acceptable cost and runtime per run?
12. Will the provided credential be an OpenAI API key with API access? Configure it securely when needed; do not put it in these docs.

## Before deployment

- Who supplies API credentials: the operator or each customer?
- How long should screenshots, sessions, and generated assets be kept?
- Are uploaded screenshots or manual navigation needed as fallbacks?
- What download formats, editing controls, and approval history are necessary?
- Is this only a hackathon demo, or should payment and customer onboarding follow?

## Suggested defaults if requested

Start with one browser-accessible demo app, a single operator, static creatives, a mix of faithful screenshots and generated visual elements, and brief/concept review before paid generation. Final formats, budget, stack, and authentication remain undecided.

## Decision log

| Decision | Status |
| --- | --- |
| Explore app through clicks and capture evidence | Confirmed |
| Generate creatives using OpenAI with supplied key | Confirmed |
| App URL, audience, formats, and brand | Awaiting answer |
| Exploration boundaries and review steps | Awaiting answer |
| Stack, deployment, deadline, and cost limits | Awaiting answer |
