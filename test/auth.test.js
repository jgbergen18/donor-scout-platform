// SaaS auth Phase 1 — magic-link, invitations, deactivation, identities.
// Fully offline: the console mailer stashes the raw token in memory and we
// retrieve it via the NODE_ENV=test-only /api/test/last-magic-link hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

test.after(() => closeServer());

// Helper: drive the full magic-link flow for an email on a given client.
async function requestMagic(c, email) {
  const r = await c.post('/api/auth/magic-link/request', { email });
  return r;
}
async function tokenFor(c, email) {
  const r = await c.get(`/api/test/last-magic-link?email=${encodeURIComponent(email)}`);
  return r.data?.token;
}

test('magic-link: brand-new email → consumed → logged-in session in default org', async () => {
  const c = client();
  const email = 'newbie@example.org';
  const req = await requestMagic(c, email);
  assert.equal(req.status, 200);
  assert.equal(req.data.ok, true);
  assert.ok(req.data.devToken, 'devToken surfaced in test env');

  const consume = await c.post('/api/auth/magic-link/consume', { token: req.data.devToken });
  assert.equal(consume.status, 200);
  assert.equal(consume.data.user.email, email);
  assert.equal(consume.data.user.inDefaultOrg, true, 'brand-new lands in default org');
  assert.equal(consume.data.user.orgRole, 'member');

  // Session is live.
  const me = await c.get('/api/auth/me');
  assert.equal(me.data.user.email, email);
});

test('magic-link: single-use — a second consume of the same token fails generically', async () => {
  const c = client();
  const email = 'singleuse@example.org';
  const req = await requestMagic(c, email);
  const first = await c.post('/api/auth/magic-link/consume', { token: req.data.devToken });
  assert.equal(first.status, 200);
  const second = await client().post('/api/auth/magic-link/consume', { token: req.data.devToken });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /invalid or has expired/);
});

test('magic-link: a wrong/unknown token fails with the same generic error', async () => {
  const r = await client().post('/api/auth/magic-link/consume', { token: 'not-a-real-token' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /invalid or has expired/);
});

test('magic-link: request returns identical 200 for known vs unknown email (no existence leak)', async () => {
  // Seed a known user via test login.
  const known = client();
  await known.login({ linkedinId: 'test-known-user', email: 'known@example.org' });

  const r1 = await client().post('/api/auth/magic-link/request', { email: 'known@example.org' });
  const r2 = await client().post('/api/auth/magic-link/request', { email: 'definitely-unknown@example.org' });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  // Both bodies have ok:true and a devToken (since both mint in test); neither
  // reveals whether the user exists.
  assert.equal(r1.data.ok, true);
  assert.equal(r2.data.ok, true);
});

test('magic-link: an existing (test-login) user signs into the SAME account, no duplicate', async () => {
  const existing = client();
  const me1 = await existing.login({ linkedinId: 'test-existing-acct', email: 'existing@example.org' });
  const originalId = me1.data.user.id;

  const ml = client();
  await ml.post('/api/auth/magic-link/request', { email: 'existing@example.org' });
  const token = await tokenFor(ml, 'existing@example.org');
  const consume = await ml.post('/api/auth/magic-link/consume', { token });
  assert.equal(consume.status, 200);
  assert.equal(consume.data.user.id, originalId, 'same account, no fork');
});

test('invitations: owner can invite; accepting (logged out) places the user in the inviting org + role', async () => {
  // Owner creates a fresh org.
  const owner = client();
  await owner.login({ linkedinId: 'test-inv-owner' });
  const org = await owner.post('/api/orgs', { name: 'Invite Test Org' });
  assert.equal(org.status, 201);
  const orgId = org.data.org.id;

  // Invite an admin.
  const inv = await owner.post('/api/orgs/invitations', { email: 'invitee@example.org', role: 'admin' });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.invitation.role, 'admin');
  assert.ok(inv.data.devToken);

  // Pending list shows it (no token leaked).
  const list = await owner.get('/api/orgs/invitations');
  assert.equal(list.data.invitations.length, 1);
  assert.equal(list.data.invitations[0].email, 'invitee@example.org');
  assert.ok(!('token' in list.data.invitations[0]));

  // Accept while logged out.
  const invitee = client();
  const accept = await invitee.post('/api/orgs/invitations/accept', { token: inv.data.devToken });
  assert.equal(accept.status, 200);
  assert.equal(accept.data.user.orgId, orgId, 'placed in the inviting org');
  assert.equal(accept.data.user.orgRole, 'admin', 'with the invited role');

  // Now consumed — second accept fails.
  const again = await client().post('/api/orgs/invitations/accept', { token: inv.data.devToken });
  assert.equal(again.status, 400);
});

test('invitations: owner cannot be invited (400)', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'test-inv-owner2' });
  await owner.post('/api/orgs', { name: 'No Owner Invite Org' });
  const r = await owner.post('/api/orgs/invitations', { email: 'x@example.org', role: 'owner' });
  assert.equal(r.status, 400);
});

test('invitations: a member cannot create invitations (403)', async () => {
  const member = client();
  await member.login({ linkedinId: 'test-inv-member' }); // default org, member role
  const r = await member.post('/api/orgs/invitations', { email: 'y@example.org', role: 'member' });
  assert.equal(r.status, 403);
});

test('invitations: org isolation — org A cannot revoke org B invitation, and accept only places in the issuing org', async () => {
  const ownerA = client();
  await ownerA.login({ linkedinId: 'test-iso-ownerA' });
  const orgA = await ownerA.post('/api/orgs', { name: 'Org A Iso' });
  const ownerB = client();
  await ownerB.login({ linkedinId: 'test-iso-ownerB' });
  const orgB = await ownerB.post('/api/orgs', { name: 'Org B Iso' });

  // Org A invites someone.
  const invA = await ownerA.post('/api/orgs/invitations', { email: 'crossorg@example.org', role: 'member' });
  // Find the invitation id from A's list.
  const aList = await ownerA.get('/api/orgs/invitations');
  const invId = aList.data.invitations[0].id;

  // Org B owner tries to revoke A's invitation → 404 (not B's).
  const revoke = await ownerB.del(`/api/orgs/invitations/${invId}`);
  assert.equal(revoke.status, 404);

  // Accepting A's token places the user in Org A only.
  const accept = await client().post('/api/orgs/invitations/accept', { token: invA.data.devToken });
  assert.equal(accept.status, 200);
  assert.equal(accept.data.user.orgId, orgA.data.org.id);
  assert.notEqual(accept.data.user.orgId, orgB.data.org.id);
});

test('deactivation: a deactivated user cannot log in by any method and is evicted on next request', async () => {
  // Owner + a member in a fresh org.
  const owner = client();
  await owner.login({ linkedinId: 'test-deact-owner' });
  const org = await owner.post('/api/orgs', { name: 'Deactivation Org' });
  const inv = await owner.post('/api/orgs/invitations', { email: 'victim@example.org', role: 'member' });
  const victim = client();
  const accepted = await victim.post('/api/orgs/invitations/accept', { token: inv.data.devToken });
  const victimId = accepted.data.user.id;

  // Owner deactivates the member.
  const members = await owner.get('/api/orgs/members');
  assert.ok(members.data.members.find((m) => m.id === victimId));
  const deact = await owner.patch(`/api/orgs/members/${victimId}/active`, { active: false });
  assert.equal(deact.status, 200);
  // Still appears in the member list, flagged inactive (data/attribution preserved).
  const target = deact.data.members.find((m) => m.id === victimId);
  assert.equal(target.active, 0);

  // Existing session is locked out on the next auth-gated request (requireAuth
  // re-checks is_active; deserializeUser re-read the row, so it's immediate).
  const lockedOut = await victim.get('/api/orgs/me');
  assert.equal(lockedOut.status, 403);
  assert.match(lockedOut.data.error, /deactivated/);

  // Cannot re-authenticate via magic link either.
  const ml = client();
  await ml.post('/api/auth/magic-link/request', { email: 'victim@example.org' });
  const token = await tokenFor(ml, 'victim@example.org');
  const consume = await ml.post('/api/auth/magic-link/consume', { token });
  assert.equal(consume.status, 403);
  assert.match(consume.data.error, /deactivated/);
});

test('deactivation: the sole owner cannot be deactivated (409)', async () => {
  const owner = client();
  const me = await owner.login({ linkedinId: 'test-sole-owner' });
  const org = await owner.post('/api/orgs', { name: 'Sole Owner Org' });
  const ownerId = me.data.user.id;
  const r = await owner.patch(`/api/orgs/members/${ownerId}/active`, { active: false });
  assert.equal(r.status, 409);
});

test('identities backfill: demo and test-login users still authenticate normally', async () => {
  // Demo login still works and resolves to the demo account.
  const demo = client();
  const r = await demo.post('/api/auth/demo', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isDemo, true);

  // Test login (LinkedIn-shaped identity) still works.
  const li = client();
  const r2 = await li.login({ linkedinId: 'test-backfill-li', email: 'libackfill@example.org' });
  assert.equal(r2.status, 200);
  const me = await li.get('/api/auth/me');
  assert.equal(me.data.user.email, 'libackfill@example.org');
});

test('auth/config advertises magicLinkEnabled', async () => {
  const r = await client().get('/api/auth/config');
  assert.equal(r.data.magicLinkEnabled, true);
});
