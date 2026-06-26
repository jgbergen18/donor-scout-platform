// Outreach sequencing + follow-up reminders: seeding the cadence on "asked",
// due/overdue computation, complete-advances-to-next-step, snooze, donated/declined
// closing open reminders, the legacy follow_up_date migration, and org-scoping (a
// cross-org reminder/referral id → 404; another org's reminders never appear).
// Runs fully offline against an isolated DB (see helpers.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

// Spin up a logged-in scout in their own org with one connection in the pipeline.
// Returns { c, connId } so each test starts from a clean, isolated tenant.
async function scoutWithProspect(linkedinId, contact = {}) {
  const c = client();
  await c.login({ linkedinId });
  await c.post('/api/orgs', { name: `Org ${linkedinId}` });
  await c.post('/api/connections/upload', {
    contacts: [
      {
        contact_name: contact.name || 'Pat Donor',
        contact_email: contact.email || `${linkedinId}@x.test`,
        company: contact.company || 'Acme',
        linkedin_url: 'https://l/pat',
      },
    ],
  });
  const connId = (await c.get('/api/prospects')).data.prospects[0].id;
  return { c, connId };
}

const today = () => new Date().toISOString().slice(0, 10);
function ymdPlus(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('marking "asked" seeds the cadence: one open reminder at +3d (default step 0)', async () => {
  const { c, connId } = await scoutWithProspect('rem-seed');
  // Creating a referral defaults to status "asked" → seeds the cadence.
  const ref = await c.post('/api/referrals', { connectionId: connId });
  assert.equal(ref.status, 201);

  const { data } = await c.get('/api/reminders');
  assert.equal(data.reminders.length, 1, 'exactly one reminder seeded');
  const r = data.reminders[0];
  assert.equal(r.step_index, 0);
  assert.equal(r.due_date, ymdPlus(3), 'step 0 is +3 days out');
  assert.equal(r.referral_id, ref.data.referral.id);
  // The legacy follow_up_date column tracks the next open reminder.
  assert.equal(ref.data.referral.follow_up_date, ymdPlus(3));
});

test('seeding is idempotent: re-PATCHing to "asked" does not stack reminders', async () => {
  const { c, connId } = await scoutWithProspect('rem-idem');
  const ref = (await c.post('/api/referrals', { connectionId: connId })).data.referral;
  await c.patch(`/api/referrals/${ref.id}`, { status: 'following_up' });
  await c.patch(`/api/referrals/${ref.id}`, { status: 'asked' });
  const { data } = await c.get('/api/reminders');
  assert.equal(data.reminders.length, 1, 'still just one open reminder');
});

test('due vs overdue is computed against today', async () => {
  const { c, connId } = await scoutWithProspect('rem-due');
  const ref = (await c.post('/api/referrals', { connectionId: connId })).data.referral;
  const rid = (await c.get('/api/reminders')).data.reminders[0].id;

  // Snooze it into the past → overdue; and a fresh one stays not-due.
  await c.post(`/api/reminders/${rid}/snooze`, { dueDate: ymdPlus(-2) });
  const { data } = await c.get('/api/reminders');
  const r = data.reminders.find((x) => x.id === rid);
  assert.equal(r.due, true, 'past due_date is "due"');
  assert.equal(r.overdue, true, 'strictly-past due_date is overdue');

  // Snooze to today → due but not overdue.
  await c.post(`/api/reminders/${rid}/snooze`, { dueDate: today() });
  const r2 = (await c.get('/api/reminders')).data.reminders.find((x) => x.id === rid);
  assert.equal(r2.due, true);
  assert.equal(r2.overdue, false, 'due today is not overdue');
  assert.equal(ref.status, 'asked');
});

test('completing a reminder advances to the next cadence step (+1w from the step due date)', async () => {
  const { c, connId } = await scoutWithProspect('rem-advance');
  await c.post('/api/referrals', { connectionId: connId });
  const step0 = (await c.get('/api/reminders')).data.reminders[0];
  assert.equal(step0.step_index, 0);

  const done = await c.post(`/api/reminders/${step0.id}/complete`, {});
  assert.equal(done.status, 200);
  assert.equal(done.data.open.length, 1, 'step 1 was seeded as the next open reminder');

  const queue = (await c.get('/api/reminders')).data.reminders;
  assert.equal(queue.length, 1, 'completed step 0 is gone; step 1 is now open');
  const step1 = queue[0];
  assert.equal(step1.step_index, 1);
  // cadence default [3,7,14]: step1 due = step0.due + 7 days.
  assert.equal(step1.due_date, ymdPlus(3 + 7));

  // Completing step 1 → step 2 (+14d from step1).
  await c.post(`/api/reminders/${step1.id}/complete`, {});
  const step2 = (await c.get('/api/reminders')).data.reminders[0];
  assert.equal(step2.step_index, 2);
  assert.equal(step2.due_date, ymdPlus(3 + 7 + 14));

  // Completing the LAST step ends the cadence — no more open reminders.
  await c.post(`/api/reminders/${step2.id}/complete`, {});
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 0);
});

test('snooze reschedules the same step without advancing', async () => {
  const { c, connId } = await scoutWithProspect('rem-snooze');
  await c.post('/api/referrals', { connectionId: connId });
  const r = (await c.get('/api/reminders')).data.reminders[0];

  const snoozed = await c.post(`/api/reminders/${r.id}/snooze`, { days: 5 });
  assert.equal(snoozed.status, 200);
  assert.equal(snoozed.data.dueDate, ymdPlus(5));

  const after = (await c.get('/api/reminders')).data.reminders;
  assert.equal(after.length, 1, 'still one reminder — snooze did not advance');
  assert.equal(after[0].id, r.id, 'same reminder row');
  assert.equal(after[0].step_index, 0, 'still step 0');
  assert.equal(after[0].due_date, ymdPlus(5));
});

test('donating closes open reminders', async () => {
  const { c, connId } = await scoutWithProspect('rem-donate');
  const ref = (await c.post('/api/referrals', { connectionId: connId })).data.referral;
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 1);

  await c.post(`/api/referrals/${ref.id}/donation`, { amount: 100 });
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 0, 'donation closed the cadence');
});

test('declining closes open reminders', async () => {
  const { c, connId } = await scoutWithProspect('rem-decline');
  const ref = (await c.post('/api/referrals', { connectionId: connId })).data.referral;
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 1);

  await c.patch(`/api/referrals/${ref.id}`, { status: 'declined' });
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 0, 'declining closed the cadence');
});

test('a manual follow_up_date edit reschedules the open reminder (legacy field still works)', async () => {
  const { c, connId } = await scoutWithProspect('rem-manual');
  const ref = (await c.post('/api/referrals', { connectionId: connId })).data.referral;
  const target = ymdPlus(9);
  const patched = await c.patch(`/api/referrals/${ref.id}`, { follow_up_date: target });
  assert.equal(patched.data.referral.follow_up_date, target);
  const r = (await c.get('/api/reminders')).data.reminders[0];
  assert.equal(r.due_date, target, 'open reminder moved to the requested date');
  assert.equal(r.step_index, 0, 'still the same step');

  // Clearing the date closes the open reminder.
  await c.patch(`/api/referrals/${ref.id}`, { follow_up_date: '' });
  assert.equal((await c.get('/api/reminders')).data.reminders.length, 0);
});

test('per-org cadence config drives seeding (admin-configurable)', async () => {
  const { c, connId } = await scoutWithProspect('rem-config');
  await c.patch('/api/orgs/config', { followUpCadenceDays: [1, 2] });
  await c.post('/api/referrals', { connectionId: connId });
  const r = (await c.get('/api/reminders')).data.reminders[0];
  assert.equal(r.due_date, ymdPlus(1), 'custom cadence step 0 = +1d');
});

test('org-scoping: a cross-org reminder id → 404, and another org never sees it', async () => {
  const a = await scoutWithProspect('rem-org-a');
  await a.c.post('/api/referrals', { connectionId: a.connId });
  const aReminder = (await a.c.get('/api/reminders')).data.reminders[0];
  assert.ok(aReminder, 'org A has a reminder');

  const b = await scoutWithProspect('rem-org-b');
  await b.c.post('/api/referrals', { connectionId: b.connId });

  // Org B never sees org A's reminder in its queue.
  const bQueue = (await b.c.get('/api/reminders')).data.reminders;
  assert.ok(!bQueue.some((r) => r.id === aReminder.id), "B's queue excludes A's reminder");

  // Org B cannot complete or snooze org A's reminder — 404, not a silent mutation.
  assert.equal((await b.c.post(`/api/reminders/${aReminder.id}/complete`, {})).status, 404);
  assert.equal((await b.c.post(`/api/reminders/${aReminder.id}/snooze`, {})).status, 404);

  // And A's reminder is untouched (still open, still step 0).
  const aStill = (await a.c.get('/api/reminders')).data.reminders;
  assert.equal(aStill.length, 1);
  assert.equal(aStill[0].id, aReminder.id);
});

test('completing an unknown reminder id → 404', async () => {
  const { c } = await scoutWithProspect('rem-404');
  assert.equal((await c.post('/api/reminders/999999/complete', {})).status, 404);
  assert.equal((await c.post('/api/reminders/999999/snooze', {})).status, 404);
});
