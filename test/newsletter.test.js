// Newsletter — draft a donor update, segment the audience from the donation ledger, and
// send. Every send routes through the SAME outbound chokepoint as the rest of the app, so
// in demo each copy is redirected to the operator inbox (nothing reaches a real donor).
// Offline (no key): the draft falls back to a static template; the AI success path lives in
// newsletter-ai.test.js. Pins audience segmentation, server-side audience resolution, the
// chokepoint clamp on a fan-out send, history, validation, and org isolation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';
import { markdownToHtml, buildNewsletterEmail } from '../lib/newsletter.js';

after(() => closeServer());

test('markdownToHtml escapes injection and only emits http(s) links/images', () => {
  const html = markdownToHtml(
    '<script>alert(1)</script>\n**bold** and [ok](https://safe.test/x) and [bad](javascript:alert(1))\n![pic](https://img.test/a.png)\n## Heading\n- one'
  );
  assert.ok(!/<script>/i.test(html), 'raw script tag is not emitted');
  assert.match(html, /&lt;script&gt;/, 'angle brackets are escaped');
  assert.match(html, /<strong>bold<\/strong>/, 'bold renders');
  assert.match(html, /<a href="https:\/\/safe\.test\/x"/, 'http link renders');
  assert.ok(!/href="javascript:/i.test(html), 'a javascript: URL is never turned into a link');
  assert.match(html, /<img src="https:\/\/img\.test\/a\.png"/, 'http image renders');
  assert.match(html, /<h[23]/, 'heading renders');
  assert.match(html, /<li/, 'bullet renders');
});

test('buildNewsletterEmail personalizes and includes branding, image, button, unsubscribe', () => {
  const { html, text } = buildNewsletterEmail({
    subject: 'Hi',
    preheader: 'pre',
    body: 'Hi {{first_name}}, thank you.',
    headerImageUrl: 'https://img.test/hero.jpg',
    donateUrl: 'https://give.test/donate',
    orgName: 'Code for Ukraine',
    recipientName: 'Grace Liu',
  });
  assert.match(html, /Hi Grace,/, 'first name is merged');
  assert.ok(!/\{\{\s*first_name\s*\}\}/.test(html), 'no leftover merge token');
  assert.match(html, /Code for Ukraine/, 'org branding in the header');
  assert.match(html, /src="https:\/\/img\.test\/hero\.jpg"/, 'header image rendered');
  assert.match(html, /href="https:\/\/give\.test\/donate"/, 'donate button links to the donation URL');
  assert.match(html, /unsubscribe/i, 'unsubscribe footer present');
  assert.match(text, /Grace/, 'plain-text fallback is personalized');
  assert.match(text, /give\.test\/donate/, 'plain-text fallback carries the donation link');
});

test('a quote in the header image URL cannot break out of the attribute', () => {
  const { html } = buildNewsletterEmail({
    subject: 'x',
    preheader: '',
    body: 'Hi.',
    headerImageUrl: 'https://img.test/a.jpg" onerror="alert(1)',
    donateUrl: 'https://give.test/d',
    orgName: 'Org',
    recipientName: 'Sam',
  });
  assert.ok(!/onerror="/i.test(html), 'no live onerror attribute (its quote was escaped)');
  assert.match(html, /src="https:\/\/img\.test\/a\.jpg&quot; onerror=&quot;alert\(1\)"/, 'the URL quotes are escaped and stay inside the src attribute');
});

const ymd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const slug = (s) => s.replace(/\s+/g, '-').toLowerCase();

async function donor(u, name, email, daysAgoList) {
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: name, contact_email: email || null, company: 'Acme', linkedin_url: `https://l/${slug(name)}` }],
  });
  for (const d of daysAgoList) await u.post('/api/donations/reconcile', { donors: [{ name, amount: 100, date: ymd(-d) }] });
}

async function seedDonors(u) {
  await donor(u, 'Recent Rita', 'rita@donor.test', [10]); // recent
  await donor(u, 'Lapsed Leo', 'leo@donor.test', [400]); // lapsed
  await donor(u, 'Recurring Rae', 'rae@donor.test', [20, 50]); // recent + recurring (2 gifts)
  await donor(u, 'No Email Ned', null, [10]); // gifted but unreachable
}

test('audience segments are computed server-side from the donation ledger', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-aud', name: 'Ned' });
  await u.post('/api/orgs', { name: 'NL Aud Org' });
  await seedDonors(u);

  const { data } = await u.get('/api/newsletter/audience');
  assert.equal(data.segments.all, 3, 'three donors with an email');
  assert.equal(data.segments.recent, 2, 'Rita + Rae gave within 90 days');
  assert.equal(data.segments.lapsed, 1, 'Leo gave over a year ago');
  assert.equal(data.segments.recurring, 1, 'Rae gave more than once');
  assert.equal(data.noEmail, 1, 'Ned has no email and is excluded');
});

test('sending a newsletter fans out through the chokepoint, clamped to the operator inbox', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-send', name: 'Nell' });
  await u.post('/api/orgs', { name: 'NL Send Org' });
  await seedDonors(u);

  const res = await u.post('/api/newsletter/send', { subject: 'Spring update', body: 'Thank you for your support.', segment: 'all' });
  assert.equal(res.status, 200);
  assert.equal(res.data.recipients, 3, 'resolved the 3 emailed donors server-side');
  assert.equal(res.data.sent, 3, 'all delivered (to the console adapter)');
  assert.equal(res.data.redirected, 3, 'every donor copy was redirected to the operator inbox in demo');
  assert.equal(res.data.failed, 0);

  const hist = (await u.get('/api/newsletter/history')).data.newsletters;
  assert.equal(hist.length, 1, 'the send is logged');
  assert.equal(hist[0].recipients, 3);
});

test('the draft falls back to an editable template when AI is off', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-draft', name: 'Dot' });
  await u.post('/api/orgs', { name: 'NL Draft Org' });
  await seedDonors(u);

  const res = await u.post('/api/newsletter/draft', { instructions: 'thank year-end donors' });
  assert.equal(res.status, 503, 'no key → 503, not an empty AI call');
  assert.ok(res.data.fallback?.subject?.length > 0, 'fallback has a subject');
  assert.ok(res.data.fallback?.body?.length > 0, 'fallback has a body grounded in totals');
});

test('send validates a subject + body and refuses an empty segment', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-val', name: 'Val' });
  await u.post('/api/orgs', { name: 'NL Val Org' });
  await seedDonors(u);
  assert.equal((await u.post('/api/newsletter/send', { subject: '', body: 'x', segment: 'all' })).status, 400, 'no subject → 400');
  // A fresh org with no donors → the segment is empty → 400.
  const e = client();
  await e.login({ linkedinId: 'nl-empty', name: 'Em' });
  await e.post('/api/orgs', { name: 'NL Empty Org' });
  assert.equal((await e.post('/api/newsletter/send', { subject: 'Hi', body: 'There', segment: 'all' })).status, 400, 'no donors → 400');
});

test('the audience and history are org-scoped', async () => {
  const a = client();
  await a.login({ linkedinId: 'nl-iso-a', name: 'A' });
  await a.post('/api/orgs', { name: 'NL Iso A' });
  await seedDonors(a);
  await a.post('/api/newsletter/send', { subject: 'A', body: 'A body', segment: 'all' });

  const b = client();
  await b.login({ linkedinId: 'nl-iso-b', name: 'B' });
  await b.post('/api/orgs', { name: 'NL Iso B' });
  assert.equal((await b.get('/api/newsletter/audience')).data.segments.all, 0, "org B sees none of org A's donors");
  assert.equal((await b.get('/api/newsletter/history')).data.newsletters.length, 0, "org B sees none of org A's sends");
});

test('preview renders a personalized HTML email (no send)', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-prev', name: 'Pat' });
  await u.post('/api/orgs', { name: 'NL Prev Org' });
  await seedDonors(u);
  const res = await u.post('/api/newsletter/preview', { subject: 'Hi', preheader: 'p', body: 'Hi {{first_name}}, thanks.', headerImageUrl: '' });
  assert.equal(res.status, 200);
  assert.match(res.data.html, /<html/i, 'returns an HTML document');
  assert.ok(res.data.sampleName?.length > 0, 'uses a real donor name as the sample');
  assert.match(res.data.html, new RegExp(`Hi ${res.data.sampleName.split(' ')[0]},`), 'preview is personalized');
});

test('a test send goes only to the operator inbox and is not logged as a campaign', async () => {
  const u = client();
  await u.login({ linkedinId: 'nl-test', name: 'Tess' });
  await u.post('/api/orgs', { name: 'NL Test Org' });
  await seedDonors(u);
  const res = await u.post('/api/newsletter/send', { subject: 'Hi', body: 'Hi {{first_name}}', test: true });
  assert.equal(res.status, 200);
  assert.equal(res.data.test, true);
  assert.equal(String(res.data.to).toLowerCase(), 'jgbergen18@gmail.com', 'a test goes to the operator allowlist address');
  assert.equal((await u.get('/api/newsletter/history')).data.newsletters.length, 0, 'a test is not logged as a send');
});
