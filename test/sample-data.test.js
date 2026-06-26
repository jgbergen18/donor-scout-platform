// Richer sample data (the "Sample data" toggle / Load sample data). The full demo
// seed must produce a dataset that exercises EVERY surface — Today (reminders +
// awaiting-thanks + prospects + matching-gift worklist), a recurring donor with
// per-gift ledger depth, and an active campaign — and stay idempotent + FK-safe.
// No AI, no send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('the full demo seed populates a rich, demoable dataset', async () => {
  const u = client();
  await u.login({ linkedinId: 'sample-1', name: 'Sam Sample' });
  await u.post('/api/orgs', { name: 'Sample Org' });

  const seed = await u.post('/api/demo/seed');
  assert.equal(seed.status, 200);
  assert.ok(seed.data.connections >= 25, `network seeded (${seed.data.connections})`);
  assert.ok(seed.data.pipeline >= 14, `pipeline seeded (${seed.data.pipeline})`);

  const today = (await u.get('/api/today')).data;
  assert.ok(today.reminders.length >= 1, 'follow-ups due (cadence reminders) populate Today');
  assert.ok(today.unthanked.length >= 1, 'donors awaiting a thank-you');
  assert.ok(today.prospects.length >= 1, 'un-asked prospects to ask');
  assert.ok(today.matchGifts.length >= 1, 'matching-gift worklist populated');
  assert.ok(
    today.matchGifts.some((m) => ['Google', 'Microsoft', 'Amazon'].includes(m.program)),
    'a donor at a known matching-gift employer'
  );

  // A previously-thanked, single-gift donor in the re-ask window populates the
  // second-gift retention lane (Stewardship-on-rails Tier-0).
  assert.ok(today.secondGifts.length >= 1, 'second-gift re-ask lane populated');

  // An active campaign exists so the Campaign + Brief surfaces have content.
  assert.ok((await u.get('/api/campaigns')).data.campaigns.length >= 1, 'an active campaign was seeded');

  // A starter Grants document library so grant reports have material to ground on.
  const grantDocs = (await u.get('/api/documents')).data.documents;
  assert.ok(grantDocs.length >= 4, `Grants documents seeded (${grantDocs.length})`);
  assert.ok(grantDocs.some((d) => d.kind === 'impact'), 'includes an impact document');
  assert.ok(grantDocs.some((d) => d.kind === 'financial'), 'includes a financials document');

  // The recurring donor shows per-gift ledger DEPTH (3 gifts), summed in the cache.
  const refs = (await u.get('/api/referrals')).data.referrals;
  const recurring = refs.find((r) => r.contact_name === 'Yuki Tanaka');
  assert.ok(recurring && recurring.donation_received === 1, 'recurring donor recorded');
  const ledger = (await u.get(`/api/referrals/${recurring.id}/donations`)).data;
  assert.equal(ledger.count, 3, 'three recurring gifts in the ledger');
  assert.equal(ledger.total, 150);
});

test('re-running the demo seed is idempotent (nothing piles up)', async () => {
  const u = client();
  await u.login({ linkedinId: 'sample-2', name: 'Re Run' });
  await u.post('/api/orgs', { name: 'Rerun Org' });
  await u.post('/api/demo/seed');
  const refs1 = (await u.get('/api/referrals')).data.referrals.length;
  const docs1 = (await u.get('/api/documents')).data.documents.length;
  await u.post('/api/demo/seed');
  assert.equal((await u.get('/api/referrals')).data.referrals.length, refs1, 'referrals not duplicated');
  assert.equal((await u.get('/api/campaigns')).data.campaigns.length, 1, 'exactly one campaign (not duplicated)');
  assert.equal((await u.get('/api/documents')).data.documents.length, docs1, 'documents not duplicated');
});

test('an account with a seeded campaign can still be deleted (campaign FK-safe)', async () => {
  const u = client();
  await u.login({ linkedinId: 'sample-del', name: 'Del Me' });
  await u.post('/api/orgs', { name: 'Del Org' });
  await u.post('/api/demo/seed'); // creates a campaign + its agent_* family
  const del = await u.del('/api/account', { confirm: true });
  assert.equal(del.status, 200, 'account deletion no longer trips the campaigns→users FK');
});
