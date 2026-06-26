/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CAUSE CONFIG  —  the one file you edit to point Donor Scout at a new nonprofit
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Everything cause-specific lives here: the organization's identity, its impact
 *  unit economics ("$X funds one ___"), and the donor-scoring signal that is
 *  unique to the cause. The rest of the app — relationship scoring, the pipeline,
 *  teams, the leaderboard, GitHub enrichment — is completely cause-agnostic.
 *
 *  To retarget the tool (e.g. for an animal shelter or a literacy nonprofit):
 *    1. Change `orgName` + `impact` to the new program's economics.
 *    2. Swap `affinity` keywords/label to a personal tie to *that* cause.
 *    3. Update the donation link in `client/src/config.js`.
 *  That's it — no logic changes.
 */
export const CAUSE = {
  // Organization identity.
  orgName: 'Code for Ukraine',

  // Canonical public donation link. Server-sourced (never from the client): the
  // Campaign Agent embeds ONLY this URL in drafts/replies, and enforceDonationLink
  // strips any other link. Mirrors client/src/config.js ZEFFY_DONATE_URL. Per-org
  // deployments can override it in org_config (validated http/https-only).
  donateUrl: 'https://www.zeffy.com/en-US/donation-form/fe71a2d0-1133-40ac-9032-897b66b0a7b1',

  // Impact unit economics — what one donation "buys." Drives every impact figure
  // in the app ("$800 = 1 student", "12 students funded", "$57.14 = 1 day").
  impact: {
    programCost: 800, // cost to fund one beneficiary through the full program
    programDays: 14, // length of the program
    dayCost: 57.14, // cost of a single day
    beneficiary: 'student', // singular  → "1 student"
    beneficiaries: 'students', // plural    → "12 students funded"
    programLabel: 'bootcamp', // "= 1 bootcamp"
    dayLabel: 'day of camp', // "= 1 day of camp"
  },

  // Cause affinity — a *personal tie to this cause* is the single strongest
  // predictor of giving. For another nonprofit, swap the keywords + label
  // (e.g. an animal shelter → ['rescue', 'shelter', 'spca', 'humane', ...]).
  affinity: {
    keywords: ['ukraine', 'ukrainian', 'kyiv', 'kiev', 'lviv', 'odesa', 'odessa', 'kharkiv', 'dnipro'],
    weight: 26,
    label: '🇺🇦 Ukraine ties',
  },

  // Broader cause alignment — works the donor's profile for nonprofit / education
  // / community signals. Usually transferable across causes with light edits.
  causeAlignment: {
    keywords: [
      'nonprofit', 'non-profit', 'ngo', 'foundation', 'charity', 'education', 'edtech',
      'teacher', 'professor', 'university', 'school', 'bootcamp', 'mentor',
      'developer advocate', 'devrel', 'community', 'volunteer', 'social impact',
      'for good', 'humanitarian',
    ],
    weight: 6,
    label: '📚 Cause-aligned',
  },
};
