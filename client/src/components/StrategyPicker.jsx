import { useEffect, useState } from 'react';
import api from '../api';

// Per-user fundraising-strategy picker (the STRATEGY pattern's selection UI).
//
// The strategy decides how a prospect's component sub-scores (Affinity =
// relationship, Propensity = cause fit, Capacity = giving capacity) combine into
// the rank. Relationship-first is preselected and labeled "Recommended" because
// relationship strength predicts a "yes" far better than perceived wealth; the
// other strategies are clearly opt-in. Capacity is always shown to SIZE THE ASK,
// regardless of strategy — so switching never loses the "ask the people who know
// you" coaching.
//
// Selecting a strategy persists it on the user and immediately re-scores ONLY this
// scout's connections (POST /api/profile/strategy → rescoreUserConnections), so the
// Prospects list re-ranks right away.

// Even weights for a fresh custom switch (33/33/33-ish), normalized server-side.
const EVEN = { affinity: 34, propensity: 33, capacity: 33 };

export default function StrategyPicker() {
  const [catalog, setCatalog] = useState([]);
  const [current, setCurrent] = useState('relationship_first');
  const [orgDefault, setOrgDefault] = useState('relationship_first');
  const [weights, setWeights] = useState(EVEN);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/strategies');
        setCatalog(data.strategies || []);
        setCurrent(data.current || 'relationship_first');
        setOrgDefault(data.orgDefault || 'relationship_first');
        if (data.weights) {
          // Stored weights sum to 1; show them as friendly 0..100 slider values.
          setWeights({
            affinity: Math.round((data.weights.affinity || 0) * 100),
            propensity: Math.round((data.weights.propensity || 0) * 100),
            capacity: Math.round((data.weights.capacity || 0) * 100),
          });
        }
      } catch {
        /* leave defaults; picker still renders relationship-first */
      }
    })();
  }, []);

  function flash(setter, text) {
    setter(text);
    setTimeout(() => setter(''), 4000);
  }

  async function choose(key, customWeights) {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const body = { strategy: key };
      if (key === 'custom_weights') body.weights = customWeights || weights;
      const { data } = await api.post('/api/profile/strategy', body);
      setCurrent(data.current);
      flash(setMsg, `Strategy updated. Re-ranked ${data.rescored} prospect${data.rescored === 1 ? '' : 's'}.`);
    } catch (e) {
      flash(setErr, e.response?.data?.error || 'Could not update strategy.');
    } finally {
      setBusy(false);
    }
  }

  function onWeight(axis, value) {
    setWeights((w) => ({ ...w, [axis]: Number(value) }));
  }

  const totalW = weights.affinity + weights.propensity + weights.capacity;

  return (
    <section className="card strategy-card">
      <h2>Ranking strategy</h2>
      <p className="muted">
        Choose how Donor Scout <strong>ranks</strong> your prospects. We recommend{' '}
        <strong>Relationship-first</strong>: a personal relationship predicts a “yes” far better than
        perceived wealth. <strong>Capacity should size the ask, not pick who to ask</strong>, so
        capacity is always shown either way.
      </p>

      <div className="strategy-list">
        {catalog.map((s) => {
          const active = s.key === current;
          return (
            <label key={s.key} className={`strategy-option${active ? ' strategy-option--active' : ''}`}>
              <input
                type="radio"
                name="strategy"
                value={s.key}
                checked={active}
                disabled={busy}
                onChange={() => choose(s.key)}
              />
              <span className="strategy-option__body">
                <span className="strategy-option__title">
                  {s.name}
                  {s.recommended && <span className="badge badge--rec">Recommended</span>}
                  {s.key === orgDefault && !s.recommended && (
                    <span className="badge">Org default</span>
                  )}
                </span>
                <span className="strategy-option__desc muted small">{s.description}</span>
                <span className="strategy-option__ranks muted small">
                  <em>Ranks by:</em> {s.ranksBy}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {current === 'custom_weights' && (
        <div className="strategy-weights">
          <p className="muted small">
            Tune the relative weight of each component. Values are normalized to 100% when saved.
          </p>
          {[
            ['affinity', 'Affinity (relationship)'],
            ['propensity', 'Propensity (cause fit)'],
            ['capacity', 'Capacity (giving capacity)'],
          ].map(([axis, label]) => (
            <label key={axis} className="strategy-weight">
              <span>
                {label}: {totalW > 0 ? Math.round((weights[axis] / totalW) * 100) : 0}%
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={weights[axis]}
                disabled={busy}
                onChange={(e) => onWeight(axis, e.target.value)}
              />
            </label>
          ))}
          <button
            className="btn btn--primary btn--sm"
            disabled={busy || totalW <= 0}
            onClick={() => choose('custom_weights', weights)}
          >
            {busy ? 'Saving…' : 'Apply custom weights'}
          </button>
        </div>
      )}

      {msg && <div className="alert alert--success">{msg}</div>}
      {err && <div className="alert alert--error">{err}</div>}
    </section>
  );
}
