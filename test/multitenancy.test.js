// Multi-tenancy: cross-org data isolation, onboarding (create/join), roles, and
// org/team join scoping. Runs fully offline against an isolated DB (see helpers.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// Two contacts so a list is non-trivial.
const contacts = [
  { contact_name: 'Alice Org-A', contact_email: 'alice@a.test', company: 'Acme', role: 'Engineer', linkedin_url: 'https://linkedin.com/in/alicea' },
  { contact_name: 'Bob Org-A', contact_email: 'bob@a.test', company: 'Acme', role: 'Manager', linkedin_url: 'https://linkedin.com/in/boba' },
];

test('cross-org isolation: a user in org B cannot read or write org A rows', async () => {
  // --- User A: creates org A, imports a connection, adds a referral ---
  const a = client();
  await a.login({ linkedinId: 'iso-a' });
  const orgA = await a.post('/api/orgs', { name: 'Nonprofit A' });
  assert.equal(orgA.status, 201);
  assert.equal(orgA.data.org.role, 'owner');

  const up = await a.post('/api/connections/upload', { contacts });
  assert.equal(up.status, 200);
  assert.equal(up.data.added, 2);

  const aProspects = await a.get('/api/prospects');
  assert.equal(aProspects.data.prospects.length, 2);
  const connId = aProspects.data.prospects[0].id;

  const ref = await a.post('/api/referrals', { connectionId: connId });
  assert.equal(ref.status, 201);
  const refId = ref.data.referral.id;

  // --- User B: creates a separate org B with NO data ---
  const b = client();
  await b.login({ linkedinId: 'iso-b' });
  await b.post('/api/orgs', { name: 'Nonprofit B' });

  // B sees an empty prospects + referrals list (org A's rows are invisible).
  const bProspects = await b.get('/api/prospects');
  assert.equal(bProspects.data.prospects.length, 0, 'org B must not see org A connections');
  const bRefs = await b.get('/api/referrals');
  assert.equal(bRefs.data.referrals.length, 0, 'org B must not see org A referrals');

  // Direct-object access to A's connection id → 404 (existence not leaked).
  assert.equal((await b.patch(`/api/connections/${connId}`, { role: 'X' })).status, 404);
  assert.equal((await b.del(`/api/connections/${connId}`)).status, 404);
  assert.equal((await b.post(`/api/connections/${connId}/dossier`, {})).status, 404);
  assert.equal((await b.del(`/api/referrals/${refId}`)).status, 404);
  assert.equal((await b.patch(`/api/referrals/${refId}`, { status: 'declined' })).status, 404);

  // And A's data is intact and untouched after B's probing.
  const aAfter = await a.get('/api/prospects');
  assert.equal(aAfter.data.prospects.length, 2);
  const aRefAfter = await a.get('/api/referrals');
  assert.equal(aRefAfter.data.referrals.length, 1);
});

test('onboarding: a second user can join an org by code and appears in members', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'join-owner', name: 'Owner One' });
  const created = await owner.post('/api/orgs', { name: 'Joinable Org' });
  const joinCode = created.data.org.joinCode;
  assert.ok(joinCode, 'owner sees a join code');

  // A brand-new (empty) user joins with the code.
  const joiner = client();
  await joiner.login({ linkedinId: 'join-member', name: 'Member Two' });
  const joined = await joiner.post('/api/orgs/join', { code: joinCode });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.org.role, 'member');
  assert.equal(joined.data.org.joinCode, null, 'members do not see the join code');

  // The owner's member list now includes the joiner.
  const members = await owner.get('/api/orgs/members');
  assert.equal(members.status, 200);
  const names = members.data.members.map((m) => m.name).sort();
  assert.deepEqual(names, ['Member Two', 'Owner One']);

  // Unknown code → 404 (no existence leak).
  const bad = await client();
  await bad.login({ linkedinId: 'join-bad' });
  assert.equal((await bad.post('/api/orgs/join', { code: 'ORG-ZZZZZZ' })).status, 404);
});

test('onboarding: joining is blocked (409) once the account has data', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'block-owner' });
  const created = await owner.post('/api/orgs', { name: 'Target Org' });
  const code = created.data.org.joinCode;

  const user = client();
  await user.login({ linkedinId: 'block-user' });
  await user.post('/api/connections/upload', { contacts: [contacts[0]] }); // now has data
  const res = await user.post('/api/orgs/join', { code });
  assert.equal(res.status, 409, 'cannot move a non-empty account between orgs');
});

test('roles: members cannot access admin endpoints; sole owner cannot be demoted', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'role-owner' });
  const org = await owner.post('/api/orgs', { name: 'Role Org' });
  const code = org.data.org.joinCode;

  const member = client();
  await member.login({ linkedinId: 'role-member' });
  await member.post('/api/orgs/join', { code });

  // Member is forbidden from admin endpoints.
  assert.equal((await member.get('/api/orgs/members')).status, 403);
  assert.equal((await member.patch('/api/orgs/config', { defaultStrategy: 'balanced' })).status, 403);
  assert.equal((await member.post('/api/orgs/join-code/rotate')).status, 403);

  // Find the member + owner ids from the owner's member list.
  const members = (await owner.get('/api/orgs/members')).data.members;
  const ownerRow = members.find((m) => m.role === 'owner');
  const memberRow = members.find((m) => m.role === 'member');

  // Owner promotes the member to admin (allowed).
  const promote = await owner.patch(`/api/orgs/members/${memberRow.id}`, { role: 'admin' });
  assert.equal(promote.status, 200);

  // An admin may NOT change the owner.
  const adminClient = member; // member is now admin
  assert.equal(
    (await adminClient.patch(`/api/orgs/members/${ownerRow.id}`, { role: 'member' })).status,
    403
  );

  // The sole owner cannot demote themselves (would orphan the org).
  const selfDemote = await owner.patch(`/api/orgs/members/${ownerRow.id}`, { role: 'member' });
  assert.equal(selfDemote.status, 409);
});

test('team join is org-scoped: a code from another org returns 404', async () => {
  const a = client();
  await a.login({ linkedinId: 'team-a' });
  await a.post('/api/orgs', { name: 'Team Org A' });
  const teamA = await a.post('/api/team', { name: 'Squad A' });
  const teamCode = teamA.data.team.inviteCode;
  assert.ok(teamCode);

  const b = client();
  await b.login({ linkedinId: 'team-b' });
  await b.post('/api/orgs', { name: 'Team Org B' });

  // B tries to join A's team by its code → same 404 as an unknown code.
  const join = await b.post('/api/team/join', { code: teamCode });
  assert.equal(join.status, 404, 'cross-org team join must be rejected as 404');

  // A teammate in the SAME org can join.
  const a2 = client();
  await a2.login({ linkedinId: 'team-a2' });
  await a2.post('/api/orgs/join', { code: (await a.get('/api/orgs/me')).data.org.joinCode });
  const ok = await a2.post('/api/team/join', { code: teamCode });
  assert.equal(ok.status, 200);
});

test('per-org config: owner can set defaultStrategy + economics; impact reflects it', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'cfg-owner' });
  await owner.post('/api/orgs', { name: 'Config Org' });

  // Update org default strategy + per-org impact economics.
  const patch = await owner.patch('/api/orgs/config', {
    defaultStrategy: 'balanced',
    impact: { programCost: 1000, dayCost: 100 },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.config.defaultStrategy, 'balanced');

  // The org default surfaces on /api/orgs/me + auth/me.
  assert.equal((await owner.get('/api/orgs/me')).data.org.defaultStrategy, 'balanced');
  assert.equal((await owner.get('/api/auth/me')).data.user.orgDefaultStrategy, 'balanced');

  // Bad strategy key is rejected.
  assert.equal((await owner.patch('/api/orgs/config', { defaultStrategy: 'nope' })).status, 400);

  // Per-org economics drive impact unit costs.
  const impact = await owner.get('/api/impact');
  assert.equal(impact.data.costPerBootcamp, 1000);
  assert.equal(impact.data.costPerDay, 100);
});

test('default-org user keeps zero-friction signup and stays in the default org', async () => {
  const u = client();
  const me = await u.login({ linkedinId: 'default-user' });
  assert.ok(me.data.user.orgId, 'new user is assigned an org');
  // Without creating/joining, they can use the app and see their own org context.
  const org = await u.get('/api/orgs/me');
  assert.equal(org.status, 200);
  assert.ok(org.data.org.defaultStrategy);
});

test('cross-org isolation: contact_history (relationship memory) is not visible across orgs', async () => {
  // User A uploads relationship memory in org A.
  const a = client();
  await a.login({ linkedinId: 'hist-a' });
  await a.post('/api/orgs', { name: 'Hist Org A' });
  const up = await a.post('/api/history/upload', {
    history: [
      {
        name: 'Alice Org-A',
        last: '2024-01-01',
        count: 5,
        sent: 3,
        received: 2,
        snippets: [{ date: '2024-01-01', direction: 'sent', text: 'great catching up, Alice' }],
      },
    ],
  });
  assert.equal(up.status, 200);
  const aSummary = await a.get('/api/history/summary');
  assert.ok(aSummary.data.contacts >= 1, 'org A sees its own relationship memory');
  assert.ok(aSummary.data.messages >= 5);

  // A user in a different org sees none of it (history reads are user+org scoped).
  const b = client();
  await b.login({ linkedinId: 'hist-b' });
  await b.post('/api/orgs', { name: 'Hist Org B' });
  const bSummary = await b.get('/api/history/summary');
  assert.equal(bSummary.data.contacts, 0, 'org B must not see org A contact_history');
  assert.equal(bSummary.data.messages, 0);
});

test('roles: changing the role of a member in another org returns 404 (no cross-org write)', async () => {
  const a = client();
  await a.login({ linkedinId: 'xrole-a' });
  await a.post('/api/orgs', { name: 'XRole Org A' });

  const b = client();
  await b.login({ linkedinId: 'xrole-b', name: 'Bob B' });
  await b.post('/api/orgs', { name: 'XRole Org B' });
  const bUserId = (await b.get('/api/auth/me')).data.user.id;
  assert.ok(bUserId, 'B has a user id');

  // A (owner of org A) tries to change B (a user in org B) → 404, not 200/403.
  const res = await a.patch(`/api/orgs/members/${bUserId}`, { role: 'member' });
  assert.equal(res.status, 404, 'cannot target a member in another org');
});
