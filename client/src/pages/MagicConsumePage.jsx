import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';

// Landing page for a magic-link email. Reads ?token= from the URL, posts it to
// the consume endpoint, and on success establishes the session + routes into the
// app. Single-use: a second visit (or an expired link) shows the generic error.
export default function MagicConsumePage({ onSignedIn }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('working'); // working | error
  const [error, setError] = useState('');
  const ran = useRef(false); // guard against React 18 StrictMode double-invoke

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setError('This sign-in link is invalid or has expired.');
      return;
    }
    (async () => {
      try {
        const { data } = await api.post('/api/auth/magic-link/consume', { token });
        await onSignedIn?.(data.user);
        navigate('/dashboard', { replace: true });
      } catch (e) {
        setStatus('error');
        setError(e.response?.data?.error || 'This sign-in link is invalid or has expired.');
      }
    })();
  }, [params, navigate, onSignedIn]);

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <h1>
            Donor <span className="text-blue">Scout</span>
          </h1>
        </div>
        {status === 'working' ? (
          <div className="login__actions" style={{ textAlign: 'center' }}>
            <div className="spinner" />
            <p>Signing you in…</p>
          </div>
        ) : (
          <div className="login__actions">
            <div className="alert alert--error">{error}</div>
            <button className="btn btn--primary btn--block" onClick={() => navigate('/login', { replace: true })}>
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
