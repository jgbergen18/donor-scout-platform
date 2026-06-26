/**
 * Outbound send guard — the single policy for who an app-sent email may actually
 * reach. EVERY outbound send (outreach, thank-you, second-gift re-ask, newsletter)
 * is expected to route through this so a real donor can never be emailed by accident
 * while the product is in demo/dev. Pure + unit-testable (no I/O here).
 *
 * Env:
 *   SEND_ALLOWLIST  comma-separated addresses that may be emailed as-is.
 *                   Default: jgbergen18@gmail.com (the operator's own inbox).
 *   SEND_MODE       redirect (default) | block | live
 *     - redirect: a non-allowlisted recipient is rewritten to the FIRST allowlist
 *                 address; the intended recipient is preserved in the subject + a body
 *                 banner so the demo inbox shows who it WOULD reach in production.
 *     - block:    a non-allowlisted recipient is dropped (nothing sent).
 *     - live:     no clamp — send to whoever is addressed (lifts the demo guard).
 *
 * To go fully live later: set SEND_MODE=live (or widen SEND_ALLOWLIST).
 */

export function parseAllowlist(env = process.env) {
  return String(env.SEND_ALLOWLIST ?? 'jgbergen18@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Decide what to do with an intended recipient. Returns one of:
//   { action: 'send', to, redirected, intended? }
//   { action: 'block', intended }
export function resolveOutbound(intendedTo, env = process.env) {
  const allow = parseAllowlist(env);
  const mode = String(env.SEND_MODE || 'redirect').toLowerCase();
  const to = String(intendedTo || '').trim();
  const toLc = to.toLowerCase();

  if (mode === 'live') return { action: 'send', to, redirected: false };
  if (toLc && allow.includes(toLc)) return { action: 'send', to, redirected: false };
  // Non-allowlisted from here. With no allowlist or block mode, drop it.
  if (mode === 'block' || allow.length === 0) return { action: 'block', intended: to };
  // Default (redirect): clamp to the operator's inbox.
  return { action: 'send', to: allow[0], redirected: true, intended: to };
}

// Rewrite a redirected message so the demo inbox clearly shows the real intended
// recipient. Pure; returns a new { subject, text, html }.
export function decorateRedirect({ subject, text, html }, intended) {
  const who = intended || 'the donor';
  const banner = `[DEMO] Redirected to you. In production this would be sent to: ${who}.`;
  return {
    subject: `[demo → ${who}] ${subject || ''}`.trim(),
    text: text ? `${banner}\n\n${text}` : banner,
    html: html
      ? `<p style="background:#fff3cd;border-radius:6px;padding:8px 10px;margin:0 0 12px">${banner}</p>${html}`
      : undefined,
  };
}
