# TrackerApp — non-negotiables

Personal habit-gamification PWA. Offline-first, single user, no accounts, no server.
`SPEC.md` is the design of record; these are the rules that must never be traded away.

## Data

1. **Records are never deleted.** End-of-life is a state transition on a retained row —
   `resolvedAt` / `resolvedVia` for failures, `lapsedAt` for skips. A brief that says the log
   "wipes" means it stops being redeemable, not that rows are removed.
2. **Export dumps every store in full** — every completion, failure, redemption, skip, and
   weight entry ever recorded. Day-one feature, and the reason rule 1 exists.

## Design

3. **Never document a known exploit as an accepted quirk — fix it.** If analysis turns up a
   loophole, correct the design. If the fix needs a decision, raise it as an open question with
   a recommendation, not as a quirk the design has absorbed.
4. **Points are scored once, at the settling event**, using the tier in effect at that moment.
   Nothing is ever recomputed retroactively. Where an award depends on facts not yet known
   (bonus gating, the weekly cap), defer the settlement rather than rescore later.

## Architecture

5. **Rollover is lazy and idempotent.** Driven off `state.lastProcessedTimestamp` on app open,
   settling every elapsed boundary forward in order. Repeated runs produce identical state.
   No cron, no background job, no push notification, no scheduled work of any kind.
6. **`scoring.js` and `time.js` are pure.** No DOM, no IndexedDB, no `Date.now()`. State and
   the current instant arrive as arguments, so the engine runs directly under `node --test`.
7. **Time is always `America/Chicago` via `Intl`.** Day boundary 02:00, week boundary Monday
   02:00. Never hardcode or persist a UTC offset — DST must resolve itself on every run.

## Configuration

8. **Every tunable value comes from `config.json`** — tasks, points, penalties, tiers, caps,
   shop items. None of it is duplicated in code; the config is retuned weekly and the app must
   pick up changes on reload. The service worker is network-first for `config.json`,
   cache-first for the app shell.
9. **`penalty === points` for every `quota` and `daily` task**, validated at startup and
   throwing loudly and visibly if violated. Do not boot a broken economy.
