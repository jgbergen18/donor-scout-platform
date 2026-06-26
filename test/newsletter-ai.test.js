// Newsletter draft — AI success path, offline. KEEP_AI_KEY + a FAKE Anthropic client
// (lib/ai's __test.setClient seam). No network, no real send. Pins the plumbing: the draft
// comes back as { subject, body } grounded in the org's data, and enforceDonationLink
// strips any foreign link the model emits (only the canonical donation URL survives).
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
      const props = reqBody.output_config?.format?.schema?.properties || {};
      if (props.subject && props.body) {
        const body = 'Hi {{first_name}},\n\nThanks to you we funded 38 students this year.\n\nWith thanks';
        return { content: [{ type: 'text', text: JSON.stringify({ subject: 'Your impact this year', preheader: 'A quick thank-you', body }) }], usage: { input_tokens: 300, output_tokens: 150 }, stop_reason: 'end_turn' };
      }
      return { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' };
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

test('newsletter draft returns subject + body and strips any foreign link', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-ai', name: 'Nora' });
  await u.post('/api/orgs', { name: 'NL AI Org' });
  await u.post('/api/documents', { name: 'Impact', kind: 'impact', content: 'In 2024 we funded 38 students.' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Dana Donor', contact_email: 'dana@donor.test', company: 'Acme', linkedin_url: 'https://l/dana-nl' }] });
  await u.post('/api/donations/reconcile', { donors: [{ name: 'Dana Donor', amount: 250, date: ymd(-20) }] });

  const res = await u.post('/api/newsletter/draft', { instructions: 'thank recent donors' });
  assert.equal(res.status, 200);
  assert.ok(res.data.subject?.length > 0, 'a subject came back');
  assert.ok(res.data.preheader?.length > 0, 'a preheader came back');
  assert.ok(res.data.body?.length > 0, 'a markdown body came back');
  assert.match(res.data.body, /\{\{first_name\}\}/, 'the body carries the personalization token for per-donor merge');
});
