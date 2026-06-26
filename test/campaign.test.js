// Campaign Agent — tenant isolation + graceful degradation (no API key).
// CRUD and org-scoping need no AI; the planner/draft/reply degrade to 503 without
// a key. The AI SUCCESS path (plan → approve → draft → reply) is covered offline
// with a fake client in campaign-agent.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('campaign CRUD works and is strictly org-scoped', async () => {
  const a = client();
  await a.login({ linkedinId: 'camp-a', name: 'Ann A' });
  await a.post('/api/orgs', { name: 'Org A' });

  const created = await a.post('/api/campaigns', { name: 'Alpha', goalAmount: 500, constraints: "don't ask family" });
  assert.equal(created.status, 201);
  const id = created.data.campaign.id;
  assert.equal(created.data.campaign.goalAmount, 500);

  assert.equal((await a.get('/api/campaigns')).data.campaigns.length, 1, 'A lists its campaign');
  assert.equal((await a.get(`/api/campaigns/${id}`)).data.campaign.name, 'Alpha');

  const patched = await a.patch(`/api/campaigns/${id}`, { name: 'Alpha 2', status: 'archived' });
  assert.equal(patched.data.campaign.name, 'Alpha 2');
  assert.equal(patched.data.campaign.status, 'archived');

  // A second org sees and can touch NONE of it (404, no existence leak).
  const b = client();
  await b.login({ linkedinId: 'camp-b', name: 'Bo B' });
  await b.post('/api/orgs', { name: 'Org B' });
  assert.equal((await b.get('/api/campaigns')).data.campaigns.length, 0, 'B sees none of A campaigns');
  assert.equal((await b.get(`/api/campaigns/${id}`)).status, 404);
  assert.equal((await b.patch(`/api/campaigns/${id}`, { name: 'hijack' })).status, 404);
  assert.equal((await b.post(`/api/campaigns/${id}/plan`)).status, 404);
  assert.equal((await b.del(`/api/campaigns/${id}`)).status, 404);

  // A deletes its own.
  assert.equal((await a.del(`/api/campaigns/${id}`)).status, 200);
  assert.equal((await a.get('/api/campaigns')).data.campaigns.length, 0);
});

test('the planner needs candidates, then degrades to 503 without an API key', async () => {
  const u = client();
  await u.login({ linkedinId: 'camp-plan', name: 'Pat Plan' });
  await u.post('/api/orgs', { name: 'Plan Org' });
  const camp = (await u.post('/api/campaigns', { name: 'Plan', goalAmount: 1000 })).data.campaign;

  // No connections yet → an empty plan with an explanation (200, no AI call made).
  const empty = await u.post(`/api/campaigns/${camp.id}/plan`);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.actions.length, 0);
  assert.ok(empty.data.message, 'explains there is nothing to plan');

  // Add a strong (Ukraine-affinity) candidate → planner runs, but no key → 503.
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Olena K', company: 'Kyiv Digital', role: 'Engineer', linkedin_url: 'https://l/olena' }],
  });
  const top = (await u.get('/api/prospects')).data.prospects[0];
  assert.ok(top.donor_likelihood_score >= 1, 'the candidate scored (affinity), so the planner has someone to rank');
  const res = await u.post(`/api/campaigns/${camp.id}/plan`);
  assert.equal(res.status, 503, 'no ANTHROPIC_API_KEY → graceful 503, never a crash');
});

test('reply drafting degrades to 503 without an API key (never sends)', async () => {
  const u = client();
  await u.login({ linkedinId: 'camp-reply', name: 'Ray Reply' });
  await u.post('/api/orgs', { name: 'Reply Org' });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Sam', company: 'Acme', linkedin_url: 'https://l/sam' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;
  const reply = await u.post('/api/ai/reply', { connectionId: connId, theirMessage: 'Tell me more' });
  assert.equal(reply.status, 503);
});
