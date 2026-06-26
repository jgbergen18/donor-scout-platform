// SaaS auth Phase 2 — per-org Okta OIDC SSO (BYO IdP). Runs FULLY OFFLINE: the
// live OIDC handshake (discovery, code exchange, ID-token signature/issuer/
// audience verification) needs a real Okta + HTTPS and CANNOT run in CI, so these
// tests drive the security-critical LOGIC without a network:
//   (a) the secret-box encryption round-trip + "secrets never returned" contract;
//   (b) email-domain → org routing (only VERIFIED domains route);
//   (c) the pure resolveSsoUser() (JIT create / existing match / group→role /
//       deactivated block / cross-org safety / issuer mismatch) — driven directly
//       AND through the NODE_ENV=test fake-claims hook /api/test/sso-callback,
//       which mirrors /api/test/login but feeds INJECTED, already-verified claims
//       into the SAME finalize path the real callback uses;
//   (d) the 'enforced' toggle disabling non-SSO logins.
//
// REAL end-to-end (a browser hitting /api/auth/sso/start → Okta → /callback) is
// out of scope here: it requires a configured Okta tenant + HTTPS (Secure cookies
// + the OIDC redirect_uri allow-list). Those network/crypto steps are handled by
// openid-client in server.js and are intentionally NOT mocked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';
import { createSecretBox } from '../lib/secrets.js';
import { resolveSsoUser, mapGroupsToRole } from '../lib/sso.js';

after(() => closeServer());

// ── (a) Secret encryption round-trip + secrets never returned ────────────────

test('secret box: encrypt → decrypt round-trips and ciphertext hides the plaintext', () => {
  const box = createSecretBox();
  const secret = 'super-secret-okta-client-value-123';
  const enc = box.encrypt(secret);
  assert.notEqual(enc, secret, 'ciphertext must not equal plaintext');
  assert.ok(!enc.includes(secret), 'ciphertext must not contain the plaintext');
  assert.ok(enc.startsWith('v1:'), 'versioned wire format');
  assert.equal(box.decrypt(enc), secret, 'round-trips back to the original');
});

test('secret box: tampered ciphertext fails the GCM auth tag', () => {
  const box = createSecretBox();
  const enc = box.encrypt('value');
  const parts = enc.split(':');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] = ct[0] ^ 0xff;
  parts[3] = ct.toString('base64');
  assert.throws(() => box.decrypt(parts.join(':')), 'tampering must throw');
});

test('SSO config API never returns the client secret', async () => {
  const a = client();
  await a.login({ linkedinId: 'sso-owner-1', name: 'SSO Owner' });
  await a.post('/api/orgs', { name: 'Secret Org' });
  const put = await a.put('/api/orgs/sso', {
    issuer: 'https://example.okta.com',
    clientId: 'client-abc',
    clientSecret: 'THE-SECRET-VALUE',
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.config.hasClientSecret, true);
  assert.ok(!('clientSecret' in put.data.config));
  assert.ok(!JSON.stringify(put.data).includes('THE-SECRET-VALUE'), 'secret must never appear in a response');

  const get = await a.get('/api/orgs/sso');
  assert.equal(get.status, 200);
  assert.ok(!JSON.stringify(get.data).includes('THE-SECRET-VALUE'));
  assert.equal(get.data.config.issuer, 'https://example.okta.com');
  assert.equal(get.data.config.clientId, 'client-abc');
});

test('SSO config update keeps the existing secret when omitted', async () => {
  const a = client();
  await a.login({ linkedinId: 'sso-owner-2', name: 'Owner2' });
  await a.post('/api/orgs', { name: 'Keep Secret Org' });
  await a.put('/api/orgs/sso', { issuer: 'https://k.okta.com', clientId: 'cid', clientSecret: 's1' });
  // Update without a secret → still configured (kept).
  const up = await a.put('/api/orgs/sso', { issuer: 'https://k.okta.com', clientId: 'cid2', enforced: true });
  assert.equal(up.status, 200);
  assert.equal(up.data.config.hasClientSecret, true);
  assert.equal(up.data.config.clientId, 'cid2');
  assert.equal(up.data.config.enforced, true);
});

test('SSO config requires a secret on first create', async () => {
  const a = client();
  await a.login({ linkedinId: 'sso-owner-3', name: 'Owner3' });
  await a.post('/api/orgs', { name: 'No Secret Org' });
  const r = await a.put('/api/orgs/sso', { issuer: 'https://n.okta.com', clientId: 'cid' });
  assert.equal(r.status, 400);
});

// ── (b) Domain verification gate + email→org routing ─────────────────────────

test('an UNVERIFIED domain does not route SSO; verifying it enables routing', async () => {
  const a = client();
  await a.login({ linkedinId: 'dom-owner', name: 'Dom Owner' });
  await a.post('/api/orgs', { name: 'Routing Org' });
  await a.put('/api/orgs/sso', { issuer: 'https://r.okta.com', clientId: 'cid', clientSecret: 's', jitProvisioning: true });

  const add = await a.post('/api/orgs/sso/domains', { domain: 'acme-route.test' });
  assert.equal(add.status, 201);
  assert.equal(add.data.domain.verified, false);
  const domId = add.data.domain.id;

  // Unverified → the fake-claims hook reports the domain doesn't route.
  const before = await client().post('/api/test/sso-callback', { sub: 'okta|1', email: 'jo@acme-route.test' });
  assert.equal(before.status, 400);
  assert.equal(before.data.error, 'no_sso_for_domain');

  // Verify (DNS/email check is stubbed) → now it routes + JIT-creates.
  const ver = await a.post(`/api/orgs/sso/domains/${domId}/verify`, {});
  assert.equal(ver.status, 200);
  assert.equal(ver.data.domain.verified, true);

  const after = await client().post('/api/test/sso-callback', { sub: 'okta|1', email: 'jo@acme-route.test' });
  assert.equal(after.status, 200);
  assert.equal(after.data.user.email, 'jo@acme-route.test');
});

test('a domain is globally unique (anti-takeover) — a second org cannot claim it', async () => {
  const a = client();
  await a.login({ linkedinId: 'uniq-a', name: 'A' });
  await a.post('/api/orgs', { name: 'Uniq A' });
  await a.put('/api/orgs/sso', { issuer: 'https://ua.okta.com', clientId: 'c', clientSecret: 's' });
  const first = await a.post('/api/orgs/sso/domains', { domain: 'contested.test' });
  assert.equal(first.status, 201);

  const b = client();
  await b.login({ linkedinId: 'uniq-b', name: 'B' });
  await b.post('/api/orgs', { name: 'Uniq B' });
  await b.put('/api/orgs/sso', { issuer: 'https://ub.okta.com', clientId: 'c', clientSecret: 's' });
  const second = await b.post('/api/orgs/sso/domains', { domain: 'contested.test' });
  assert.equal(second.status, 409, 'duplicate domain rejected');
});

// ── (c) Pure resolveSsoUser — unit tests with injected ops + claims ──────────

function makeFakeOps(seed = {}) {
  // In-memory user store keyed by id. Identities keyed by `${provider}:${sub}`.
  const users = new Map(Object.entries(seed.users || {}).map(([id, u]) => [Number(id), { id: Number(id), ...u }]));
  const identities = new Map(Object.entries(seed.identities || {})); // 'okta:sub' -> userId
  const invitations = seed.invitations || []; // [{ email, org_id, role, id }]
  let nextId = Math.max(0, ...users.keys()) + 1;
  const created = [];
  const roleChanges = [];
  return {
    ops: {
      findUserByIdentity: (provider, sub) => {
        const uid = identities.get(`${provider}:${sub}`);
        return uid ? users.get(uid) : undefined;
      },
      findUserByEmailInOrg: (email, orgId) =>
        [...users.values()].find((u) => (u.email || '').toLowerCase() === email && u.org_id === orgId),
      findLiveInvitation: (email, orgId) =>
        invitations.find((i) => i.email === email && i.org_id === orgId) || null,
      setUserRole: (userId, orgId, role) => {
        users.get(userId).org_role = role;
        roleChanges.push({ userId, orgId, role });
      },
      ensureIdentity: (userId, provider, sub) => identities.set(`${provider}:${sub}`, userId),
      createUser: ({ email, orgId, role, sub }) => {
        const id = nextId++;
        const u = { id, email, org_id: orgId, org_role: role, is_active: 1 };
        users.set(id, u);
        identities.set(`okta:${sub}`, id);
        created.push(u);
        return u;
      },
      reload: (userId) => users.get(userId),
    },
    created,
    roleChanges,
    users,
  };
}

const ORG_A = { id: 100 };
const CONF = { issuer: 'https://a.okta.com', jit_provisioning: 1, group_role_map: JSON.stringify({ Admins: 'admin', Owners: 'owner' }) };

test('resolveSsoUser: JIT-creates a brand-new user in the resolving org as member', () => {
  const f = makeFakeOps();
  const { user, created, role } = resolveSsoUser({
    claims: { sub: 'okta|new', email: 'new@a.test', iss: CONF.issuer },
    org: ORG_A,
    config: CONF,
    ops: f.ops,
  });
  assert.equal(created, true);
  assert.equal(role, 'member');
  assert.equal(user.org_id, ORG_A.id);
});

test('resolveSsoUser: group claim maps to a higher role via group_role_map', () => {
  const f = makeFakeOps();
  const { role } = resolveSsoUser({
    claims: { sub: 'okta|adm', email: 'adm@a.test', groups: ['Engineering', 'Admins'], iss: CONF.issuer },
    org: ORG_A,
    config: CONF,
    ops: f.ops,
  });
  assert.equal(role, 'admin');
});

test('mapGroupsToRole picks the highest-privilege matching group', () => {
  const map = { Member: 'member', Admins: 'admin', Owners: 'owner' };
  assert.equal(mapGroupsToRole(['Member', 'Admins'], map), 'admin');
  assert.equal(mapGroupsToRole(['Owners', 'Admins'], map), 'owner');
  assert.equal(mapGroupsToRole(['Unknown'], map), null);
  assert.equal(mapGroupsToRole(undefined, map), null);
});

test('resolveSsoUser: existing okta identity logs in (no duplicate create)', () => {
  const f = makeFakeOps({
    users: { 5: { email: 'old@a.test', org_id: ORG_A.id, org_role: 'member', is_active: 1 } },
    identities: { 'okta:okta|old': 5 },
  });
  const { user, created } = resolveSsoUser({
    claims: { sub: 'okta|old', email: 'old@a.test', iss: CONF.issuer },
    org: ORG_A,
    config: CONF,
    ops: f.ops,
  });
  assert.equal(created, false);
  assert.equal(user.id, 5);
  assert.equal(f.created.length, 0);
});

test('resolveSsoUser: deactivated user is BLOCKED', () => {
  const f = makeFakeOps({
    users: { 6: { email: 'dead@a.test', org_id: ORG_A.id, org_role: 'member', is_active: 0 } },
    identities: { 'okta:okta|dead': 6 },
  });
  assert.throws(
    () => resolveSsoUser({ claims: { sub: 'okta|dead', email: 'dead@a.test', iss: CONF.issuer }, org: ORG_A, config: CONF, ops: f.ops }),
    (e) => e.code === 'deactivated'
  );
});

test('resolveSsoUser: cross-org safety — an okta identity in a DIFFERENT org is rejected', () => {
  const f = makeFakeOps({
    users: { 7: { email: 'x@a.test', org_id: 999, org_role: 'member', is_active: 1 } },
    identities: { 'okta:okta|x': 7 },
  });
  assert.throws(
    () => resolveSsoUser({ claims: { sub: 'okta|x', email: 'x@a.test', iss: CONF.issuer }, org: ORG_A, config: CONF, ops: f.ops }),
    (e) => e.code === 'cross_org'
  );
});

test('resolveSsoUser: issuer mismatch is rejected (token for another org)', () => {
  const f = makeFakeOps();
  assert.throws(
    () => resolveSsoUser({ claims: { sub: 'okta|z', email: 'z@a.test', iss: 'https://evil.okta.com' }, org: ORG_A, config: CONF, ops: f.ops }),
    (e) => e.code === 'issuer_mismatch'
  );
});

test('resolveSsoUser: JIT off → requires an invitation (rejected when none)', () => {
  const f = makeFakeOps();
  const conf = { ...CONF, jit_provisioning: 0 };
  assert.throws(
    () => resolveSsoUser({ claims: { sub: 'okta|noinv', email: 'noinv@a.test', iss: CONF.issuer }, org: ORG_A, config: conf, ops: f.ops }),
    (e) => e.code === 'no_invite'
  );
});

test('resolveSsoUser: JIT off → an invitation places the user in the invite org+role', () => {
  const f = makeFakeOps({ invitations: [{ id: 1, email: 'inv@a.test', org_id: ORG_A.id, role: 'admin' }] });
  const conf = { ...CONF, jit_provisioning: 0 };
  const { user, created, role } = resolveSsoUser({
    claims: { sub: 'okta|inv', email: 'inv@a.test', iss: CONF.issuer },
    org: ORG_A,
    config: conf,
    ops: f.ops,
  });
  assert.equal(created, true);
  assert.equal(role, 'admin');
  assert.equal(user.org_id, ORG_A.id);
});

// ── (c') The fake-claims hook over HTTP — same finalize path as the real callback

async function setupSsoOrg(c, { name, issuer, domain, jit = true, enforced = false }) {
  await c.post('/api/orgs', { name });
  await c.put('/api/orgs/sso', { issuer, clientId: 'cid', clientSecret: 'secret', jitProvisioning: jit, enforced });
  const add = await c.post('/api/orgs/sso/domains', { domain });
  await c.post(`/api/orgs/sso/domains/${add.data.domain.id}/verify`, {});
}

test('fake-claims hook: JIT login establishes a session in the routed org', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'hook-owner', name: 'Hook Owner' });
  await setupSsoOrg(owner, { name: 'Hook Org', issuer: 'https://hook.okta.com', domain: 'hook.test' });

  const sso = client();
  const r = await sso.post('/api/test/sso-callback', { sub: 'okta|hook1', email: 'staff@hook.test', groups: [] });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'staff@hook.test');
  // The session is live: /api/auth/me returns the same user.
  const me = await sso.get('/api/auth/me');
  assert.equal(me.data.user.email, 'staff@hook.test');
});

test('fake-claims hook: a token whose iss != the org issuer is rejected', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'iss-owner', name: 'Iss Owner' });
  await setupSsoOrg(owner, { name: 'Iss Org', issuer: 'https://iss.okta.com', domain: 'issorg.test' });

  const r = await client().post('/api/test/sso-callback', {
    sub: 'okta|x',
    email: 'p@issorg.test',
    iss: 'https://attacker.okta.com',
  });
  assert.equal(r.status, 403);
});

test('fake-claims hook: deactivated SSO user cannot log in', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'deact-owner', name: 'Deact Owner' });
  await setupSsoOrg(owner, { name: 'Deact Org', issuer: 'https://de.okta.com', domain: 'deactorg.test' });

  // First login JIT-creates the member.
  const sso = client();
  const first = await sso.post('/api/test/sso-callback', { sub: 'okta|de1', email: 'gone@deactorg.test' });
  assert.equal(first.status, 200);
  const memberId = first.data.user.id;

  // Owner deactivates them.
  const members = (await owner.get('/api/orgs/members')).data.members;
  assert.ok(members.some((m) => m.id === memberId));
  const deact = await owner.patch(`/api/orgs/members/${memberId}/active`, { active: false });
  assert.equal(deact.status, 200);

  // Next SSO attempt is blocked.
  const again = await client().post('/api/test/sso-callback', { sub: 'okta|de1', email: 'gone@deactorg.test' });
  assert.equal(again.status, 403);
});

// ── (d) 'enforced' toggle disables non-SSO logins for the org ────────────────

test("enforced toggle blocks a member's magic-link login", async () => {
  const owner = client();
  await owner.login({ linkedinId: 'enf-owner', name: 'Enf Owner' });
  await setupSsoOrg(owner, { name: 'Enforced Org', issuer: 'https://enf.okta.com', domain: 'enforced.test', enforced: true });

  // JIT-create a member via SSO so they belong to the enforced org.
  const m = await client().post('/api/test/sso-callback', { sub: 'okta|enf1', email: 'member@enforced.test' });
  assert.equal(m.status, 200);

  // That member now tries a magic-link login → blocked by the enforced gate.
  const u = client();
  const reqRes = await u.post('/api/auth/magic-link/request', { email: 'member@enforced.test' });
  const token = reqRes.data.devToken;
  assert.ok(token, 'dev token expected in test');
  const consume = await u.post('/api/auth/magic-link/consume', { token });
  assert.equal(consume.status, 403);
  assert.match(consume.data.error, /single sign-on|SSO/i);
});

// ── Graceful: the app is fully usable with NO SSO configured ─────────────────

test('with no SSO configured, magic-link + demo logins are unaffected', async () => {
  // /api/auth/config still advertises magic-link; demo login still works.
  const c = client();
  const cfg = await c.get('/api/auth/config');
  assert.equal(cfg.data.magicLinkEnabled, true);
  const demo = await c.post('/api/auth/demo', {});
  assert.equal(demo.status, 200);
  assert.equal(demo.data.user.isDemo, true);
});
