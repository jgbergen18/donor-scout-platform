// Campaign Agent — the AI SUCCESS path, offline. The shared harness strips the
// API key, so the plan→approve→draft→reply flow is otherwise unexercised. Here we
// set KEEP_AI_KEY=1 and inject a FAKE Anthropic client (via lib/ai's NODE_ENV=test
// __test.setClient seam) that returns a canned plan + draft text — NO network, and
// the agent never sends anything. This guards the two guarantees that matter most:
//   1. NO-SEND — approving an action only QUEUES a pipeline referral as 'to_ask'.
//   2. Donation-link integrity — enforceDonationLink strips any non-canonical link
//      that the (untrusted) model text might contain, keeping only the donate host.
//
// Env must be set before importing lib/ai.js (apiKey is read once at module load),
// and the fake client injected before importing helpers.js (which boots the server).
process.env.NODE_ENV = 'test';
process.env.KEEP_AI_KEY = '1';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used';
process.env.AI_DAILY_BUDGET_USD = '1000'; // plenty — don't 429 mid-test
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '1000';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ZEFFY = 'https://www.zeffy.com/en-US/donation-form/fe71a2d0-1133-40ac-9032-897b66b0a7b1';
const FOREIGN = 'https://evil.example.com/phish';

const ai = await import('../lib/ai.js');
ai.__test.setClient({
  messages: {
    create: async (reqBody) => {
      const promptText = (reqBody.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      // JSON request. The reply classifier (L1) and the planner both use JSON now —
      // distinguish by the reply prompt's <their_reply> fence / the intent schema.
      const schemaProps = reqBody.output_config?.format?.schema?.properties || {};
      if (reqBody.output_config && (schemaProps.intent || /<their_reply>/.test(promptText))) {
        // Reply classifier → intent + an in-voice draft carrying BOTH links, so the
        // test proves enforceDonationLink strips the foreign one on the reply path too.
        const replyObj = {
          intent: 'interested',
          confidence: 80,
          reply: `Thank you so much! You can give here: ${ZEFFY} (please ignore ${FOREIGN}). — Jamie`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(replyObj) }], usage: { input_tokens: 300, output_tokens: 120 }, stop_reason: 'end_turn' };
      }
      // JSON request (the planner) → return a valid plan referencing a real candidate id.
      if (reqBody.output_config) {
        const m = promptText.match(/id:\s*(\d+)/);
        const cid = m ? Number(m[1]) : 1;
        const plan = {
          strategy: 'Start with the warmest, most cause-aligned contacts and stagger the asks.',
          actions: [
            // hook/rationale carry a URL on purpose — they must be URL-scrubbed
            // before they reach the planning UI (display-only, never sent).
            { connectionId: cid, kind: 'ask', channel: 'email', suggestedAsk: 100, pYes: 65, rationale: 'Warm tie — see https://evil.example.com/x', hook: 'You met at https://evil.example.com last year', scheduleOffsetDays: 0 },
          ],
        };
        return { content: [{ type: 'text', text: JSON.stringify(plan) }], usage: { input_tokens: 600, output_tokens: 200 }, stop_reason: 'end_turn' };
      }
      // Text request (a draft / reply) → include BOTH the canonical link and a
      // FOREIGN phishing link, so the test proves enforceDonationLink strips the latter.
      return {
        content: [{ type: 'text', text: `Hi — would you consider giving? Donate here: ${ZEFFY} (please ignore ${FOREIGN}). Thank you! Jamie` }],
        usage: { input_tokens: 400, output_tokens: 120 },
        stop_reason: 'end_turn',
      };
    },
  },
});

// Boot the server AFTER injecting the fake client (KEEP_AI_KEY=1 keeps AI enabled).
const { client, closeServer } = await import('./helpers.js');
after(() => closeServer());

async function seededCampaign(u) {
  await u.post('/api/orgs', { name: 'Camp Org' });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Olena K', company: 'Kyiv Digital', role: 'Engineer', linkedin_url: 'https://l/olena' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;
  const camp = (await u.post('/api/campaigns', { name: 'Spring Drive', goalAmount: 1000 })).data.campaign;
  return { connId, campId: camp.id };
}

test('plan → approve queues a to_ask referral (NO-SEND) and never contacts anyone', async () => {
  const u = client();
  await u.login({ linkedinId: 'agent-flow', name: 'Jamie Bergen' });
  const { connId, campId } = await seededCampaign(u);

  const plan = await u.post(`/api/campaigns/${campId}/plan`);
  assert.equal(plan.status, 200);
  assert.ok(plan.data.actions.length >= 1, 'the planner created at least one action');
  const action = plan.data.actions[0];
  assert.equal(action.connectionId, connId, 'action targets a real candidate (no hallucinated id)');
  assert.equal(action.status, 'proposed');
  // Planning notes shown in the UI must be URL-scrubbed (no clickable phishing link).
  assert.ok(!action.hook.includes('http'), 'hook is URL-scrubbed');
  assert.ok(!action.rationale.includes('http'), 'rationale is URL-scrubbed');

  // Approve → the action becomes a QUEUED pipeline referral, status 'to_ask'.
  const appr = await u.post(`/api/actions/${action.id}/approve`);
  assert.equal(appr.status, 200);
  const referralId = appr.data.referralId;
  assert.ok(referralId, 'approval queued a referral');

  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.id === referralId);
  assert.ok(ref, 'the referral is in the pipeline');
  assert.equal(ref.status, 'to_ask', 'approved action is QUEUED as to_ask — never auto-sent/asked');
  assert.equal(ref.donation_received, 0, 'nothing was sent or recorded as contacted');
});

test('action draft keeps ONLY the canonical donation link (enforceDonationLink)', async () => {
  const u = client();
  await u.login({ linkedinId: 'agent-draft', name: 'Jamie Bergen' });
  const { campId } = await seededCampaign(u);
  const action = (await u.post(`/api/campaigns/${campId}/plan`)).data.actions[0];

  const draft = await u.post(`/api/actions/${action.id}/draft`);
  assert.equal(draft.status, 200);
  const text = draft.data.action.draft;
  assert.ok(text.includes('zeffy.com'), 'the canonical donation link is preserved');
  assert.ok(!text.includes('evil.example.com'), 'the foreign/phishing link was stripped');
});

test('paste-a-reply drafting returns text only, with foreign links stripped', async () => {
  const u = client();
  await u.login({ linkedinId: 'agent-reply', name: 'Jamie Bergen' });
  const { connId } = await seededCampaign(u);

  const reply = await u.post('/api/ai/reply', { connectionId: connId, theirMessage: 'Sure, how can I help?' });
  assert.equal(reply.status, 200);
  assert.ok(typeof reply.data.draft === 'string' && reply.data.draft.length > 0, 'a draft reply came back');
  assert.ok(!reply.data.draft.includes('evil.example.com'), 'reply also strips foreign links');
});

test('an action can be skipped, and one org cannot approve another org’s action', async () => {
  const u = client();
  await u.login({ linkedinId: 'agent-skip', name: 'Jamie Bergen' });
  const { campId } = await seededCampaign(u);
  const action = (await u.post(`/api/campaigns/${campId}/plan`)).data.actions[0];

  // PATCH cannot APPROVE — approvals only flow through /approve (the single path
  // that queues a 'to_ask' referral), so the no-send guarantee can't be bypassed.
  const tryApprove = await u.patch(`/api/actions/${action.id}`, { status: 'approved' });
  assert.equal(tryApprove.data.action.status, 'proposed', 'PATCH ignores status=approved');

  const skipped = await u.patch(`/api/actions/${action.id}`, { status: 'skipped' });
  assert.equal(skipped.data.action.status, 'skipped');

  // A different org cannot touch this action (404, isolation).
  const other = client();
  await other.login({ linkedinId: 'agent-other', name: 'Other Org' });
  await other.post('/api/orgs', { name: 'Other Org' });
  assert.equal((await other.post(`/api/actions/${action.id}/approve`)).status, 404);
  assert.equal((await other.patch(`/api/actions/${action.id}`, { status: 'approved' })).status, 404);
  assert.equal((await other.post(`/api/actions/${action.id}/draft`)).status, 404);
});
