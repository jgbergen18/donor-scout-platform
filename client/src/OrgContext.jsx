import { createContext, useContext } from 'react';
import { CAUSE, ZEFFY_DONATE_URL, ZEFFY_EMBED_URL } from './config';

// Phase 2.5b: branding/cause copy is now per-organization. The server sends the
// org's cause config on `user.cause` (from /api/auth/me); this maps it into the
// display shape the UI uses, falling back to the static cause.config.js defaults
// so a logged-out / no-org state still renders.

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// Derive a Zeffy embed (iframe) URL from a Zeffy donation-form link. For any OTHER
// donation host we return null: an arbitrary page must NOT be embedded in the
// payment-enabled iframe (an owner could otherwise point it anywhere) — the caller
// falls back to an "open the donation page" link instead.
function embedFor(donateUrl) {
  if (!donateUrl) return ZEFFY_EMBED_URL;
  const m = /zeffy\.com\/(?:[a-z-]+\/)?donation-form\/([\w-]+)/i.exec(donateUrl);
  return m ? `https://www.zeffy.com/embed/donation-form/${m[1]}` : null;
}

// "day of camp" → "Days of camp" / "days of camp"; otherwise pluralize sensibly.
function daysLabel(dayLabel, upper) {
  if (!dayLabel) return upper ? CAUSE.daysFunded : CAUSE.daysFundedLower;
  if (/^day\b/i.test(dayLabel)) return dayLabel.replace(/^day/i, upper ? 'Days' : 'days');
  return upper ? `${cap(dayLabel)}s funded` : `${dayLabel}s funded`;
}

export function causeView(serverCause) {
  const c = serverCause || {};
  const i = c.impact || {};
  const beneficiaries = i.beneficiaries || CAUSE.beneficiaries;
  const donateUrl = c.donateUrl || ZEFFY_DONATE_URL;
  return {
    orgName: c.orgName || CAUSE.orgName,
    beneficiary: i.beneficiary || CAUSE.beneficiary,
    beneficiaries,
    beneficiariesFunded: `${cap(beneficiaries)} funded`,
    daysFunded: daysLabel(i.dayLabel, true),
    daysFundedLower: daysLabel(i.dayLabel, false),
    programUnit: i.programLabel || CAUSE.programUnit,
    dayUnit: i.dayLabel || CAUSE.dayUnit,
    programCost: Number(i.programCost) || 800,
    dayCost: Number(i.dayCost) || 57.14,
    donateUrl,
    embedUrl: embedFor(donateUrl),
  };
}

// Default value = the static fallback (used before a user/org is loaded).
const defaultView = causeView(null);
export const OrgContext = createContext(defaultView);
export const useOrg = () => useContext(OrgContext);
