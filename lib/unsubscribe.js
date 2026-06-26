/**
 * Unsubscribe tokens — a signed, self-contained one-click opt-out link per recipient.
 *
 * The token carries (org_id, email) and an HMAC-SHA256 signature over them, so:
 *   - it needs NO database row to issue (every newsletter recipient gets one for free),
 *   - it cannot be forged or enumerated (a valid signature requires the server secret),
 *   - verifying it both authenticates the request AND tells us exactly which org+email to
 *     suppress, with no auth/session needed (the recipient clicks from their email client).
 *
 * Format: `<base64url(orgId:email)>.<base64url(hmac)>`. No expiry: unsubscribe links must
 * keep working indefinitely (a stale opt-out link that 404s is itself a compliance problem).
 * Pure + dependency-free (node:crypto only) so it is unit-testable offline.
 */
import crypto from 'node:crypto';

// Derive a 32-byte HMAC key from whatever secret material the operator supplies (mirrors
// lib/secrets.js so a passphrase / hex / base64 all work). Falls back to a clearly-labeled
// dev key when unset, like the rest of the app's graceful degradation.
const DEV_KEY = 'donor-scout-DEV-secrets-key-do-not-use-in-prod';
function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret || DEV_KEY)).digest();
}

export function signUnsubToken(orgId, email, secret) {
  const payload = Buffer.from(`${Number(orgId)}:${String(email || '').trim().toLowerCase()}`, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', keyFrom(secret)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Verify a token. Returns { orgId, email } when the signature is valid, else null.
export function verifyUnsubToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', keyFrom(secret)).update(payload).digest('base64url');
  // Constant-time compare; bail before timingSafeEqual if lengths differ (it throws otherwise).
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 1) return null;
    const orgId = Number(decoded.slice(0, idx));
    const email = decoded.slice(idx + 1);
    if (!orgId || !email) return null;
    return { orgId, email };
  } catch {
    return null;
  }
}
