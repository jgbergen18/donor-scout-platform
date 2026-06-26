// First client tests (audit Batch E). Vitest unit tests for the pure formatting +
// template helpers — the trivially-testable logic that was previously unguarded.
import { describe, test, expect } from 'vitest';
import { money, percent } from './api';
import {
  firstNameOf,
  buildOutreachMessage,
  buildThankYouMessage,
  buildMatchGiftMessage,
  mailtoLink,
} from './outreach';

const ORG = {
  orgName: 'Test Org',
  beneficiary: 'student',
  programUnit: 'bootcamp',
  programCost: 800,
  dayCost: 57.14,
  donateUrl: 'https://give.test/donate',
};

describe('formatting helpers', () => {
  test('money coerces and formats USD', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(800)).toBe('$800.00');
    expect(money(57.14)).toBe('$57.14');
    expect(money('not a number')).toBe('$0.00');
    expect(money(null)).toBe('$0.00');
  });
  test('percent rounds a 0–1 ratio', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.5)).toBe('50%');
    expect(percent(1)).toBe('100%');
    expect(percent('x')).toBe('0%');
  });
});

describe('firstNameOf', () => {
  test('takes the first token, falls back to "there"', () => {
    expect(firstNameOf('Olena Kovalenko')).toBe('Olena');
    expect(firstNameOf('  Bohdan  ')).toBe('Bohdan');
    expect(firstNameOf('')).toBe('there');
    expect(firstNameOf('   ')).toBe('there');
    expect(firstNameOf(null)).toBe('there');
  });
});

describe('outreach templates', () => {
  test('buildOutreachMessage uses the org cause view + names + donate link', () => {
    const m = buildOutreachMessage('Olena K', 'Jamie Bergen', ORG);
    expect(m).toContain('Olena');
    expect(m).toContain('Test Org');
    expect(m).toContain('https://give.test/donate');
    expect(m).toContain('$800');
    expect(m.trimEnd().endsWith('Jamie')).toBe(true);
  });

  test('buildThankYouMessage picks the impact tier by amount', () => {
    expect(buildThankYouMessage('Olena', null, 800, ORG)).toContain('funds 1 student');
    expect(buildThankYouMessage('Olena', null, 1600, ORG)).toContain('funds 2 students');
    // Between dayCost and programCost → the "days" tier.
    expect(buildThankYouMessage('Olena', null, 100, ORG)).toContain('covers about 1 day');
    // No amount → no impact clause.
    const none = buildThankYouMessage('Olena', null, 0, ORG);
    expect(none).not.toContain('Your gift funds');
    expect(none).not.toContain('covers about');
  });

  test('buildMatchGiftMessage names the employer and the double', () => {
    const m = buildMatchGiftMessage('Dana', 'Jamie', 'Google', 'Google', ORG);
    expect(m).toContain('Dana');
    expect(m).toContain('Google');
    expect(m).toContain('doubled');
  });

  test('mailtoLink builds an encoded mailto', () => {
    const link = mailtoLink('a@b.com', 'Hi there & thanks', 'Subject');
    expect(link.startsWith('mailto:a@b.com?')).toBe(true);
    expect(link).toContain('subject=Subject');
    expect(link).toContain('Hi%20there%20%26%20thanks'); // body is URL-encoded
  });
});
