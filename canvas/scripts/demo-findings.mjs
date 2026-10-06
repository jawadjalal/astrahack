// The sample findings of the seeded "Fernly" demo board. Every one is FUNCTIONAL: observable broken behavior with
// steps, expected vs actual and the screen it shows on (see src/findings-filter.js for the definition).
// Kept apart from seed-demo.mjs so tests can check them without posting anything.
//
//   screen:  index into the seeded screens (0 onboarding, 1 sign up, 2 paywall, 3 home, 4 settings, 5 empty garden)
//   steps:   the reproduction, shown in `actual` on the card because the finding op has no steps field

export const DEMO_FINDINGS = [
  {
    id: "f1-paywall-close", rank: 1, screen: 2, severity: "critical", verified: true, timestamp: 3,
    title: "Paywall close button is unresponsive",
    expected: "Tapping x closes the paywall and opens Home.",
    actual: "Tapped x five times and swiped down: the paywall stays. The only way out was force-quitting the app. Repro: Get started, Create account, tap x.",
    steps: ["Tap Get started", "Create an account", "On the paywall, tap the x in the top corner five times"],
  },
  {
    id: "f2-signup-first-tap", rank: 2, screen: 1, severity: "high", verified: true, timestamp: 2,
    title: "Sign up button ignores the first tap",
    expected: "Tapping Create account with a valid email and password creates the account and moves on.",
    actual: "Valid email, password with a number, both rules ticked. First tap: no spinner, no error, same screen. The second tap works. Repro: fill the form, tap Create account once.",
    steps: ["Open Sign up", "Enter maya.ortiz@gmail.com and a 10-character password with a number", "Tap Create account once"],
  },
  {
    id: "f3-reminder-count", rank: 3, screen: 3, severity: "high", verified: true, timestamp: 4,
    title: "Reminder count not updated after watering",
    expected: "After tapping Water on Monstera the banner reads 2 plants need water.",
    actual: "Monstera is marked watered but the banner still says 3 plants need water until the app is restarted. Repro: open Home, tap Water on Monstera, read the banner.",
    steps: ["Open Home", "Tap Water on Monstera", "Read the banner at the top"],
  },
  {
    id: "f4-reminder-time", rank: 4, screen: 4, severity: "medium", verified: true, timestamp: 5,
    title: "Reminder time reverts to 8:00 AM",
    expected: "A reminder time set to 7:30 AM is still 7:30 AM when Settings is reopened.",
    actual: "Picked 7:30 AM, left Settings, came back: the row shows 8:00 AM again. Repro: Settings, Reminder time, 7:30 AM, tap Home, tap Settings.",
    steps: ["Open Settings", "Set Reminder time to 7:30 AM", "Tap Home", "Tap Settings and read Reminder time"],
  },
  {
    id: "f5-home-badge", rank: 5, screen: 3, severity: "medium", verified: false, timestamp: 4,
    title: "Home badge shows 5 but only 3 plants are due",
    expected: "The Home badge equals the number of plants due (3).",
    actual: "The tab badge reads 5. The banner and the list both show 3. Seen once; needs a second run.",
    steps: ["Open Home", "Compare the tab badge with the banner and the Today list"],
  },
  {
    id: "f6-add-plant", rank: 6, screen: 5, severity: "medium", verified: false, timestamp: 5,
    title: "Add (+) on My garden does nothing",
    expected: "Tapping + opens the add-a-plant screen.",
    actual: "Tapped + in the top corner three times: no sheet, no navigation, no error. Seen once; needs a second run.",
    steps: ["Open Garden on a fresh account", "Tap + in the top corner three times"],
  },
];
