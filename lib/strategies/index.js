/**
 * Fundraising strategies — the STRATEGY pattern over the component sub-scores.
 * ----------------------------------------------------------------------------
 * server.js's scoreProspect() is now a PURE component scorer: it derives three
 * independent sub-scores for a prospect relative to a scout —
 *
 *   affinityScore   (0..90)  — relationship strength (family/school/coworker/
 *                              reachable/local). "Do I actually know them?"
 *   propensityScore (0..propensityMax) — cause fit (a personal tie to the cause
 *                              + broader cause-aligned signals). Capped low by
 *                              the per-org cause config (default 32).
 *   capacityScore   (0..100) — estimated giving capacity (company tier + GitHub
 *                              footprint + role seniority). Sizes the ASK.
 *
 * A FundraisingStrategy is a small value object (not a class — matches server.js's
 * function-first, single-file style) that combines those three components into the
 * final donor_likelihood_score (the RANK). Each strategy is interchangeable behind
 * a common shape:
 *
 *   {
 *     key, name, description, ranksBy,   // metadata (surfaced via /api/strategies)
 *     recommended: boolean,              // relationship-first is the safe default
 *     combine(components, weights) -> 0..100   // the pure ranking function
 *   }
 *
 * `components` is a StrategyComponents bag: { affinityScore, propensityScore,
 * propensityMax, capacityScore }. `combine` is PURE — same inputs, same output —
 * so a user can switch strategy and we recombine the persisted sub-scores WITHOUT
 * re-deriving any signals (no GitHub calls, no re-reading the profile).
 *
 * Ethics note (see docs/fundraising-strategies.md + nonprofitConsiderations):
 * relationship_first is the product default and is labeled "Recommended". Capacity
 * is a display / ask-sizing signal in EVERY strategy — capacity_score is persisted
 * regardless of the chosen strategy so the "ask the people who know you" coaching
 * is never lost, even when a scout opts into capacity_first.
 */

// The display/ranking ceiling. donor_likelihood_score is always clamped to 0..100.
const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));

// Lift the propensity component (capped low — 32 by default) into a 0..100 range so
// the cause-fit / balanced / custom strategies can weight it on the same scale as
// affinity and capacity. Falls back to a sane max if propensityMax is missing/zero.
function scaleProp(components) {
  const max = components.propensityMax || 32;
  return clamp100((100 * (components.propensityScore || 0)) / max);
}

/**
 * Relationship-first (DEFAULT) — today's shipped behavior, byte-for-byte.
 * Ranks by who the scout actually knows, plus a modest cause-propensity boost.
 * Capacity is display/ask-sizing only and never enters the rank here.
 * NOTE: affinityScore + propensityScore is exactly scoreProspect's prior `score`.
 */
const relationship_first = {
  key: 'relationship_first',
  name: 'Relationship-first',
  description:
    "Ranks by who you actually know: shared surname or family, shared school, " +
    "current or former coworker, reachable by email, or same city, plus a modest " +
    "cause boost. Capacity is shown but does NOT drive rank; it only sizes the " +
    "suggested ask. Relationship strength predicts a 'yes' better than wealth.",
  ranksBy: 'affinity + propensity (capped 100); capacity is ask-sizing + tiebreaker only.',
  recommended: true,
  combine(c) {
    return clamp100((c.affinityScore || 0) + (c.propensityScore || 0));
  },
};

/**
 * Capacity-first — ranks by estimated giving capacity ahead of relationship.
 * Opt-in only (surfaced with an in-app caution) because it inverts the product's
 * relationship-led thesis. relationshipBlend = affinity + propensity, normalized.
 */
const capacity_first = {
  key: 'capacity_first',
  name: 'Capacity-first',
  description:
    'Ranks by estimated giving capacity (company tier + GitHub footprint + role ' +
    'seniority) ahead of relationship. For campaigns explicitly chasing larger ' +
    'gifts. Opt-in: it can steer outreach toward strangers, so use capacity to ' +
    'size the ask, not to pick who to ask.',
  ranksBy: 'round(0.7*capacity + 0.3*relationshipBlend); affinity breaks ties.',
  recommended: false,
  combine(c) {
    const relationshipBlend = clamp100((c.affinityScore || 0) + (c.propensityScore || 0));
    return clamp100(0.7 * (c.capacityScore || 0) + 0.3 * relationshipBlend);
  },
};

/**
 * Cause-fit / Propensity-first — ranks by alignment with the cause. Lifts the
 * (normally low-capped) propensity component to a 0..100 range so a personal tie
 * to the cause dominates the rank. Best when the cause is emotionally specific.
 */
const cause_fit = {
  key: 'cause_fit',
  name: 'Cause-fit',
  description:
    'Ranks by alignment with the cause: a personal tie to the cause (org affinity ' +
    'keywords, e.g. Ukraine ties) and broader cause-aligned signals. Best when the ' +
    'cause is emotionally specific and self-selecting donors matter more than ' +
    'network closeness.',
  ranksBy: 'round(0.6*propensityScaled + 0.4*affinity); capacity breaks ties.',
  recommended: false,
  combine(c) {
    return clamp100(0.6 * scaleProp(c) + 0.4 * (c.affinityScore || 0));
  },
};

/**
 * Balanced blend — a fixed, pre-tuned weighting of all three components for scouts
 * who want capacity to matter without abandoning relationship. "One knob, already
 * tuned" between relationship-first and capacity-first.
 */
const balanced = {
  key: 'balanced',
  name: 'Balanced blend',
  description:
    'A fixed, sensible weighted blend of all three components for scouts who want ' +
    'capacity to matter without abandoning relationship. A one-knob, already-tuned ' +
    'option between relationship-first and capacity-first.',
  ranksBy: 'round(0.45*affinity + 0.20*propensityScaled + 0.35*capacity).',
  recommended: false,
  combine(c) {
    return clamp100(
      0.45 * (c.affinityScore || 0) + 0.2 * scaleProp(c) + 0.35 * (c.capacityScore || 0)
    );
  },
};

/**
 * Custom weights — the scout tunes the relative weight of Affinity, Propensity,
 * and Capacity (three sliders that normalize to 1). Falls back to relationship-
 * first weights {affinity:1,propensity:0,capacity:0} if unset, so an un-edited
 * custom strategy reproduces relationship_first's ranking exactly.
 */
const DEFAULT_CUSTOM_WEIGHTS = { affinity: 1, propensity: 0, capacity: 0 };

const custom_weights = {
  key: 'custom_weights',
  name: 'Custom weights',
  description:
    'Advanced: you tune the relative weight of Affinity, Propensity, and Capacity ' +
    'yourself (three sliders that normalize to 100%). For power users and org admins ' +
    'setting a house style. Defaults to relationship-first weights until edited.',
  ranksBy: 'round(wA*affinity + wP*propensityScaled + wC*capacity), weights sum to 1.',
  recommended: false,
  combine(c, weights) {
    const w = normalizeWeights(weights);
    return clamp100(
      w.affinity * (c.affinityScore || 0) +
        w.propensity * scaleProp(c) +
        w.capacity * (c.capacityScore || 0)
    );
  },
};

// Normalize a {affinity,propensity,capacity} weight bag: clamp each to >= 0, drop
// NaN/missing, and rescale so they sum to 1. Falls back to relationship-first
// weights when the bag is empty/all-zero (so an unset custom strategy == default).
export function normalizeWeights(weights) {
  const a = Math.max(0, Number(weights?.affinity) || 0);
  const p = Math.max(0, Number(weights?.propensity) || 0);
  const c = Math.max(0, Number(weights?.capacity) || 0);
  const sum = a + p + c;
  if (sum <= 0) return { ...DEFAULT_CUSTOM_WEIGHTS };
  return { affinity: a / sum, propensity: p / sum, capacity: c / sum };
}

// ── The registry (a plain map keyed by strategy key) ────────────────────────
const STRATEGIES = {
  relationship_first,
  capacity_first,
  cause_fit,
  balanced,
  custom_weights,
};

// The product default everywhere: relationship strength predicts a "yes" best.
export const DEFAULT_STRATEGY_KEY = 'relationship_first';

// Every known key — used by server.js for input validation (PATCH /api/orgs/config
// defaultStrategy + POST /api/profile/strategy).
export const STRATEGY_KEYS = Object.keys(STRATEGIES);

/**
 * Resolve a strategy by key (the FACTORY). Unknown / missing keys fall back to the
 * default (relationship_first) so a bad value can never break ranking.
 */
export function getStrategy(key) {
  return STRATEGIES[key] || STRATEGIES[DEFAULT_STRATEGY_KEY];
}

/**
 * Resolve the effective strategy + weights for a user row: user.strategy → org
 * default → relationship_first. Mirrors orgConfigForUserId's resolution order.
 * `orgDefault` is the org_config.defaultStrategy (server.js passes it in so this
 * module stays DB-free and pure). Returns { key, strategy, weights }.
 */
export function resolveStrategy(user, orgDefault) {
  const key = (user && user.strategy) || orgDefault || DEFAULT_STRATEGY_KEY;
  const strategy = getStrategy(key);
  let weights = null;
  if (strategy.key === 'custom_weights') {
    let parsed = null;
    if (user && user.strategy_weights) {
      try {
        parsed = JSON.parse(user.strategy_weights);
      } catch {
        parsed = null;
      }
    }
    weights = normalizeWeights(parsed);
  }
  return { key: strategy.key, strategy, weights };
}

/**
 * Combine component sub-scores into a final donor_likelihood_score for a resolved
 * strategy. `resolved` is the object returned by resolveStrategy(). PURE.
 */
export function combineScore(components, resolved) {
  return resolved.strategy.combine(components, resolved.weights);
}

// Public metadata for the strategy picker (GET /api/strategies). Order matters:
// relationship-first first (it's the recommended default).
export function strategyCatalog() {
  return STRATEGY_KEYS.map((key) => {
    const s = STRATEGIES[key];
    return {
      key: s.key,
      name: s.name,
      description: s.description,
      ranksBy: s.ranksBy,
      recommended: !!s.recommended,
    };
  });
}

export { STRATEGIES };
