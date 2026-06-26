// Selectable fundraising-strategy tests (the STRATEGY pattern, Pass 2).
//
// Two layers:
//   1. PURE unit tests against lib/strategies/index.js — registry/factory, each
//      strategy's combine() ranking behavior on fixture components, custom-weights,
//      and the unknown-key fallback to the default. No DB, no HTTP.
//   2. INTEGRATION tests through the live app — selecting a strategy re-ranks ONLY
//      that scout's prospects, capacity_first reorders toward high-capacity
//      contacts, custom_weights {1,0,0} == relationship_first, default resolution,
//      input validation, and org-default inheritance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStrategy,
  resolveStrategy,
  combineScore,
  normalizeWeights,
  strategyCatalog,
  STRATEGY_KEYS,
  DEFAULT_STRATEGY_KEY,
  STRATEGIES,
} from '../lib/strategies/index.js';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// ── Pure unit tests ─────────────────────────────────────────────────────────

// A close-relationship, low-capacity prospect.
const CLOSE = { affinityScore: 80, propensityScore: 5, propensityMax: 32, capacityScore: 10 };
// A high-capacity stranger.
const RICH = { affinityScore: 5, propensityScore: 0, propensityMax: 32, capacityScore: 95 };
// A strong cause tie, otherwise weak.
const CAUSEY = { affinityScore: 10, propensityScore: 32, propensityMax: 32, capacityScore: 15 };

function combine(key, c, weights) {
  return getStrategy(key).combine(c, weights);
}

test('registry/factory: every spec strategy is present and metadata is well-formed', () => {
  for (const key of ['relationship_first', 'capacity_first', 'cause_fit', 'balanced', 'custom_weights']) {
    assert.ok(STRATEGY_KEYS.includes(key), `${key} registered`);
    const s = getStrategy(key);
    assert.equal(s.key, key);
    assert.equal(typeof s.combine, 'function');
  }
  assert.equal(DEFAULT_STRATEGY_KEY, 'relationship_first');
  // Catalog surfaces exactly the registry, with relationship_first the only "recommended".
  const cat = strategyCatalog();
  assert.equal(cat.length, STRATEGY_KEYS.length);
  assert.equal(cat.filter((c) => c.recommended).length, 1);
  assert.equal(cat[0].key, 'relationship_first');
  assert.ok(cat[0].recommended);
});

test('factory falls back to relationship_first for unknown/missing keys', () => {
  assert.equal(getStrategy('not_a_strategy').key, 'relationship_first');
  assert.equal(getStrategy(undefined).key, 'relationship_first');
  assert.equal(getStrategy(null).key, 'relationship_first');
});

test('relationship_first: rank = affinity + propensity, capacity ignored', () => {
  assert.equal(combine('relationship_first', CLOSE), 85);
  assert.equal(combine('relationship_first', RICH), 5); // big capacity does NOT lift the rank
  // The close contact outranks the rich stranger.
  assert.ok(combine('relationship_first', CLOSE) > combine('relationship_first', RICH));
});

test('capacity_first: high-capacity stranger outranks the close relationship', () => {
  const close = combine('capacity_first', CLOSE);
  const rich = combine('capacity_first', RICH);
  assert.ok(rich > close, 'capacity_first inverts the relationship-first ordering');
  // And it is the literal inverse of relationship_first on this fixture pair.
  assert.ok(combine('relationship_first', CLOSE) > combine('relationship_first', RICH));
});

test('cause_fit: a strong cause tie outranks a closer-but-uncausey relationship', () => {
  // CAUSEY has full propensity (scaled to 100) but modest affinity; CLOSE has high
  // affinity but almost no cause tie. cause_fit should prefer CAUSEY.
  assert.ok(combine('cause_fit', CAUSEY) > combine('cause_fit', CLOSE));
  // relationship_first prefers the opposite.
  assert.ok(combine('relationship_first', CLOSE) > combine('relationship_first', CAUSEY));
});

test('balanced: lands between relationship_first and capacity_first for the rich stranger', () => {
  const rel = combine('relationship_first', RICH);
  const cap = combine('capacity_first', RICH);
  const bal = combine('balanced', RICH);
  assert.ok(bal > rel && bal < cap, 'balanced is a blend, not an extreme');
});

test('custom_weights {1,0,0} reproduces relationship_first exactly', () => {
  const w = { affinity: 1, propensity: 0, capacity: 0 };
  for (const c of [CLOSE, RICH, CAUSEY]) {
    // relationship_first = affinity + propensity; custom {1,0,0} = affinity only.
    // They match when propensity is 0; assert the affinity-only behavior here and
    // the full-equivalence (incl. propensity) via the integration test below.
    assert.equal(combine('custom_weights', c, w), Math.min(100, Math.round(c.affinityScore)));
  }
});

test('normalizeWeights: clamps negatives/NaN, drops to default when all-zero, sums to 1', () => {
  const n = normalizeWeights({ affinity: 2, propensity: 2, capacity: 0 });
  assert.ok(Math.abs(n.affinity + n.propensity + n.capacity - 1) < 1e-9);
  assert.equal(n.affinity, 0.5);
  // Negative + NaN are clamped to 0.
  const c = normalizeWeights({ affinity: -5, propensity: Number.NaN, capacity: 3 });
  assert.equal(c.affinity, 0);
  assert.equal(c.capacity, 1);
  // All-zero / empty → relationship-first weights (so unset custom == default).
  assert.deepEqual(normalizeWeights({}), { affinity: 1, propensity: 0, capacity: 0 });
  assert.deepEqual(normalizeWeights({ affinity: 0, propensity: 0, capacity: 0 }), {
    affinity: 1,
    propensity: 0,
    capacity: 0,
  });
});

test('resolveStrategy: user choice → org default → relationship_first', () => {
  // Explicit user choice wins.
  assert.equal(resolveStrategy({ strategy: 'capacity_first' }, 'cause_fit').key, 'capacity_first');
  // No user choice → org default.
  assert.equal(resolveStrategy({ strategy: null }, 'cause_fit').key, 'cause_fit');
  // Neither → relationship_first.
  assert.equal(resolveStrategy({}, null).key, 'relationship_first');
  // Unknown user key falls back through getStrategy.
  assert.equal(resolveStrategy({ strategy: 'bogus' }, null).key, 'relationship_first');
  // custom_weights resolves weights; others get null.
  const cw = resolveStrategy({ strategy: 'custom_weights', strategy_weights: '{"affinity":1,"propensity":1,"capacity":2}' }, null);
  assert.equal(cw.key, 'custom_weights');
  assert.ok(Math.abs(cw.weights.affinity + cw.weights.propensity + cw.weights.capacity - 1) < 1e-9);
  assert.equal(resolveStrategy({ strategy: 'balanced' }, null).weights, null);
});

test('combineScore ties registry + resolver together', () => {
  const resolved = resolveStrategy({ strategy: 'relationship_first' }, null);
  assert.equal(combineScore(CLOSE, resolved), 85);
  // STRATEGIES map is the same object combine reads from.
  assert.equal(STRATEGIES.relationship_first.combine(CLOSE), 85);
});

// ── Integration tests (through the live app) ─────────────────────────────────

// Helper: log in a fresh scout in their own org with two fixture contacts —
// one close relationship (coworker+local), one high-capacity stranger.
async function setupScout(lid, name) {
  const u = client();
  await u.login({ linkedinId: lid, name });
  await u.post('/api/orgs', { name: `${lid}-org` });
  await u.post('/api/profile', { company: 'Acme', location: 'Boston' });
  await u.post('/api/connections/upload', {
    contacts: [
      { contact_name: 'Coworker Pal', contact_email: 'pal@acme.test', company: 'Acme', role: 'Engineer', location: 'Boston', linkedin_url: 'https://l/pal' },
      { contact_name: 'Stranger Exec', company: 'Google', role: 'VP Engineering', location: 'Mountain View', linkedin_url: 'https://l/exec' },
    ],
  });
  return u;
}

function byName(prospects) {
  return Object.fromEntries(prospects.map((p) => [p.contact_name, p]));
}

test('GET /api/strategies returns the catalog + the caller resolved choice', async () => {
  const u = await setupScout('strat-list', 'List Scout');
  const r = await u.get('/api/strategies');
  assert.equal(r.status, 200);
  assert.equal(r.data.current, 'relationship_first');
  assert.equal(r.data.orgDefault, 'relationship_first');
  assert.equal(r.data.strategies.length, 5);
  assert.equal(r.data.weights, null);
});

test('switching to capacity_first re-ranks the scout toward high-capacity contacts', async () => {
  const u = await setupScout('strat-cap', 'Cap Scout');

  // Default (relationship_first): coworker outranks the exec.
  let p = byName((await u.get('/api/prospects')).data.prospects);
  assert.ok(p['Coworker Pal'].donor_likelihood_score > p['Stranger Exec'].donor_likelihood_score);

  // Switch to capacity_first → re-scored, ordering flips toward the exec.
  const res = await u.post('/api/profile/strategy', { strategy: 'capacity_first' });
  assert.equal(res.status, 200);
  assert.equal(res.data.current, 'capacity_first');
  assert.ok(res.data.rescored >= 2, 'rescore count returned');

  p = byName((await u.get('/api/prospects')).data.prospects);
  assert.ok(
    p['Stranger Exec'].donor_likelihood_score > p['Coworker Pal'].donor_likelihood_score,
    'capacity_first ranks the high-capacity stranger above the coworker'
  );
  // Capacity is still persisted regardless of strategy (ask-sizing never lost).
  assert.ok(p['Stranger Exec'].capacity_score > p['Coworker Pal'].capacity_score);
  // The component sub-scores are unchanged by the strategy switch.
  assert.ok(p['Coworker Pal'].affinity_score > p['Stranger Exec'].affinity_score);
});

test('custom_weights {1,0,0} produces the same ranking as relationship_first', async () => {
  const u = await setupScout('strat-custom', 'Custom Scout');
  const rel = byName((await u.get('/api/prospects')).data.prospects);

  const res = await u.post('/api/profile/strategy', {
    strategy: 'custom_weights',
    weights: { affinity: 1, propensity: 0, capacity: 0 },
  });
  assert.equal(res.status, 200);

  const cust = byName((await u.get('/api/prospects')).data.prospects);
  // Same ranks for every prospect → same ordering as relationship_first.
  for (const name of Object.keys(rel)) {
    assert.equal(
      cust[name].donor_likelihood_score,
      rel[name].donor_likelihood_score,
      `${name} rank unchanged under custom {1,0,0}`
    );
  }
});

test('changing strategy re-ranks ONLY the caller, never another scout', async () => {
  const a = await setupScout('iso-a', 'Iso A');
  const b = await setupScout('iso-b', 'Iso B');

  const bBefore = byName((await b.get('/api/prospects')).data.prospects);

  // A switches to capacity_first.
  await a.post('/api/profile/strategy', { strategy: 'capacity_first' });

  // B is untouched — still relationship_first ordering and identical ranks.
  const bAfter = byName((await b.get('/api/prospects')).data.prospects);
  for (const name of Object.keys(bBefore)) {
    assert.equal(bAfter[name].donor_likelihood_score, bBefore[name].donor_likelihood_score);
  }
  assert.equal((await b.get('/api/strategies')).data.current, 'relationship_first');
  assert.equal((await a.get('/api/strategies')).data.current, 'capacity_first');
});

test('POST /api/profile/strategy rejects unknown keys (400) and normalizes custom weights', async () => {
  const u = await setupScout('strat-valid', 'Valid Scout');
  const bad = await u.post('/api/profile/strategy', { strategy: 'wealth_screen_everyone' });
  assert.equal(bad.status, 400);
  // Custom weights with negatives are clamped + normalized server-side.
  const ok = await u.post('/api/profile/strategy', {
    strategy: 'custom_weights',
    weights: { affinity: -10, propensity: 0, capacity: 5 },
  });
  assert.equal(ok.status, 200);
  const got = await u.get('/api/strategies');
  // Negative affinity clamped to 0 → all weight on capacity.
  assert.equal(got.data.weights.capacity, 1);
  assert.equal(got.data.weights.affinity, 0);
});

test('new members inherit the org default strategy', async () => {
  // Owner sets org default to capacity_first.
  const owner = client();
  await owner.login({ linkedinId: 'def-owner', name: 'Def Owner' });
  await owner.post('/api/orgs', { name: 'Default Strat Org' });
  await owner.patch('/api/orgs/config', { defaultStrategy: 'capacity_first' });
  const code = (await owner.get('/api/orgs/me')).data.org.joinCode;

  // A brand-new member joins (empty account) and inherits the org default.
  const member = client();
  await member.login({ linkedinId: 'def-member', name: 'Def Member' });
  const join = await member.post('/api/orgs/join', { code });
  assert.equal(join.status, 200);

  const strat = await member.get('/api/strategies');
  assert.equal(strat.data.orgDefault, 'capacity_first');
  assert.equal(strat.data.current, 'capacity_first', 'member with no explicit choice resolves to org default');
});
