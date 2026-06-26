// Retention engine, Milestone 1: the second-gift lane (Stewardship-on-rails Tier-0).
// A donated + thanked donor whose single gift is now 30-90 days old resurfaces as a
// re-ask. Detection is deterministic SQL (zero AI). These tests pin the detector's
// gates (one gift, in-window, thanked, no open ask), the no-send mark/snooze (which only
// schedules a follow-up reminder), org isolation, the cap, and the AI-off fallback.
// All offline (no key) — the AI success path lives in retention-second-gift-ai.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// N days ago as YYYY-MM-DD (the detector windows on date('now', '-N days')).
const ymd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const slug = (s) => s.replace(/\s+/g, '-').toLowerCase();

// Create a donor with a dated gift (org-scoped), optionally thanked / with a 2nd gift.
async function gift(u, name, daysAgo, { thanked = true, secondAmount } = {}) {
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: name, company: 'Acme', linkedin_url: `https://l/${slug(name)}` }],
  });
  await u.post('/api/donations/reconcile', { donors: [{ name, amount: 100, date: ymd(-daysAgo) }] });
  if (secondAmount) {
    await u.post('/api/donations/reconcile', { donors: [{ name, amount: secondAmount, date: ymd(-(daysAgo + 5)) }] });
  }
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === name);
  if (thanked) await u.post(`/api/referrals/${ref.id}/thanked`);
  return ref;
}

test('the lane surfaces only a thanked, single-gift donor in the 30-90 day window', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-detect', name: 'Dee' });
  await u.post('/api/orgs', { name: 'Detect Org' });
  await gift(u, 'Aria Window', 45); // qualifies
  await gift(u, 'Bea Twice', 45, { secondAmount: 50 }); // two gifts → excluded
  await gift(u, 'Cleo Recent', 10); // too recent → excluded
  await gift(u, 'Dom Stale', 200); // too old → excluded
  await gift(u, 'Eve Unthanked', 45, { thanked: false }); // not thanked → excluded

  const today = (await u.get('/api/today')).data;
  const names = today.secondGifts.map((r) => r.contact_name);
  assert.deepEqual(names, ['Aria Window'], `only the qualifying donor surfaces (got: ${names.join(', ') || 'none'})`);
  assert.equal(today.secondGifts[0].donation_amount, 100, 'carries the real prior gift amount');
  assert.ok(today.secondGifts[0].daysAgo >= 30 && today.secondGifts[0].daysAgo <= 90, 'daysAgo is inside the window');
});

test('marking a re-asked donor drops them from the lane and opens a follow-up reminder', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-mark', name: 'Mark' });
  await u.post('/api/orgs', { name: 'Mark Org' });
  const ref = await gift(u, 'Gina Reask', 45);
  assert.ok((await u.get('/api/today')).data.secondGifts.some((r) => r.id === ref.id), 'in the lane first');

  const r = await u.post(`/api/referrals/${ref.id}/reconnect`, { asked: true });
  assert.equal(r.status, 200);
  assert.ok(!(await u.get('/api/today')).data.secondGifts.some((x) => x.id === ref.id), 'gone from the lane (open reminder)');
  const reminders = (await u.get('/api/reminders')).data.reminders;
  assert.ok(reminders.some((rm) => rm.referral_id === ref.id), 're-entered into the reminders cadence');
});

test('skipping a donor drops them from the lane durably and schedules no reminder', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-skip', name: 'Sue' });
  await u.post('/api/orgs', { name: 'Skip Org' });
  const ref = await gift(u, 'Sam Skip', 45);
  const r = await u.post(`/api/referrals/${ref.id}/reconnect`, { snooze: true });
  assert.equal(r.status, 200);
  assert.ok(!(await u.get('/api/today')).data.secondGifts.some((x) => x.id === ref.id), 'gone from the lane');
  const open = (await u.get('/api/reminders')).data.reminders.filter((rm) => rm.referral_id === ref.id);
  assert.equal(open.length, 0, 'skip dismisses without scheduling a follow-up reminder');
});

test('a re-asked donor stays out of the lane even after the follow-up cadence fully completes', async () => {
  // Regression: suppression must be DURABLE (the second_ask_at marker), not merely while an
  // open reminder happens to exist. Once the auto-seeded [3,7,14] cadence is fully completed,
  // a donor still inside the 30-90d window must NOT re-surface.
  const u = client();
  await u.login({ linkedinId: 'sg-durable', name: 'Dura' });
  await u.post('/api/orgs', { name: 'Durable Org' });
  const ref = await gift(u, 'Hank Durable', 45);
  await u.post(`/api/referrals/${ref.id}/reconnect`, { asked: true });

  // Drain the cadence to completion (each complete advances to the next step; [3,7,14] = 3).
  for (let i = 0; i < 6; i++) {
    const open = (await u.get('/api/reminders')).data.reminders.filter((rm) => rm.referral_id === ref.id);
    if (!open.length) break;
    await u.post(`/api/reminders/${open[0].id}/complete`);
  }
  const stillOpen = (await u.get('/api/reminders')).data.reminders.filter((rm) => rm.referral_id === ref.id);
  assert.equal(stillOpen.length, 0, 'cadence fully drained (no open reminder)');
  assert.ok(!(await u.get('/api/today')).data.secondGifts.some((x) => x.id === ref.id), 'does not re-surface after the cadence completes');
});

test('the second-gift lane and its actions are org-scoped', async () => {
  const a = client();
  await a.login({ linkedinId: 'sg-iso-a', name: 'A' });
  await a.post('/api/orgs', { name: 'SG Iso A' });
  const ref = await gift(a, 'Iso Donor', 45);
  assert.ok((await a.get('/api/today')).data.secondGifts.length >= 1, 'owner sees their own donor');

  const b = client();
  await b.login({ linkedinId: 'sg-iso-b', name: 'B' });
  await b.post('/api/orgs', { name: 'SG Iso B' });
  assert.equal((await b.get('/api/today')).data.secondGifts.length, 0, "org B sees none of org A's donors");
  // And org B cannot act on org A's referral (404 before any work).
  assert.equal((await b.post(`/api/referrals/${ref.id}/reconnect`, { asked: true })).status, 404);
  assert.equal((await b.post(`/api/referrals/${ref.id}/reconnect-draft`)).status, 404);
});

test('the lane is capped (never floods the daily queue)', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-cap', name: 'Cap' });
  await u.post('/api/orgs', { name: 'Cap Org' });
  const contacts = [];
  for (let i = 0; i < 12; i++) contacts.push({ contact_name: `Capper ${i}`, company: 'Acme', linkedin_url: `https://l/cap${i}` });
  await u.post('/api/connections/upload', { contacts });
  await u.post('/api/donations/reconcile', { donors: contacts.map((c) => ({ name: c.contact_name, amount: 100, date: ymd(-45) })) });
  for (const r of (await u.get('/api/referrals')).data.referrals) await u.post(`/api/referrals/${r.id}/thanked`);

  assert.equal((await u.get('/api/today')).data.secondGifts.length, 10, 'capped at 10 even with 12 candidates');
});

test('reconnect-draft 503s with an editable static fallback when AI is off', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-noai', name: 'Noah' });
  await u.post('/api/orgs', { name: 'NoAI Org' });
  const ref = await gift(u, 'Faye Fallback', 45);
  const res = await u.post(`/api/referrals/${ref.id}/reconnect-draft`);
  assert.equal(res.status, 503, 'no key → 503, not an empty AI call');
  assert.ok(typeof res.data.fallback === 'string' && res.data.fallback.length > 0, 'a static fallback is provided');
  assert.match(res.data.fallback, /\$100/, 'the fallback grounds on the real prior gift amount');
});

test('reconnect-draft 404s for a referral with no recorded gift', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-nogift', name: 'Nora' });
  await u.post('/api/orgs', { name: 'NoGift Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Una Asked', company: 'Acme', linkedin_url: 'https://l/una' }] });
  const cid = (await u.get('/api/prospects')).data.prospects.find((p) => p.contact_name === 'Una Asked').id;
  await u.post('/api/referrals', { connectionId: cid }); // pipelined, never donated
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'Una Asked');
  const res = await u.post(`/api/referrals/${ref.id}/reconnect-draft`);
  assert.equal(res.status, 400, 'no donation on file → 400, never a re-ask for someone who never gave');
});
