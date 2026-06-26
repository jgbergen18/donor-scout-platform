import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { money } from '../api';
import Icon from '../components/Icon';
import { HelpTip } from '../components/Help';

// The Morning Brief — L2's payoff. Overnight, the Standing Planner re-sequenced the
// portfolio and pre-staged today's moves; the human opens to finished work to
// AUTHORIZE, not a list to start. Auto-approved moves are already QUEUED in the
// pipeline (nothing was sent — you send each by hand); net-new asks wait for a glance.
export default function BriefPage({ user }) {
  const [data, setData] = useState(null);
  const role = user?.orgRole || 'member'; // from App (no extra /api/auth/me round-trip)
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(() => new Set());

  async function load() {
    setLoading(true);
    try {
      const brief = await api.get('/api/brief').then((r) => r.data);
      setData(brief);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const isAdmin = role === 'owner' || role === 'admin';
  async function planNow() {
    setRunning(true);
    try {
      const r = await api.post('/api/brief/run').then((x) => x.data);
      if (r.enabled === false) alert('AI is off, so nightly planning is unavailable. Add an API key to enable it.');
      await load();
    } finally {
      setRunning(false);
    }
  }
  const resolve = (id, p) => p.then(() => setDone((s) => new Set(s).add(id))).catch(() => {});

  if (loading) {
    return (
      <div className="page">
        <div className="page__head"><h1>Morning Brief</h1></div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const autoApproved = (data?.autoApproved || []).filter((m) => !done.has(m.id));
  const needsReview = (data?.needsReview || []).filter((m) => !done.has(m.id));
  const empty = autoApproved.length === 0 && needsReview.length === 0;

  return (
    <div className="page">
      <div className="page__head">
        <h1>Morning Brief</h1>
        <p className="page__sub">
          What the planner staged for you{data?.date ? ` (${data.date})` : ''}.{' '}
          Approved moves are queued in your pipeline, ready to review and send.
        </p>
      </div>

      {isAdmin && (
        <div className="brief-actions">
          <button className="btn btn--sm btn--ghost" onClick={planNow} disabled={running}>
            <Icon name="refresh" size={13} /> {running ? 'Planning…' : 'Plan today’s moves now'}
          </button>
          {data?.autonomy && (
            <span className="muted small">
              Auto-approve is {data.autonomy.autoApproveMoves ? 'ON' : 'off'} ·{' '}
              <Link to="/org">change</Link>
            </span>
          )}
        </div>
      )}

      {empty ? (
        <section className="card empty">
          <Icon name="check" size={28} />
          <h3>Nothing staged yet</h3>
          <p className="muted">
            The planner runs overnight for active campaigns.{' '}
            {isAdmin ? 'Use “Plan today’s moves now” to populate it, or ' : 'Ask an admin to run it, or '}
            <Link to="/campaign">set up a campaign</Link>.
          </p>
        </section>
      ) : (
        <>
          {needsReview.length > 0 && (
            <section className="today-group">
              <h2>Needs your decision <span className="today-count">{needsReview.length}</span></h2>
              <p className="muted small today-group__hint">Net-new asks. A quick yes/no before they join your pipeline.</p>
              {needsReview.map((m) => (
                <div className="card today-card" key={m.id}>
                  <div className="today-card__main">
                    <span className="today-card__name">{m.contactName || 'A contact'}</span>
                    {m.suggestedAsk > 0 && <span className="tag tag--ok">{money(m.suggestedAsk)}</span>}
                    <span className="tag tag--muted">{m.kind}</span>
                    {m.rationale && <span className="muted small">{m.rationale}</span>}
                  </div>
                  <div className="today-card__actions">
                    <button className="btn btn--sm btn--ghost" onClick={() => resolve(m.id, api.patch(`/api/actions/${m.id}`, { status: 'skipped' }))}>Skip</button>
                    <button className="btn btn--sm btn--primary" onClick={() => resolve(m.id, api.post(`/api/actions/${m.id}/approve`))}>
                      <Icon name="plus" size={13} /> Approve
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {autoApproved.length > 0 && (
            <section className="today-group">
              <h2>
                Queued for you <span className="today-count">{autoApproved.length}</span>{' '}
                <HelpTip label="What does “queued” mean?">
                  The planner auto-approved these routine moves and added them to your pipeline as <strong>to-ask</strong>.
                  “Approved” only <strong>stages</strong> a draft in your pipeline. You review each one and send it
                  when you're ready. An admin can turn auto-approve off under Settings.
                </HelpTip>
              </h2>
              <p className="muted small today-group__hint">Auto-approved routine moves, already in your pipeline. Open to draft &amp; send each one yourself.</p>
              {autoApproved.map((m) => (
                <div className="card today-card" key={m.id}>
                  <div className="today-card__main">
                    <span className="today-card__name">{m.contactName || 'A contact'}</span>
                    {m.suggestedAsk > 0 && <span className="tag tag--ok">{money(m.suggestedAsk)}</span>}
                    <span className="tag tag--muted">{m.kind}</span>
                    {m.rationale && <span className="muted small">{m.rationale}</span>}
                  </div>
                  <div className="today-card__actions">
                    <Link className="btn btn--sm btn--primary" to="/pipeline">Open to send</Link>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
