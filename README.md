# AstraHack

AstraHack is an early-stage system of agents that explores a startup's website or app, checks how it works, and turns what it learns into useful product and marketing outputs.

## Initial MVP

Given access to a website or app and a short brief, the agents should be able to:

1. **Explore and understand the product.** Use computer control to navigate the real website or app, try important user journeys, and build a grounded picture of what the product does and who it is for.
2. **Run practical QA.** Identify broken flows, confusing interactions, and other observable problems. Record the steps taken, expected and actual behavior, and supporting screenshots or video.
3. **Capture product assets.** Take screenshots and short screen recordings of meaningful features and flows that can be used in reports and promotional work.
4. **Create ad concepts and images.** Use the observed product experience and captured assets to propose messages and generate images for advertisements.
5. **Plan UGC campaigns.** Suggest creator angles, hooks, example scripts, and a campaign plan grounded in the product's actual features and audience.

The output of a run is a concise product understanding, a prioritized QA report with evidence, a set of captured product assets, ad image concepts, and a UGC campaign plan. The agents should distinguish what they directly observed from assumptions or proposed marketing claims.

## Our focus: computer use

We own the computer-use slice. Its job is to **use the website or app and understand it**, then give the other agents reliable context and evidence. In the MVP, that means:

- Open the website in a browser or the app in its supported environment, navigate its interface, and exercise key flows as a user would.
- Keep track of the actions taken, screens visited, and outcomes observed.
- Capture screenshots and video at useful moments.
- Describe the product's features, user journeys, and friction points in a structured handoff.
- Report failures with reproducible steps and evidence.

The computer-use agent is the source of observed product knowledge for QA and promotional planning. Generated ads and UGC ideas should build on that knowledge, while remaining clearly identified as creative proposals.

## MVP success criteria

For one supported website or app, a run should complete a small set of important user journeys and produce evidence that another person can review: what the agent did, what it saw, where it got stuck, and what it learned. The QA findings should be reproducible, and the promotional outputs should refer to features the agent actually found in the product.

This README defines the initial product direction. Implementation details, supported platforms, and setup instructions will be added as the MVP takes shape.
