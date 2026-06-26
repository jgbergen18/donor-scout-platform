// Outbound send guard — the single chokepoint that governs who an app-sent email can
// actually reach. In demo/dev the allowlist clamps every donor send to the operator's
// own inbox (redirect), so a real donor can never be emailed by accident. Pins the pure
// policy (allow / redirect / block / live) and the live path: sending a second-gift
// re-ask routes through the chokepoint, is clamped to the operator inbox, and re-asks
// the donor (durably leaving the lane). Offline — the console mailer never delivers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutbound, decorateRedirect, parseAllowlist } from '../lib/sendguard.js';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

const ymd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

test('resolveOutbound: an allowlisted address sends as-is, everyone else is redirected', () => {
  const env = { SEND_ALLOWLIST: 'jgbergen18@gmail.com', SEND_MODE: 'redirect' };
  assert.deepEqual(resolveOutbound('jgbergen18@gmail.com', env), { action: 'send', to: 'jgbergen18@gmail.com', redirected: false });
  const r = resolveOutbound('alice@realdonor.com', env);
  assert.equal(r.action, 'send');
  assert.equal(r.to, 'jgbergen18@gmail.com', 'clamped to the operator inbox');
  assert.equal(r.redirected, true);
  assert.equal(r.intended, 'alice@realdonor.com', 'intended recipient preserved');
});

test('resolveOutbound: block drops a non-allowlisted recipient; live sends anywhere', () => {
  assert.equal(resolveOutbound('alice@realdonor.com', { SEND_MODE: 'block' }).action, 'block');
  assert.deepEqual(resolveOutbound('alice@realdonor.com', { SEND_MODE: 'live' }), { action: 'send', to: 'alice@realdonor.com', redirected: false });
});

test('default allowlist is the operator inbox; matching is case-insensitive', () => {
  assert.deepEqual(parseAllowlist({}), ['jgbergen18@gmail.com']);
  assert.equal(resolveOutbound('JGBergen18@Gmail.com', {}).redirected, false);
});

test('decorateRedirect prefixes the subject and banners the body with the intended recipient', () => {
  const d = decorateRedirect({ subject: 'Hi', text: 'Body' }, 'alice@realdonor.com');
  assert.match(d.subject, /demo → alice@realdonor\.com/);
  assert.match(d.text, /alice@realdonor\.com/);
  assert.match(d.text, /Body/);
});

test('sending a second-gift re-ask routes through the chokepoint and clamps to the operator inbox', async () => {
  const u = client();
  await u.login({ linkedinId: 'send-1', name: 'Sender' });
  await u.post('/api/orgs', { name: 'Send Org' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'Donor Dee', contact_email: 'dee@realdonor.com', company: 'Acme', linkedin_url: 'https://l/dee' }] });
  await u.post('/api/donations/reconcile', { donors: [{ name: 'Donor Dee', amount: 100, date: ymd(-45) }] });
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'Donor Dee');
  await u.post(`/api/referrals/${ref.id}/thanked`);
  assert.ok((await u.get('/api/today')).data.secondGifts.some((x) => x.id === ref.id), 'in the lane');

  const res = await u.post(`/api/referrals/${ref.id}/reconnect-send`, { text: 'Thanks again. Would you give once more?' });
  assert.equal(res.status, 200);
  assert.equal(res.data.send.redirected, true, 'a donor send is redirected in demo');
  assert.equal(res.data.send.intended, 'dee@realdonor.com', 'intended recipient preserved');
  assert.equal(String(res.data.send.to).toLowerCase(), 'jgbergen18@gmail.com', 'clamped to the operator inbox');
  assert.ok(!(await u.get('/api/today')).data.secondGifts.some((x) => x.id === ref.id), 'left the lane after sending');
});

test('reconnect-send refuses with no draft text or no donor email', async () => {
  const u = client();
  await u.login({ linkedinId: 'send-2', name: 'Sender2' });
  await u.post('/api/orgs', { name: 'Send Org 2' });
  await u.post('/api/connections/upload', { contacts: [{ contact_name: 'No Email', company: 'Acme', linkedin_url: 'https://l/noemail' }] });
  await u.post('/api/donations/reconcile', { donors: [{ name: 'No Email', amount: 50, date: ymd(-45) }] });
  const ref = (await u.get('/api/referrals')).data.referrals.find((r) => r.contact_name === 'No Email');
  await u.post(`/api/referrals/${ref.id}/thanked`);
  assert.equal((await u.post(`/api/referrals/${ref.id}/reconnect-send`, { text: '' })).status, 400, 'empty text → 400');
  assert.equal((await u.post(`/api/referrals/${ref.id}/reconnect-send`, { text: 'hi' })).status, 400, 'no donor email → 400');
});
