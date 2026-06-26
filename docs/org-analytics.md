# Org / manager analytics dashboard

[← Docs index](./README.md) · [Multi-tenancy](./multi-tenancy.md) ·
[Fundraising strategies](./fundraising-strategies.md) · [Data model](./data-model.md)

> **Status:** SHIPPED (PM P1-3). A whole-org rollup **across every scout** for owners/admins,
> distinct from the per-scout Dashboard (`/api/impact` + `/api/stats`). Answers the manager's core
> question: *"show me our funnel, what's converting, and who needs help."*

## Endpoint

```
GET /api/orgs/analytics      requireAuth + requireOrgRole('owner','admin')
```

- **Gating:** owner/admin only — a **member gets `403`** (same as the other admin endpoints). Layered
  on `requireAuth`.
- **Scope:** every query binds `orgScope(req)` (the org from the **session**, never request input),
  so **no other tenant's rows are ever counted**. Demo-teammate scouts (`linkedin_id LIKE
  'demo-teammate-%'`) are excluded, mirroring the real team leaderboard.
- **Economics:** beneficiaries-funded uses **per-org** impact economics via `getOrgConfig(orgId)`
  (`programCost`/`dayCost`), falling back to `cause.config.js` — consistent with `/api/impact` and
  the team leaderboard.

### Response shape

```jsonc
{
  "funnel": {
    "counts": { "to_ask": 1, "asked": 1, "following_up": 1, "donated": 2, "declined": 1 },
    "conversion": {
      "to_ask_to_asked": 0.83,          // reached (asked-or-further) / (to_ask + reached)
      "asked_to_following_up": 0.6,     // (following_up + donated) / reached
      "following_up_to_donated": 0.66,  // donated / (following_up + donated)
      "overall": 0.4                    // donations / asks
    }
  },
  "totals": {
    "raised": 800, "asks": 5, "donations": 2, "totalReferrals": 6,
    "beneficiariesFunded": 1, "daysFunded": 14,   // via per-org economics
    "activeScouts": 2,                              // scouts with >=1 referral
    "conversionRate": 0.4                           // donations / asks
  },
  "segments": [                                      // sorted best-converting first
    { "segment": "🏢 Coworker", "asks": 2, "donations": 1, "conversionRate": 0.5 },
    { "segment": "✉️ Reachable", "asks": 5, "donations": 1, "conversionRate": 0.2 }
  ],
  "scouts": [                                        // per-scout breakdown, raised DESC
    { "id": 3, "name": "Olive Owner", "email": "...", "role": "owner",
      "asks": 4, "donations": 1, "raised": 500, "totalReferrals": 5,
      "beneficiariesFunded": 0, "conversionRate": 0.25 }
  ],
  "economics": { "costPerBootcamp": 800, "costPerDay": 57.14, "beneficiaries": "students",
                 "orgName": "Code for Ukraine" }
}
```

## What it aggregates

All figures come from the org-scoped `referrals` rows (joined to `users` for the org/demo filter),
using prepared statements — the same approach as the team leaderboard and `code_x_impact`.

- **Stage funnel** — referral counts grouped by `status` over `PIPELINE_STAGES`
  (`to_ask / asked / following_up / donated / declined`). The **`donated` count is taken from
  `donation_received`** (the authoritative flag set when a donation is recorded) so the funnel always
  agrees with `totals.raised`/conversion, even if a row's status text drifts. Sequential conversion
  rates walk the funnel; `overall = donations / asks`.
- **Totals** — `raised` (sum of `donation_amount` where `donation_received = 1`), `donations`,
  `asks` (referrals at `asked`-or-further), `totalReferrals`, `activeScouts` (distinct scouts with a
  referral), and `beneficiariesFunded`/`daysFunded` via per-org economics.
- **Per-segment conversion** — each referral is joined to its originating connection's
  `score_reasons` (the relationship/cause segments produced by scoring, e.g. *Possible family*,
  *Coworker*, *Shared school*, *Reachable*, plus the per-org cause-affinity labels). Reasons are a
  JSON array, exploded in JS; a referral counts **once per distinct segment**, and a donation
  (`donation_received`) counts as that segment's conversion. Result is sorted best-converting first.
- **Per-scout breakdown** — every real member (LEFT JOIN, so scouts with no pipeline appear as
  zeros) with `asks / donations / raised / totalReferrals / beneficiariesFunded / conversionRate`,
  ordered by raised DESC.

## Frontend

`client/src/pages/AnalyticsPage.jsx`, routed at **`/analytics`**. The **Analytics** nav link is
shown only to owners/admins (Header reads `user.orgRole`); the page also redirects non-managers to
`/dashboard` and the API 403s them — defense in depth. It renders the headline stat cards (raised,
beneficiaries, active scouts, conversion), a horizontal **pipeline funnel** bar chart with the
stage-to-stage rates, the **conversion-by-segment** table, and the **per-scout breakdown** table
(the caller's own row is highlighted).

## Tests

`test/analytics.test.js` (offline, `node:test`, in the `--test-concurrency=1` `npm test` script):
builds an org with 2 scouts and referrals spread across every stage + donations, and asserts the
funnel counts, totals, per-scout breakdown, and per-segment conversion; that a **member gets 403**;
and that **another org's numbers never appear** in the rollup.
