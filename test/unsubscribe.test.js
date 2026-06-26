// Unsubscribe + suppression — the keystone that makes going live safe. A signed one-click
// token suppresses an (org, email); the suppression is enforced FIRST in sendOutbound and
// also filters the newsletter audience, so an opted-out donor is never emailed. Auth mail
// is unaffected (it never flows through sendOutbound). Also pins the send-mode endpoint and
// the List-Unsubscribe header plumbing. Offline (console mailer); no real send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { signUnsubToken, verifyUnsubToken } from '../lib/unsubscribe.js';
import { buildProviderRequest } from '../lib/mailer.js';
import { buildNewsletterEmail } from '../lib/newsletter.js';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

const ymd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const SECRET = process.env.SECRETS_KEY || ''; // the server uses the same material

test('unsubscribe token round-trips and rejects tampering / wrong secret', () => {
  const t = signUnsubToken(7, 'Donor@Example.com', 'sekret');
  assert.deepEqual(verifyUnsubToken(t, 'sekret'), { orgId: 7, email: 'donor@example.com' }, 'lowercased email + org');
  assert.equal(verifyUnsubToken(t, 'different'), null, 'wrong secret is rejected');
  assert.equal(verifyUnsubToken(t.slice(0, -3) + 'zzz', 'sekret'), null, 'tampered signature is rejected');
  assert.equal(verifyUnsubToken('not-a-token', 'sekret'), null);
});

test('buildProviderRequest carries List-Unsubscribe headers for each provider', () => {
  const base = { key: 'k', from: 'a@b.org', to: 'c@d.org', subject: 's', text: 't', mailHeaders: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  assert.equal(buildProviderRequest('resend', base).body.headers['List-Unsubscribe'], '<https://x/u>');
  assert.equal(buildProviderRequest('sendgrid', base).body.headers['List-Unsubscribe'], '<https://x/u>');
  assert.deepEqual(
    buildProviderRequest('postmark', base).body.Headers,
    [{ Name: 'List-Unsubscribe', Value: '<https://x/u>' }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]
  );
});

test('buildNewsletterEmail renders a real unsubscribe link when given a URL', () => {
  const { html, text } = buildNewsletterEmail({
    subject: 's', body: 'Hi.', orgName: 'Org', recipientName: 'Sam', unsubscribeUrl: 'https://app.test/api/unsubscribe/tok',
  });
  assert.match(html, /href="https:\/\/app\.test\/api\/unsubscribe\/tok"/, 'footer has a real unsubscribe link');
  assert.match(html, />Unsubscribe</);
  assert.match(text, /Unsubscribe: https:\/\/app\.test\/api\/unsubscribe\/tok/, 'plain text has it too');
});

test('the send-mode endpoint reports the demo redirect clamp', async () => {
  const u = client();
  await u.login({ linkedinId: 'sm-1', name: 'S' });
  await u.post('/api/orgs', { name: 'SM Org' });
  const r = await u.get('/api/system/send-mode');
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'redirect');
  assert.equal(String(r.data.redirectTo).toLowerCase(), 'jgbergen18@gmail.com');
});

async function donor(u, name, email, daysAgo) {
  await u.post('/api/connections/upload', { contacts: [{ contact_name: name, contact_email: email, company: 'Acme', linkedin_url: `https://l/${name.replace(/\s+/g, '')}` }] });
  await u.post('/api/donations/reconcile', { donors: [{ name, amount: 100, date: ymd(-daysAgo) }] });
}

test('an unsubscribed donor leaves the audience and is not emailed', async () => {
  const u = client();
  await u.login({ linkedinId: 'unsub-1', name: 'Op' });
  await u.post('/api/orgs', { name: 'Unsub Org' });
  const orgId = (await u.get('/api/auth/me')).data.user.orgId;
  await donor(u, 'Opt Out', 'optout@donor.test', 20);
  await donor(u, 'Stay Subbed', 'stay@donor.test', 20);
  assert.equal((await u.get('/api/newsletter/audience')).data.segments.all, 2, 'both reachable before opt-out');

  // The recipient unsubscribes (the one-click POST from their email client / confirm form).
  const token = signUnsubToken(orgId, 'optout@donor.test', SECRET);
  const pub = client();
  assert.equal((await pub.post(`/api/unsubscribe/${token}`)).status, 200);

  assert.equal((await u.get('/api/newsletter/audience')).data.segments.all, 1, 'opted-out donor leaves the audience');
  const send = await u.post('/api/newsletter/send', { subject: 'Hi', body: 'Hi {{first_name}}', segment: 'all' });
  assert.equal(send.data.recipients, 1, 'only the still-subscribed donor is targeted');
  assert.equal(send.data.sent, 1);
});

test('sendOutbound drops a suppressed donor on a direct send (second-gift re-ask)', async () => {
  const u = client();
  await u.login({ linkedinId: 'unsub-2', name: 'Op2' });
  await u.post('/api/orgs', { name: 'Unsub Org 2' });
  const orgId = (await u.get('/api/auth/me')).data.user.orgId;
  await donor(u, 'Gone Quiet', 'gonequiet@donor.test', 45);
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'Gone Quiet');
  await u.post(`/api/referrals/${ref.id}/thanked`);

  const pub = client();
  await pub.post(`/api/unsubscribe/${signUnsubToken(orgId, 'gonequiet@donor.test', SECRET)}`);

  const res = await u.post(`/api/referrals/${ref.id}/reconnect-send`, { text: 'Would you give again?' });
  assert.equal(res.status, 202, 'a suppressed direct send is reported, not delivered');
  assert.equal(res.data.send.suppressed, true);
});

test('GET unsubscribe is non-mutating (a confirm page); only POST suppresses', async () => {
  const u = client();
  await u.login({ linkedinId: 'unsub-get', name: 'G' });
  await u.post('/api/orgs', { name: 'Unsub GET Org' });
  const orgId = (await u.get('/api/auth/me')).data.user.orgId;
  await donor(u, 'Prefetch Me', 'prefetch@donor.test', 20);
  const token = signUnsubToken(orgId, 'prefetch@donor.test', SECRET);
  const pub = client();

  const get = await pub.get(`/api/unsubscribe/${token}`);
  assert.equal(get.status, 200);
  assert.match(String(get.data), /Confirm unsubscribe/, 'GET shows a confirm form');
  assert.equal((await u.get('/api/newsletter/audience')).data.segments.all, 1, 'a GET prefetch did NOT suppress');

  assert.equal((await pub.post(`/api/unsubscribe/${token}`)).status, 200);
  assert.equal((await u.get('/api/newsletter/audience')).data.segments.all, 0, 'POST suppresses');
});

test('unsubscribe is idempotent and never leaks whether an address exists', async () => {
  const pub = client();
  // A garbage token still returns a 200 page (no existence leak, no error).
  assert.equal((await pub.get('/api/unsubscribe/garbage.token')).status, 200);
  // A valid token can be POSTed twice with no error (INSERT OR IGNORE).
  const t = signUnsubToken(1, 'x@y.test', SECRET);
  assert.equal((await pub.post(`/api/unsubscribe/${t}`)).status, 200);
  assert.equal((await pub.post(`/api/unsubscribe/${t}`)).status, 200);
});
