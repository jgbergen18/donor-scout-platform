// L2 — Morning Brief + nightly planner, with NO API key (the shared harness strips
// it). Pins graceful degradation (no AI → no nightly planning, brief is empty but
// 200) and the admin gate / default dial. No AI, no send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('the Morning Brief is empty and 200 when nothing has been planned', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-empty', name: 'Ed E' });
  await u.post('/api/orgs', { name: 'Empty Brief Org' });
  const brief = await u.get('/api/brief');
  assert.equal(brief.status, 200);
  assert.equal(brief.data.total, 0);
  assert.deepEqual(brief.data.autoApproved, []);
  assert.deepEqual(brief.data.needsReview, []);
  assert.equal(brief.data.autonomy.autoApproveMoves, true, 'auto-approve defaults ON');
});

test('on-demand nightly run degrades gracefully when AI is off', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-degrade', name: 'Di D' });
  await u.post('/api/orgs', { name: 'Degrade Org' });
  const run = await u.post('/api/brief/run');
  assert.equal(run.status, 200, 'never 500s without a key');
  assert.equal(run.data.enabled, false, 'reports AI off — no planning attempted');
});

test('only owners/admins can trigger an on-demand nightly run (403 for members)', async () => {
  const u = client();
  // A fresh login lands in the default org as a plain 'member'.
  await u.login({ linkedinId: 'l2-member', name: 'Mo M' });
  const run = await u.post('/api/brief/run');
  assert.equal(run.status, 403, 'members cannot trigger the planner');
});
