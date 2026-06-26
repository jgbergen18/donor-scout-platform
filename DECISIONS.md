# Design Decisions & Tradeoffs

The interesting part of this project wasn't the CRUD — it was a handful of judgment calls. This is where I show my work.

---

## 1. Rank by *relationship*, not by *capacity*

**The call.** The priority score that orders the prospect list is built from **affinity** (how well you know someone) plus a cause-fit nudge. Wealth signals — company prestige, GitHub footprint, seniority — are computed into a **separate "capacity" score that does *not* drive the ranking.** It only sizes the suggested ask and breaks ties.

**Why.** The first version ranked by capacity and the results were useless: the top of the list was impressive strangers — a director at a big tech company, a founder I'd met once — who would never reply to a fundraising DM. Peer-to-peer giving is driven by **trust and reciprocity**, not the target's net worth. So I split the two questions the fundraiser is really asking:

- *"Who will say yes?"* → **relationship** → drives the rank.
- *"How much should I ask for?"* → **capacity** → a badge + tiebreaker.

**Tradeoff.** Affinity is inferred from imperfect signals (surnames aren't proof of family; an email's presence is a proxy for closeness). I accepted some noise for a ranking that matches a fundraiser's intuition — and surfaced the reasons on every card so a human can overrule a bad guess at a glance. The ranking is a *prioritizer for human judgment*, not an oracle.

## 2. Enrichment that can't be fooled

**The call.** GitHub enrichment searches the real API for a contact by name (+ city) and reads followers / repos / company. A name search is noisy, so every match carries a **confidence** (`high` / `medium` / `low`), and a low-confidence hit contributes **zero** to the score until a human confirms or relinks it.

**Why.** An enrichment pipeline that silently trusts its first hit produces confidently-wrong scores. Making bad matches count for nothing — and letting the user confirm — keeps the number honest. Same principle as #1: assist judgment, don't fake it.

## 3. I chose **not to scrape**

**The call.** LinkedIn only exposes a member's **1st-degree** connections, via the official data export — not an API. The tempting "feature" is to crawl friends-of-friends. I deliberately didn't.

**Why.** Scraping LinkedIn violates its Terms of Service and harvests data about people who never consented to be in a fundraising database — a legal, ethical, and (for a nonprofit) reputational risk. The right answer to "reach more people" isn't *crawl wider*, it's **recruit more volunteers who each work their own network with consent.** That's exactly why the team model exists: it's the scaling story *and* the ethical one in one feature.

## 4. One config file = one nonprofit

**The call.** The problem ("a volunteer doesn't know who to ask, and asks get dropped") is universal to small nonprofits; only the *cause* changes. So everything cause-specific — impact unit economics and the cause-affinity scoring signal — lives in [`cause.config.js`](cause.config.js) (and per-org config in the multi-tenant build). The scoring/pipeline/impact engine knows nothing about Ukraine, bootcamps, or Zeffy.

**Why.** Hard-coding the cause would mean rebuilding the tool per org. Pulling it into config makes retargeting (animal shelter, literacy program, food bank) an afternoon of editing values, not a fork — and keeps the "what predicts giving for *this* cause" knob explicit and reviewable in one place.

## 5. Graceful degradation as a design rule

**The call.** Every external dependency — GitHub, the Anthropic API, LinkedIn OIDC, email delivery — is **optional and degrades to a sensible fallback** when its credentials are absent (heuristics instead of AI, console output instead of email, demo login instead of OIDC).

**Why.** It has to *run* for anyone — a reviewer with no keys, a local dev, a tiny nonprofit. Degradation-by-default also means a single flaky integration never takes the app down; it just quietly drops to the baseline. The AI layer additionally sits behind a **per-org spend budget guard** so cost can't run away.

## 6. Multi-tenant by construction

**The call.** Rather than bolt on orgs later, **`org_id` scoping is enforced on every data query**, with owner/admin/member roles gating org-level actions and a create-or-join onboarding flow.

**Why.** Data isolation is the kind of thing that's miserable to retrofit and dangerous to get wrong (one missed `WHERE org_id = ?` leaks another nonprofit's donors). Making it a convention every query follows — and testing it directly — is far safer than hoping it was remembered.

## 7. Boring, robust stack on purpose

**The call.** Single-file Express + **SQLite (better-sqlite3)** + React/Vite, with Node's built-in test runner (`node:test`) and no ORM or UI framework. Dockerized with health/readiness probes and structured logging.

**Why.** Fewer moving parts means fewer ways for a reviewer's clone to break and a smaller surface to reason about. Synchronous better-sqlite3 keeps the data layer legible; `node:test` adds ~40 suites with zero new runtime deps. SQLite won't serve thousands of concurrent tenants — but that's a deployment concern (documented Postgres migration path), not a prototype one, and the schema ports with minimal change.

---

## What's real vs. mocked (so nobody's misled)

| Component | Status |
| --- | --- |
| LinkedIn OIDC + magic-link auth | **Real** |
| LinkedIn *connections* | **Real**, via the member's official export (not API, not scraped) |
| GitHub enrichment | **Real**, throttled, rate-limit-aware, confidence-scored |
| Anthropic AI (dossiers / drafts / newsletter) | **Real**, with graceful fallback + budget guard |
| Zeffy donations | **Real** platform; reconciles a **real** CSV export |
| Multi-tenancy, roles, scoring, pipeline, impact, analytics | **Real**, persisted, tested |
| Team leaderboard *teammates* | **Seeded** sample data |
| Okta SSO / SCIM · Postgres migration | **Designed + documented**, not built |

## What I'd do next

Okta SSO (Phase 2 of the auth plan) for orgs that bring their own IdP; the documented Postgres migration once tenant/data volume justifies it; and a richer stewardship loop (automatic thank-you + re-ask cadences), since retention is cheaper than acquisition. Full technical docs live in [`docs/`](docs/).
