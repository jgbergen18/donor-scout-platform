import { NavLink, Link } from 'react-router-dom';
import Icon from './Icon';
import { useOrg } from '../OrgContext';
import { useSendMode } from '../sendMode';

export default function Header({ user, onLogout, onToggleDemo }) {
  const org = useOrg();
  const send = useSendMode();
  const live = send.mode === 'live';
  const initials = (user?.name || '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="site-header">
      <div className="site-header__inner container">
        <div className="brand">
          <span className="brand__flag" aria-hidden="true">
            <span className="b-blue" />
            <span className="b-yellow" />
          </span>
          <div className="brand__text">
            <span className="brand__org">{org.orgName}</span>
            <span className="brand__app">Donor Scout</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Primary">
          <NavLink to="/today" className={({ isActive }) => (isActive ? 'active' : '')}>
            Today
          </NavLink>
          <NavLink to="/brief" className={({ isActive }) => (isActive ? 'active' : '')}>
            Brief
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'active' : '')}>
            Dashboard
          </NavLink>
          <NavLink to="/prospects" className={({ isActive }) => (isActive ? 'active' : '')}>
            Prospects
          </NavLink>
          <NavLink to="/campaign" className={({ isActive }) => (isActive ? 'active' : '')}>
            Campaign
          </NavLink>
          <NavLink to="/pipeline" className={({ isActive }) => (isActive ? 'active' : '')}>
            Pipeline
          </NavLink>
          <NavLink to="/grants" className={({ isActive }) => (isActive ? 'active' : '')}>
            Grants
          </NavLink>
          <NavLink to="/newsletter" className={({ isActive }) => (isActive ? 'active' : '')}>
            Newsletter
          </NavLink>
          <NavLink to="/team" className={({ isActive }) => (isActive ? 'active' : '')}>
            Team
          </NavLink>
          {/* Org analytics is a manager view — only owners/admins see the link. */}
          {(user?.orgRole === 'owner' || user?.orgRole === 'admin') && (
            <NavLink to="/analytics" className={({ isActive }) => (isActive ? 'active' : '')}>
              Analytics
            </NavLink>
          )}
        </nav>

        <div className="user-box">
          <span
            className={`send-chip ${live ? 'send-chip--live' : 'send-chip--test'}`}
            title={
              live
                ? 'LIVE: emails go to real donors.'
                : `Test mode: every send is redirected to ${send.redirectTo || 'your inbox'}. No donor is emailed.`
            }
          >
            <span className="send-chip__dot" aria-hidden="true" />
            {live ? 'Live' : 'Test mode'}
          </span>
          <button
            type="button"
            className={`btn btn--sm demo-toggle${user?.demoMode ? ' demo-toggle--on' : ''}`}
            onClick={onToggleDemo}
            title={
              user?.demoMode
                ? 'Sample data is on. Click to remove the sample prospects, pipeline, and teammates'
                : 'Add sample prospects, pipeline, reminders, and teammates on top of your data to explore the app'
            }
          >
            <Icon name="sparkles" size={15} /> {user?.demoMode ? 'Sample data on' : 'Sample data'}
          </button>
          <a
            className="btn btn--donate btn--sm"
            href={org.donateUrl}
            target="_blank"
            rel="noreferrer"
            title={`Donate to ${org.orgName}`}
          >
            <Icon name="heart" size={15} /> Donate
          </a>
          <Link to="/profile" className="user-link" title="Your profile">
            <div className="user-box__avatar">
              {user?.profilePicture ? (
                <img src={user.profilePicture} alt={user.name} />
              ) : (
                <span>{initials}</span>
              )}
            </div>
            <div className="user-box__meta">
              <span className="user-box__name">{user?.name}</span>
              {user?.isDemo && <span className="badge badge--demo">Demo</span>}
            </div>
          </Link>
          <button className="btn btn--ghost btn--sm" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>
    </header>
  );
}
