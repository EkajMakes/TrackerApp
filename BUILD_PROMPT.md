# BUILD PROMPT — Habit Gamification PWA

Paste everything between the horizontal rules into Claude Code as your first message.
`config.json` should already be in the project folder before you send it.

---

I'm building a personal habit-gamification PWA for my iPhone. Single user, offline,
no accounts. Read this entire brief, then write `SPEC.md` and **STOP** and wait for my
review. Do not write any implementation code until I approve the spec.

## STACK

- Static, offline-first Progressive Web App. Vanilla HTML/CSS/JS. No framework, no build step.
- IndexedDB for all storage. No server, no network calls at runtime.
- Include `manifest.json` + a service worker so "Add to Home Screen" in iOS Safari
  produces a fullscreen app with its own icon and no browser chrome.
- Must work in airplane mode and on cellular. It must never depend on my PC being on.
- Target: iPhone Safari. Mobile-first layout, large tap targets, one-handed use.

## TIME

- Day boundary: **2:00 AM**, timezone **America/Chicago**.
- Week boundary: **Monday 2:00 AM America/Chicago**.
- Use the IANA timezone identifier and handle CST/CDT transitions correctly.
  Never hardcode a UTC offset.

## CONFIGURATION

All tasks, point values, multiplier tiers, and shop items are defined in `config.json`
(already in the project root). Read it. Do not duplicate any of those values in code —
I will retune them weekly and the app must pick up changes on reload.

## TASK TYPES

- **`quota`** — weekly target. At week close, apply `penalty` for each unit short.
  If `extraEarnsPoints` is true, completions beyond the target still award full points.
- **`daily`** — due every day. Awards `points` per completion, up to `dailyTarget`
  completions per day (default 1). At *day* rollover, apply `penalty` once for each
  completion short of `dailyTarget`.
- **`target`** — weekly target with **no penalty**. Award `targetBonus` once at week
  close if the target was met. Missing it simply forfeits the bonus.
- **`bonus`** — points on completion, never penalized, enforced `dailyCap`.
  A bonus task with a `pool` array lets me pick a label from the pool per completion.
- **`tracker`** — records a numeric value, awards points for logging, no penalty.

## DAY ROSTERS

Each task declares `days` as `"all"` or a weekday list. The Today view shows only tasks
whose roster includes the current weekday. **Roster membership controls visibility only** —
weekly quotas and targets are counted independently of which weekday the completion
happened on.

## DAY FLAGS

A task may carry a per-weekday label (`dayFlags`), e.g. stream is `"prime"` on Tuesday and
`"early"` on other days. Render it as a badge on the Today view. No scoring effect.

## STREAK & MULTIPLIER

- Streak = consecutive days with **at least one `anchor: true` task completed**.
- Non-anchor tasks earn points at the current multiplier but do **not** maintain the streak.
- A day passing with zero anchor completions resets the streak to 0.
- Tiers are in config: 3 days Flowing 1.05x, 5 days Cooking 1.10x, 10 days Burning 1.20x.
- The multiplier applies to **earned points only** — task completions and target bonuses.
  It never applies to penalties.
- Apply the multiplier at the moment points are awarded, not retroactively when the
  tier changes.

## BONUS GATING

- If `bonusRequiresAnchor` is true, a `bonus` task completed on a day with **zero** anchor
  completions awards **0 points**. The completion is still recorded in history.
- The UI must show bonus tasks as locked-but-tappable until the day's first anchor lands,
  with the reason stated on screen, so this never looks like a bug.
- **Bonus weekly cap**: total points from `bonus` tasks in one week cannot exceed
  `bonusWeeklyCap`. Past the cap, further bonus completions record at 0 points.
  Show remaining bonus headroom in the UI.

## SKIPS

- **5 granted automatically at each week boundary.** Unused skips do **not** roll over.
- Purchasable in the shop.
- **Never auto-applied.** Spent manually against entries in the Failure log.

## FAILURE LOG

- `quota` tasks write a Failure entry per unit short at **week close**.
- `daily` tasks write a Failure entry at **day rollover**, one per completion short of
  `dailyTarget`. Note there are three `daily` tasks, so a bad week can produce 21+ daily
  Failure entries against only 5 free skips. The Failure log must sort by penalty value
  descending by default, so the most expensive entry to redeem is always at the top, and
  must group identical entries (e.g. "Pray ×4, −40") rather than listing them separately.
- The point deduction applies immediately when the entry is written.
- Spending 1 skip clears one Failure entry and **refunds its exact penalty**.
- The entire Failure log wipes at the next week boundary — one week to redeem.
- `target` tasks never generate Failure entries. Show a missed target as
  "bonus missed" — not a failure, not skip-redeemable.

## BALANCE

- Carries over indefinitely. Can go negative. Hard floor at `balanceFloor` (-250).
- **No automatic debt forgiveness.** Climbing back out is the point of the system.
- Cannot redeem shop items while the balance is negative.

## SHOP

- Config-driven catalog of `{name, cost, cooldownDays}`.
- Every redemption logged with a timestamp.
- Items on cooldown render visibly disabled with remaining time shown.
- The Skip token is a purchasable item like any other.

## WEIGHT SCORING — IMPORTANT

Points are awarded for **the act of recording an entry**. The recorded value must never
affect points, penalties, streaks, or multipliers in any way. The number is stored for
history and charting only.

## CRITICAL ARCHITECTURE

1. **Rollover must be LAZY and IDEMPOTENT, never scheduled.** On app open, read
   `lastProcessedTimestamp` and settle every elapsed day and week boundary forward in
   order. Running it repeatedly must produce identical state. There is no cron, no
   background job, no push notification.
2. **The scoring engine is a pure module** — no DOM access, no IndexedDB, no `Date.now()`.
   All state and the current time are passed in as arguments. Unit test it directly.
3. **`penalty` always equals the task's point value.** Read it from config, but validate
   at startup that `penalty === points` for every `quota` and `daily` task, and throw
   loudly if not.
4. **"Export all data as JSON" is a day-one feature**, not a later addition. It must
   dump every completion, penalty, redemption, and weight entry ever recorded.

## UI

Single page, four sections:

- **Today** — roster for the current weekday, tap to complete. Balance and streak tier
  pinned at the top at all times.
- **Shop** — catalog with costs, cooldowns, and affordability state.
- **Failure log** — open entries with their penalties and a "spend skip" action.
- **History** — completions by week, weight chart, running balance.

## DEV TOOL

Include a **week simulator** command that takes a hypothetical set of completions and
prints the resulting net points, so I can retune the economy without waiting a real week.

## SPEC.md MUST COVER

- The IndexedDB schema.
- The rollover algorithm as pseudocode.
- These edge cases:
  - a catch-up run spanning multiple week boundaries at once
  - spending a skip on a Failure entry when the balance is at the floor
  - completing a task after the day boundary but before the app is reopened
  - device clock changes and DST transitions
  - a bonus task completed *before* the day's first anchor, then an anchor completed later
    (does the bonus retroactively pay? — recommend an answer)
- The file layout.

Flag anything ambiguous rather than guessing.

---
