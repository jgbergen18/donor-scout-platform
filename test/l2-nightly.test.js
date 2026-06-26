// L2 — the nightly Standing Planner (AI SUCCESS path, offline). KEEP_AI_KEY=1 + a
// FAKE Anthropic client (lib/ai's __test.setClient seam) returns a canned plan; NO
// network, NO send. Guards the L2 guarantees:
//   - auto-approve only QUEUES a 'to_ask' referral (never sends, never records a gift),
//   - autoApproveMoves=false leaves moves for human review,
//   - the tick is idempotent per campaign/day,
//   - CRON TENANT ISOLATION: the org boundary is re-derived from the campaign row
//     (no session), so one org's nightly moves never reference another org's data.
process.env.NODE_ENV = 'test';
process.env.KEEP_AI_KEY = '1';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used';
process.env.AI_DAILY_BUDGET_USD = '1000';
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '1000';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

let failPlans = 0; // test hook: make the next N planner calls throw (transient failure)
const ai = await import('../lib/ai.js');
ai.__test.setClient({
  messages: {
    create: async (reqBody) => {
      const prompt = (reqBody.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const props = reqBody.output_config?.format?.schema?.properties || {};
      // Planner → one ASK action referencing the first real candidate id in the prompt.
      if (props.actions) {
        if (failPlans > 0) { failPlans--; throw new Error('Transient planner failure'); }
        const m = prompt.match(/id:\s*(\d+)/);
        const cid = m ? Number(m[1]) : 1;
        const plan = {
          strategy: 'Lead with the warmest cause-aligned contact.',
          actions: [{ connectionId: cid, kind: 'ask', channel: 'email', suggestedAsk: 100, pYes: 60, rationale: 'Warm tie.', hook: 'You mentioned the cause.', scheduleOffsetDays: 0 }],
        };
        return { content: [{ type: 'text', text: JSON.stringify(plan) }], usage: { input_tokens: 600, output_tokens: 200 }, stop_reason: 'end_turn' };
      }
      return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 50, output_tokens: 10 }, stop_reason: 'end_turn' };
    },
  },
});

const { client, closeServer } = await import('./helpers.js');
const server = await import('../server.js');
after(() => closeServer());

async function seed(u, orgName, contact) {
  await u.post('/api/orgs', { name: orgName });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: contact, company: 'Kyiv Digital', role: 'Engineer', linkedin_url: `https://l/${contact.replace(/\s/g, '')}` }] });
  await u.post('/api/campaigns', { name: 'Nightly Drive', goalAmount: 1000 });
}

test('moveTierFor surfaces net-new asks first, routine moves second', () => {
  assert.equal(server.moveTierFor('ask'), 'ask');
  assert.equal(server.moveTierFor('followup'), 'routine');
  assert.equal(server.moveTierFor('thanks'), 'routine');
});

test('nightly run stages moves and auto-approves them into to_ask referrals (NO send)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-auto', name: 'Nadia N' });
  await seed(u, 'Nightly Org', 'Olena K');

  const run = (await u.post('/api/brief/run')).data;
  assert.equal(run.enabled, true);
  assert.ok(run.staged >= 1 && run.approved >= 1, 'a move was staged and auto-approved');

  const brief = (await u.get('/api/brief')).data;
  assert.ok(brief.autoApproved.length >= 1, 'the Morning Brief shows auto-approved moves');
  assert.equal(brief.needsReview.length, 0, 'nothing left to review when auto-approve is on');
  assert.equal(brief.autoApproved[0].tier, 'ask');

  // Auto-approve only QUEUED a to_ask referral — nothing was sent or recorded.
  const refId = brief.autoApproved[0].referralId;
  assert.ok(refId, 'the approved move queued a referral');
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.id === refId);
  assert.equal(ref.status, 'to_ask', 'queued, never auto-sent/asked');
  assert.equal(ref.donation_received, 0, 'no gift fabricated');
});

test('autoApproveMoves=false leaves moves for human review (no auto referral)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-review', name: 'Roman R' });
  await seed(u, 'Review Org', 'Petro P');
  await u.patch('/api/orgs/autonomy', { autoApproveMoves: false });

  const run = (await u.post('/api/brief/run')).data;
  assert.ok(run.staged >= 1, 'still staged');
  assert.equal(run.approved, 0, 'nothing auto-approved');

  const brief = (await u.get('/api/brief')).data;
  assert.equal(brief.autoApproved.length, 0);
  assert.ok(brief.needsReview.length >= 1, 'moves wait for the human');
  // No nightly referral was queued.
  assert.equal((await u.get('/api/referrals')).data.referrals.length, 0);

  // The human approval path still works → queues to_ask.
  const appr = await u.post(`/api/actions/${brief.needsReview[0].id}/approve`);
  assert.ok(appr.data.referralId, 'manual approve still queues a referral');
});

test('the nightly tick is idempotent per campaign/day (no duplicate moves)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-idem', name: 'Ivan I' });
  await seed(u, 'Idem Org', 'Maria M');

  await u.post('/api/brief/run');
  const first = (await u.get('/api/brief')).data.total;
  assert.ok(first >= 1);
  const second = (await u.post('/api/brief/run')).data;
  assert.equal(second.staged, 0, 'second run plans nothing new');
  assert.equal((await u.get('/api/brief')).data.total, first, 'no duplicate moves');
});

test('a failed plan releases the day’s claim so a later run retries (no duplicates)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-retry', name: 'Yara Y' });
  await seed(u, 'Retry Org', 'Taras T');

  failPlans = 1; // make the first planner call throw
  const first = (await u.post('/api/brief/run')).data;
  assert.equal(first.staged, 0, 'failed plan staged nothing');
  assert.equal((await u.get('/api/brief')).data.total, 0, 'nothing left staged after a failure');

  // The claim was released → a later run re-plans successfully (exactly once).
  const second = (await u.post('/api/brief/run')).data;
  assert.ok(second.staged >= 1, 'retry succeeds');
  assert.equal((await u.get('/api/brief')).data.total, second.staged, 'no duplicate moves from the retry');
});

test('deleting a campaign removes its staged moves, runs, and nightly_runs (no orphans)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l2-del', name: 'Cleo C' });
  await seed(u, 'Del Camp Org', 'Olga O');
  await u.post('/api/brief/run'); // stages nightly moves + a nightly_runs claim row
  assert.ok((await u.get('/api/brief')).data.total >= 1, 'moves staged');
  const campId = (await u.get('/api/campaigns')).data.campaigns[0].id;

  const del = await u.del(`/api/campaigns/${campId}`);
  assert.equal(del.status, 200);
  assert.equal((await u.get('/api/brief')).data.total, 0, 'staged moves removed with the campaign');
  // Assert the dependent ledgers are clean directly (the orphan the audit caught).
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM nightly_runs WHERE campaign_id = ?').get(campId).n, 0, 'no orphan nightly_runs');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM agent_actions WHERE campaign_id = ?').get(campId).n, 0, 'no orphan agent_actions');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE campaign_id = ?').get(campId).n, 0, 'no orphan agent_runs');
});

test('CRON ISOLATION: a global nightly run never crosses tenants', async () => {
  const a = client();
  await a.login({ linkedinId: 'l2-iso-a', name: 'Ana A' });
  await seed(a, 'Iso Org A', 'Olena Alpha');

  const b = client();
  await b.login({ linkedinId: 'l2-iso-b', name: 'Bo B' });
  await seed(b, 'Iso Org B', 'Bohdan Beta');

  // The session-less global tick — the org boundary comes from each campaign row.
  await server.runNightlyPlanning();

  const briefA = (await a.get('/api/brief')).data;
  const briefB = (await b.get('/api/brief')).data;
  const namesA = [...briefA.autoApproved, ...briefA.needsReview].map((m) => m.contactName);
  const namesB = [...briefB.autoApproved, ...briefB.needsReview].map((m) => m.contactName);

  assert.ok(namesA.some((n) => /Olena Alpha/.test(n)), 'org A planned its own contact');
  assert.ok(!namesA.some((n) => /Bohdan Beta/.test(n)), "org A never sees org B's contact");
  assert.ok(namesB.some((n) => /Bohdan Beta/.test(n)), 'org B planned its own contact');
  assert.ok(!namesB.some((n) => /Olena Alpha/.test(n)), "org B never sees org A's contact");

  // And the queued referrals stay org-scoped too.
  const refsA = (await a.get('/api/referrals')).data.referrals.map((r) => r.contact_name);
  assert.ok(!refsA.some((n) => /Bohdan Beta/.test(n)), "org A's pipeline has no org B contact");
});
