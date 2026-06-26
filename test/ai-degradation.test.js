// AI cost-control degradation over HTTP (audit Batch E). The budget primitives are
// unit-tested in ai-budget*.test.js; this asserts the END-TO-END behavior the audit
// flagged as untested: when the per-org daily budget is exhausted, AI write endpoints
// 429 and the Morning/daily brief degrades to the raw queue (never 500s).
// Per-org budget is pinned to $0 so every model call is refused at reserve().
process.env.NODE_ENV = 'test';
process.env.KEEP_AI_KEY = '1';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used';
process.env.AI_DAILY_BUDGET_USD = '1000';
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '0'; // every AI call is over budget

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ai = await import('../lib/ai.js');
// A benign fake client (never reached — reserve() refuses before any call).
ai.__test.setClient({
  messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) },
});

const { client, closeServer } = await import('./helpers.js');
after(() => closeServer());

test('an AI draft over the per-org budget returns 429 (budgetExhausted)', async () => {
  const u = client();
  await u.login({ linkedinId: 'budget-http', name: 'Bea B' });
  await u.post('/api/orgs', { name: 'Budget Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Olena K', company: 'Kyiv Tech', linkedin_url: 'https://l/ok' }] });
  const cid = (await u.get('/api/prospects')).data.prospects[0].id;

  const res = await u.post(`/api/connections/${cid}/draft`);
  assert.equal(res.status, 429, 'over-budget AI call is refused with 429 (reserve() gate)');
});

test('the daily brief degrades to the raw queue when the AI budget is spent (no 500)', async () => {
  const u = client();
  await u.login({ linkedinId: 'budget-brief', name: 'Bo B' });
  await u.post('/api/orgs', { name: 'Budget Brief Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Dana M', company: 'Kyiv Digital', linkedin_url: 'https://l/dm' }] });

  const res = await u.get('/api/today/brief');
  assert.equal(res.status, 200, 'brief never 500s on a budget error');
  assert.equal(res.data.triage.enabled, false, 'triage degraded off');
  assert.equal(res.data.triage.error, true, 'degradation flagged');
  assert.ok(Array.isArray(res.data.prospects), 'raw queue still returned');
});
