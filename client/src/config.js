// Real donation form (Zeffy) for Code.X / Code for Ukraine.
// "Help make Code for Ukraine 2027 happen next summer!"
// Override the form via VITE_ZEFFY_FORM_ID in client/.env (no rebuild of URLs needed).
const FORM_ID = import.meta.env.VITE_ZEFFY_FORM_ID || 'fe71a2d0-1133-40ac-9032-897b66b0a7b1';

// Public donation page (open in a new tab / share with prospects).
export const ZEFFY_DONATE_URL = `https://www.zeffy.com/en-US/donation-form/${FORM_ID}`;

// Embeddable iframe source (Zeffy "Share" → Iframe).
export const ZEFFY_EMBED_URL = `https://www.zeffy.com/embed/donation-form/${FORM_ID}`;

// Cause-specific display copy — mirrors cause.config.js on the backend. Edit
// this (and cause.config.js) to retarget the tool to another nonprofit. The
// impact *numbers* come from the API (which reads cause.config.js); these are
// just the words wrapped around them.
export const CAUSE = {
  orgName: 'Code for Ukraine',
  beneficiary: 'student', // "1 student"
  beneficiaries: 'students', // "12 students funded"
  beneficiariesFunded: 'Students funded', // stat-card label
  daysFunded: 'Days of camp', // stat-card label
  daysFundedLower: 'days of camp', // inline copy
  programUnit: 'bootcamp', // "= 1 bootcamp"
  dayUnit: 'day', // "= 1 day"
};
