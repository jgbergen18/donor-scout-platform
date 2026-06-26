// Retention M1 — the second-gift re-ask DRAFT (AI success path), offline. KEEP_AI_KEY +
// a FAKE Anthropic client (lib/ai's __test.setClient seam). No network, no send. The
// draft is grounded ONLY on the donor's real prior gift, and enforceDonationLink strips
// any foreign link the model emits. The no-fabrication/lazy/no-send rules live in the
// route + lib/brief; here we pin the plumbing: a draft comes back, grounded + link-safe.
process.env.NODE_ENV = 'test';
process.env.KEEP_AI_KEY = '1';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used';
process.env.AI_DAILY_BUDGET_USD = '1000';
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '1000';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ai = await import('../lib/ai.js');
ai.__test.setClient({
  messages: {
    create: async (reqBody) => {
      const prompt = (reqBody.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      // Echo the server-sourced donation link + the real prior gift amount from the prompt,
      // and slip in a foreign link so the test can prove enforceDonationLink strips it.
      const link = (prompt.match(/Donation link[^:]*:\s*(\S+)/) || [])[1] || '';
      const amt = (prompt.match(/they gave \$(\d+)/) || [])[1] || '';
      const text = `Hi there, thank you again for your $${amt} gift. Would you consider giving once more? ${link}\nhttp://evil.example/phish\nJamie`;
      return { content: [{ type: 'text', text }], usage: { input_tokens: 300, output_tokens: 120 }, stop_reason: 'end_turn' };
    },
  },
});

const { client, closeServer } = await import('./helpers.js');
after(() => closeServer());

const ymd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

test('reconnect-draft returns an in-voice draft grounded on the prior gift, foreign links stripped', async () => {
  const u = client();
  await u.login({ linkedinId: 'sg-ai', name: 'Jamie B' });
  await u.post('/api/orgs', { name: 'SG AI Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Dana Donor', company: 'Acme', linkedin_url: 'https://l/dana-ai' }] });
  await u.post('/api/donations/reconcile', { donors: [{ name: 'Dana Donor', amount: 120, date: ymd(-45) }] });
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'Dana Donor');
  await u.post(`/api/referrals/${ref.id}/thanked`);

  const res = await u.post(`/api/referrals/${ref.id}/reconnect-draft`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.data.draft === 'string' && res.data.draft.length > 0, 'a draft came back');
  assert.match(res.data.draft, /\$120/, 'grounded on the real prior gift amount');
  assert.ok(!/evil\.example/.test(res.data.draft), 'foreign phishing link stripped by enforceDonationLink');
});
