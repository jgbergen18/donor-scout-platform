/**
 * App-level secret encryption (SaaS auth Phase 2 — enterprise SSO).
 * ------------------------------------------------------------------
 * Per-org Okta `client_secret`s are ENCRYPTED AT REST: the database stores only
 * AES-256-GCM ciphertext, and no API ever returns the plaintext. This module is
 * the single auditable spot for that crypto, deliberately pure + dependency-free
 * (node:crypto only) so the encrypt/decrypt round-trip is unit-testable offline.
 *
 * Key management:
 *   - The 32-byte key is derived (sha256) from the SECRETS_KEY env var, so the
 *     operator can supply any length passphrase / hex / base64 string.
 *   - In PRODUCTION, SECRETS_KEY is REQUIRED: createSecretBox() throws if it is
 *     missing, so we never silently encrypt enterprise secrets under a known key.
 *   - In NON-PROD (dev/test), we fall back to a fixed dev key and log a CLEAR
 *     one-time warning — so the app keeps booting and is fully testable without
 *     any secret configured, mirroring the AI/GitHub/Mailer graceful-degradation.
 *
 * Wire format (so a key/algorithm change is detectable): a single string
 *   v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 * The version prefix lets a future rotation distinguish ciphertexts.
 */
import crypto from 'node:crypto';

const IS_PROD = process.env.NODE_ENV === 'production';
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
// A clearly-labeled, NON-SECRET dev fallback. Only ever used in non-prod, and
// only with a loud warning. Production must supply a real SECRETS_KEY.
const DEV_KEY_MATERIAL = 'donor-scout-DEV-secrets-key-do-not-use-in-prod';

let _warned = false;

// Resolve the 32-byte key from SECRETS_KEY. Throws in prod when absent; warns and
// falls back to the dev key otherwise.
function resolveKey() {
  const material = process.env.SECRETS_KEY;
  if (material && material.length > 0) {
    return crypto.createHash('sha256').update(material).digest();
  }
  if (IS_PROD) {
    throw new Error(
      'SECRETS_KEY is required in production to encrypt per-org IdP client secrets at rest.'
    );
  }
  if (!_warned) {
    _warned = true;
    console.warn(
      '[secrets] SECRETS_KEY is not set — using an INSECURE built-in dev key. ' +
        'Set SECRETS_KEY before storing real IdP client secrets in production.'
    );
  }
  return crypto.createHash('sha256').update(DEV_KEY_MATERIAL).digest();
}

/**
 * Build a small encrypt/decrypt facade bound to the resolved key. Constructed
 * once at boot (createSecretBox()) so the prod key-required check fires early.
 */
export function createSecretBox() {
  const key = resolveKey();

  function encrypt(plaintext) {
    if (plaintext == null) throw new Error('encrypt() requires a value');
    const iv = crypto.randomBytes(12); // 96-bit nonce, recommended for GCM
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  function decrypt(packed) {
    if (!packed || typeof packed !== 'string') throw new Error('decrypt() requires a packed string');
    const parts = packed.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Unrecognized secret ciphertext format');
    }
    const [, ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag); // GCM auth tag → tamper detection on decrypt
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}
