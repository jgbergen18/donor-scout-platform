// L1 — the conversation drives the pipeline (AI SUCCESS path, offline).
// The shared harness strips the API key, so the reply-classify + daily-triage flows
// are otherwise unexercised. Here we set KEEP_AI_KEY=1 and inject a FAKE Anthropic
// client (lib/ai's NODE_ENV=test __test.setClient seam) that classifies a pasted
// reply by keyword and triages the queue deterministically — NO network, NO send.
// Guards the L1 guarantees: auto-accept applies only REVERSIBLE moves, a claimed
// gift is always a human fork (never auto-recorded), triage only hides/surfaces.
process.env.NODE_ENV = 'test';
process.env.KEEP_AI_KEY = '1';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used';
process.env.AI_DAILY_BUDGET_USD = '1000';
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '1000';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ZEFFY = 'https://www.zeffy.com/en-US/donation-form/fe71a2d0-1133-40ac-9032-897b66b0a7b1';

const ai = await import('../lib/ai.js');
ai.__test.setClient({
  messages: {
    create: async (reqBody) => {
      const prompt = (reqBody.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const props = reqBody.output_config?.format?.schema?.properties || {};
      // Reply classifier → classify the <their_reply> by keyword, draft a short reply.
      if (props.intent || /<their_reply>/.test(prompt)) {
        const msg = (prompt.match(/<their_reply>\s*([\s\S]*?)\s*<\/their_reply>/) || [])[1] || '';
        let intent = 'interested';
        if (/already|i gave|donated/i.test(msg)) intent = 'already_gave';
        else if (/\bno\b|not interested|can't|cannot|decline/i.test(msg)) intent = 'declined';
        else if (/later|not now|next year|busy|circle back/i.test(msg)) intent = 'not_now';
        else if (/maybe|how much|but |hesit|unsure/i.test(msg)) intent = 'hesitant';
        return { content: [{ type: 'text', text: JSON.stringify({ intent, confidence: 90, reply: `Thank you! ${ZEFFY}` }) }], usage: { input_tokens: 200, output_tokens: 80 }, stop_reason: 'end_turn' };
      }
      // Triage → suppress any queue item whose label mentions "Bereaved"; one fork.
      if (props.summary && props.forks) {
        const items = [];
        const re = /- ref:\s*(\S+)\n\s*what:\s*([^\n]*)/g;
        let m;
        while ((m = re.exec(prompt))) if (/Bereaved/i.test(m[2])) items.push({ ref: m[1], suppress: true, reason: 'Recently bereaved — hold.' });
        return { content: [{ type: 'text', text: JSON.stringify({ summary: 'A light, kind day.', items, forks: [{ title: 'Same household', detail: 'Two asks to one family — pick one.' }] }) }], usage: { input_tokens: 300, output_tokens: 120 }, stop_reason: 'end_turn' };
      }
      return { content: [{ type: 'text', text: `Hi! ${ZEFFY}` }], usage: { input_tokens: 80, output_tokens: 30 }, stop_reason: 'end_turn' };
    },
  },
});

const { client, closeServer } = await import('./helpers.js');
const server = await import('../server.js');
after(() => closeServer());

const upload = (u, contacts) => u.post('/api/connections/upload', { contacts });
const connId = async (u, name) => (await u.get('/api/prospects')).data.prospects.find((p) => p.contact_name === name)?.id;
const refFor = async (u, cid) => (await u.get('/api/referrals')).data.referrals.find((r) => r.connection_id === cid);

test('stateChangeForIntent maps intents to reversible moves (never a gift/send)', () => {
  assert.equal(server.stateChangeForIntent('interested').kind, 'advance');
  assert.equal(server.stateChangeForIntent('hesitant').kind, 'advance');
  assert.equal(server.stateChangeForIntent('not_now').kind, 'snooze');
  assert.equal(server.stateChangeForIntent('declined').kind, 'decline');
  assert.equal(server.stateChangeForIntent('already_gave').kind, 'record_gift_fork');
  assert.equal(server.stateChangeForIntent('garbage').kind, 'none');
});

test('auto-accept applies the reversible move for each intent on an existing referral', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-apply', name: 'Lee L' });
  await u.post('/api/orgs', { name: 'L1 Org' });
  await upload(u, [
    { contact_name: 'Yes Person', company: 'Acme', linkedin_url: 'https://l/yes' },
    { contact_name: 'No Person', company: 'Acme', linkedin_url: 'https://l/no' },
    { contact_name: 'Later Person', company: 'Acme', linkedin_url: 'https://l/later' },
  ]);
  for (const name of ['Yes Person', 'No Person', 'Later Person']) {
    await u.post('/api/referrals', { connectionId: await connId(u, name) });
  }

  // interested → advance to following_up + a near follow-up date.
  const yId = await connId(u, 'Yes Person');
  const yRes = await u.post('/api/ai/reply', { connectionId: yId, theirMessage: 'Yes, happy to help!' });
  assert.equal(yRes.status, 200);
  assert.equal(yRes.data.intent, 'interested');
  assert.equal(yRes.data.applied.kind, 'advance');
  assert.ok(yRes.data.draft.length > 0 && yRes.data.draft.includes('zeffy.com'));
  assert.equal((await refFor(u, yId)).status, 'following_up');

  // declined → mark declined.
  const nId = await connId(u, 'No Person');
  const nRes = await u.post('/api/ai/reply', { connectionId: nId, theirMessage: 'No, not interested, sorry.' });
  assert.equal(nRes.data.intent, 'declined');
  assert.equal(nRes.data.applied.kind, 'decline');
  assert.equal((await refFor(u, nId)).status, 'declined');

  // not_now → snooze (status unchanged, follow-up pushed out).
  const lId = await connId(u, 'Later Person');
  const before = (await refFor(u, lId)).status;
  const lRes = await u.post('/api/ai/reply', { connectionId: lId, theirMessage: 'Maybe circle back next year, busy now.' });
  assert.equal(lRes.data.intent, 'not_now');
  assert.equal(lRes.data.applied.kind, 'snooze');
  assert.equal((await refFor(u, lId)).status, before, 'snooze keeps the stage');
});

test('a claimed gift is a human fork — never auto-recorded', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-fork', name: 'Faye F' });
  await u.post('/api/orgs', { name: 'Fork Org' });
  await upload(u, [{ contact_name: 'Gave Already', company: 'Acme', linkedin_url: 'https://l/gave' }]);
  const cid = await connId(u, 'Gave Already');
  await u.post('/api/referrals', { connectionId: cid });

  const r = await u.post('/api/ai/reply', { connectionId: cid, theirMessage: 'I already donated last week!' });
  assert.equal(r.data.intent, 'already_gave');
  assert.equal(r.data.applied, null, 'no auto state change');
  assert.equal(r.data.fork.kind, 'record_gift', 'surfaced as a record-gift fork');
  // No gift was recorded — the referral has no donation.
  const ref = await refFor(u, cid);
  assert.equal(ref.donation_received, 0, 'no gift fabricated from a parsed message');
  assert.equal((await u.get(`/api/referrals/${ref.id}/donations`)).data.count, 0);
});

test('autoAcceptReplies=false disables auto state changes (still drafts + classifies)', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-off', name: 'Olga O' });
  await u.post('/api/orgs', { name: 'Manual Org' });
  await u.patch('/api/orgs/autonomy', { autoAcceptReplies: false });
  await upload(u, [{ contact_name: 'Quiet One', company: 'Acme', linkedin_url: 'https://l/quiet' }]);
  const cid = await connId(u, 'Quiet One');
  await u.post('/api/referrals', { connectionId: cid });
  const before = (await refFor(u, cid)).status;

  const r = await u.post('/api/ai/reply', { connectionId: cid, theirMessage: 'Yes, count me in!' });
  assert.equal(r.data.intent, 'interested');
  assert.equal(r.data.applied, null, 'no auto-apply when the dial is off');
  assert.ok(r.data.draft.length > 0, 'still drafts a reply');
  assert.equal((await refFor(u, cid)).status, before, 'pipeline untouched');
});

test('daily triage suppresses a relationship-damaging item and surfaces forks', async () => {
  const u = client();
  await u.login({ linkedinId: 'l1-triage', name: 'Tess T' });
  await u.post('/api/orgs', { name: 'Triage Org' });
  // Kyiv-flavored employers so the connections score >= 1 and surface in the Today
  // queue (which uses minScore=1), like the timesavers fixtures.
  await upload(u, [
    { contact_name: 'Bereaved Donor', company: 'Kyiv Tech', linkedin_url: 'https://l/ber' },
    { contact_name: 'Healthy Prospect', company: 'Kyiv Digital', linkedin_url: 'https://l/heal' },
  ]);

  const raw = (await u.get('/api/today')).data;
  assert.ok(raw.prospects.some((p) => p.contact_name === 'Bereaved Donor'), 'raw queue shows everyone');

  const brief = (await u.get('/api/today/brief')).data;
  assert.equal(brief.triage.enabled, true);
  assert.ok(!brief.prospects.some((p) => p.contact_name === 'Bereaved Donor'), 'damaging item suppressed');
  assert.ok(brief.prospects.some((p) => p.contact_name === 'Healthy Prospect'), 'safe item kept');
  assert.ok(brief.triage.suppressed.some((s) => /prospect:/.test(s.ref)), 'suppression recorded with a ref + reason');
  assert.ok(brief.triage.forks.length >= 1 && brief.triage.summary.length > 0, 'forks + summary surfaced');
});
