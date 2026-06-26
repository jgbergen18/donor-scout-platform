import { useEffect, useState } from 'react';
import api, { money, percent } from '../api';
import StatCard from '../components/StatCard';
import { useOrg } from '../OrgContext';

export default function TeamPage() {
  const org = useOrg();
  const [data, setData] = useState(null); // { teams, team, aggregate, leaderboard }
  const [loading, setLoading] = useState(true);
  const [showForms, setShowForms] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createGoal, setCreateGoal] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editGoal, setEditGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/api/team');
      setData(data);
      setShowForms((data.teams || []).length === 0);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function call(method, url, body, onErr, after) {
    setBusy(true);
    setError('');
    try {
      const { data } = await api[method](url, body);
      setData(data);
      after?.(data);
      return true;
    } catch (err) {
      setError(err.response?.data?.error || onErr);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const createTeam = (e) => {
    e.preventDefault();
    call('post', '/api/team', { name: createName, goalAmount: Number(createGoal) || 0 }, 'Could not create team.', () => {
      setCreateName('');
      setCreateGoal('');
      setShowForms(false);
    });
  };
  const joinTeam = (e) => {
    e.preventDefault();
    call('post', '/api/team/join', { code }, 'Could not join team.', () => {
      setCode('');
      setShowForms(false);
    });
  };
  const switchTeam = (id) => call('post', '/api/team/switch', { teamId: id }, 'Could not switch team.');
  const startEdit = () => {
    setEditName(data.team.name);
    setEditGoal(data.team.goalAmount ? String(data.team.goalAmount) : '');
    setEditing(true);
  };
  const saveSettings = async (e) => {
    e.preventDefault();
    const ok = await call('patch', '/api/team', { name: editName, goalAmount: Number(editGoal) || 0 }, 'Could not save.');
    if (ok) setEditing(false);
  };
  async function leaveTeam() {
    if (!window.confirm('Leave this team? Your own prospects and donations stay with you.')) return;
    await call('post', '/api/team/leave', {}, 'Could not leave.');
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(data.team.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="empty">Loading team…</div>
      </div>
    );
  }

  const teams = data?.teams || [];
  const team = data?.team || null;
  const pct = team?.goalAmount ? Math.min(100, (data.aggregate.raised / team.goalAmount) * 100) : 0;
  // Per-org economics (from the API) drive the impact labels; fall back to the
  // static cause config if an older payload doesn't include them.
  const econ = data?.economics || {};
  const costPerBootcamp = econ.costPerBootcamp ?? org.programCost;
  const costPerDay = econ.costPerDay ?? org.dayCost;
  const orgName = econ.orgName || org.orgName;

  return (
    <div className="page">
      <div className="page__head">
        <h1>{team ? team.name : 'Team'}</h1>
        <p className="page__sub">
          {team
            ? `${team.memberCount} scout${team.memberCount === 1 ? '' : 's'} · competing for ${orgName}`
            : 'Run the campaign together and compete on the leaderboard.'}
        </p>
      </div>

      {teams.length > 0 && (
        <div className="team-switcher">
          {teams.map((t) => (
            <button
              key={t.id}
              className={`chip${t.isActive ? ' chip--active' : ''}`}
              onClick={() => !t.isActive && switchTeam(t.id)}
              disabled={busy}
            >
              {t.name}
            </button>
          ))}
          <button className="chip team-switcher__add" onClick={() => setShowForms((s) => !s)}>
            + New / join
          </button>
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}

      {(showForms || teams.length === 0) && (
        <div className="team-setup">
          <section className="card">
            <h2>Create a team</h2>
            <p className="muted small">Start a team and share the invite code with other volunteers.</p>
            <form onSubmit={createTeam} className="team-form">
              <label className="field">
                <span>Team name</span>
                <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="e.g. Code for Ukraine 2027" />
              </label>
              <label className="field">
                <span>Team goal ($)</span>
                <input type="number" min="0" step="100" value={createGoal} onChange={(e) => setCreateGoal(e.target.value)} placeholder="e.g. 50000" />
              </label>
              <button className="btn btn--primary" disabled={busy || !createName.trim()}>
                Create team
              </button>
            </form>
          </section>
          <section className="card">
            <h2>Join a team</h2>
            <p className="muted small">Got an invite code from a teammate? Enter it here.</p>
            <form onSubmit={joinTeam} className="team-form team-form--row">
              <input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
              <button className="btn btn--primary" disabled={busy || !code.trim()}>
                Join
              </button>
            </form>
          </section>
        </div>
      )}

      {team && (
        <>
          {team.goalAmount > 0 && (
            <section className="card goal-card">
              <div className="goal-card__top">
                <h2>Team goal</h2>
                <span className="goal-card__nums">
                  {money(data.aggregate.raised)} <span className="muted">of {money(team.goalAmount)}</span>
                </span>
              </div>
              <div className="progress">
                <div className="progress__bar" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">
                {Math.round(pct)}% · {data.aggregate.studentsFunded} {org.beneficiaries} funded ·{' '}
                {data.aggregate.donations} donations across the team
              </p>
            </section>
          )}

          <section className="stat-grid">
            <StatCard label="Total raised" value={money(data.aggregate.raised)} icon="dollar" accent />
            <StatCard label={org.beneficiariesFunded} value={data.aggregate.studentsFunded} sub={`${money(costPerBootcamp)} = 1 ${org.programUnit}`} icon="cap" />
            <StatCard label={org.daysFunded} value={data.aggregate.daysFunded} sub={`${money(costPerDay)} = 1 ${org.dayUnit}`} icon="calendar" />
            <StatCard
              label="Conversion rate"
              value={percent(data.aggregate.conversionRate)}
              sub={`${data.aggregate.donations}/${data.aggregate.totalReferrals} referrals donated`}
              icon="trend"
            />
          </section>

          <section className="card">
            <div className="team-invite">
              <div>
                <h2>Invite teammates</h2>
                <p className="muted small">
                  Share this code. They join from their own Team page, import their own connections, and start
                  competing.
                </p>
              </div>
              <div className="invite-code">
                <span className="invite-code__code">{team.inviteCode}</span>
                <button className="btn btn--sm btn--on-light" onClick={copyCode}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Leaderboard</h2>
            <p className="muted small">
              Ranked by donations raised. Record donations on the Pipeline (or sync from Zeffy) to climb.
            </p>
            <div className="table-wrap">
              <table className="table leaderboard">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Scout</th>
                    <th>Raised</th>
                    <th>Donations</th>
                    <th>Students</th>
                  </tr>
                </thead>
                <tbody>
                  {data.leaderboard.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted small">
                        No teammates yet. Share your invite code to get the leaderboard going.
                      </td>
                    </tr>
                  )}
                  {data.leaderboard.map((m) => (
                    <tr key={m.id} className={m.isYou ? 'row--you' : ''}>
                      <td data-label="#">
                        <span className={`rank rank--${m.rank <= 3 ? m.rank : 'n'}`}>{m.rank}</span>
                      </td>
                      <td data-label="Scout">
                        <strong>{m.name}</strong>
                        {m.isYou && <span className="badge badge--demo leaderboard__you">You</span>}
                      </td>
                      <td data-label="Raised">{money(m.raised)}</td>
                      <td data-label="Donations">{m.donations}</td>
                      <td data-label="Students">{m.students}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {team.isOwner && (
            <section className="card">
              <div className="team-invite">
                <div>
                  <h2>Team settings</h2>
                  <p className="muted small">Owner only. Rename the team or adjust the shared goal.</p>
                </div>
                {!editing && (
                  <button className="btn btn--sm btn--on-light" onClick={startEdit}>
                    Edit
                  </button>
                )}
              </div>
              {editing && (
                <form onSubmit={saveSettings} className="team-form">
                  <label className="field">
                    <span>Team name</span>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Team goal ($)</span>
                    <input type="number" min="0" step="100" value={editGoal} onChange={(e) => setEditGoal(e.target.value)} />
                  </label>
                  <div className="upload-card__actions">
                    <button className="btn btn--ghost btn--on-light" type="button" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                    <button className="btn btn--primary" disabled={busy}>
                      Save
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          <button className="btn btn--danger-text" onClick={leaveTeam} disabled={busy}>
            Leave “{team.name}”
          </button>
        </>
      )}
    </div>
  );
}
