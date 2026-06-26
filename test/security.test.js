// Security hardening (audit Batch B). Unit-tests the session-secret prod guard.
// The SSO domain-verify prod-501 gate is env-gated (IS_PROD is false under the test
// harness), so the dev verify path stays exercised by sso.test.js; the campaign-delete
// dependent-cleanup is asserted in l2-nightly.test.js where nightly rows actually exist.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeServer } from './helpers.js'; // boots the app with SKIP_LISTEN set
const { resolveSessionSecret } = await import('../server.js');

after(() => closeServer());

test('resolveSessionSecret fails loudly in production without a secret', () => {
  assert.throws(() => resolveSessionSecret(true, ''), /required in production/);
  assert.throws(() => resolveSessionSecret(true, undefined), /required in production/);
});

test('resolveSessionSecret returns the real secret in production', () => {
  assert.equal(resolveSessionSecret(true, 'a-real-strong-secret'), 'a-real-strong-secret');
});

test('resolveSessionSecret keeps the dev convenience literal off the prod path', () => {
  assert.equal(resolveSessionSecret(false, ''), 'dev-secret-change-me');
  assert.equal(resolveSessionSecret(false, 'custom'), 'custom');
});
// (LinkedIn-unconfigured fallback isn't unit-tested here: the local .env carries
// LinkedIn creds and dotenv re-populates them after the harness deletes them, so the
// assertion would be environment-dependent. The graceful redirect is covered manually.)
