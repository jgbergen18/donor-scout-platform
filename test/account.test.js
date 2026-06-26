// Trust & privacy baseline: account data export (portability), account deletion
// (right to erasure) with the sole-owner safeguard, and the owner/admin audit
// reader. Runs fully offline against an isolated DB (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

const contacts = [
  { contact_name: 'Alice Donor', contact_email: 'alice@x.test', company: 'Acme', role: 'CTO', linkedin_url: 'https://linkedin.com/in/alicex' },
  { contact_name: 'Bob Donor', contact_email: 'bob@x.test', company: 'Globex', role: 'VP', linkedin_url: 'https://linkedin.com/in/bobx' },
];

// ── Export ───────────────────────────────────────────────────────────────────

test('export returns ONLY the caller’s own data, org-scoped', async () => {
  // User A in org A with connections, a referral, and relationship memory.
  const a = client();
  await a.login({ linkedinId: 'exp-a', name: 'Exporter A' });
  await a.post('/api/orgs', { name: 'Export Org A' });
  const up = await a.post('/api/connections/upload', { contacts });
  assert.equal(up.status, 200);
  const prospects = (await a.get('/api/prospects')).data.prospects;
  const connId = prospects[0].id;
  await a.post('/api/referrals', { connectionId: connId });
  await a.post('/api/history/upload', {
    history: [{ name: 'Alice Donor', count: 5, sent: 3, received: 2 }],
    voiceSample: 'Hey, hope you are well!',
  });

  // A separate user B in a separate org B with their OWN data.
  const b = client();
  await b.login({ linkedinId: 'exp-b', name: 'Exporter B' });
  await b.post('/api/orgs', { name: 'Export Org B' });
  await b.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Carol B', contact_email: 'carol@b.test', company: 'B Inc' }],
  });

  const res = await a.get('/api/account/export');
  assert.equal(res.status, 200);
  const data = res.data;

  // Profile is the caller's.
  assert.equal(data.profile.name, 'Exporter A');
  assert.equal(data.schema, 'donor-scout/account-export/v1');

  // Only A's two connections — none of B's.
  assert.equal(data.connections.length, 2);
  const names = data.connections.map((c) => c.contact_name).sort();
  assert.deepEqual(names, ['Alice Donor', 'Bob Donor']);
  assert.ok(!data.connections.some((c) => c.contact_name === 'Carol B'), 'must not leak org B data');

  // Referral + contact history + voice presence are the caller's.
  assert.equal(data.referrals.length, 1);
  assert.equal(data.contactHistory.length, 1);
  assert.equal(data.voiceProfile.exists, true);
  assert.ok(data.voiceProfile.chars > 0);

  // identities reports the method but NOT the raw subject/email secret.
  assert.ok(Array.isArray(data.identities));
  assert.ok(data.identities.every((i) => i.provider && i.provider_sub === undefined));

  // Export was audited.
  const audit = (await a.get('/api/orgs/audit')).data.entries;
  assert.ok(audit.some((e) => e.action === 'account.exported'), 'export should be audited');
});

// ── Deletion (right to erasure) ────────────────────────────────────────────────

test('deletion requires explicit confirmation', async () => {
  const u = client();
  await u.login({ linkedinId: 'del-confirm' });
  await u.post('/api/orgs', { name: 'Confirm Org' });
  const res = await u.del('/api/account', {});
  assert.equal(res.status, 400, 'missing confirm → 400');
  // Still authenticated afterward.
  assert.equal((await u.get('/api/auth/me')).data.user?.name, 'del-confirm');
});

test('deletion removes ALL of the user’s rows and ends access', async () => {
  const u = client();
  await u.login({ linkedinId: 'del-full', name: 'Delete Me' });
  await u.post('/api/orgs', { name: 'Erasure Org' });
  await u.post('/api/connections/upload', { contacts });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;
  const ref = await u.post('/api/referrals', { connectionId: connId });
  await u.post(`/api/referrals/${ref.data.referral.id}/donation`, { amount: 500 });
  await u.post('/api/history/upload', {
    history: [{ name: 'Alice Donor', count: 2 }],
    voiceSample: 'voice text here',
  });
  await u.post('/api/team', { name: 'Erasure Squad' });

  // Sanity: data exists before deletion.
  assert.ok((await u.get('/api/prospects')).data.prospects.length > 0);

  const del = await u.del('/api/account', { confirm: true });
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);

  // Session ended — subsequent calls are unauthenticated.
  assert.equal((await u.get('/api/prospects')).status, 401);

  // Re-logging in with the SAME linkedinId creates a brand-new empty account
  // (the old rows are gone). Prospects/referrals/history must all be empty.
  const again = client();
  await again.login({ linkedinId: 'del-full' });
  assert.equal((await again.get('/api/prospects')).data.prospects.length, 0, 'connections erased');
  assert.equal((await again.get('/api/referrals')).data.referrals.length, 0, 'referrals erased');
  const summary = (await again.get('/api/history/summary')).data;
  assert.equal(summary.contacts, 0, 'contact history erased');
  assert.equal(summary.voiceChars, 0, 'voice sample erased');
  const impact = (await again.get('/api/impact')).data;
  assert.equal(impact.totalRaised, 0, 'impact erased');
});

test('sole owner WITH other members is blocked (409); last-member owner can delete', async () => {
  // Owner creates an org and invites a member who joins → org has 2 members.
  const owner = client();
  await owner.login({ linkedinId: 'so-owner' });
  await owner.post('/api/orgs', { name: 'Sole Owner Org' });
  const code = (await owner.get('/api/orgs/me')).data.org.joinCode;

  const member = client();
  await member.login({ linkedinId: 'so-member' });
  await member.post('/api/orgs/join', { code });

  // Sole owner of an org that still has another member → blocked.
  const blocked = await owner.del('/api/account', { confirm: true });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /transfer ownership/i);
  // Owner is still around.
  assert.ok((await owner.get('/api/orgs/me')).data.org);

  // A last-member owner (different org, only member) CAN delete.
  const solo = client();
  await solo.login({ linkedinId: 'solo-owner' });
  await solo.post('/api/orgs', { name: 'Solo Org' });
  const soloDel = await solo.del('/api/account', { confirm: true });
  assert.equal(soloDel.status, 200);
});

// ── Audit reader ───────────────────────────────────────────────────────────────

test('audit reader is owner/admin-only (member → 403)', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'aud-owner' });
  await owner.post('/api/orgs', { name: 'Audit Org' });
  const code = (await owner.get('/api/orgs/me')).data.org.joinCode;

  const member = client();
  await member.login({ linkedinId: 'aud-member' });
  await member.post('/api/orgs/join', { code });

  assert.equal((await owner.get('/api/orgs/audit')).status, 200, 'owner can read');
  assert.equal((await member.get('/api/orgs/audit')).status, 403, 'member cannot read');
});

test('audit reader is org-isolated and leaks no token', async () => {
  // Org A: owner sends an email invite (which records invite.created in A's log).
  const a = client();
  await a.login({ linkedinId: 'audiso-a' });
  await a.post('/api/orgs', { name: 'Audit Iso A' });
  const inv = await a.post('/api/orgs/invitations', { email: 'someone@a.test', role: 'member' });
  assert.equal(inv.status, 201);

  // Org B's owner must NOT see org A's entries.
  const b = client();
  await b.login({ linkedinId: 'audiso-b' });
  await b.post('/api/orgs', { name: 'Audit Iso B' });

  const aLog = (await a.get('/api/orgs/audit')).data;
  const bLog = (await b.get('/api/orgs/audit')).data;
  assert.ok(aLog.entries.some((e) => e.action === 'invite.created'), 'A sees its own invite');
  assert.ok(!bLog.entries.some((e) => e.action === 'invite.created'), 'B must not see A’s invite');

  // No field anywhere should resemble a raw token (the dev token is echoed by the
  // invite endpoint, never persisted to the audit log).
  const devToken = inv.data.devToken;
  const serialized = JSON.stringify(aLog);
  if (devToken) {
    assert.ok(!serialized.includes(devToken), 'audit log must not contain the raw invite token');
  }
  // No entry carries anything that looks like a secret blob.
  assert.ok(
    aLog.entries.every((e) => e.token === undefined && e.secret === undefined),
    'audit entries expose no token/secret fields'
  );
});

test('audit reader paginates newest-first', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'aud-page' });
  await owner.post('/api/orgs', { name: 'Audit Page Org' });
  // Generate several audited actions.
  for (let i = 0; i < 3; i++) {
    await owner.post('/api/orgs/invitations', { email: `p${i}@x.test`, role: 'member' });
  }
  const page1 = (await owner.get('/api/orgs/audit?limit=2&offset=0')).data;
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.total >= 3); // the 3 invite.created entries at least
  // Newest-first → ids strictly descending.
  assert.ok(page1.entries[0].id > page1.entries[1].id, 'newest-first ordering');
  const page2 = (await owner.get('/api/orgs/audit?limit=2&offset=2')).data;
  assert.ok(page2.entries[0].id < page1.entries[1].id, 'second page is older');
});
