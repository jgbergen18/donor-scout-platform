// L1 — autonomy dial + graceful degradation, with NO API key (the shared harness
// strips it). Pins: the daily brief degrades to the raw queue when AI is off, the
// autonomy policy is admin-gated and org-scoped, and the defaults are ON per the
// deployment directive. No AI, no send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('the daily brief degrades to the raw queue when AI is off', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-degrade', name: 'Dee D' });
  await u.post('/api/orgs', { name: 'Degrade Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Kyiv Friend', company: 'Kyiv Tech', linkedin_url: 'https://l/kf' }] });

  const brief = await u.get('/api/today/brief');
  assert.equal(brief.status, 200, 'brief never 500s without a key');
  assert.equal(brief.data.triage.enabled, false, 'triage reports disabled');
  assert.ok(Array.isArray(brief.data.prospects), 'still returns the assembled buckets');
  // Same content as the plain queue (no suppression applied).
  const raw = (await u.get('/api/today')).data;
  assert.equal(brief.data.prospects.length, raw.prospects.length);
});

test('autonomy defaults are ON and exposed on the org payload', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-default', name: 'Ada A' });
  await u.post('/api/orgs', { name: 'Default Org' });
  const a = (await u.get('/api/orgs/me')).data.org.autonomy;
  assert.equal(a.autoAcceptReplies, true);
  assert.equal(a.autoApplyTriage, true);
  assert.equal(a.policy, '');
});

test('an admin can set the autonomy dial; it round-trips on the org payload', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-set', name: 'Sam S' });
  await u.post('/api/orgs', { name: 'Set Org' }); // creator = owner
  const res = await u.patch('/api/orgs/autonomy', { autoAcceptReplies: false, policy: "Don't ask board members this quarter." });
  assert.equal(res.status, 200);
  assert.equal(res.data.autonomy.autoAcceptReplies, false);
  assert.equal(res.data.autonomy.autoApplyTriage, true, 'untouched field preserved');
  const me = (await u.get('/api/orgs/me')).data.org.autonomy;
  assert.equal(me.autoAcceptReplies, false);
  assert.match(me.policy, /board members/);
});

test('a non-admin member cannot change the autonomy dial (403)', async () => {
  const u = client();
  // A fresh login lands in the default org as a plain 'member'.
  await u.login({ linkedinId: 'l1-member', name: 'Mo M' });
  const res = await u.patch('/api/orgs/autonomy', { autoAcceptReplies: false });
  assert.equal(res.status, 403, 'members cannot turn the dial');
});

test('the autonomy policy is org-scoped — one org cannot see another’s', async () => {
  const a = client();
  await a.login({ linkedinId: 'l1-iso-a', name: 'Ana' });
  await a.post('/api/orgs', { name: 'Iso A' });
  await a.patch('/api/orgs/autonomy', { policy: 'HOLD-THE-BOARD' });

  const b = client();
  await b.login({ linkedinId: 'l1-iso-b', name: 'Bo' });
  await b.post('/api/orgs', { name: 'Iso B' });
  const bAutonomy = (await b.get('/api/orgs/me')).data.org.autonomy;
  assert.equal(bAutonomy.policy, '', "org B does not see org A's policy");
});
