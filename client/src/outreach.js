import { CAUSE, ZEFFY_DONATE_URL } from './config';

export const firstNameOf = (fullName) => (fullName || '').trim().split(/\s+/)[0] || 'there';

// Static outreach templates (the non-AI fallback; the "Draft with AI" path is
// org-aware on the server). These are parameterized by the org's cause view so
// the copy rebrands per tenant. `org` is the causeView object from OrgContext;
// it falls back to the static cause.config.js defaults.
function orgOr(org) {
  return {
    orgName: org?.orgName || CAUSE.orgName,
    beneficiary: org?.beneficiary || CAUSE.beneficiary,
    programUnit: org?.programUnit || CAUSE.programUnit,
    programCost: Number(org?.programCost) || 800,
    dayCost: Number(org?.dayCost) || 57.14,
    donateUrl: org?.donateUrl || ZEFFY_DONATE_URL,
  };
}

// A warm, ready-to-send ask that the scout can edit before copying/sending.
export function buildOutreachMessage(prospectName, scoutName, org) {
  const o = orgOr(org);
  const first = firstNameOf(prospectName);
  const me = (scoutName || '').trim().split(/\s+/)[0] || '';
  const seat = o.programCost
    ? ` $${o.programCost} funds a full ${o.programUnit} for one ${o.beneficiary}.`
    : '';
  return `Hi ${first},

I'm helping raise money for ${o.orgName}.${seat}

If you're able, any amount helps. 100% goes to the cause:
${o.donateUrl}

Thanks for considering it.${me ? `\n\n${me}` : ''}`;
}

// A warm thank-you to send after a donation lands (stewardship lifts repeat giving).
export function buildThankYouMessage(prospectName, scoutName, amount, org) {
  const o = orgOr(org);
  const first = firstNameOf(prospectName);
  const me = (scoutName || '').trim().split(/\s+/)[0] || '';
  const amt = Number(amount) || 0;
  const days = amt && o.dayCost ? Math.floor(amt / o.dayCost) : 0;
  const seats = amt && o.programCost ? Math.floor(amt / o.programCost) : 0;
  const impact =
    seats >= 1
      ? ` Your gift funds ${seats} ${o.beneficiary}${seats === 1 ? '' : 's'} through a full ${o.programUnit}.`
      : days
        ? ` Your gift covers about ${days} day${days === 1 ? '' : 's'} of the program.`
        : '';
  return `Hi ${first},

Thank you for your donation to ${o.orgName}.${impact} I appreciate you supporting this.

I'll keep you posted on the impact. Thanks again.${me ? `\n\n${me}` : ''}`;
}

// A short note asking a donor whose employer matches gifts to submit a match —
// free money the nonprofit usually never asks for. Static (no AI), copy/mailto only.
export function buildMatchGiftMessage(prospectName, scoutName, company, program, org) {
  const o = orgOr(org);
  const first = firstNameOf(prospectName);
  const me = (scoutName || '').trim().split(/\s+/)[0] || '';
  const employer = program || company || 'your employer';
  return `Hi ${first},

Thank you again for supporting ${o.orgName}. One quick thing: ${employer} may run a matching-gift program, which means your gift could be doubled. You can check on your employer's giving portal.

If you're open to it, that would make your gift go twice as far for the cause. Happy to help if you have any questions.${me ? `\n\n${me}` : ''}`;
}

export function mailtoLink(email, message, subject = 'Supporting a cause I care about') {
  return `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}
