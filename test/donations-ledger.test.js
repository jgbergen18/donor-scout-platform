// Per-gift donations ledger (the keystone). Every recorded gift flows through the
// recordGift() funnel: it appends a row to the `donations` ledger AND refreshes the
// referral's denormalized donation_* cache (received = EXISTS, amount = SUM, date =
// MAX) in the same write. These tests pin: append + multi-gift rollup, idempotent
// dedupe (re-imports are no-ops), the org-scoped read endpoint, and cascade delete.
// All no-AI / no-send — they run fully offline against the shared harness.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

const upload = (u, contacts) => u.post('/api/connections/upload', { contacts });
const refByName = async (u, name) =>
  (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === name);

test('ledger appends multiple gifts and the referral cache rolls up to SUM / MAX / received', async () => {
  const u = client();
  await u.login({ linkedinId: 'ledger-a', name: 'Ana A' });
  await u.post('/api/orgs', { name: 'Ledger Org' });
  await upload(u, [{ contact_name: 'Dana Match', company: 'Google', linkedin_url: 'https://l/dana' }]);

  // Two DIFFERENT gifts (different dates) → two ledger rows, summed cache.
  let rec = await u.post('/api/donations/reconcile', { donors: [{ name: 'Dana Match', amount: 100, date: '2026-01-01' }] });
  assert.equal(rec.status, 200);
  assert.ok(rec.data.recorded + rec.data.createdFromConnections >= 1, 'first gift recorded');
  rec = await u.post('/api/donations/reconcile', { donors: [{ name: 'Dana Match', amount: 50, date: '2026-02-15' }] });
  assert.ok(rec.data.recorded >= 1, 'second, distinct gift recorded (not a duplicate)');

  const dana = await refByName(u, 'Dana Match');
  assert.equal(dana.donation_received, 1, 'cache flag set');
  assert.equal(dana.donation_amount, 150, 'cache amount = SUM of the ledger');
  assert.ok(String(dana.donation_date).startsWith('2026-02-15'), 'cache date = MAX (most recent gift)');

  const ledger = (await u.get(`/api/referrals/${dana.id}/donations`)).data;
  assert.equal(ledger.count, 2, 'two ledger rows');
  assert.equal(ledger.total, 150);
  assert.deepEqual(ledger.donations.map((d) => d.amount).sort((a, b) => a - b), [50, 100]);
});

test('re-importing the same gift is idempotent (dedupe), reported as alreadyRecorded', async () => {
  const u = client();
  await u.login({ linkedinId: 'ledger-dedupe', name: 'Dee D' });
  await u.post('/api/orgs', { name: 'Dedupe Org' });
  await upload(u, [{ contact_name: 'Sam Same', company: 'Acme', linkedin_url: 'https://l/sam' }]);

  await u.post('/api/donations/reconcile', { donors: [{ name: 'Sam Same', amount: 80, date: '2026-03-01' }] });
  // Same person, same amount, same day → the dedupe index ignores it.
  const again = await u.post('/api/donations/reconcile', { donors: [{ name: 'Sam Same', amount: 80, date: '2026-03-01' }] });
  assert.ok(again.data.alreadyRecorded >= 1, 'duplicate gift reported as already recorded');
  assert.equal(again.data.recorded, 0, 'duplicate not counted as a new gift');

  const sam = await refByName(u, 'Sam Same');
  assert.equal(sam.donation_amount, 80, 'amount not double-counted');
  const ledger = (await u.get(`/api/referrals/${sam.id}/donations`)).data;
  assert.equal(ledger.count, 1, 'still exactly one ledger row');
});

test('the manual donation route appends to the ledger and dedupes a same-day repeat', async () => {
  const u = client();
  await u.login({ linkedinId: 'ledger-manual', name: 'Mae M' });
  await u.post('/api/orgs', { name: 'Manual Org' });
  await upload(u, [{ contact_name: 'Pat Prospect', company: 'Acme', linkedin_url: 'https://l/pat' }]);
  // Add to pipeline so there's a referral to record against.
  const pid = (await u.get('/api/prospects')).data.prospects.find((p) => p.contact_name === 'Pat Prospect').id;
  await u.post('/api/referrals', { connectionId: pid });
  const ref = await refByName(u, 'Pat Prospect');

  const first = await u.post(`/api/referrals/${ref.id}/donation`, { amount: 200 });
  assert.equal(first.status, 200);
  assert.equal(first.data.alreadyRecorded, false);
  // Same referral + amount + same day → idempotent no-op.
  const dup = await u.post(`/api/referrals/${ref.id}/donation`, { amount: 200 });
  assert.equal(dup.data.alreadyRecorded, true, 'same-day repeat reported, not double-counted');

  const ledger = (await u.get(`/api/referrals/${ref.id}/donations`)).data;
  assert.equal(ledger.count, 1);
  assert.equal(ledger.total, 200);
});

test('the donations ledger read is org-scoped — another org cannot read it', async () => {
  const a = client();
  await a.login({ linkedinId: 'ledger-iso-a', name: 'Ana' });
  await a.post('/api/orgs', { name: 'Iso A' });
  await upload(a, [{ contact_name: 'Ann Donor', company: 'Acme', linkedin_url: 'https://l/ann' }]);
  await a.post('/api/donations/reconcile', { donors: [{ name: 'Ann Donor', amount: 60 }] });
  const ann = await refByName(a, 'Ann Donor');
  assert.ok((await a.get(`/api/referrals/${ann.id}/donations`)).data.count >= 1, 'owner can read');

  const b = client();
  await b.login({ linkedinId: 'ledger-iso-b', name: 'Bo' });
  await b.post('/api/orgs', { name: 'Iso B' });
  const cross = await b.get(`/api/referrals/${ann.id}/donations`);
  assert.equal(cross.status, 404, "org B cannot read org A's gift ledger");
});

test('a non-positive amount never fabricates a gift (record 400s, reconcile skips)', async () => {
  const u = client();
  await u.login({ linkedinId: 'ledger-zero', name: 'Zee Z' });
  await u.post('/api/orgs', { name: 'Zero Org' });
  await upload(u, [{ contact_name: 'Zero Donor', company: 'Acme', linkedin_url: 'https://l/zero' }]);

  // record: a 0/blank amount is rejected up front — no ledger row, no donated flag.
  const rec0 = await u.post('/api/donations/record', { donor: { name: 'Zero Donor', amount: 0 } });
  assert.equal(rec0.status, 400, 'zero amount rejected');
  assert.equal((await u.get('/api/referrals')).data.referrals.length, 0, 'no referral fabricated');

  // reconcile: a row with a name but amount 0 is silently skipped, not recorded.
  const rc = await u.post('/api/donations/reconcile', { donors: [{ name: 'Zero Donor', amount: 0 }, { name: 'Real Donor', amount: 30 }] });
  assert.equal(rc.status, 200);
  assert.equal(rc.data.recorded + rc.data.createdFromConnections, 0, 'zero-amount donor not recorded (Zero Donor is a connection, Real is unknown)');
  // Real Donor ($30, not in network) lands in review; Zero Donor never appears.
  assert.ok(!rc.data.unmatchedReview.some((r) => r.name === 'Zero Donor'), 'zero-amount donor not even queued');

  const zero = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'Zero Donor');
  assert.ok(!zero || zero.donation_received === 0, 'Zero Donor never marked donated');
});

test('deleting a referral removes its ledger rows (no orphans, FK-safe)', async () => {
  const u = client();
  await u.login({ linkedinId: 'ledger-del', name: 'Del D' });
  await u.post('/api/orgs', { name: 'Delete Org' });
  await upload(u, [{ contact_name: 'Gone Soon', company: 'Acme', linkedin_url: 'https://l/gone' }]);
  await u.post('/api/donations/reconcile', { donors: [{ name: 'Gone Soon', amount: 40 }] });
  const ref = await refByName(u, 'Gone Soon');
  assert.ok((await u.get(`/api/referrals/${ref.id}/donations`)).data.count >= 1);

  const del = await u.del(`/api/referrals/${ref.id}`);
  assert.equal(del.status, 200);
  // The referral is gone → the ledger read 404s, and no orphan rows remain.
  assert.equal((await u.get(`/api/referrals/${ref.id}/donations`)).status, 404);
});
