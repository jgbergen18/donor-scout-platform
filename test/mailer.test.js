// Mailer: provider selection + the PURE HTTP request builders. No network, no
// server boot — just lib/mailer.js. Confirms real delivery is wired correctly
// and that the app still degrades to the console adapter without config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMailerConfig, buildProviderRequest, createMailer } from '../lib/mailer.js';

test('resolveMailerConfig: console by default (no mail env)', () => {
  const cfg = resolveMailerConfig({});
  assert.equal(cfg.mode, 'console');
  assert.equal(cfg.partial, false);
});

test('resolveMailerConfig: http only when provider + key + from are all set', () => {
  const full = resolveMailerConfig({ MAIL_PROVIDER: 'resend', MAIL_PROVIDER_KEY: 're_x', MAIL_FROM: 'a@b.org' });
  assert.equal(full.mode, 'http');
  assert.equal(full.provider, 'resend');

  // Partial / unsupported configs fall back to console but are flagged.
  assert.deepEqual(resolveMailerConfig({ MAIL_PROVIDER: 'resend' }), { mode: 'console', partial: true });
  assert.equal(resolveMailerConfig({ MAIL_PROVIDER: 'bogus', MAIL_PROVIDER_KEY: 'k', MAIL_FROM: 'a@b.org' }).mode, 'console');
});

test('createMailer returns the console adapter (with the dev/test token hook) when unconfigured', () => {
  const m = createMailer({});
  assert.equal(m.name, 'console');
  assert.equal(typeof m.lastTokenFor, 'function');
});

test('createMailer returns an http adapter that never exposes tokens when configured', () => {
  const m = createMailer({ MAIL_PROVIDER: 'postmark', MAIL_PROVIDER_KEY: 'pm_x', MAIL_FROM: 'a@b.org' });
  assert.equal(m.name, 'postmark');
  assert.equal(m.lastTokenFor('a@b.org'), null); // real mail never leaks tokens
});

const MSG = { key: 'SECRET_KEY', from: 'team@cause.org', to: 'donor@x.org', subject: 'Hi', text: 'link', html: '<a>link</a>' };

test('buildProviderRequest: resend shape + bearer auth', () => {
  const r = buildProviderRequest('resend', MSG);
  assert.equal(r.url, 'https://api.resend.com/emails');
  assert.equal(r.headers.Authorization, 'Bearer SECRET_KEY');
  assert.deepEqual(r.body.to, ['donor@x.org']);
  assert.equal(r.body.from, 'team@cause.org');
  assert.equal(r.body.subject, 'Hi');
});

test('buildProviderRequest: sendgrid shape', () => {
  const r = buildProviderRequest('sendgrid', MSG);
  assert.equal(r.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(r.headers.Authorization, 'Bearer SECRET_KEY');
  assert.equal(r.body.personalizations[0].to[0].email, 'donor@x.org');
  assert.equal(r.body.from.email, 'team@cause.org');
  assert.ok(r.body.content.some((c) => c.type === 'text/html'));
});

test('buildProviderRequest: postmark shape + token header', () => {
  const r = buildProviderRequest('postmark', MSG);
  assert.equal(r.url, 'https://api.postmarkapi.com/email');
  assert.equal(r.headers['X-Postmark-Server-Token'], 'SECRET_KEY');
  assert.equal(r.body.To, 'donor@x.org');
  assert.equal(r.body.HtmlBody, '<a>link</a>');
});

test('buildProviderRequest: unknown provider throws (caught at config time)', () => {
  assert.throws(() => buildProviderRequest('mailgun', MSG), /Unknown mail provider/);
});
