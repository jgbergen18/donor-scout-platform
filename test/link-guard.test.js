// Donation-link integrity (lib/brief.js enforceDonationLink). The Campaign Agent's
// drafts/replies may only contain the ONE server-sourced donation host; every other
// link must be stripped, because the model text is grounded in UNTRUSTED candidate
// data + a pasted-in reply. These cases include the backslash-userinfo bypass that a
// WHATWG-vs-lenient-client host mismatch would otherwise sneak through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDonationLink } from '../lib/brief.js';

const OK = 'https://www.zeffy.com/en-US/donation-form/abc';

test('keeps the canonical donation link', () => {
  const out = enforceDonationLink(`Donate here: ${OK} — thank you!`, OK);
  assert.ok(out.includes(OK), 'canonical link preserved');
});

test('strips a plain foreign link while keeping the canonical one', () => {
  const out = enforceDonationLink(`Give at ${OK} (not https://evil.example.com/x)`, OK);
  assert.ok(out.includes('zeffy.com'));
  assert.ok(!out.includes('evil.example.com'), 'foreign link removed');
});

test('strips the backslash-userinfo bypass (host\\@evil.com)', () => {
  const sneaky = 'https://www.zeffy.com\\@evil.com/x'; // one real backslash before @
  const out = enforceDonationLink(`Please click ${sneaky} now`, OK);
  assert.ok(!out.includes('evil.com'), 'backslash-userinfo link must be stripped');
  assert.ok(!out.includes('\\@'), 'no backslash token survives');
});

test('strips @-userinfo when the REAL host is foreign', () => {
  const out = enforceDonationLink('Go to https://www.zeffy.com@evil.com/x', OK);
  assert.ok(!out.includes('evil.com'), 'real host is evil.com → stripped');
});

test('keeps the canonical link despite trailing punctuation', () => {
  const out = enforceDonationLink(`Donate: ${OK}.`, OK);
  assert.ok(out.includes(OK), 'trailing period does not break the host match');
});

test('no-op when there is no allowed URL (text returned unchanged)', () => {
  const t = 'see https://evil.example.com';
  assert.equal(enforceDonationLink(t, ''), t);
});
