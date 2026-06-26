// Real teams & live leaderboard: a non-demo team must aggregate its REAL members'
// REAL stats (referrals → donations → amount raised → beneficiaries funded),
// org-scoped, with the team goal/impact figures driven by PER-ORG economics — not
// the hardcoded module constants. Demo teammates must NEVER appear on a real team.
// Runs fully offline against an isolated DB (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// Drive a user from a fresh connection all the way to a recorded donation so their
// real impact aggregate (raised/donations/students) is populated for the leaderboard.
async function recordDonation(c, name, url, amount) {
  await c.post('/api/connections/upload', {
    contacts: [{ contact_name: name, contact_email: `${url}@x.test`, company: 'Acme', linkedin_url: `https://l/${url}` }],
  });
  const conn = (await c.get('/api/prospects')).data.prospects.find((p) => p.contact_name === name);
  const ref = await c.post('/api/referrals', { connectionId: conn.id });
  const refId = ref.data.referral.id;
  const donated = await c.post(`/api/referrals/${refId}/donation`, { amount });
  assert.equal(donated.status, 200);
  return donated;
}

test('real team with 2+ members shows both members real stats on the leaderboard', async () => {
  // Owner creates the org + team and raises money.
  const owner = client();
  await owner.login({ linkedinId: 'rt-owner' });
  await owner.post('/api/orgs', { name: 'Real Team Org' });
  const orgCode = (await owner.get('/api/orgs/me')).data.org.joinCode;
  const created = await owner.post('/api/team', { name: 'Squad', goalAmount: 10000 });
  const teamCode = created.data.team.inviteCode;
  await recordDonation(owner, 'Owner Donor', 'ownerdonor', 600);

  // Teammate joins the SAME org, then the team by its invite code, and raises more.
  const mate = client();
  await mate.login({ linkedinId: 'rt-mate' });
  await mate.post('/api/orgs/join', { code: orgCode });
  const joined = await mate.post('/api/team/join', { code: teamCode });
  assert.equal(joined.status, 200);
  await recordDonation(mate, 'Mate Donor', 'matedonor', 900);

  // The leaderboard (read by either member) lists BOTH with their real numbers.
  const board = (await owner.get('/api/team')).data;
  assert.equal(board.team.memberCount, 2, 'two real members on the team');
  assert.equal(board.leaderboard.length, 2);

  const names = board.leaderboard.map((m) => m.name).sort();
  // The teammate raised more, so they rank first (ordered by raised DESC).
  assert.equal(board.leaderboard[0].raised, 900);
  assert.equal(board.leaderboard[1].raised, 600);
  assert.equal(board.leaderboard[0].donations, 1);
  assert.equal(board.aggregate.raised, 1500, 'aggregate sums real members');
  assert.equal(board.aggregate.donations, 2);
  assert.equal(board.aggregate.totalReferrals, 2);
  assert.ok(names.length === 2);
});

test('per-org economics drive team impact figures (not the hardcoded constants)', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'econ-owner' });
  await owner.post('/api/orgs', { name: 'Econ Org' });
  // Set a per-org program cost of $300/beneficiary (default cause is $800).
  const cfg = await owner.patch('/api/orgs/config', { impact: { programCost: 300, dayCost: 100 } });
  assert.equal(cfg.status, 200);

  await owner.post('/api/team', { name: 'Econ Squad', goalAmount: 5000 });
  await recordDonation(owner, 'Econ Donor', 'econdonor', 900);

  const board = (await owner.get('/api/team')).data;
  // $900 / $300 = 3 beneficiaries (would be 1 at the hardcoded $800 default).
  assert.equal(board.aggregate.studentsFunded, 3, 'studentsFunded uses per-org programCost');
  assert.equal(board.aggregate.daysFunded, 9, 'daysFunded uses per-org dayCost');
  // The economics block exposes the per-org numbers for the client labels.
  assert.equal(board.economics.costPerBootcamp, 300);
  assert.equal(board.economics.costPerDay, 100);
});

test('demo teammates do NOT appear on a non-demo team leaderboard', async () => {
  const u = client();
  await u.login({ linkedinId: 'no-demo-team' });
  await u.post('/api/orgs', { name: 'Clean Org' });
  await u.post('/api/team', { name: 'Clean Squad' });
  await recordDonation(u, 'Real Donor', 'realdonor', 400);

  const board = (await u.get('/api/team')).data;
  // Only the real owner — no seeded demo-teammate-* users.
  assert.equal(board.team.memberCount, 1);
  assert.equal(board.leaderboard.length, 1);
  assert.ok(
    board.leaderboard.every((m) => !/^Teammate [A-E]$/.test(m.name)),
    'no DEMO_TEAMMATES leaked onto the real team'
  );
});

test('demo mode still populates + removes the leaderboard (presentation flow)', async () => {
  const u = client();
  await u.login({ linkedinId: 'demo-flow' });
  await u.post('/api/orgs', { name: 'Demo Flow Org' });

  // Enable demo → a team appears, populated with the seeded teammates.
  const enabled = await u.post('/api/demo/enable', {});
  assert.equal(enabled.status, 200);
  const onBoard = (await u.get('/api/team')).data;
  assert.ok(onBoard.team, 'demo mode created/used a team');
  // The 5 seeded teammates + the real user.
  assert.ok(onBoard.leaderboard.some((m) => /^Teammate A$/.test(m.name)), 'demo teammates present in demo mode');
  assert.ok(onBoard.leaderboard.length >= 6);

  // Disable demo → seeded teammates are removed; the leaderboard is real again.
  const disabled = await u.post('/api/demo/disable', {});
  assert.equal(disabled.status, 200);
  const offBoard = (await u.get('/api/team')).data;
  assert.ok(
    offBoard.leaderboard.every((m) => !/^Teammate [A-E]$/.test(m.name)),
    'demo teammates removed when demo mode is turned off'
  );
});

test('a team leaderboard is org-isolated (no other org members)', async () => {
  // Org A: owner + teammate on a shared team.
  const a = client();
  await a.login({ linkedinId: 'iso-team-a-owner' });
  await a.post('/api/orgs', { name: 'Iso Team Org A' });
  const aOrgCode = (await a.get('/api/orgs/me')).data.org.joinCode;
  const aTeam = await a.post('/api/team', { name: 'Iso Squad A' });
  const aTeamCode = aTeam.data.team.inviteCode;
  await recordDonation(a, 'A Donor', 'adonor', 500);

  const a2 = client();
  await a2.login({ linkedinId: 'iso-team-a-mate' });
  await a2.post('/api/orgs/join', { code: aOrgCode });
  await a2.post('/api/team/join', { code: aTeamCode });
  await recordDonation(a2, 'A2 Donor', 'a2donor', 300);

  // Org B: a totally separate org/team with its own member raising money.
  const b = client();
  await b.login({ linkedinId: 'iso-team-b-owner' });
  await b.post('/api/orgs', { name: 'Iso Team Org B' });
  await b.post('/api/team', { name: 'Iso Squad B' });
  await recordDonation(b, 'B Donor', 'bdonor', 9999);

  // A's leaderboard shows only org-A members; B's $9999 never appears.
  const aBoard = (await a.get('/api/team')).data;
  assert.equal(aBoard.team.memberCount, 2, 'only the two org-A members');
  assert.equal(aBoard.aggregate.raised, 800, 'sums only org-A donations (500 + 300)');
  assert.ok(aBoard.leaderboard.every((m) => m.raised !== 9999), 'no org-B numbers leak in');

  // B's leaderboard is its own, isolated.
  const bBoard = (await b.get('/api/team')).data;
  assert.equal(bBoard.team.memberCount, 1);
  assert.equal(bBoard.aggregate.raised, 9999);
});
