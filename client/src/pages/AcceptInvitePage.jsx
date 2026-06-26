import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';

// Landing page for an invitation email link (`/invite?token=...`). The invite IS
// the credential: accepting it both signs the user in AND places them in the
// inviting org with the invited role (org + role come from the token row on the
// server, never from anything we send). We don't expose org/role until after
// acceptance (no pre-auth info leak); the success state confirms where they
// landed by reading /api/orgs/me.
export default function AcceptInvitePage({ onSignedIn }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(token ? '' : 'This invitation link is missing its token.');
  const [landed, setLanded] = useState(null); // { orgName, role }

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/api/orgs/invitations/accept', { token });
      await onSignedIn?.(data.user);
      // Confirm placement for the user before sending them in.
      let orgName = '';
      try {
        const me = await api.get('/api/orgs/me');
        orgName = me.data?.org?.name || '';
      } catch {
        /* non-fatal — still signed in */
      }
      setLanded({ orgName, role: data.user?.orgRole || 'member' });
    } catch (e) {
      setError(e.response?.data?.error || 'This invitation is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <h1>
            Donor <span className="text-blue">Scout</span>
          </h1>
          <p className="login__tagline">You’ve been invited to join a team on Donor Scout.</p>
        </div>

        {landed ? (
          <div className="login__actions">
            <div className="alert alert--success" role="status">
              You’ve joined{' '}
              <strong>{landed.orgName || 'your organization'}</strong> as{' '}
              <strong>{landed.role}</strong>.
            </div>
            <button
              className="btn btn--primary btn--block"
              onClick={() => navigate('/dashboard', { replace: true })}
            >
              Go to dashboard →
            </button>
          </div>
        ) : (
          <div className="login__actions">
            {error ? (
              <>
                <div className="alert alert--error">{error}</div>
                <button
                  className="btn btn--primary btn--block"
                  onClick={() => navigate('/login', { replace: true })}
                >
                  Back to sign in
                </button>
              </>
            ) : (
              <>
                <p className="login__hint">
                  Accepting signs you in and adds you to the inviting organization with the role they
                  chose for you.
                </p>
                <button
                  className="btn btn--primary btn--block"
                  onClick={accept}
                  disabled={busy}
                >
                  {busy ? 'Joining…' : 'Accept invitation'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
