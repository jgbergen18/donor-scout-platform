import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import Icon from '../components/Icon';

const ERROR_MESSAGES = {
  linkedin_not_configured:
    'LinkedIn sign-in isn’t configured yet. Use demo mode, or add LinkedIn credentials (see SETUP.md).',
  auth_failed: 'LinkedIn sign-in failed or was cancelled. Please try again.',
  sso_failed: 'Single sign-on didn’t complete. Please try again, or use another sign-in method.',
};

export default function LoginPage({ config, onDemoLogin }) {
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  // After a successful request we show a "check your email" confirmation. In dev
  // the backend echoes a devToken so the link is usable with no mail provider.
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState('');
  const [emailErr, setEmailErr] = useState('');
  // SSO email entry: user types their work email; we route them to their org's
  // Okta via the backend. If the domain isn't mapped to an SSO org, the backend
  // bounces back to /login?sso=unavailable and we offer the fallback methods.
  const [ssoEmail, setSsoEmail] = useState('');
  const error = params.get('error');
  const reason = params.get('reason');
  const ssoStatus = params.get('sso'); // 'unavailable' when no SSO org matched

  // Start the OAuth dance on the API origin directly so the session cookie is set
  // first-party to the backend (in dev that's :5000, not the Vite proxy at :5173).
  const authBase =
    import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:5000' : '');
  const linkedinHref = `${authBase}/api/auth/linkedin`;

  // Full-page navigate to the backend's SSO start so the session cookie + the
  // Okta redirect are first-party to the API (mirrors the LinkedIn flow). The
  // backend resolves the email's verified domain → that org's Okta.
  function startSso(e) {
    e.preventDefault();
    const addr = ssoEmail.trim();
    if (!addr) return;
    window.location.assign(`${authBase}/api/auth/sso/start?email=${encodeURIComponent(addr)}`);
  }

  async function demo() {
    setBusy(true);
    try {
      await onDemoLogin();
    } finally {
      setBusy(false);
    }
  }

  // Request a passwordless magic link. The backend ALWAYS returns 200 (no
  // existence leak), so a successful response just means "if that email maps to
  // an account, a link is on its way" — we show the same confirmation regardless.
  async function requestMagicLink(e) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setEmailBusy(true);
    setEmailErr('');
    setDevLink('');
    try {
      const { data } = await api.post('/api/auth/magic-link/request', { email: addr });
      setSent(true);
      // Dev convenience: the server only returns devToken outside production.
      if (data?.devToken) {
        setDevLink(`${window.location.origin}/auth/magic?token=${data.devToken}`);
      }
    } catch {
      // Network/server error — keep the generic, non-leaky message.
      setEmailErr('Could not send the sign-in link. Please try again.');
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <span className="brand__flag brand__flag--lg" aria-hidden="true">
            <span className="b-blue" />
            <span className="b-yellow" />
          </span>
          <h1>
            Donor <span className="text-blue">Scout</span>
          </h1>
          <p className="login__tagline">
            Turn your LinkedIn network into donors for <strong>Code for Ukraine</strong>.
            Rank prospects, track referrals, and watch the impact grow.
          </p>
        </div>

        {error && (
          <div className="alert alert--error">
            {ERROR_MESSAGES[error] || 'Something went wrong.'}
            {reason && <div className="small" style={{ marginTop: 6, opacity: 0.85 }}>Details: {reason}</div>}
          </div>
        )}

        {ssoStatus === 'unavailable' && (
          <div className="alert alert--info" role="status">
            <strong>No single sign-on for that email.</strong> Your organization hasn’t set up
            SSO (or that domain isn’t verified yet). Use email, LinkedIn, or demo mode below.
          </div>
        )}

        <div className="login__actions">
          <form className="login__email" onSubmit={startSso}>
            <label className="field">
              <span>Sign in with single sign-on (SSO)</span>
              <input
                type="email"
                autoComplete="email"
                value={ssoEmail}
                placeholder="you@example.com"
                onChange={(e) => setSsoEmail(e.target.value)}
              />
            </label>
            <button className="btn btn--block" type="submit" disabled={!ssoEmail.trim()}>
              Continue with SSO →
            </button>
            <p className="login__hint">
              Enter your work email and we’ll route you to your organization’s identity provider
              (Okta). No SSO? Use one of the options below.
            </p>
          </form>

          <div className="login__divider"><span>or</span></div>

          {config?.magicLinkEnabled !== false && (
            <>
              {sent ? (
                <div className="alert alert--success" role="status">
                  <strong>Check your email.</strong> If an account exists for{' '}
                  <strong>{email.trim()}</strong>, we’ve sent a one-time sign-in link. It expires in
                  15 minutes.
                  {devLink && (
                    <p className="small" style={{ marginTop: 8 }}>
                      Dev mode (no mail provider): {' '}
                      <a href={devLink}>open your sign-in link</a>.
                    </p>
                  )}
                  <p className="small" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setSent(false);
                        setDevLink('');
                      }}
                    >
                      Use a different email
                    </button>
                  </p>
                </div>
              ) : (
                <form className="login__email" onSubmit={requestMagicLink}>
                  <label className="field">
                    <span>Sign in with email</span>
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      placeholder="you@example.org"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn--primary btn--block"
                    type="submit"
                    disabled={emailBusy || !email.trim()}
                  >
                    {emailBusy ? 'Sending…' : 'Email me a sign-in link'}
                  </button>
                  {emailErr && (
                    <p className="login__hint" style={{ color: 'var(--err)' }}>{emailErr}</p>
                  )}
                </form>
              )}

              <div className="login__divider"><span>or</span></div>
            </>
          )}

          {config?.linkedinEnabled ? (
            <a className="btn btn--linkedin btn--block" href={linkedinHref}>
              <Icon name="linkedin" size={18} /> Sign in with LinkedIn
            </a>
          ) : (
            <button className="btn btn--linkedin btn--block" disabled title="Not configured. See SETUP.md">
              <Icon name="linkedin" size={18} /> Sign in with LinkedIn
            </button>
          )}

          <button className="btn btn--primary btn--block" onClick={demo} disabled={busy}>
            {busy ? 'Signing in…' : 'Continue in demo mode →'}
          </button>
          {!config?.linkedinEnabled && (
            <p className="login__hint">
              LinkedIn isn’t configured. Demo mode signs you in as a sample scout so you can try the
              whole app right now.
            </p>
          )}
        </div>
      </div>

      <p className="login__footnote">
        <Icon name="flag-ua" size={15} /> $800 funds one student through a 14-day coding bootcamp.
      </p>
    </div>
  );
}
