// Per-tenant AI budget (lib/ai.js). The per-org sub-budget must ISOLATE one org
// from another — a tenant that exhausts its daily budget cannot 429 the rest —
// while the GLOBAL ceiling still binds across all orgs, and reserve/release must
// be symmetric so a finished (or failed) call frees its hold.
//
// The shared harness strips ANTHROPIC_API_KEY, so there is no real Claude spend
// path to exercise end-to-end. Instead we drive the budget primitives directly
// through the NODE_ENV=test-only `__test` seam. Budgets are read from env at module
// load, so we set LOW, exactly-representable caps BEFORE importing lib/ai.js — and
// this file deliberately does NOT use ./helpers.js (which would import lib/ai.js
// first, with the default $5 budgets, before we could lower them).
process.env.NODE_ENV = 'test';
process.env.AI_DAILY_BUDGET_USD = '10'; // global ceiling across all orgs
process.env.AI_DAILY_BUDGET_PER_ORG_USD = '1'; // each org's daily sub-budget
delete process.env.ANTHROPIC_API_KEY; // keep AI disabled/offline

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { __test, status, generateText, generateJSON, AIDisabledError } = await import('../lib/ai.js');

assert.ok(__test, 'the __test seam must be exposed under NODE_ENV=test');
const { AIBudgetError } = __test;

// Each test starts from a drained budget (global counter + every org bucket).
beforeEach(() => __test.reset());

test('budgets are read from env (global $10, per-org $1)', () => {
  assert.equal(__test.budgets.global, 10);
  assert.equal(__test.budgets.perOrg, 1);
});

test('per-org isolation: one org exhausting its sub-budget does not 429 another', () => {
  // Org 1 fills its $1 sub-budget exactly (four $0.25 holds; 0.25 is exact in IEEE-754).
  for (let i = 0; i < 4; i++) __test.reserve(1, 0.25);
  // A further hold for org 1 exceeds ITS sub-budget → refused.
  assert.throws(() => __test.reserve(1, 0.25), AIBudgetError, 'org 1 over its own sub-budget');
  // Org 2 is untouched: its own bucket is empty and the global ceiling ($10) is fine.
  assert.doesNotThrow(() => __test.reserve(2, 0.5), 'org 2 unaffected by org 1');
});

test('the global ceiling still binds across orgs (sum of per-org budgets is capped)', () => {
  // Ten orgs each reserve their full $1 sub-budget → $10 reserved globally.
  for (let org = 1; org <= 10; org++) __test.reserve(org, 1);
  // An 11th org has room in its OWN bucket, but the global $10 ceiling is reached.
  assert.throws(() => __test.reserve(11, 0.5), AIBudgetError, 'global ceiling caps total spend');
});

test('reserve/release symmetry: releasing the holds frees the sub-budget again', () => {
  __test.reserve(1, 0.5);
  __test.reserve(1, 0.5);
  assert.throws(() => __test.reserve(1, 0.25), AIBudgetError, 'sub-budget full');
  __test.release(1, 0.5);
  __test.release(1, 0.5);
  assert.doesNotThrow(() => __test.reserve(1, 1), 'reservations fully drained → room again');
});

test('a missing orgId shares ONE bounded sentinel bucket (not an unbounded bypass)', () => {
  __test.reserve(null, 0.6);
  // undefined maps to the SAME sentinel bucket as null, so it accumulates and trips.
  assert.throws(() => __test.reserve(undefined, 0.6), AIBudgetError, 'sentinel bucket is shared + bounded');
});

test('status(orgId) reports the org sub-budget alongside the global ceiling', () => {
  __test.reserve(7, 0.25); // a reservation is an in-flight hold, not realized spend
  const s = status(7);
  assert.equal(s.budgetUsd, 1, 'per-org budget is the headline figure');
  assert.equal(s.spentUsd, 0, 'reservations are not counted as realized spend');
  assert.equal(s.remainingUsd, 1, 'remaining is realized-spend based');
  assert.equal(s.globalBudgetUsd, 10, 'global ceiling reported alongside');
  assert.equal(s.enabled, false, 'no API key → disabled, but status still reports');
  assert.equal(status(8).spentUsd, 0, 'a different org reads an independent bucket');
});

test('graceful degradation: no API key → AIDisabledError before any spend', async () => {
  await assert.rejects(
    () => generateText({ orgId: 1, system: 's', prompt: 'p', model: 'claude-haiku-4-5' }),
    (e) => e instanceof AIDisabledError
  );
  await assert.rejects(
    () => generateJSON({ orgId: 1, system: 's', prompt: 'p', schema: { type: 'object' } }),
    (e) => e instanceof AIDisabledError
  );
  // Nothing was billed against the org or global budget.
  assert.equal(status(1).spentUsd, 0);
});
