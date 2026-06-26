import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import api, { money, percent } from '../api';
import StatCard from '../components/StatCard';
import { useOrg } from '../OrgContext';

// Manager / org analytics: a whole-org rollup ACROSS every scout, distinct from
// the per-scout Dashboard. Owner/admin only — members are redirected away (the
// server also 403s the endpoint, so this is defense-in-depth, not the gate).
export default function AnalyticsPage({ user }) {
  const org = useOrg();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isManager = user && (user.orgRole === 'owner' || user.orgRole === 'admin');

  useEffect(() => {
    if (!isManager) return;
    (async () => {
      try {
        const { data } = await api.get('/api/orgs/analytics');
        setData(data);
      } catch (err) {
        setError(err.response?.data?.error || 'Could not load analytics.');
      } finally {
        setLoading(false);
      }
    })();
  }, [isManager]);

  // Members never see this view — send them to their own dashboard.
  if (user && !isManager) return <Navigate to="/dashboard" replace />;

  if (loading) {
    return (
      <div className="page">
        <div className="empty">Loading org analytics…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { funnel, totals, segments, scouts, economics } = data;
  const orgName = economics?.orgName || org.orgName;
  const beneficiaries = economics?.beneficiaries || org.beneficiaries;

  // Ordered funnel stages for the bar chart (declined sits outside the linear flow
  // but is worth surfacing). Widths are relative to the largest stage count.
  const flow = [
    { key: 'to_ask', label: 'To ask' },
    { key: 'asked', label: 'Asked' },
    { key: 'following_up', label: 'Following up' },
    { key: 'donated', label: 'Donated' },
    { key: 'declined', label: 'Declined' },
  ];
  const maxCount = Math.max(1, ...flow.map((s) => funnel.counts[s.key] || 0));

  return (
    <div className="page">
      <div className="page__head">
        <h1>Org analytics</h1>
        <p className="page__sub">
          Whole-org performance across every scout for {orgName}. Owner / admin only.
        </p>
      </div>

      <section className="stat-grid">
        <StatCard label="Total raised" value={money(totals.raised)} icon="dollar" accent />
        <StatCard
          label={org.beneficiariesFunded}
          value={totals.beneficiariesFunded}
          sub={`${money(economics.costPerBootcamp)} = 1 ${org.programUnit}`}
          icon="cap"
        />
        <StatCard label="Active scouts" value={totals.activeScouts} sub={`${scouts.length} on the team`} icon="users" />
        <StatCard
          label="Conversion rate"
          value={percent(totals.conversionRate)}
          sub={`${totals.donations}/${totals.asks} asks donated`}
          icon="trend"
        />
      </section>

      <section className="card">
        <h2>Pipeline funnel</h2>
        <p className="muted small">
          Where every prospect sits org-wide, and how the org converts stage to stage.
        </p>
        <div className="funnel">
          {flow.map((s) => {
            const n = funnel.counts[s.key] || 0;
            return (
              <div key={s.key} className="funnel__row">
                <span className="funnel__label">{s.label}</span>
                <div className="funnel__track">
                  <div
                    className={`funnel__bar funnel__bar--${s.key}`}
                    style={{ width: `${(n / maxCount) * 100}%` }}
                  />
                </div>
                <span className="funnel__count">{n}</span>
              </div>
            );
          })}
        </div>
        <div className="funnel__rates">
          <span>Asked of queued: <strong>{percent(funnel.conversion.to_ask_to_asked)}</strong></span>
          <span>Following up of asked: <strong>{percent(funnel.conversion.asked_to_following_up)}</strong></span>
          <span>Donated of engaged: <strong>{percent(funnel.conversion.following_up_to_donated)}</strong></span>
          <span>Overall (donations/asks): <strong>{percent(funnel.conversion.overall)}</strong></span>
        </div>
      </section>

      <section className="card">
        <h2>Conversion by segment</h2>
        <p className="muted small">
          Which relationship &amp; cause segments (from connection signals) convert best across the org.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Segment</th>
                <th>Asks</th>
                <th>Donations</th>
                <th>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {segments.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted small">
                    No segmented pipeline yet. Segments appear once scouts ask connections with relationship signals.
                  </td>
                </tr>
              )}
              {segments.map((s) => (
                <tr key={s.segment}>
                  <td data-label="Segment">{s.segment}</td>
                  <td data-label="Asks">{s.asks}</td>
                  <td data-label="Donations">{s.donations}</td>
                  <td data-label="Conversion">{percent(s.conversionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Per-scout breakdown</h2>
        <p className="muted small">Every scout&apos;s asks, donations, raised, and conversion.</p>
        <div className="table-wrap">
          <table className="table leaderboard">
            <thead>
              <tr>
                <th>Scout</th>
                <th>Role</th>
                <th>Asks</th>
                <th>Donations</th>
                <th>Raised</th>
                <th>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {scouts.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted small">
                    No scouts yet.
                  </td>
                </tr>
              )}
              {scouts.map((s) => (
                <tr key={s.id} className={s.id === user.id ? 'row--you' : ''}>
                  <td data-label="Scout">
                    <strong>{s.name}</strong>
                    {s.id === user.id && <span className="badge badge--demo leaderboard__you">You</span>}
                  </td>
                  <td data-label="Role">{s.role}</td>
                  <td data-label="Asks">{s.asks}</td>
                  <td data-label="Donations">{s.donations}</td>
                  <td data-label="Raised">{money(s.raised)}</td>
                  <td data-label="Conversion">{percent(s.conversionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
