// Per-tenant AI budget — the REALIZED-SPEND path (lib/ai.js). The sibling
// ai-budget.test.js drives the reserve/release primitives with no key; this file
// closes the gap the offline harness leaves open: with the key stripped, the
// SUCCESS branch of call() (release the hold, then add the measured cost to BOTH
// the global counter and the org bucket) never runs, so cost accrual + budget
// exhaustion are otherwise untested. We inject a FAKE Anthropic client via the
// NODE_ENV=test `__test.setClient` seam — no real key, no network, no message ever
// sent — and assert spend accrues once per counter, the per-org cap actually 429s
// the over-spender, and one exhausted org never blocks another (isolation under
// real spend, not just reservations).
//
// apiKey is read once at module load, so we set a fake (truthy) key BEFORE import.
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-only-fake-key-never-used'; // truthy ⇒ getClient() returns the injected client
process.env.AI_DAILY_BUDGET_USD = '10'; // global ceiling well above the per-org cap
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '0.02'; // a few Haiku calls exhaust this

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { __test, status, generateText, generateJSON } = await import('../lib/ai.js');
assert.ok(__test?.setClient, 'the __test.setClient seam must be present under NODE_ENV=test');

// A fake client that bills 1k in + 1k out per call (~$0.006 on Haiku) and returns
// JSON-parseable text. It NEVER reaches the network and sends nothing to anyone.
let calls = 0;
__test.setClient({
  messages: {
    create: async () => {
      calls++;
      return {
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 1000, output_tokens: 1000 },
        stop_reason: 'end_turn',
      };
    },
  },
});

const opts = (orgId) => ({ orgId, system: 'sys', prompt: 'prompt' });

test('a realized call adds its cost ONCE to both the org bucket and the global counter', async () => {
  __test.reset();
  const before = calls;
  const text = await generateText(opts(5));
  assert.equal(text, '{"ok":true}', 'returns the model text');
  assert.equal(calls, before + 1, 'the SDK was actually invoked (success path ran)');
  const s = status(5);
  assert.ok(s.spentUsd > 0, 'org bucket accrued realized spend');
  assert.equal(s.globalSpentUsd, s.spentUsd, 'same cost landed on the global counter (single org ⇒ equal), counted once each');
});

test('the per-org cap 429s the over-spending org after enough realized calls', async () => {
  __test.reset();
  let ok = 0;
  let budgetError = false;
  for (let i = 0; i < 25; i++) {
    try {
      await generateText(opts(6));
      ok++;
    } catch (e) {
      if (e instanceof __test.AIBudgetError) {
        budgetError = true;
        break;
      }
      throw e;
    }
  }
  assert.ok(ok >= 1, 'at least one call went through before the cap');
  assert.ok(budgetError, 'the per-org sub-budget eventually refuses with AIBudgetError');
  assert.ok(status(6).spentUsd <= __test.budgets.perOrg, 'realized spend never exceeds the org cap');
});

test('isolation under REAL spend: an exhausted org never blocks another', async () => {
  __test.reset();
  // Exhaust org 6.
  let exhausted = false;
  for (let i = 0; i < 25 && !exhausted; i++) {
    try {
      await generateText(opts(6));
    } catch (e) {
      if (e instanceof __test.AIBudgetError) exhausted = true;
      else throw e;
    }
  }
  assert.ok(exhausted, 'org 6 reached its cap');
  // Org 7 — fresh bucket, and the global ceiling ($10) has plenty left — is served.
  const text = await generateText(opts(7));
  assert.equal(text, '{"ok":true}', 'org 7 served despite org 6 being capped');
  assert.ok(status(7).spentUsd > 0, 'org 7 spent under its OWN bucket');
  assert.ok(status(6).spentUsd >= status(7).spentUsd, 'org 6 (exhausted) spent at least as much as the one fresh org-7 call');
});

test('generateJSON realized path returns the parsed object and bills the org', async () => {
  __test.reset();
  const obj = await generateJSON({ orgId: 8, system: 'sys', prompt: 'prompt', schema: { type: 'object' } });
  assert.deepEqual(obj, { ok: true });
  assert.ok(status(8).spentUsd > 0, 'JSON generation accrues spend too');
});
