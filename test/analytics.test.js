// Org / manager analytics (GET /api/orgs/analytics): a whole-org rollup ACROSS
// every scout — stage funnel, totals (raised + per-org beneficiaries + active
// scouts + asks/donations + conversion), per-segment conversion (grouped by the
// connection's score_reasons), and a per-scout breakdown. Owner/admin ONLY (a
// member gets 403) and strictly org-scoped (another org's numbers never appear).
// Runs fully offline against an isolated DB (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// Upload one connection for the caller and return its scored prospect row (so the
// test can read the connection id + its score_reasons segments).
async function addConnection(c, { name, email, company }) {
  await c.post('/api/connections/upload', {
    contacts: [{ contact_name: name, contact_email: email, company, linkedin_url: `https://l/${email}` }],
  });
  return (await c.get('/api/prospects')).data.prospects.find((p) => p.contact_name === name);
}

// Put a connection into the pipeline at a given stage. If `donate` is set, record
// the donation (which also flips status → donated).
async function pipeline(c, connectionId, { status = 'asked', donate = 0 } = {}) {
  const ref = await c.post('/api/referrals', { connectionId, status });
  const refId = ref.data.referral.id;
  if (donate) {
    const d = await c.post(`/api/referrals/${refId}/donation`, { amount: donate });
    assert.equal(d.status, 200);
  }
  return refId;
}

test('org analytics: funnel, totals, per-scout breakdown, per-segment conversion', async () => {
  // ── Org A: owner (company Acme so "coworker" matches Acme contacts) ──
  const owner = client();
  await owner.login({ linkedinId: 'an-owner', name: 'Olive Owner' });
  await owner.post('/api/orgs', { name: 'Analytics Org' });
  await owner.post('/api/profile', { company: 'Acme' });
  const orgCode = (await owner.get('/api/orgs/me')).data.org.joinCode;

  // A second scout joins the SAME org (a member).
  const mate = client();
  await mate.login({ linkedinId: 'an-mate', name: 'Manny Mate' });
  await mate.post('/api/orgs/join', { code: orgCode });

  // ── Owner pipeline: spread across every stage ──
  // Two Acme coworkers (segment: Coworker + Reachable). One donates, one is asked.
  const cw1 = await addConnection(owner, { name: 'CW Donor', email: 'cw1@x.test', company: 'Acme' });
  const cw2 = await addConnection(owner, { name: 'CW Asked', email: 'cw2@x.test', company: 'Acme' });
  assert.ok(
    cw1.score_reasons.some((r) => /Coworker/.test(r.label || r)),
    'Acme contact gets a Coworker segment relative to the Acme owner'
  );
  await pipeline(owner, cw1.id, { donate: 500 }); // → donated
  await pipeline(owner, cw2.id, { status: 'asked' }); // → asked

  // Two non-coworker contacts (segment: Reachable only). One follows up, one declines.
  const r1 = await addConnection(owner, { name: 'Reach Follow', email: 'r1@x.test', company: 'Globex' });
  const r2 = await addConnection(owner, { name: 'Reach Declined', email: 'r2@x.test', company: 'Globex' });
  await pipeline(owner, r1.id, { status: 'following_up' });
  await pipeline(owner, r2.id, { status: 'declined' });

  // One queued-but-not-asked (to_ask).
  const q1 = await addConnection(owner, { name: 'Queued', email: 'q1@x.test', company: 'Initech' });
  await pipeline(owner, q1.id, { status: 'to_ask' });

  // ── Mate pipeline: one ask that donates ──
  const m1 = await addConnection(mate, { name: 'Mate Donor', email: 'm1@x.test', company: 'Wayne' });
  await pipeline(mate, m1.id, { donate: 300 }); // → donated

  // ── Read analytics as the owner ──
  const res = await owner.get('/api/orgs/analytics');
  assert.equal(res.status, 200);
  const { funnel, totals, segments, scouts } = res.data;

  // Funnel counts: 1 to_ask, 1 asked, 1 following_up, 2 donated (owner+mate), 1 declined.
  assert.equal(funnel.counts.to_ask, 1, 'to_ask count');
  assert.equal(funnel.counts.asked, 1, 'asked count');
  assert.equal(funnel.counts.following_up, 1, 'following_up count');
  assert.equal(funnel.counts.donated, 2, 'donated = recorded donations across both scouts');
  assert.equal(funnel.counts.declined, 1, 'declined count');

  // Totals. asks = everything that's been asked-or-further (asked + following_up +
  // donated + declined) = 1 + 1 + 2 + 1 = 5. donations = 2. raised = 500 + 300 = 800.
  assert.equal(totals.totalReferrals, 6, 'all 6 pipeline rows org-wide');
  assert.equal(totals.asks, 5, 'asks = asked-or-further');
  assert.equal(totals.donations, 2);
  assert.equal(totals.raised, 800, 'raised sums both scouts donations');
  assert.equal(totals.activeScouts, 2, 'both scouts have pipeline');
  // Per-org economics: default $800/beneficiary → floor(800/800) = 1.
  assert.equal(totals.beneficiariesFunded, 1, 'beneficiaries via per-org economics');
  assert.equal(totals.conversionRate, 2 / 5, 'overall conversion = donations/asks');
  assert.equal(funnel.conversion.overall, 2 / 5);

  // Per-scout breakdown: owner has 4 asks (asked+following_up+donated+declined) +
  // 1 to_ask = 5 referrals, 1 donation, $500. Mate has 1 ask, 1 donation, $300.
  const byName = Object.fromEntries(scouts.map((s) => [s.name, s]));
  assert.equal(byName['Olive Owner'].totalReferrals, 5);
  assert.equal(byName['Olive Owner'].asks, 4);
  assert.equal(byName['Olive Owner'].donations, 1);
  assert.equal(byName['Olive Owner'].raised, 500);
  assert.equal(byName['Olive Owner'].conversionRate, 1 / 4);
  assert.equal(byName['Manny Mate'].asks, 1);
  assert.equal(byName['Manny Mate'].donations, 1);
  assert.equal(byName['Manny Mate'].raised, 300);
  assert.equal(byName['Manny Mate'].conversionRate, 1);

  // Per-segment conversion. The Coworker segment (only the 2 Acme contacts: cw1
  // donated, cw2 asked) → 1/2 conversion. "Reachable" covers every owner contact
  // with an email (5 of them) — used here just to assert it's tracked & has asks.
  const bySeg = Object.fromEntries(segments.map((s) => [s.segment, s]));
  const coworkerKey = Object.keys(bySeg).find((k) => /Coworker/.test(k));
  assert.ok(coworkerKey, 'a coworker segment is reported');
  assert.equal(bySeg[coworkerKey].asks, 2, 'two coworker-tied referrals');
  assert.equal(bySeg[coworkerKey].donations, 1, 'one coworker donated');
  assert.equal(bySeg[coworkerKey].conversionRate, 0.5);
  const reachableKey = Object.keys(bySeg).find((k) => /Reachable/.test(k));
  assert.ok(reachableKey, 'a reachable segment is reported');
  assert.ok(bySeg[reachableKey].asks >= 2, 'reachable segment has referrals');
});

test('org analytics: a member gets 403', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'an403-owner' });
  await owner.post('/api/orgs', { name: 'Gated Org' });
  const code = (await owner.get('/api/orgs/me')).data.org.joinCode;

  const member = client();
  await member.login({ linkedinId: 'an403-member' });
  await member.post('/api/orgs/join', { code });

  assert.equal((await member.get('/api/orgs/analytics')).status, 403, 'members cannot see org analytics');
  assert.equal((await owner.get('/api/orgs/analytics')).status, 200, 'owner can');
});

test('org analytics is org-isolated: another org never appears in the numbers', async () => {
  // Org A: a single donation of $700.
  const a = client();
  await a.login({ linkedinId: 'an-iso-a', name: 'A Owner' });
  await a.post('/api/orgs', { name: 'Iso Analytics A' });
  const aConn = await addConnection(a, { name: 'A Donor', email: 'isoa@x.test', company: 'Acme' });
  await pipeline(a, aConn.id, { donate: 700 });

  // Org B: a much larger donation that must NEVER leak into A's analytics.
  const b = client();
  await b.login({ linkedinId: 'an-iso-b', name: 'B Owner' });
  await b.post('/api/orgs', { name: 'Iso Analytics B' });
  const bConn = await addConnection(b, { name: 'B Donor', email: 'isob@x.test', company: 'Acme' });
  await pipeline(b, bConn.id, { donate: 99999 });

  const aData = (await a.get('/api/orgs/analytics')).data;
  assert.equal(aData.totals.raised, 700, 'A only sees its own $700');
  assert.equal(aData.totals.activeScouts, 1, 'only A’s scout');
  assert.equal(aData.scouts.length, 1, 'only A’s scout in the breakdown');
  assert.ok(aData.scouts.every((s) => s.raised !== 99999), 'no org-B figure leaks in');
  assert.ok(aData.scouts.every((s) => s.name !== 'B Owner'), 'no org-B scout leaks in');

  const bData = (await b.get('/api/orgs/analytics')).data;
  assert.equal(bData.totals.raised, 99999, 'B sees its own number, isolated');
});
