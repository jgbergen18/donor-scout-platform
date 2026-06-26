// Observability: /healthz (liveness, no auth, no DB) and /readyz (readiness,
// SELECT 1 → 200/503), plus a sanity check that the request-logging middleware
// is quiet under NODE_ENV=test and doesn't break ordinary requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

test.after(() => closeServer());

test('GET /healthz returns 200 without auth (liveness)', async () => {
  const c = client(); // no login
  const res = await c.get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'ok');
  assert.equal(typeof res.data.uptime, 'number');
  assert.ok(res.data.uptime >= 0);
});

test('GET /readyz returns 200 ready when the DB is reachable', async () => {
  const c = client(); // no login
  const res = await c.get('/readyz');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'ready');
});

test('health probes do not leak sensitive info', async () => {
  const c = client();
  const health = await c.get('/healthz');
  const ready = await c.get('/readyz');
  // Only the documented, non-sensitive keys are present.
  assert.deepEqual(Object.keys(health.data).sort(), ['status', 'timestamp', 'uptime']);
  assert.deepEqual(Object.keys(ready.data), ['status']);
});

test('request logging is quiet under NODE_ENV=test (no stdout spam)', async () => {
  // Capture console.log while issuing a normal API request; the middleware must
  // emit nothing because LOG_REQUESTS defaults off under test.
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const c = client();
    await c.get('/api/auth/me'); // unauthenticated but routed normally
    await c.get('/healthz');
  } finally {
    console.log = original;
  }
  const requestLines = lines.filter((l) => l.includes('"msg":"request"'));
  assert.equal(requestLines.length, 0, 'no request log lines should be emitted under test');
});

test('normal requests still work alongside the logging middleware', async () => {
  const c = client();
  const res = await c.get('/api/auth/me');
  // /api/auth/me returns a well-formed JSON response (not a 5xx), proving the
  // middleware passed the request through untouched.
  assert.equal(res.status, 200);
  assert.ok(res.data !== null);
  assert.ok('user' in res.data);
});
