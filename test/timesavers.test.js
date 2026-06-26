// Time-saving features: Tonight's 15 Minutes (Today queue), Reconcile Review
// (unmatched donors + near-match candidates + record), and the employer
// matching-gift detector. All are no-AI + no-send (local writes / copy only),
// so they run fully offline against the shared harness.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';
import { matchProgramFor, matchProgramWith, compileCustom, MATCH_PROGRAM_COUNT } from '../lib/matchgifts.js';

after(() => closeServer());

const upload = (u, contacts) => u.post('/api/connections/upload', { contacts });
const prospectId = async (u, name) =>
  (await u.get('/api/prospects')).data.prospects.find((p) => p.contact_name === name)?.id;

test('employer-match detector flags known companies and ignores look-alikes', () => {
  // Broad coverage across sectors from the expanded curated list.
  assert.ok(MATCH_PROGRAM_COUNT >= 150, `expanded list (${MATCH_PROGRAM_COUNT} programs)`);
  assert.equal(matchProgramFor('Google'), 'Google');
  assert.equal(matchProgramFor('Apple Inc.'), 'Apple');
  assert.equal(matchProgramFor('Senior Engineer, Microsoft'), 'Microsoft');
  assert.equal(matchProgramFor('JPMorgan Chase & Co.'), 'JPMorgan Chase');
  assert.equal(matchProgramFor('Pfizer'), 'Pfizer');
  assert.equal(matchProgramFor('Deloitte LLP'), 'Deloitte');
  assert.equal(matchProgramFor('The Home Depot'), 'The Home Depot');
  assert.equal(matchProgramFor('UPS'), 'UPS');
  // Word-boundary discipline → no false positives on look-alikes.
  assert.equal(matchProgramFor('Snapple'), null, 'Apple != Snapple');
  assert.equal(matchProgramFor('Visalia Unified'), null, 'Visa != Visalia');
  assert.equal(matchProgramFor('Stanford University'), null, 'Ford != Stanford');
  assert.equal(matchProgramFor('Startups Inc'), null, 'UPS != Startups');
  assert.equal(matchProgramFor('Acme Widgets'), null);
  assert.equal(matchProgramFor(''), null);
  assert.equal(matchProgramFor(null), null);
});

test("Today queue assembles prospects + a match-gift worklist, and is org-scoped", async () => {
  const a = client();
  await a.login({ linkedinId: 'today-a', name: 'Ana A' });
  await a.post('/api/orgs', { name: 'Org A' });
  await upload(a, [
    { contact_name: 'Olena K', company: 'Kyiv Digital', linkedin_url: 'https://l/olena' },
    { contact_name: 'Dana Match', company: 'Google', linkedin_url: 'https://l/dana' },
  ]);

  // Record a donation for Dana (at a match-eligible employer) via reconcile.
  const rec = await a.post('/api/donations/reconcile', { donors: [{ name: 'Dana Match', amount: 100 }] });
  assert.equal(rec.status, 200);
  assert.ok(rec.data.recorded >= 1 || rec.data.createdFromConnections >= 1, 'Dana donation recorded');

  const today = (await a.get('/api/today')).data;
  assert.ok(Array.isArray(today.prospects) && today.prospects.length >= 1, 'un-asked prospects surfaced');
  assert.ok(today.prospects.some((p) => p.contact_name === 'Olena K'), 'Olena is an un-asked prospect');
  const match = today.matchGifts.find((m) => m.contact_name === 'Dana Match');
  assert.ok(match, 'Dana appears in the match-gift worklist');
  assert.equal(match.program, 'Google', 'detector labels the employer program');

  // A second org sees none of org A's Today data.
  const b = client();
  await b.login({ linkedinId: 'today-b', name: 'Bo B' });
  await b.post('/api/orgs', { name: 'Org B' });
  const bToday = (await b.get('/api/today')).data;
  assert.equal(bToday.prospects.length, 0);
  assert.equal(bToday.matchGifts.length, 0);
});

test('snoozing a prospect drops it from the Today queue', async () => {
  const u = client();
  await u.login({ linkedinId: 'today-snooze', name: 'Sam S' });
  await u.post('/api/orgs', { name: 'Snooze Org' });
  await upload(u, [{ contact_name: 'Kyiv Friend', company: 'Kyiv Tech', linkedin_url: 'https://l/kf' }]);

  const before = (await u.get('/api/today')).data.prospects;
  assert.ok(before.some((p) => p.contact_name === 'Kyiv Friend'), 'shown before snooze');
  const id = await prospectId(u, 'Kyiv Friend');

  const snooze = await u.post('/api/today/snooze', { connectionId: id, days: 7 });
  assert.equal(snooze.status, 200);
  const after = (await u.get('/api/today')).data.prospects;
  assert.ok(!after.some((p) => p.contact_name === 'Kyiv Friend'), 'hidden after snooze');
});

test('Reconcile Review: unmatched donors get near-match candidates; record links or creates', async () => {
  const u = client();
  await u.login({ linkedinId: 'reconcile-rev', name: 'Rae R' });
  await u.post('/api/orgs', { name: 'Reconcile Org' });
  await upload(u, [{ contact_name: 'Olena Kovalenko', company: 'Kyiv Tech', linkedin_url: 'https://l/ok' }]);

  // A near (not exact) name doesn't auto-match → it lands in the review queue WITH a suggestion.
  const rec = await u.post('/api/donations/reconcile', { donors: [{ name: 'Olena Kovalchuk', amount: 50 }] });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.unmatched, 1);
  const row = rec.data.unmatchedReview.find((r) => r.name === 'Olena Kovalchuk');
  assert.ok(row, 'unmatched donor is in the review queue');
  assert.ok(row.candidates.length >= 1, 'near-match candidate suggested');
  assert.equal(row.candidates[0].name, 'Olena Kovalenko', 'suggests the right person');

  // LINK it to the suggested connection → records the gift on that person.
  const olenaId = await prospectId(u, 'Olena Kovalenko');
  const linked = await u.post('/api/donations/record', { donor: row, connectionId: olenaId });
  assert.equal(linked.status, 200);
  let refs = (await u.get('/api/referrals')).data.referrals;
  const olenaRef = refs.find((r) => r.connection_id === olenaId);
  assert.ok(olenaRef && olenaRef.donation_received === 1, 'donation recorded on the linked connection');
  assert.equal(olenaRef.donation_amount, 50);

  // Re-recording the same connection is a no-op, honestly reported (not double-counted).
  const again = await u.post('/api/donations/record', { donor: row, connectionId: olenaId });
  assert.equal(again.data.alreadyRecorded, true, 're-record reports already recorded');

  // RECORD a brand-new donor (no connection) → standalone donated referral.
  const created = await u.post('/api/donations/record', { donor: { name: 'Ghost Donor', amount: 25 } });
  assert.equal(created.status, 200);
  refs = (await u.get('/api/referrals')).data.referrals;
  const ghost = refs.find((r) => r.contact_name === 'Ghost Donor');
  assert.ok(ghost && ghost.donation_received === 1 && ghost.connection_id == null, 'standalone gift recorded');
  assert.equal(ghost.donation_amount, 25);
});

test('donations/record is org-scoped — cannot link to another org’s connection', async () => {
  const a = client();
  await a.login({ linkedinId: 'rec-iso-a', name: 'Ana' });
  await a.post('/api/orgs', { name: 'Iso A' });
  await upload(a, [{ contact_name: 'A Person', company: 'Acme', linkedin_url: 'https://l/ap' }]);
  const aId = await prospectId(a, 'A Person');

  const b = client();
  await b.login({ linkedinId: 'rec-iso-b', name: 'Bo' });
  await b.post('/api/orgs', { name: 'Iso B' });
  const res = await b.post('/api/donations/record', { donor: { name: 'A Person', amount: 99 }, connectionId: aId });
  assert.equal(res.status, 404, 'org B cannot record against org A connection');
});

test('matchProgramWith prefers custom companies, then falls back to the built-in list', () => {
  const custom = compileCustom([{ name: 'Globex' }]);
  assert.equal(matchProgramWith('Globex Corporation', custom), 'Globex', 'custom company matched');
  assert.equal(matchProgramWith('Google', custom), 'Google', 'falls back to built-in');
  assert.equal(matchProgramWith('Nowhere LLC', custom), null);
});

test('custom matching-gift companies extend the Today detector and are org-scoped', async () => {
  const a = client();
  await a.login({ linkedinId: 'match-a', name: 'Ana' });
  await a.post('/api/orgs', { name: 'Match Org A' });

  let mc = (await a.get('/api/match-companies')).data;
  assert.ok(mc.builtInCount >= 150, 'built-in count reported');
  assert.equal(mc.companies.length, 0);

  // Manual add + dedup (case-insensitive).
  assert.equal((await a.post('/api/match-companies', { name: 'Globex' })).status, 201);
  await a.post('/api/match-companies', { name: 'globex' });
  assert.equal(
    (await a.get('/api/match-companies')).data.companies.filter((c) => /globex/i.test(c.name)).length,
    1,
    'duplicate ignored'
  );

  // A donor at the custom employer now surfaces in the Today match worklist.
  await upload(a, [{ contact_name: 'Glo Donor', company: 'Globex', linkedin_url: 'https://l/glo' }]);
  await a.post('/api/donations/reconcile', { donors: [{ name: 'Glo Donor', amount: 75 }] });
  const today = (await a.get('/api/today')).data;
  const m = today.matchGifts.find((x) => x.contact_name === 'Glo Donor');
  assert.ok(m, 'custom-company donor surfaces');
  assert.equal(m.program, 'Globex');

  // CSV/bulk import (client parses → names array), deduped against existing.
  const bulk = await a.post('/api/match-companies/bulk', { names: ['Initech', 'Hooli', 'Globex'] });
  assert.equal(bulk.data.added, 2, 'Globex already present → only 2 new added');

  // Org B can't see org A's custom list, and it doesn't affect B's Today worklist.
  const b = client();
  await b.login({ linkedinId: 'match-b', name: 'Bo' });
  await b.post('/api/orgs', { name: 'Match Org B' });
  assert.equal((await b.get('/api/match-companies')).data.companies.length, 0);
  await upload(b, [{ contact_name: 'B Donor', company: 'Globex', linkedin_url: 'https://l/bd' }]);
  await b.post('/api/donations/reconcile', { donors: [{ name: 'B Donor', amount: 40 }] });
  const bToday = (await b.get('/api/today')).data;
  assert.ok(!bToday.matchGifts.some((x) => x.contact_name === 'B Donor'), "org A's custom company does not leak to org B");

  // Remove.
  const gid = (await a.get('/api/match-companies')).data.companies.find((c) => c.name === 'Globex').id;
  const del = await a.del(`/api/match-companies/${gid}`);
  assert.ok(!del.data.companies.some((c) => c.name === 'Globex'), 'removed');
});
