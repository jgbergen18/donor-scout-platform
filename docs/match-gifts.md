# Employer matching-gift detector

Many large employers **double** an employee's charitable gift through a corporate
matching-gift program — free money nonprofits routinely leave on the table because
nobody asks. Donor Scout flags donors whose employer is a known matcher and surfaces a
one-click "ask them to submit a match" prompt on the **Today** page ("Double their
gift"). Like all outreach here it is **no-send**: the volunteer copies a short message
and sends it themselves; no donor data leaves the app and no AI budget is spent.

## How it works

- `lib/matchgifts-data.js` is a **curated heuristic list** of ~300 large employers
  across tech, finance, insurance, pharma/healthcare, consumer/retail, industrial/energy,
  telecom/media, and professional services that are commonly known to run matching
  programs.
- `lib/matchgifts.js` compiles each entry's keywords into a **word-boundary** regex
  (so "Apple" ≠ "Snapple", "Visa" ≠ "Visalia", "Ford" ≠ "Stanford") and exposes
  `matchProgramFor(company) → program name | null`.
- The server uses it in `GET /api/today` to build the match-gift worklist from donated
  referrals whose `company` matches.

It is intentionally a **heuristic, not a database**: matching is a standard benefit at
most large employers, so this covers the bulk of real matches by volume — but it is not
exhaustive, and a given program can change. A miss just means no prompt (never a wrong
action), and the donor message says the employer *may* match, prompting a quick check.

## Extending coverage

1. **Add to the list** — append `{ name, kw: ['lowercase keyword', …] }` entries to
   `lib/matchgifts-data.js`. Keep keywords **distinctive**; avoid short/common words
   (e.g. "ge", "ice", "gap") that would cause false positives. Add a test case in
   `test/timesavers.test.js`.
2. **Authoritative database (optional)** — the industry standard is **Double the
   Donation / 360MatchPro** (~24,000 companies, paid API + embeddable search widget).
   Two integration shapes fit our guardrails differently:
   - *Embeddable donor-facing widget* — the donor types their own employer; keeps donor
     data client-side. Lowest privacy cost, but a donor-facing UX and needs an account.
   - *Server API lookup* — sends the donor's employer name to a third party, which cuts
     against "donor data stays per-org and local," so it should be opt-in per org and
     clearly disclosed.
   Either would be wired as a configurable, opt-in seam (off by default), exactly like
   the AI / GitHub / email integrations — the curated list stays the zero-cost default.
