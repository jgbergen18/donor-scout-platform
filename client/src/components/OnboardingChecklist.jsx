import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Icon from './Icon';

// First-run onboarding checklist. Every step's DONE state is DERIVED on the server
// from the scout's real data (GET /api/onboarding) — the user never self-marks a
// step. The widget auto-hides once the checklist is complete or the scout dismisses
// it (POST /api/onboarding/dismiss persists the flag). Reuses the .card / .progress
// / .badge / .btn patterns already in the app.
export default function OnboardingChecklist() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/onboarding');
        setData(data);
      } catch {
        /* ignore — the dashboard still renders without the checklist */
      }
    })();
  }, []);

  async function dismiss() {
    setData((d) => (d ? { ...d, dismissed: true } : d));
    try {
      await api.post('/api/onboarding/dismiss', {});
    } catch {
      /* the optimistic hide is enough; the flag retries on next load */
    }
  }

  // Hidden once dismissed or fully complete (nothing left to guide).
  if (!data || data.dismissed || data.complete) return null;

  const pct = data.totalSteps ? Math.round((data.completedSteps / data.totalSteps) * 100) : 0;

  return (
    <section className="card onboarding">
      <div className="onboarding__head">
        <div>
          <h2>Get started with Donor Scout</h2>
          <p className="muted small">
            {data.completedSteps} of {data.totalSteps} done. Finish setup to fill your dashboard
            with your best prospects.
          </p>
        </div>
        <button className="btn btn--sm btn--on-light" onClick={dismiss} title="Hide this checklist">
          Dismiss
        </button>
      </div>

      <div className="progress">
        <div className="progress__bar" style={{ width: `${pct}%` }} />
      </div>

      <ul className="onboarding__list">
        {data.steps.map((s) => (
          <li key={s.key} className={`onboarding__item${s.done ? ' onboarding__item--done' : ''}`}>
            <span className={`onboarding__check${s.done ? ' onboarding__check--done' : ''}`}>
              {s.done && <Icon name="check" size={14} />}
            </span>
            <div className="onboarding__body">
              <span className="onboarding__title">
                {s.title}
                {s.optional && <span className="badge">Optional</span>}
              </span>
              <span className="muted small">{s.description}</span>
            </div>
            {!s.done && (
              <button
                className="btn btn--sm btn--primary onboarding__cta"
                onClick={() => navigate(s.href)}
              >
                {s.cta}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
