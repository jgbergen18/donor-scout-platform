# Design — Thank-You / Receipt Stewardship (closing the donor loop)

[← Docs index](./README.md) · [Architecture](./architecture.md) · [Data model](./data-model.md) ·
[AI engine](./ai-engine.md) · [AI outreach drafts](./ai-outreach-drafts.md)

> **Status: IMPLEMENTED.** Shipped on `rebuild/strategy-multitenancy`. Closing the loop after a gift —
> stewardship lifts repeat giving and is the warmest, lowest-cost moment in the funnel.

## The loop

Once a referral reaches `donated` (`donation_received = 1`, with `donation_amount` / `donation_date`),
the scout should thank the donor and acknowledge the gift. This feature surfaces those donors,
generates an in-voice thank-you, exposes a copyable acknowledgement, and tracks who's been thanked.

## The `thanked` model

- **`referrals.thanked_at`** (`TEXT`, added via the existing `ensureColumn`) — the timestamp the scout
  marked the donor thanked. `NULL` = gift landed but donor not yet thanked. It is the single source of
  truth for the "awaiting thanks" gate.
- **Mark thanked:** `POST /api/referrals/:id/thanked` (org-scoped; cross-org id → **404**) sets
  `thanked_at = COALESCE(thanked_at, CURRENT_TIMESTAMP)` — idempotent, keeps the first timestamp.

## The AI thank-you draft

- **Endpoint:** `POST /api/referrals/:id/thank-you` (`requireAuth`), org-scoped via
  `getReferral.get(id, req.user.id, orgScope(req))` — a cross-org id returns **404** before the AI
  guard (existence not leaked). `400` if no donation is recorded yet.
- **Reuses the outreach-draft grounding pattern.** `thankYouContext()` wraps the same
  `dossierFacts(conn, scout, history)` (connection row, `score_reasons` relationship signals, scout
  profile, shared `contact_history`) used by the in-voice outreach draft, plus the scout's
  `voice_profiles.sample` (→ `voiced: true` only when present), and adds the **real donation** (amount,
  date, org) and the **concrete impact** the gift funds via per-org economics (`impactForAmount`,
  derived from `getOrgConfig().impact` — e.g. "$800 = 1 student").
- **Generation:** `generateText({ model: MODELS.draft, system: thankYouSystem(cfg, voiced), … ,
  maxTokens: 600, thinking: false })` — exactly the outreach-draft call shape (Haiku draft tier, not
  ADAPTIVE_OK). Transient; no new columns for the text.
- **Graceful degradation:** with no `ANTHROPIC_API_KEY` the endpoint returns **503** *and* a static
  `fallback` thank-you so the loop can always be closed; `AIBudgetError → 429`, other errors → **502** —
  all carry the same `fallback`. The client seeds its editable textarea from the static template and
  swaps in the AI draft when available.
- **Ethics:** grounded ONLY in real facts (never invents employer/income/motivation), warm and
  specific, ties the gift to concrete impact, makes **no second ask**, and is always an **editable
  starting point** the human reviews before sending. `thankYouContext`/`thankYouSystem`/
  `impactForAmount` are pure and exported via `__stewardshipInternals` for offline unit tests.

## The receipt (an acknowledgement, NOT a tax document)

- **Endpoint:** `GET /api/referrals/:id/receipt` (org-scoped → 404; `400` if no donation). Returns a
  structured `receipt`: `kind: 'acknowledgement'`, `donor`, `amount`, `date`, `org`, the `impact` it
  funded, and a `disclaimer`.
- **It is explicitly an acknowledgement, not a tax receipt.** Zeffy is the processor of record and
  issues the official tax receipt; the disclaimer says so. The scout can view it and copy a plain-text
  version for their own records or to share warmly with the donor.

## The "donors awaiting thanks" surface

- **Endpoint:** `GET /api/referrals/awaiting-thanks` — donated (`donation_received = 1`) AND not yet
  thanked (`thanked_at IS NULL`), for the calling scout only, org-scoped. Registered before the
  `/api/referrals/:id` routes so `awaiting-thanks` is never captured as an `:id`.
- **Frontend:** a "Thank your donors" prompt on both the **Dashboard** and the **Pipeline** lists the
  unthanked donors with **Thank** (opens the editable thank-you modal with the "Draft in my voice" AI
  action when AI is on), **Receipt** (view/copy the acknowledgement), and **Mark thanked**. Donated
  rows in the pipeline table also show a Receipt link and a "Thanked" pill once marked.

## Tests

`test/stewardship.test.js` (node:test, offline, no new deps): the thank-you endpoint **503 + fallback**
without a key and **cross-org id → 404**; `thanked_at` tracking (mark, and it drops from
awaiting-thanks); awaiting-thanks lists only the calling scout's donated-unthanked referrals
(org-scoped); the receipt content includes the impact and is labeled an acknowledgement (with the Zeffy
disclaimer); and pure unit tests of `thankYouContext`/`impactForAmount`/`buildReceipt` (grounded, no
invented facts).
