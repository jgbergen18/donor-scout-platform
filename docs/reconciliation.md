# Reconciliation: AI-autonomy features merged onto the multi-tenant SaaS trunk

Donor Scout briefly developed along two parallel branches that forked at Phase 0:

- **`main`** — the *AI autonomy* line: a Campaign Agent, a per-tenant AI budget, and
  per-org rebranding.
- **`rebuild/strategy-multitenancy`** — the *SaaS* line (this trunk): magic-link +
  invitations + per-org Okta SSO, audit log, outreach reminders/cadence, thank-you
  stewardship, manager analytics, selectable fundraising strategies, onboarding +
  in-app help, Docker + GitHub Actions CI, a 124-test suite, and a Postgres-migration
  plan.

The two were reconciled by keeping the SaaS branch as the trunk and **grafting the
three distinctive `main` features onto it, rewritten to the trunk's conventions**
(`server.js` was not `git merge`d — it shares no later history and would conflict
top-to-bottom; the features were ported region by region). Each graft was built,
adversarially reviewed, and tested as its own increment:

| Increment | Feature | What landed |
|---|---|---|
| **R1** | Per-tenant AI budget | `lib/ai.js` gains an in-memory per-org daily sub-budget (`_orgBuckets`) under the persisted global ceiling, so one tenant can't exhaust the shared budget and 429 everyone else. `orgId = orgScope(req)` threads into every Claude call; `status()` reports per-org + global. Tests: `ai-budget.test.js`, `ai-budget-spend.test.js`. |
| **R2** | Campaign Agent | `lib/campaign.js` (goal → one strategy call over the top-N candidates → ranked actions; paste-a-reply drafting) + a lean `lib/brief.js` (link guard + context builders + the link-bearing draft). Tables `campaigns`/`agent_actions`/`agent_runs` (all `org_id`); six endpoints rewritten to 3-arg org-scoped reads; `CampaignPage` + nav. Tests: `campaign.test.js`, `campaign-agent.test.js`, `link-guard.test.js`. |
| **R3** | Per-org rebranding | Server ships a per-org `cause` (orgName + impact economics + a validated donate link) on `/api/auth/me`; the client `OrgContext` rebrands the whole app via `useOrg()`, falling back to `cause.config.js`. Owner/admin "Cause & branding" editor in `OrgSettings`. Test: `orgbrand.test.js`. |

## Guardrails preserved throughout

- **No-send** — nothing ever messages a real donor. Approving a Campaign Agent action
  only *queues* a pipeline referral as `to_ask`; the human still sends every message by
  hand. Outreach is draft / copy / `mailto:` only.
- **AI cost control** — every Claude call routes through `lib/ai.js`; the per-org
  sub-budget sits under the persisted global ceiling (the hard backstop); the app
  degrades gracefully (503) with no `ANTHROPIC_API_KEY` and 429s on budget exhaustion.
- **Donation-link integrity** — the donate link is server-sourced and validated
  (`cleanDonateUrl`: https only, http on localhost) at both read and write; agent
  drafts/replies embed only that host (`enforceDonationLink`, hardened against the
  backslash-userinfo bypass); the payment iframe embeds only recognized donation forms.
- **Tenant isolation** — every owned read/write is keyed by `(user_id, org_id)` with
  `org_id` derived from the session (`orgScope(req)`), never from request input.
- **Demo mode** keeps working; the default org still brands as "Code for Ukraine".

## End state

The reconciled branch is the union of the SaaS platform and `main`'s AI autonomy. The
full suite (152 tests) and the client build pass; the reconciliation added **no new
runtime dependencies** and left the `Dockerfile` unchanged, so the CI `docker-build`
job validates the production image on push.
