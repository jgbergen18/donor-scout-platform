/**
 * lib/matchgifts.js — employer matching-gift detector (logic).
 *
 * The company list lives in lib/matchgifts-data.js — a CURATED HEURISTIC list of
 * large employers commonly known to run matching-gift programs, not an authoritative
 * database (see docs/match-gifts.md for full-coverage options). Here we compile each
 * program's keywords into a word-boundary regex and expose matchProgramFor().
 *
 * Many large employers DOUBLE an employee's charitable gift through a corporate
 * matching-gift program — free money usually left on the table because nobody asks.
 * This flag surfaces a one-click "ask them to submit a match" PROMPT; it never
 * contacts anyone and spends no AI budget (the volunteer copies a short message and
 * sends it themselves — no-send, exactly like every other outreach in the app).
 */
import { MATCH_PROGRAMS } from './matchgifts-data.js';

const esc = (k) => k.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');

// Compile once. Word-boundary match per keyword (so "Apple" ≠ "Snapple",
// "Visa" ≠ "Visalia", "Ford" ≠ "Stanford") — boundaries are any non-alphanumeric.
const PROGRAMS = MATCH_PROGRAMS.map((p) => ({
  name: p.name,
  re: new RegExp(`(^|[^a-z0-9])(${p.kw.map(esc).join('|')})([^a-z0-9]|$)`, 'i'),
}));

/** Return the matching-gift program/company name for a company string, or null. */
export function matchProgramFor(company) {
  if (!company) return null;
  const c = String(company);
  for (const p of PROGRAMS) {
    if (p.re.test(c)) return p.name;
  }
  return null;
}

// ── Per-org custom companies (an org can extend the built-in list) ───────────
// Compile org-supplied rows ({name, keyword?}) into word-boundary matchers. The
// keyword defaults to the name, so an admin who adds "Acme" matches "Acme",
// "Acme Corp", "Acme Inc", etc. — same discipline as the built-in list.
export function compileCustom(rows) {
  return (rows || [])
    .map((r) => {
      const kw = String(r.keyword || r.name || '').trim().toLowerCase();
      return kw ? { name: r.name, re: new RegExp(`(^|[^a-z0-9])(${esc(kw)})([^a-z0-9]|$)`, 'i') } : null;
    })
    .filter(Boolean);
}

/** Match an org's CUSTOM compiled companies first (so they win/extend), then the
 *  built-in list. Pass the result of compileCustom(orgRows). */
export function matchProgramWith(company, customCompiled) {
  if (!company) return null;
  const c = String(company);
  for (const p of customCompiled || []) {
    if (p.re.test(c)) return p.name;
  }
  return matchProgramFor(company);
}

export const MATCH_PROGRAM_COUNT = PROGRAMS.length;
