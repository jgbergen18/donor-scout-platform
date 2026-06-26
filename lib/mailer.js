/**
 * Pluggable Mailer (Adapter / Strategy pattern) — SaaS auth Phase 1.
 * ------------------------------------------------------------------
 * Mirrors the AI (no key) / GitHub (no token) graceful-degradation philosophy:
 * the app fully runs with ZERO email setup. createMailer() selects an adapter
 * from env. The DEFAULT console adapter just logs a clearly-labeled block with
 * the recipient + full link, so a nonprofit can pilot magic-link/invite login
 * before configuring real email. A real SMTP/HTTP-provider adapter is a
 * DOCUMENTED SEAM (commented stub below) — Phase 1 adds NO runtime dependency.
 *
 * Interface (all adapters implement):
 *   mailer.send({ to, subject, text, html?, meta }) -> Promise<void>
 *   mailer.lastTokenFor(email) -> string | null   (dev/test only; see below)
 *
 * Test/dev offline hook: ONLY when !IS_PROD or NODE_ENV==='test', the console
 * adapter records the last raw token per recipient email in an in-memory Map.
 * The server's NODE_ENV=test-only route GET /api/test/last-magic-link reads it
 * via lastTokenFor(email), so tests retrieve the link WITHOUT real email and
 * stay fully offline (mirroring the existing /api/test/login hook).
 */
import axios from 'axios';

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';
// The console adapter may expose raw tokens (logged + stashed) ONLY here.
const ALLOW_DEV_TOKEN = !IS_PROD || IS_TEST;

// ── Email templates ──────────────────────────────────────────────
// Plain, clearly-labeled links with text (and optional HTML). Lower-friction
// than passwords for volunteer/occasional fundraisers; human, accessible copy.
export function magicLinkEmail(link) {
  return {
    subject: 'Your Donor Scout sign-in link',
    text:
      `Click the link below to sign in to Donor Scout. It expires in 15 minutes ` +
      `and can be used once.\n\n${link}\n\n` +
      `If you didn't request this, you can safely ignore this email.`,
    html:
      `<p>Click the button below to sign in to Donor Scout. ` +
      `It expires in 15 minutes and can be used once.</p>` +
      `<p><a href="${link}">Sign in to Donor Scout</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email.</p>`,
  };
}

export function invitationEmail(orgName, role, link) {
  const org = orgName || 'a team';
  return {
    subject: `You're invited to join ${org} on Donor Scout`,
    text:
      `You've been invited to join ${org} on Donor Scout as a ${role}. ` +
      `Click the link below to accept. It expires in 7 days.\n\n${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`,
    html:
      `<p>You've been invited to join <strong>${org}</strong> on Donor Scout as a <strong>${role}</strong>.</p>` +
      `<p><a href="${link}">Accept your invitation</a></p>` +
      `<p>This invitation expires in 7 days. If you weren't expecting this, you can ignore this email.</p>`,
  };
}

// ── Console / dev adapter (DEFAULT) ──────────────────────────────
function consoleAdapter() {
  // Last raw token per recipient email — ONLY populated in dev/test, never prod.
  // Lets the offline test hook retrieve the issued link without sending email.
  const lastToken = new Map();

  return {
    name: 'console',
    async send({ to, subject, text, meta } = {}) {
      // Stash the raw token (carried in meta) for the dev/test retrieval hook.
      if (ALLOW_DEV_TOKEN && to && meta?.token) {
        lastToken.set(String(to).toLowerCase(), meta.token);
      }
      // Clearly-labeled block so a developer/operator sees the link in the logs.
      // The link is only logged when dev-token exposure is allowed; in prod we
      // log that mail was "sent" but never the link/token.
      const lines = [
        '──────────────────────────────────────────────',
        '[Mailer:console] Email (no real delivery configured)',
        `  to:      ${to}`,
        `  subject: ${subject}`,
      ];
      if (ALLOW_DEV_TOKEN && text) {
        lines.push('  body:');
        for (const l of String(text).split('\n')) lines.push(`    ${l}`);
      }
      lines.push('──────────────────────────────────────────────');
      console.log(lines.join('\n'));
    },
    lastTokenFor(email) {
      if (!ALLOW_DEV_TOKEN || !email) return null;
      return lastToken.get(String(email).toLowerCase()) || null;
    },
  };
}

// ── Real HTTP email providers (Resend / SendGrid / Postmark) ─────────────────
// Real delivery uses the already-present axios — NO new runtime dependency.
// buildProviderRequest is PURE (returns url + headers + body) so it's unit-tested
// offline; the adapter just POSTs it. Add a provider by extending this switch.
const PROVIDERS = new Set(['resend', 'sendgrid', 'postmark']);

export function buildProviderRequest(provider, { key, from, to, subject, text, html, mailHeaders }) {
  // mailHeaders are EMAIL headers (e.g. List-Unsubscribe), distinct from the HTTP auth
  // headers below. Each provider carries them differently.
  const hdrs = mailHeaders && Object.keys(mailHeaders).length ? mailHeaders : null;
  switch (provider) {
    case 'resend':
      return {
        url: 'https://api.resend.com/emails',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: { from, to: [to], subject, text, ...(html ? { html } : {}), ...(hdrs ? { headers: hdrs } : {}) },
      };
    case 'sendgrid':
      return {
        url: 'https://api.sendgrid.com/v3/mail/send',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject,
          content: [
            { type: 'text/plain', value: text },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
          ...(hdrs ? { headers: hdrs } : {}),
        },
      };
    case 'postmark':
      return {
        url: 'https://api.postmarkapi.com/email',
        headers: {
          'X-Postmark-Server-Token': key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: {
          From: from, To: to, Subject: subject, TextBody: text,
          ...(html ? { HtmlBody: html } : {}),
          ...(hdrs ? { Headers: Object.entries(hdrs).map(([Name, Value]) => ({ Name, Value })) } : {}),
        },
      };
    default:
      throw new Error(`Unknown mail provider: ${provider}`);
  }
}

// HTTP-provider adapter. Real mail NEVER exposes tokens (lastTokenFor → null).
function httpAdapter({ provider, key, from }) {
  return {
    name: provider,
    async send({ to, subject, text, html, headers } = {}) {
      const req = buildProviderRequest(provider, { key, from, to, subject, text, html, mailHeaders: headers });
      // Never log the request — its headers carry the API key. The caller catches
      // a rejection and logs a generic error (never the key/link).
      await axios.post(req.url, req.body, { headers: req.headers, timeout: 10000 });
    },
    lastTokenFor() {
      return null;
    },
  };
}

// SMTP would require nodemailer (a new dependency), so it is intentionally NOT
// wired — the HTTP providers above cover real delivery with zero new deps.

let _warnedPartial = false;

/**
 * Resolve the mailer mode from env (PURE — unit-testable). Real HTTP delivery
 * needs a supported MAIL_PROVIDER + MAIL_PROVIDER_KEY + MAIL_FROM; anything else
 * (including a partial/unsupported config) → the console adapter.
 */
export function resolveMailerConfig(env = process.env) {
  // Tests must NEVER use a real mail provider: the suites run fully offline, and the
  // magic-link token stash the offline auth tests read only exists on the console adapter.
  // Force console under NODE_ENV=test regardless of any MAIL_* in the environment or .env.
  if (String(env.NODE_ENV || '').toLowerCase() === 'test') return { mode: 'console', forcedByTest: true };
  const provider = String(env.MAIL_PROVIDER || '').toLowerCase();
  const key = env.MAIL_PROVIDER_KEY;
  const from = env.MAIL_FROM;
  if (PROVIDERS.has(provider) && key && from) {
    return { mode: 'http', provider, key, from };
  }
  // Flag a partial config so a misconfiguration isn't silently swallowed.
  const partial = !!(provider || key || env.SMTP_URL || env.MAIL_FROM);
  return { mode: 'console', partial };
}

/**
 * Factory: choose the mailer adapter from env. Console is the default and always
 * "works" (logs), so login is never hard-broken; set MAIL_PROVIDER (+ key + from)
 * for real delivery.
 */
export function createMailer(env = process.env) {
  const cfg = resolveMailerConfig(env);
  if (cfg.mode === 'http') {
    console.log(`[Mailer] Real email delivery via ${cfg.provider} (from ${cfg.from}).`);
    return httpAdapter(cfg);
  }
  if (cfg.partial && !_warnedPartial) {
    _warnedPartial = true;
    console.warn(
      '[Mailer] A mail env var is set but the config is incomplete/unsupported ' +
        '(need MAIL_PROVIDER ∈ {resend,sendgrid,postmark} + MAIL_PROVIDER_KEY + MAIL_FROM). ' +
        'Falling back to the console adapter — no real email will be sent.'
    );
  }
  return consoleAdapter();
}
