# Self-serve onboarding + in-app help

A guided first-run experience for new scouts, plus lightweight contextual help that
explains the product's core concepts where they appear. Built in the existing
single-file `server.js` + the React SPA, reusing `orgScope(req)` and the existing UI
patterns (`.card`, `.progress`, `.badge`, `.btn`). No new runtime dependencies.

## The checklist (derived, never self-marked)

`GET /api/onboarding` (auth, org-scoped) returns a checklist whose every step's
**DONE state is DERIVED from the scout's real data** — the user never ticks a box.
All counts are scoped to `(user_id, org_id)` (org_id from the session, never the
request), so a scout only ever sees their **own** signals — never a teammate's or
another tenant's.

| Step | Key | Derived signal |
| --- | --- | --- |
| Set up your profile | `profile` | any of `users.company` / `location` / `schools` is set |
| Import your connections | `connections` | `COUNT(connections) WHERE user_id+org_id > 0` |
| Pick a fundraising strategy | `strategy` | `users.strategy` is non-NULL (an **explicit** choice — NULL means "inherit the org default", i.e. not yet picked) |
| Create or join your organization (optional) | `org` | the scout has **left the shared default org** (`org_id !== DEFAULT_ORG_ID`). The default org is the catch-all everyone lands in at signup, so membership there — even alongside other scouts — never counts as "your org" |
| Reach out to your first prospect | `referral` | `COUNT(referrals) WHERE user_id+org_id > 0` |

Response shape:

```jsonc
{
  "steps": [ { "key", "title", "description", "done", "href", "cta", "optional?" } ],
  "completedSteps": 0,      // required steps done
  "totalSteps": 4,          // required steps only (org is optional)
  "complete": false,        // every REQUIRED step done
  "dismissed": false        // the one persisted bit (see below)
}
```

The `org` step is **optional**: it flips to done when satisfied but is excluded from
`completedSteps` / `totalSteps`, so it never blocks `complete`.

## The dismiss model (the only persisted state)

The single persisted onboarding bit is `users.onboarding_dismissed` (added via the
existing `ensureColumn` helper, `INTEGER DEFAULT 0`). `POST /api/onboarding/dismiss`
sets it (`{ dismissed }` defaults to `true`, so a bare "Dismiss" button can POST an
empty body; pass `{ dismissed: false }` to un-dismiss). Dismissal is **per-user** and
survives across requests. Everything else is recomputed on each GET.

The `OnboardingChecklist` widget (on the Dashboard) auto-hides when the checklist is
**complete** or **dismissed**. It shows a progress bar, each step with a derived
check, and a CTA linking to where the step is done (`/profile`, `/prospects`).

## Contextual in-app help

`client/src/components/Help.jsx` provides two reusable, dependency-free affordances:

- **`<HelpTip label="…">…</HelpTip>`** — a small inline info disclosure built on
  native `<details>`/`<summary>` (keyboard- and screen-reader-accessible for free).
  Used on the Prospects page header to explain relationship-led ranking in place.
- **`<HelpPanel />`** — a compact "How Donor Scout works" card (on the Dashboard)
  covering the four core concepts, with the copy shared via `HELP_TOPICS` so a tip
  and the panel never drift:
  1. **Relationship-led ranking** — rank by relationship strength, not perceived wealth.
  2. **Fundraising strategies** — Affinity / Propensity / Capacity combine into the rank.
  3. **Pipeline stages** — asked → following up → donated / declined; reminders keep cadence.
  4. **Capacity vs. likelihood** — capacity sizes the ask; it doesn't pick who to ask.

The copy reuses the language already in `StrategyPicker` and the dashboard.

## Tests

`test/onboarding.test.js` (offline `node:test`, added to the `--test-concurrency=1`
`npm test` script):

- empty account → every required step incomplete, `complete: false`;
- after setting profile / importing connections / choosing a strategy / making a
  first referral → those steps flip to done and `complete` becomes true;
- the `org` step derives from leaving the default org;
- dismissal persists across a fresh request and can be un-dismissed;
- org-scoped: scout A's connections and dismissal never leak to scout B;
- both routes require auth (401 when anonymous).
