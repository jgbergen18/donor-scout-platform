// Per-org rebranding (OrgContext source-of-truth). The server attaches a per-org
// `cause` (orgName + impact economics + a validated donate link) to the user on
// /api/auth/me; the client OrgContext rebrands the whole app from it. These guard
// the server half: the cause is org-scoped, reflects the org's REAL name, validates
// the donate link (no javascript:/cleartext), and never leaks across tenants.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('/api/auth/me carries an org-scoped cause (default org branding)', async () => {
  const u = client();
  await u.login({ linkedinId: 'brand-default' });
  const me = (await u.get('/api/auth/me')).data.user;
  assert.ok(me.cause, 'cause is attached to the user');
  assert.equal(me.cause.orgName, 'Code for Ukraine', 'default org brands as Code for Ukraine');
  assert.ok(me.cause.donateUrl.startsWith('https://'), 'a validated https donate link');
  assert.ok(me.cause.impact && me.cause.impact.programCost > 0, 'impact economics present');
});

test('a custom org rebrands: cause.orgName is the real org name, not the cloned default', async () => {
  const u = client();
  await u.login({ linkedinId: 'brand-custom' });
  await u.post('/api/orgs', { name: 'Sea Shepherd Fund' });
  const me = (await u.get('/api/auth/me')).data.user;
  assert.equal(me.cause.orgName, 'Sea Shepherd Fund', 'the whole app rebrands to the org name');
});

test('PATCH /api/orgs/config validates the donate link and applies cause-copy edits', async () => {
  const u = client();
  await u.login({ linkedinId: 'brand-edit' });
  await u.post('/api/orgs', { name: 'Acme Good' });

  // A javascript: URL is rejected — the donate link stays the safe https default.
  await u.patch('/api/orgs/config', { donateUrl: 'javascript:alert(1)' });
  let me = (await u.get('/api/auth/me')).data.user;
  assert.ok(me.cause.donateUrl.startsWith('https://'), 'javascript: donateUrl rejected');
  assert.ok(!me.cause.donateUrl.toLowerCase().includes('javascript'), 'no javascript scheme leaks into the link');

  // A valid https URL + a cause-copy edit flow through to the cause.
  const good = 'https://example.org/give';
  await u.patch('/api/orgs/config', { donateUrl: good, impact: { beneficiaries: 'whales' } });
  me = (await u.get('/api/auth/me')).data.user;
  assert.equal(me.cause.donateUrl, good, 'valid donate link applied');
  assert.equal(me.cause.impact.beneficiaries, 'whales', 'plural beneficiaries edit applied');
});

test('cause is org-isolated: one org never sees another org’s branding', async () => {
  const a = client();
  await a.login({ linkedinId: 'brand-iso-a' });
  await a.post('/api/orgs', { name: 'Org Alpha' });
  await a.patch('/api/orgs/config', { donateUrl: 'https://alpha.example/give' });

  const b = client();
  await b.login({ linkedinId: 'brand-iso-b' });
  await b.post('/api/orgs', { name: 'Org Beta' });

  const meA = (await a.get('/api/auth/me')).data.user;
  const meB = (await b.get('/api/auth/me')).data.user;
  assert.equal(meA.cause.orgName, 'Org Alpha');
  assert.equal(meB.cause.orgName, 'Org Beta');
  assert.notEqual(meA.cause.donateUrl, meB.cause.donateUrl, 'each org carries its own donate link');
});
