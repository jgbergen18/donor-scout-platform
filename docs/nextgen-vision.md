# Donor Scout — the next-generation vision

> The reframe: stop shipping **a database the human drives** and ship **a standing
> per-org planner that re-decides the relationship portfolio and hands the human a
> tiny daily approval queue.** The human inverts from *operator* (picks who's next,
> researches, drafts, sequences, logs) to *approver + relationship-holder* (sets
> policy, resolves forks, owns every actual conversation and every go/no-go).

This doc is the north star and the build log. It exists because the product was, by
design feedback, "a better CRM" — sensible and custom-fit, but shaped like tools that
already exist. The next-gen bet is to change the *loop*, not add features.

## The ambition ladder

Each rung is buildable on the one below. The honest 10x is **L2 autonomy at ~3–4x on
time, compounding into money because more relationships actually advance** — not a
magic money machine, and not the cross-org network (cut; see Non-goals).

| Rung | The loop | Mechanism | 10x lever | Status |
|---|---|---|---|---|
| **L0** | Human scans rows, hand-picks who's next, drafts, copies, sends, logs. | On-demand plan + lazy drafts behind a button. | — (baseline ~7–9 hrs/wk) | shipped (pre-existing) |
| **L1** | The *conversation* drives the pipeline. A pasted reply classifies intent → reversible move; one daily pass suppresses relationship-damaging items and flags forks. | `classifyReply` + `triageToday` (`lib/triage.js`). | autonomy ~2x, safe | **shipped** |
| **L2** | A nightly Standing Planner re-sequences the in-flight portfolio, pre-stages moves, routes them by a deterministic policy gate; the human opens to a Morning Brief. | `runNightlyPlanning` over `agent_actions` Moves + `approveActionToReferral`. | autonomy ~3–4x | **shipped** |
| **L3** | Calibrated ask-pricing (clamp to the org's realized gift distribution) + intra-org warm-path intros. | ask-band clamp + 2-hop graph over board members. | output / money | future (needs ledger history to mature) |

## What "autonomy" means here — the dial, not the cliff

Autonomy is scoped strictly to **research / draft / sequence / decide-what-to-propose
— never to transmission.** This is the load-bearing guarantee:

- **NO-SEND is absolute.** Nothing in any rung messages a donor. "Auto-accept" /
  "auto-approve" only *stage* or *queue* work:
  - L1 auto-accept applies a **reversible** pipeline move (advance / snooze / mark
    declined) from a classified reply. A claimed gift (`already_gave`) is **always a
    human fork** — no amount is ever parsed from a message into the ledger.
  - L2 auto-approve only creates a **`to_ask`** referral (the existing approval path).
    The human still drafts and sends every message by hand.
- **The dial is per-org** (`org_config.autonomy`, `PATCH /api/orgs/autonomy`,
  owner/admin): `autoAcceptReplies`, `autoApplyTriage`, `autoApproveMoves`, and a
  free-text `policy`. Defaults are **ON** per the deployment directive; any org can
  turn the dial down to "stage everything for review."
- **Cost stays bounded.** Every model call routes through `lib/ai.js` (Haiku-default,
  per-org daily $ budget, graceful no-key degradation). L2 is exactly **one Sonnet
  plan per campaign per day**, idempotent (no re-spend), no per-donor fan-out.
- **Tenant isolation holds.** `org_id` is always derived from the session — except the
  cron, which has no session and re-derives the boundary from the **campaign row**
  (`campaign.user_id` / `campaign.org_id`). A dedicated isolation test asserts a global
  nightly run never crosses tenants.

## Why this is not just a CRM with AI sprinkled on

1. **The human's role inverts** — operator → approver.
2. **Work runs continuously, not on-open** — you open to finished work to authorize.
3. **The unit is a portfolio/journey, not a contact row** — you touch the Brief and the
   Policy, not 800 rows; the referral row is an audit trail the agent moves.
4. **The conversation drives the pipeline** — a pasted reply emits a state change; the
   pipeline stage is emergent, not hand-maintained.
5. **Honest residue:** the ledger, contact list, and pipeline-as-audit are still
   relational rows underneath. What changed is *who drives them.*

## Build map (where each piece lives)

- **Keystone — per-gift donations ledger:** `donations` table + `recordGift()` funnel
  (append + refresh the cached `donation_*` columns in one txn). The spine L3's
  retention features will build on. See `server.js` (search `recordGift`) and the
  `donations` DDL.
- **L1:** `lib/triage.js` (`classifyReply`, `triageToday`); `POST /api/ai/reply`
  (intent + reversible auto-apply + `already_gave` fork); `GET /api/today/brief`
  (triage suppression + forks, degrades to the raw queue).
- **L2:** `runNightlyPlanning` / `runNightlyForOrg` / `runNightlyForCampaign` /
  `persistNightlyMoves` / `approveActionToReferral` in `server.js`; `nightly_runs`
  idempotency table; `agent_actions.source/approval_tier/brief_date`; the hourly
  `setInterval` in the listen block; `GET /api/brief`, `POST /api/brief/run`;
  `client/src/pages/BriefPage.jsx`.

## Non-goals (the line we won't cross)

- **No cross-org federated warm-path network.** Its anonymity is cryptographically soft
  against a malicious participant org (low-entropy name+employer hashes; the
  shared-vs-per-pair-salt dilemma), and the honest fix (private-set-intersection /
  trusted broker) is infrastructure a 2-person nonprofit can't run. L3 warm paths stay
  strictly **intra-org** (board members within one `org_id`). If ever revisited, it
  requires double-opt-in *plus* a trusted-broker PSI design.

## Honest risks (and the cheapest de-risk)

1. **Stale state burns a real donor** — a confident re-ask to someone mid-grief costs
   more than a year of saved hours. *De-risk:* shadow-mode the planner against orgs
   still working manually; only widen auto-approve for a move class once its shadow
   false-positive rate is ~zero. The L1 triage suppression is the first guard.
2. **Trust / over-automation backlash** — batch-approve drifts to rubber-stamp.
   *De-risk:* the dial defaults can be tightened per org; the Morning Brief surfaces
   net-new asks first so the eye lands on consequential moves.
3. **Tenant leak in the cron** — a single mis-scoped statement leaks across tenants.
   *De-risk:* the colliding-orgs isolation test runs in CI on every change to the runner.
