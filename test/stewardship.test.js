// Thank-you / receipt stewardship: graceful degradation (503 + static fallback
// without a key), org isolation (a cross-org referral id → 404), thanked_at
// tracking, the org-scoped "donors awaiting thanks" surface, the acknowledgement
// receipt (impact + clearly-not-a-tax-receipt), and a pure unit test of the
// grounded thank-you context assembly (it must invent NOTHING).
//
// Offline: the harness deletes ANTHROPIC_API_KEY, so the thank-you route never
// reaches the real Anthropic API; the 503 guard returns before any SDK call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';
import { __stewardshipInternals } from '../server.js';

after(() => closeServer());

// Helper: a logged-in scout in a fresh org with one donated referral.
async function donatedReferral(linkedinId, name = 'Dana Donor', amount = 800) {
  const u = client();
  await u.login({ linkedinId });
  await u.post('/api/orgs', { name: `Org ${linkedinId}` });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: name, company: 'Acme', linkedin_url: 'https://l/x' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;
  const ref = (await u.post('/api/referrals', { connectionId: connId })).data.referral;
  await u.post(`/api/referrals/${ref.id}/donation`, { amount });
  return { u, ref };
}

test('thank-you route degrades gracefully without an API key (503 + static fallback)', async () => {
  const { u, ref } = await donatedReferral('thanks-503');
  const res = await u.post(`/api/referrals/${ref.id}/thank-you`, {});
  assert.equal(res.status, 503, 'no ANTHROPIC_API_KEY → graceful 503');
  assert.match(res.data.error, /ANTHROPIC_API_KEY/, 'message tells the user how to enable it');
  // The static fallback always lets the scout close the loop.
  assert.ok(res.data.fallback && res.data.fallback.length > 0, 'a static fallback thank-you is returned');
  assert.match(res.data.fallback, /Dana/, 'fallback addresses the donor by name');
  assert.match(res.data.fallback, /student/, 'fallback ties the $800 gift to concrete impact');
});

test('thank-you route is org-scoped: a cross-org referral id returns 404', async () => {
  const { ref } = await donatedReferral('thanks-iso-a');
  const b = client();
  await b.login({ linkedinId: 'thanks-iso-b' });
  await b.post('/api/orgs', { name: 'Other Org' });
  // B must not be able to draft a thank-you against A's referral → 404, not 503.
  const res = await b.post(`/api/referrals/${ref.id}/thank-you`, {});
  assert.equal(res.status, 404, 'cross-org referral id must 404 before the AI guard');
});

test('thanked_at tracking: mark-thanked removes the donor from awaiting-thanks', async () => {
  const { u, ref } = await donatedReferral('thanks-track');

  // Donated but unthanked → on the awaiting list.
  let awaiting = (await u.get('/api/referrals/awaiting-thanks')).data.referrals;
  assert.equal(awaiting.length, 1, 'one donor awaiting thanks');
  assert.equal(awaiting[0].id, ref.id);

  const marked = await u.post(`/api/referrals/${ref.id}/thanked`, {});
  assert.equal(marked.status, 200);
  assert.ok(marked.data.referral.thanked_at, 'thanked_at is set');

  // Now off the awaiting list.
  awaiting = (await u.get('/api/referrals/awaiting-thanks')).data.referrals;
  assert.equal(awaiting.length, 0, 'thanked donor no longer awaiting');

  // Idempotent: re-marking keeps the first timestamp.
  const first = marked.data.referral.thanked_at;
  const again = await u.post(`/api/referrals/${ref.id}/thanked`, {});
  assert.equal(again.data.referral.thanked_at, first, 'thanked_at is stable across re-marks');
});

test('mark-thanked is org-scoped: a cross-org referral id returns 404', async () => {
  const { ref } = await donatedReferral('thanks-mark-iso-a');
  const b = client();
  await b.login({ linkedinId: 'thanks-mark-iso-b' });
  await b.post('/api/orgs', { name: 'Mark Iso Org' });
  const res = await b.post(`/api/referrals/${ref.id}/thanked`, {});
  assert.equal(res.status, 404);
});

test('awaiting-thanks lists only this scout\'s donated-unthanked referrals', async () => {
  // Scout A: one donated (unthanked), one only asked (no donation).
  const a = client();
  await a.login({ linkedinId: 'awaiting-a' });
  await a.post('/api/orgs', { name: 'Awaiting Org' });
  await a.post('/api/connections/upload', {
    contacts: [
      { contact_name: 'Gave Money', company: 'A', linkedin_url: 'https://l/1' },
      { contact_name: 'Just Asked', company: 'A', linkedin_url: 'https://l/2' },
    ],
  });
  const ps = (await a.get('/api/prospects')).data.prospects;
  const gaveConn = ps.find((p) => p.contact_name === 'Gave Money').id;
  const askConn = ps.find((p) => p.contact_name === 'Just Asked').id;
  const gaveRef = (await a.post('/api/referrals', { connectionId: gaveConn })).data.referral;
  await a.post('/api/referrals', { connectionId: askConn }); // asked, no donation
  await a.post(`/api/referrals/${gaveRef.id}/donation`, { amount: 200 });

  // Scout B (separate org) also has a donated-unthanked referral.
  await donatedReferral('awaiting-b');

  const awaiting = (await a.get('/api/referrals/awaiting-thanks')).data.referrals;
  assert.equal(awaiting.length, 1, 'only A\'s one donated-unthanked referral');
  assert.equal(awaiting[0].contact_name, 'Gave Money', 'the asked-but-not-donated one is excluded');
});

test('receipt includes the impact and is clearly an acknowledgement, not a tax receipt', async () => {
  const { u, ref } = await donatedReferral('receipt-test', 'Pat Patron', 800);
  const res = await u.get(`/api/referrals/${ref.id}/receipt`);
  assert.equal(res.status, 200);
  const rc = res.data.receipt;

  assert.equal(rc.kind, 'acknowledgement', 'labeled an acknowledgement');
  assert.equal(rc.donor, 'Pat Patron');
  assert.equal(rc.amount, 800);
  assert.match(rc.impact || '', /student/, 'states the concrete impact the gift funds');
  // Explicitly NOT a tax document — Zeffy is the processor of record.
  assert.match(rc.disclaimer, /not an official tax receipt/i, 'disclaims tax-receipt status');
  assert.match(rc.disclaimer, /Zeffy/, 'names Zeffy as the processor of record');
});

test('receipt route is org-scoped: a cross-org referral id returns 404', async () => {
  const { ref } = await donatedReferral('receipt-iso-a');
  const b = client();
  await b.login({ linkedinId: 'receipt-iso-b' });
  await b.post('/api/orgs', { name: 'Receipt Iso Org' });
  const res = await b.get(`/api/referrals/${ref.id}/receipt`);
  assert.equal(res.status, 404);
});

// ── Pure unit tests of the grounded assembly (no API key needed) ──
const CFG = {
  orgName: 'Code for Ukraine',
  impact: { programCost: 800, dayCost: 57.14, beneficiary: 'student', beneficiaries: 'students', programLabel: 'bootcamp', dayLabel: 'day of camp' },
};

test('impactForAmount maps real amounts to concrete units and never fabricates', () => {
  const { impactForAmount } = __stewardshipInternals;
  assert.equal(impactForAmount(1600, CFG).beneficiaries, 2, '$1600 → 2 students');
  assert.match(impactForAmount(1600, CFG).summary, /2 students through the full bootcamp/);
  assert.match(impactForAmount(100, CFG).summary, /covers about \d+ days?/, 'sub-program gift → days');
  assert.equal(impactForAmount(0, CFG), null, 'no amount → null (nothing invented)');
  // With no economics configured, no impact is invented.
  assert.equal(impactForAmount(800, { orgName: 'X' }), null);
});

test('thankYouContext grounds on the real gift + impact + shared facts, invents nothing', () => {
  const { thankYouContext } = __stewardshipInternals;
  const referral = { donation_amount: 800, donation_date: '2026-06-01', contact_name: 'Sam Rivera', company: 'Globex' };
  const conn = {
    contact_name: 'Sam Rivera', company: 'Globex', role: 'Engineer', location: 'Kyiv',
    score_reasons: JSON.stringify([{ label: 'Same school' }]), github_username: null, dossier_json: null,
  };
  const scout = { name: 'Alex Kim', company: 'Initech', past_companies: null, location: null, schools: null };
  const history = [{ message_count: 4, sent_count: 2, received_count: 2, last_interaction: '2025-01-02', snippets: '["hi"]' }];

  const ctx = thankYouContext(referral, conn, scout, history, 'hey, quick note —', CFG);

  // Real gift carried through.
  assert.equal(ctx.donation.amount, 800);
  assert.equal(ctx.donation.org, 'Code for Ukraine');
  // Concrete impact attached (not invented — derived from the configured economics).
  assert.equal(ctx.impact.beneficiaries, 1);
  // Reuses the draft grounding facts.
  assert.equal(ctx.facts.contact.name, 'Sam Rivera');
  assert.deepEqual(ctx.facts.contact.relationshipSignals, ['Same school']);
  assert.equal(ctx.facts.you.name, 'Alex Kim');
  assert.equal(ctx.voiceSample, 'hey, quick note —');

  // Invents nothing: no wealth/income/net-worth keys anywhere in the context.
  const json = JSON.stringify(ctx).toLowerCase();
  for (const forbidden of ['networth', 'net_worth', 'income', 'salary', 'wealth']) {
    assert.ok(!json.includes(forbidden), `context must not contain "${forbidden}"`);
  }
});

test('thankYouSystem forbids fabrication + a second ask and states the impact rule', () => {
  const { thankYouSystem } = __stewardshipInternals;
  const voiced = thankYouSystem(CFG, true);
  const neutral = thankYouSystem(CFG, false);
  assert.match(voiced, /NEVER invent/i, 'forbids fabrication');
  assert.match(voiced, /never another ask|no second ask/i, 'no second ask — this is gratitude');
  assert.match(voiced, /Code for Ukraine/, 'names the cause');
  assert.match(voiced, /voiceSample/, 'voiced register references the writing sample');
  assert.match(neutral, /warm, plain, personal/i, 'neutral register when no sample');
  assert.notEqual(voiced, neutral, 'the two registers differ');
});

test('buildReceipt produces an impact-bearing acknowledgement (not a tax receipt)', () => {
  const { buildReceipt } = __stewardshipInternals;
  const rc = buildReceipt({ contact_name: 'Lee Giver', donation_amount: 400, donation_date: '2026-05-05' }, CFG);
  assert.equal(rc.kind, 'acknowledgement');
  assert.equal(rc.amount, 400);
  assert.match(rc.impact, /covers about \d+ days?/, 'concrete impact for a sub-program gift');
  assert.match(rc.disclaimer, /not an official tax receipt/i);
});
