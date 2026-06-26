// Shared test harness: boot the exported Express app on an ephemeral port against
// an isolated, throwaway SQLite database, and provide a tiny cookie-aware HTTP
// client so each test can act as a distinct logged-in user.
//
// The env vars MUST be set before server.js is imported: it reads DATA_DIR (DB
// location), SKIP_LISTEN (don't bind the prod port), and NODE_ENV=test (mounts
// the test-only /api/test/login route). Each suite imports this once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-scout-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SKIP_LISTEN = '1';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
// Make sure no real provider keys leak in and AI stays disabled/offline. A suite
// that must exercise the AI SUCCESS path (the campaign agent) sets KEEP_AI_KEY=1
// and injects a FAKE client via lib/ai's NODE_ENV=test __test.setClient seam — it
// still never touches the network and sends nothing.
// Set to '' (not delete) so that dotenv.config() inside server.js can't RE-POPULATE a real
// ANTHROPIC_API_KEY from the developer's .env: dotenv never overrides an already-defined
// var, and '' reads as AI-off. Without this, adding a real key to .env would silently turn
// AI on inside the offline suite and fire real (paid, networked) Claude calls.
if (process.env.KEEP_AI_KEY !== '1') process.env.ANTHROPIC_API_KEY = '';
delete process.env.GITHUB_TOKEN;
delete process.env.LINKEDIN_CLIENT_ID;
delete process.env.LINKEDIN_CLIENT_SECRET;
// Pin the outbound send policy so the send-clamp assertions are independent of the dev
// .env (a real SEND_MODE=live for go-live must never flip these to vacuous/failing). The
// mailer is forced to the console adapter under NODE_ENV=test regardless, so nothing sends.
process.env.SEND_MODE = 'redirect';
process.env.SEND_ALLOWLIST = 'jgbergen18@gmail.com';

const { app } = await import('../server.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

export function closeServer() {
  return new Promise((resolve) => server.close(resolve));
}

// A minimal cookie jar — enough to carry the express-session cookie between calls
// for one simulated user. Each client() is an independent session.
//
// Uses raw http.request with `agent: false` (a fresh, non-pooled socket per call,
// closed when the response ends) instead of global fetch, so no keep-alive sockets
// linger to hold the node:test process open after closeServer().
export function client() {
  let cookie = '';
  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload) headers['content-length'] = Buffer.byteLength(payload);
      const r = http.request(
        base + url,
        { method, headers, agent: false },
        (res) => {
          const setCookie = res.headers['set-cookie'];
          if (setCookie && setCookie[0]) cookie = setCookie[0].split(';')[0];
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              data = text;
            }
            resolve({ status: res.statusCode, data });
          });
        }
      );
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }
  return {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b),
    patch: (u, b) => req('PATCH', u, b),
    del: (u, b) => req('DELETE', u, b),
    // Log in as a fresh, distinct user (defaults to a random linkedinId).
    login: (opts = {}) => req('POST', '/api/test/login', opts),
  };
}

// Convenience: retrieve the raw magic-link token the console mailer stashed for
// an email (NODE_ENV=test-only route), so the offline suites can complete the
// passwordless flow without real email.
export function lastMagicLink(email) {
  const c = client();
  return c.get(`/api/test/last-magic-link?email=${encodeURIComponent(email)}`);
}
