// Regression: the existing single-org features still work end-to-end under org
// scoping — demo seed (prospects + pipeline + donations), impact, the pipeline,
// and history upload + the org-scoped "delete my data" promise.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('demo seed populates prospects, pipeline, and impact for a single-org user', async () => {
  const u = client();
  await u.login({ linkedinId: 'demo-regression', name: 'Demo Scout' });

  const seed = await u.post('/api/demo/seed');
  assert.equal(seed.status, 200);
  assert.ok(seed.data.connections > 0, 'demo seeded prospects');
  assert.ok(seed.data.pipeline > 0, 'demo seeded pipeline');

  const prospects = await u.get('/api/prospects');
  assert.ok(prospects.data.prospects.length > 0);

  const refs = await u.get('/api/referrals');
  assert.ok(refs.data.referrals.length > 0);

  // Impact reflects the seeded donations.
  const impact = await u.get('/api/impact');
  assert.ok(impact.data.totalRaised > 0, 'demo donations roll up into impact');

  // Clearing wipes the caller's own data.
  await u.post('/api/demo/clear');
  assert.equal((await u.get('/api/prospects')).data.prospects.length, 0);
});

test('pipeline + donation flow and org-scoped history delete', async () => {
  const u = client();
  await u.login({ linkedinId: 'pipeline-regression' });
  await u.post('/api/orgs', { name: 'Pipeline Org' });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Pat Donor', contact_email: 'pat@x.test', company: 'Acme', linkedin_url: 'https://l/pat' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;

  const ref = await u.post('/api/referrals', { connectionId: connId });
  assert.equal(ref.status, 201);
  const refId = ref.data.referral.id;

  const donated = await u.post(`/api/referrals/${refId}/donation`, { amount: 250 });
  assert.equal(donated.status, 200);
  assert.equal(donated.data.referral.donation_received, 1);
  assert.ok(donated.data.impact.total >= 250);

  // History upload + summary, then the org-scoped delete promise.
  await u.post('/api/history/upload', {
    history: [{ name: 'Pat Donor', last: '2025-01-01', count: 4, sent: 2, received: 2, snippets: [] }],
    voiceSample: 'Hi there, hope you are well!',
  });
  const sum = await u.get('/api/history/summary');
  assert.equal(sum.data.contacts, 1);
  assert.ok(sum.data.voiceChars > 0);

  const del = await u.del('/api/history');
  assert.equal(del.status, 200);
  assert.equal((await u.get('/api/history/summary')).data.contacts, 0);
});

test('AI dossier degrades gracefully without an API key (503, not crash)', async () => {
  const u = client();
  await u.login({ linkedinId: 'ai-regression' });
  await u.post('/api/orgs', { name: 'AI Org' });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Dana Lead', company: 'Acme', linkedin_url: 'https://l/dana' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;
  const res = await u.post(`/api/connections/${connId}/dossier`, {});
  assert.equal(res.status, 503, 'no ANTHROPIC_API_KEY → graceful 503');
});
