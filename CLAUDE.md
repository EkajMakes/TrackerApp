# TrackerApp — non-negotiables

Personal habit-gamification PWA. Offline-first, single user, no accounts, no server.
`SPEC.md` is the design of record; these are the rules that must never be traded away.

## Data

1. **Records are never deleted.** End-of-life is a state transition on a retained row —
   `resolvedAt` / `resolvedVia` for failures, `lapsedAt` for skips, `voidedAt` for an undone
   completion. A brief that says the log "wipes" means it stops being redeemable, not that rows
   are removed. There is no delete path in `db.js` and nothing the app does in normal operation
   removes a row. **Cutting a feature is not permission to lose its history**: when a store is
   retired, its rows are copied into `archive` inside the same upgrade transaction *before* the
   store is dropped (see `migrateToV2`).
2. **The single named exception** is the reset in History: `config.resetsAllowed` uses for the
   life of the app, gated behind a completed export and typing `RESET`, dropping the whole
   database via `indexedDB.deleteDatabase` at the call site. `meta.resetsUsed` is read before
   the wipe and rewritten after it — a counter living inside the erased data would reset itself.
   Whole-database or nothing; never per-record deletion. No other delete is permitted anywhere.
3. **Export dumps every store in full** — every completion, failure, skip, missed target,
   weight entry, archived row and the `meta` row. Day-one feature, and the reason rule 1 exists.

## Design

4. **Points are a score, not currency.** There is no shop and nothing is spent; config carrying
   a `shop` key fails validation. In the UI the figure is labelled **Points**, never "balance",
   though `balance` keeps its name in the data. Motivation comes from the streak ladder and the
   records, which are derived from the ledger and never stored.
5. **Never document a known exploit as an accepted quirk — fix it.** If analysis turns up a
   loophole, correct the design. If the fix needs a decision, raise it as an open question with
   a recommendation, not as a quirk the design has absorbed.
6. **Points are scored once, at the settling event**, using the tier in effect at that moment.
   Nothing is ever recomputed retroactively. Where an award depends on facts not yet known
   (bonus gating, the weekly cap), defer the settlement rather than rescore later.

## Architecture

7. **Rollover is lazy and idempotent.** Driven off `state.lastProcessedTimestamp` on app open,
   settling every elapsed boundary forward in order. Repeated runs produce identical state.
   No cron, no background job, no push notification, no scheduled work of any kind.
8. **`scoring.js`, `time.js`, `schedule.js` and `views.js` are pure.** No DOM, no IndexedDB,
   no `Date.now()`. State and the current instant arrive as arguments, so they run directly
   under `node --test`.
9. **Time is always `America/Chicago` via `Intl`.** Day boundary 02:00, week boundary Monday
   02:00. Never hardcode or persist a UTC offset — DST must resolve itself on every run. "Today"
   always means the **app-day**, including on the Schedule tab: at 1am you are still in
   yesterday.

## Configuration

10. **Every tunable value comes from `config.json`** — tasks, points, penalties, tier names,
   multipliers and colours, caps, allowances. None of it is duplicated in code; the config is
   retuned weekly and the app must pick up changes on reload. The service worker is network-first for `config.json`,
   cache-first for the app shell. `schedule.json` is treated the same way.
11. **`penalty === points` for every `quota` and `daily` task**, validated at startup and
   throwing loudly and visibly if violated. Do not boot a broken economy.
