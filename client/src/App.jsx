import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import api from './api';
import { OrgContext, causeView } from './OrgContext';
import Header from './components/Header';
import Icon from './components/Icon';
import LoginPage from './pages/LoginPage';
import MagicConsumePage from './pages/MagicConsumePage';
import AcceptInvitePage from './pages/AcceptInvitePage';
import DashboardPage from './pages/DashboardPage';
import TodayPage from './pages/TodayPage';
import BriefPage from './pages/BriefPage';
import GrantsPage from './pages/GrantsPage';
import NewsletterPage from './pages/NewsletterPage';
import ProspectsPage from './pages/ProspectsPage';
import CampaignPage from './pages/CampaignPage';
import PipelinePage from './pages/PipelinePage';
import TeamPage from './pages/TeamPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ProfilePage from './pages/ProfilePage';

export default function App() {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState({ linkedinEnabled: false, githubEnrichment: false });
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  async function refreshUser() {
    try {
      const { data } = await api.get('/api/auth/me');
      setUser(data.user);
      return data.user;
    } catch {
      setUser(null);
      return null;
    }
  }

  useEffect(() => {
    (async () => {
      await refreshUser();
      try {
        const { data } = await api.get('/api/auth/config');
        setConfig(data);
      } catch {
        /* keep defaults */
      }
      setLoading(false);
    })();
  }, []);

  async function handleDemoLogin() {
    const { data } = await api.post('/api/auth/demo');
    setUser(data.user);
    navigate('/dashboard');
  }

  // Called by the magic-link / invite-accept landing pages once the server has
  // established the session and returned the public user. Mirrors handleDemoLogin.
  function handleSignedIn(u) {
    setUser(u);
  }

  async function handleLogout() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
      navigate('/login');
    }
  }

  async function handleToggleDemo() {
    if (!user) return;
    const enabling = !user.demoMode;
    const ok = window.confirm(
      enabling
        ? 'Turn on demo mode? This adds sample prospects, pipeline activity, donations, and teammates on top of your current data. You can turn it off anytime.'
        : 'Turn off demo mode? This removes the demo prospects, pipeline, and teammates that were added. Your real data is untouched.'
    );
    if (!ok) return;
    try {
      await api.post(enabling ? '/api/demo/enable' : '/api/demo/disable');
    } catch {
      /* ignore */
    } finally {
      // Full navigation so every page re-fetches its data.
      window.location.assign('/dashboard');
    }
  }

  // Per-org cause view the whole app brands from. MUST be computed BEFORE the
  // early return below so the hook order stays stable on every render (computing
  // it after a conditional return crashed the dashboard in a prior phase).
  const org = useMemo(() => causeView(user?.cause), [user?.cause]);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p>Loading Donor Scout...</p>
      </div>
    );
  }

  const RequireAuth = ({ children }) => (user ? children : <Navigate to="/login" replace />);

  // Post-login nudge: invite real (non-demo) users still in the shared default org
  // to set up their own nonprofit org. Dismissible, and skipping is fine.
  const showOrgNudge =
    user && user.inDefaultOrg && !user.isDemo && localStorage.getItem('orgNudgeDismissed') !== '1';

  return (
    <OrgContext.Provider value={org}>
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      {user && <Header user={user} onLogout={handleLogout} onToggleDemo={handleToggleDemo} />}

      {showOrgNudge && (
        <div className="org-nudge">
          <span>
            Set up your nonprofit organization so your donor data stays private to your team.
          </span>
          <span className="org-nudge__actions">
            <button
              className="btn btn--sm btn--primary"
              onClick={() => navigate('/profile')}
            >
              Set up org
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                localStorage.setItem('orgNudgeDismissed', '1');
                // Force a re-render by updating user reference.
                setUser((u) => ({ ...u }));
              }}
            >
              Later
            </button>
          </span>
        </div>
      )}

      <main className="container" id="main" tabIndex={-1}>
        <Routes>
          <Route
            path="/login"
            element={
              user ? (
                <Navigate to="/dashboard" replace />
              ) : (
                <LoginPage config={config} onDemoLogin={handleDemoLogin} />
              )
            }
          />
          <Route
            path="/today"
            element={
              <RequireAuth>
                <TodayPage user={user} />
              </RequireAuth>
            }
          />
          <Route
            path="/brief"
            element={
              <RequireAuth>
                <BriefPage user={user} />
              </RequireAuth>
            }
          />
          <Route
            path="/grants"
            element={
              <RequireAuth>
                <GrantsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/newsletter"
            element={
              <RequireAuth>
                <NewsletterPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/prospects"
            element={
              <RequireAuth>
                <ProspectsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/campaign"
            element={
              <RequireAuth>
                <CampaignPage />
              </RequireAuth>
            }
          />
          <Route
            path="/pipeline"
            element={
              <RequireAuth>
                <PipelinePage />
              </RequireAuth>
            }
          />
          <Route
            path="/team"
            element={
              <RequireAuth>
                <TeamPage />
              </RequireAuth>
            }
          />
          {/* Org / manager analytics — owner/admin only. AnalyticsPage itself
              redirects members to /dashboard (the API also 403s them). */}
          <Route
            path="/analytics"
            element={
              <RequireAuth>
                <AnalyticsPage user={user} />
              </RequireAuth>
            }
          />
          {/* Public auth-landing pages — reachable whether or not signed in, since
              the link arrives by email. They establish the session, then route in. */}
          <Route path="/auth/magic" element={<MagicConsumePage onSignedIn={handleSignedIn} />} />
          <Route path="/invite" element={<AcceptInvitePage onSignedIn={handleSignedIn} />} />
          <Route path="/impact" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <ProfilePage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
        </Routes>
      </main>

      {user && (
        <footer className="site-footer">
          <span className="flag-stripe" aria-hidden="true" />
          <p>
            Built for <strong>{org.orgName}</strong> · Every referral helps fund a{' '}
            {org.beneficiary} through the {org.programUnit} <Icon name="flag-ua" size={13} />
          </p>
        </footer>
      )}
    </div>
    </OrgContext.Provider>
  );
}
