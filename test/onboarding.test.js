// Self-serve onboarding: the checklist is DERIVED from the scout's real, org-scoped
// data (never self-marked), the dismissal flag persists across requests, and a scout
// only ever sees their OWN signals. Runs fully offline (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

function stepMap(data) {
  return Object.fromEntries(data.steps.map((s) => [s.key, s]));
}

const contacts = [
  {
    contact_name: 'Casey Connect',
    contact_email: 'casey@x.test',
    company: 'Acme',
    role: 'Engineer',
    linkedin_url: 'https://linkedin.com/in/casey',
  },
];

test('empty account: every required step is incomplete', async () => {
  const c = client();
  await c.login({ linkedinId: 'onb-empty' });

  const { status, data } = await c.get('/api/onboarding');
  assert.equal(status, 200);
  const steps = stepMap(data);
  assert.equal(steps.profile.done, false);
  assert.equal(steps.connections.done, false);
  assert.equal(steps.strategy.done, false);
  assert.equal(steps.org.done, false);
  assert.equal(steps.referral.done, false);
  assert.equal(data.complete, false);
  assert.equal(data.dismissed, false);
  // Org step is optional → not counted toward the required total.
  assert.equal(data.totalSteps, 4);
  assert.equal(data.completedSteps, 0);
});

test('signals flip steps to done: profile, connections, strategy, referral', async () => {
  const c = client();
  await c.login({ linkedinId: 'onb-signals' });

  // Profile.
  await c.post('/api/profile', { company: 'SeatGeek', location: 'NYC', schools: 'MIT' });
  // Connections.
  const up = await c.post('/api/connections/upload', { contacts });
  assert.equal(up.status, 200);
  // Strategy (an explicit choice, distinct from inheriting the org default).
  await c.post('/api/profile/strategy', { strategy: 'capacity_first' });
  // Referral (reach out to first prospect).
  const prospects = await c.get('/api/prospects');
  const connId = prospects.data.prospects[0].id;
  const ref = await c.post('/api/referrals', { connectionId: connId });
  assert.equal(ref.status, 201);

  const { data } = await c.get('/api/onboarding');
  const steps = stepMap(data);
  assert.equal(steps.profile.done, true, 'profile set');
  assert.equal(steps.connections.done, true, 'connections imported');
  assert.equal(steps.strategy.done, true, 'strategy chosen');
  assert.equal(steps.referral.done, true, 'first referral made');
  // Org step is optional and still unset (shared default org, no teammates).
  assert.equal(steps.org.done, false);
  // All 4 required steps done → complete, even with the optional org step open.
  assert.equal(data.completedSteps, 4);
  assert.equal(data.complete, true);
});

test('org step derives from leaving the default org', async () => {
  const c = client();
  await c.login({ linkedinId: 'onb-org' });

  let { data } = await c.get('/api/onboarding');
  assert.equal(stepMap(data).org.done, false, 'default org → not done');

  await c.post('/api/orgs', { name: 'My Nonprofit' });
  ({ data } = await c.get('/api/onboarding'));
  assert.equal(stepMap(data).org.done, true, 'own org → done');
});

test('dismissal persists across requests', async () => {
  const c = client();
  await c.login({ linkedinId: 'onb-dismiss' });

  let { data } = await c.get('/api/onboarding');
  assert.equal(data.dismissed, false);

  const res = await c.post('/api/onboarding/dismiss', {});
  assert.equal(res.status, 200);
  assert.equal(res.data.dismissed, true);

  // Fresh GET reflects the persisted flag.
  ({ data } = await c.get('/api/onboarding'));
  assert.equal(data.dismissed, true, 'dismissal survives a new request');

  // And it can be un-dismissed explicitly.
  await c.post('/api/onboarding/dismiss', { dismissed: false });
  ({ data } = await c.get('/api/onboarding'));
  assert.equal(data.dismissed, false);
});

test('org-scoped: a scout only sees their own signals', async () => {
  // Scout A creates an org and imports a connection.
  const a = client();
  await a.login({ linkedinId: 'onb-scope-a' });
  await a.post('/api/orgs', { name: 'Org A' });
  await a.post('/api/connections/upload', { contacts });

  // Scout B in a separate, empty org.
  const b = client();
  await b.login({ linkedinId: 'onb-scope-b' });
  await b.post('/api/orgs', { name: 'Org B' });

  const { data: aData } = await a.get('/api/onboarding');
  const { data: bData } = await b.get('/api/onboarding');

  assert.equal(stepMap(aData).connections.done, true, 'A has connections');
  assert.equal(stepMap(bData).connections.done, false, 'B must not see A connections');

  // Dismissal is per-user too.
  await a.post('/api/onboarding/dismiss', {});
  const { data: bAfter } = await b.get('/api/onboarding');
  assert.equal(bAfter.dismissed, false, "A's dismissal must not affect B");
});

test('onboarding requires auth', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/onboarding')).status, 401);
  assert.equal((await anon.post('/api/onboarding/dismiss', {})).status, 401);
});
