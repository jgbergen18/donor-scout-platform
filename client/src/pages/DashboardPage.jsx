import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { money, percent } from '../api';
import StatCard from '../components/StatCard';
import OnboardingChecklist from '../components/OnboardingChecklist';
import { HelpPanel } from '../components/Help';
import Icon, { stripEmoji } from '../components/Icon';
import { useOrg } from '../OrgContext';

export default function DashboardPage() {
  const org = useOrg();
  const [impact, setImpact] = useState(null);
  const [goalAmount, setGoalAmount] = useState(0);
  const [worklistProspects, setWorklistProspects] = useState([]);
  const [referrals, setReferrals] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();

  async function loadReminders() {
    try {
      const { data } = await api.get('/api/reminders');
      // The queue widget shows what's actionable now: due today + overdue.
      setReminders((data.reminders || []).filter((r) => r.due));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const [{ data: i }, { data: me }, { data: p }, { data: r }] = await Promise.all([
          api.get('/api/impact'),
          api.get('/api/auth/me'),
          api.get('/api/prospects'),
          api.get('/api/referrals'),
        ]);
        setImpact(i);
        setGoalAmount(me.user?.goalAmount || 0);
        setWorklistProspects(p.prospects || []);
        setReferrals(r.referrals || []);
      } catch {
        /* ignore */
      }
    })();
    loadReminders();
  }, []);

  // Complete / snooze a reminder straight from the widget, then refresh the queue.
  async function completeReminder(id) {
    try {
      await api.post(`/api/reminders/${id}/complete`, {});
    } catch {
      /* ignore */
    }
    loadReminders();
  }
  async function snoozeReminder(id) {
    try {
      await api.post(`/api/reminders/${id}/snooze`, { days: 3 });
    } catch {
      /* ignore */
    }
    loadReminders();
  }

  const referredIds = useMemo(() => new Set(referrals.map((r) => r.connection_id)), [referrals]);
  const prospectById = useMemo(() => new Map(worklistProspects.map((p) => [p.id, p])), [worklistProspects]);
  const topAsks = useMemo(
    () => worklistProspects.filter((p) => !referredIds.has(p.id)).slice(0, 5),
    [worklistProspects, referredIds]
  );

  // Active pipeline = people you're working (not donated, not declined).
  const activePipeline = useMemo(
    () => referrals.filter((r) => !r.donation_received && r.status !== 'declined'),
    [referrals]
  );
  const usePipeline = activePipeline.length > 0;

  // The reminders queue (due today + overdue) drives the right-hand widget. We also
  // use the set of referral ids with a due reminder to keep the focus list distinct.
  const dueReferralIds = useMemo(
    () => new Set(reminders.map((r) => r.referral_id)),
    [reminders]
  );

  // The focus list: your active pipeline people (excluding the ones with a due
  // reminder, which get their own column), or — if your pipeline is empty —
  // suggested prospects.
  const focusItems = useMemo(() => {
    if (usePipeline) {
      return activePipeline
        .filter((r) => !dueReferralIds.has(r.id))
        .sort(
          (a, b) =>
            (a.follow_up_date || '9999').localeCompare(b.follow_up_date || '9999') ||
            (b.referred_at || '').localeCompare(a.referred_at || '')
        )
        .slice(0, 5)
        .map((r) => ({
          key: `r${r.id}`,
          score: prospectById.get(r.connection_id)?.donor_likelihood_score ?? '·',
          name: r.contact_name,
          sub: `${r.company || 'n/a'} · ${(r.status || '').replace('_', ' ')}${
            r.follow_up_date ? ` · follow up ${r.follow_up_date}` : ''
          }`,
          label: 'Open',
          onOpen: () => navigate('/pipeline'),
        }));
    }
    return topAsks.map((p) => ({
      key: `p${p.id}`,
      score: p.donor_likelihood_score,
      name: p.contact_name,
      sub: `${p.company || 'n/a'}${
        p.score_reasons?.length ? ` · ${p.score_reasons.slice(0, 2).map(stripEmoji).join(' · ')}` : ''
      }`,
      label: 'Reach out',
      onOpen: () => navigate('/prospects', { state: { focusId: p.id } }),
    }));
  }, [usePipeline, activePipeline, dueReferralIds, topAsks, prospectById, navigate]);

  // Donors whose gift has landed but who haven't been thanked yet — the
  // stewardship prompt. Marking thanked here clears them from the list.
  const awaitingThanks = useMemo(
    () => referrals.filter((r) => r.donation_received && !r.thanked_at),
    [referrals]
  );
  async function markThanked(id) {
    try {
      const { data } = await api.post(`/api/referrals/${id}/thanked`, {});
      setReferrals((rs) => rs.map((r) => (r.id === id ? data.referral : r)));
    } catch {
      /* ignore */
    }
  }

  const hasWorklist = worklistProspects.length > 0 || referrals.length > 0;

  const analytics = useMemo(() => {
    const byId = new Map(worklistProspects.map((p) => [p.id, p]));
    const SEGS = [
      { key: 'family', label: 'Family', m: (r) => /family/i.test(r) },
      { key: 'school', label: 'School', m: (r) => /school/i.test(r) },
      { key: 'coworker', label: 'Coworker', m: (r) => /coworker/i.test(r) },
      { key: 'reachable', label: 'Reachable', m: (r) => /reachable/i.test(r) },
      { key: 'ukraine', label: 'Ukraine ties', m: (r) => /ukraine/i.test(r) },
    ];
    const segs = SEGS.map((s) => {
      let referred = 0;
      let donated = 0;
      for (const ref of referrals) {
        const reasons = byId.get(ref.connection_id)?.score_reasons || [];
        if (reasons.some(s.m)) {
          referred++;
          if (ref.donation_received) donated++;
        }
      }
      return { ...s, referred, donated, rate: referred ? donated / referred : 0 };
    }).filter((s) => s.referred > 0);
    return {
      prospects: worklistProspects.length,
      referred: referrals.length,
      donated: referrals.filter((r) => r.donation_received).length,
      segs,
    };
  }, [worklistProspects, referrals]);

  const costBootcamp = impact?.costPerBootcamp || 800;
  const costDay = impact?.costPerDay || 57.14;

  return (
    <div className="page">
      <div className="page__head">
        <h1>Dashboard</h1>
        <p className="page__sub">Your campaign at a glance.</p>
      </div>

      <OnboardingChecklist />

      {goalAmount > 0 && impact && (
        <section className="card goal-card">
          <div className="goal-card__top">
            <h2>Campaign goal</h2>
            <span className="goal-card__nums">
              {money(impact.totalRaised)} <span className="muted">of {money(goalAmount)}</span>
            </span>
          </div>
          <div className="progress">
            <div
              className="progress__bar"
              style={{ width: `${Math.min(100, goalAmount ? (impact.totalRaised / goalAmount) * 100 : 0)}%` }}
            />
          </div>
          <p className="muted small">
            {Math.round(goalAmount ? (impact.totalRaised / goalAmount) * 100 : 0)}% · {impact.studentsFunded}{' '}
            {org.beneficiaries} funded · {impact.daysFunded} {org.daysFundedLower}
          </p>
        </section>
      )}

      <section className="stat-grid">
        <StatCard label="Total raised" value={money(impact?.totalRaised || 0)} icon="dollar" accent />
        <StatCard
          label={org.beneficiariesFunded}
          value={impact?.studentsFunded ?? 'n/a'}
          sub={`${money(costBootcamp)} = 1 ${org.programUnit}`}
          icon="cap"
        />
        <StatCard
          label={org.daysFunded}
          value={impact?.daysFunded ?? 'n/a'}
          sub={`${money(costDay)} = 1 ${org.dayUnit}`}
          icon="calendar"
        />
        <StatCard
          label="Conversion rate"
          value={impact ? percent(impact.conversionRate) : 'n/a'}
          sub={impact ? `${impact.referralsConverted}/${impact.totalReferrals} referrals donated` : ''}
          icon="trend"
        />
      </section>

      {awaitingThanks.length > 0 && (
        <section className="card thanks-prompt">
          <div className="thanks-prompt__head">
            <h2>
              <Icon name="heart" size={16} /> Thank your donors
            </h2>
            <span className="muted small">
              {awaitingThanks.length} {awaitingThanks.length === 1 ? 'donor' : 'donors'} awaiting a thank-you. Closing the
              loop helps repeat giving.
            </span>
          </div>
          <ul className="thanks-prompt__list">
            {awaitingThanks.slice(0, 5).map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.contact_name}</strong>{' '}
                  <span className="muted small">{money(r.donation_amount)}</span>
                </div>
                <div className="thanks-prompt__actions">
                  <button className="btn btn--sm btn--donate" onClick={() => navigate('/pipeline')}>
                    Thank
                  </button>
                  <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => markThanked(r.id)}>
                    Mark thanked
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasWorklist ? (
        <section className="card worklist">
          <h2>Today’s focus</h2>
          <div className="worklist__grid">
            <div className="worklist__col">
              <h3>{usePipeline ? 'In your pipeline' : 'Top prospects to reach out to'}</h3>
              {focusItems.length === 0 ? (
                <p className="muted small">
                  {usePipeline
                    ? 'All caught up. Check your reminders.'
                    : 'You’ve reached out to all your prospects.'}
                </p>
              ) : (
                <ul className="worklist__list">
                  {focusItems.map((it) => (
                    <li key={it.key}>
                      <div className="worklist__who">
                        <span className="worklist__score">{it.score}</span>
                        <div>
                          <strong>{it.name}</strong>
                          <div className="muted small">{it.sub}</div>
                        </div>
                      </div>
                      <button className="btn btn--sm btn--primary" onClick={it.onOpen}>
                        {it.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="worklist__col">
              <h3>Reminders due</h3>
              {reminders.length === 0 ? (
                <p className="muted small">Nothing due. You’re all caught up.</p>
              ) : (
                <ul className="worklist__list">
                  {reminders.map((r) => (
                    <li key={r.id}>
                      <div className="worklist__who">
                        <div>
                          <strong>{r.contact_name}</strong>
                          <div className={`small ${r.overdue ? 'reminder--overdue' : 'muted'}`}>
                            {r.overdue ? 'overdue · ' : 'due '}
                            {r.due_date} · step {r.step_index + 1}
                          </div>
                        </div>
                      </div>
                      <div className="reminder-actions">
                        <button
                          className="btn btn--sm btn--primary"
                          title="Mark done and advance the cadence"
                          onClick={() => completeReminder(r.id)}
                        >
                          Done
                        </button>
                        <button
                          className="btn btn--sm btn--ghost btn--on-light"
                          title="Remind me in 3 days"
                          onClick={() => snoozeReminder(r.id)}
                        >
                          Snooze
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="card onboard">
          <h2>Let’s get your campaign started</h2>
          <p className="muted">
            Head to your profile to set your details and import your LinkedIn connections, and this
            dashboard fills up with your best prospects and follow-ups. Want to explore first? You can also
            load sample data there.
          </p>
          <Link className="btn btn--primary" to="/profile">
            Set up your profile →
          </Link>
        </section>
      )}

      {referrals.length > 0 && (
        <section className="card">
          <h2>What’s converting</h2>
          <div className="funnel">
            <div className="funnel__step">
              <span className="funnel__n">{analytics.prospects}</span>
              <span className="funnel__l">Prospects</span>
            </div>
            <Icon name="arrowRight" size={18} className="funnel__arrow" />
            <div className="funnel__step">
              <span className="funnel__n">{analytics.referred}</span>
              <span className="funnel__l">Asked</span>
            </div>
            <Icon name="arrowRight" size={18} className="funnel__arrow" />
            <div className="funnel__step">
              <span className="funnel__n">{analytics.donated}</span>
              <span className="funnel__l">Donated</span>
            </div>
          </div>
          {analytics.segs.length > 0 ? (
            <div className="conv-list">
              {analytics.segs.map((s) => (
                <div className="conv-row" key={s.key}>
                  <span className="conv-row__label">{s.label}</span>
                  <div className="conv-row__bar">
                    <div className="conv-row__fill" style={{ width: `${Math.round(s.rate * 100)}%` }} />
                  </div>
                  <span className="conv-row__pct">
                    {Math.round(s.rate * 100)}% <span className="muted">({s.donated}/{s.referred})</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">
              Record some donations to see which connection types convert best.
            </p>
          )}
        </section>
      )}

      {impact && (
        <section className="card explainer">
          <h2>How impact is calculated</h2>
          <div className="explainer__row">
            <div className="explainer__item">
              <span className="explainer__big">{money(costBootcamp)}</span>
              <span>
                funds <strong>1 {org.beneficiary}</strong> through a full {impact.bootcampDays}-day{' '}
                {org.programUnit}
              </span>
            </div>
            <div className="explainer__item">
              <span className="explainer__big">{money(costDay)}</span>
              <span>
                funds <strong>1 {org.dayUnit}</strong>
              </span>
            </div>
          </div>
        </section>
      )}

      <HelpPanel />

      <section className="card donate-card">
        <div className="donate-card__head">
          <div>
            <h2>Donate to {org.orgName}</h2>
            <p className="muted">
              Donations are processed securely on <strong>Zeffy</strong>. 100% goes to the
              mission. When a prospect you referred gives, record it on the <Link to="/pipeline">Pipeline</Link>{' '}
              to grow your tracked impact.
            </p>
          </div>
          <div className="donate-card__actions">
            <button className="btn btn--donate" onClick={() => setShowForm((s) => !s)}>
              {showForm ? 'Hide form' : (<><Icon name="heart" size={15} /> Donate here</>)}
            </button>
            <a className="btn btn--ghost btn--on-light" href={org.donateUrl} target="_blank" rel="noreferrer">
              Open in new tab ↗
            </a>
          </div>
        </div>
        {showForm &&
          (org.embedUrl ? (
            <div className="zeffy-embed">
              <iframe
                title="Donation form powered by Zeffy"
                className="zeffy-iframe"
                src={org.embedUrl}
                allow="payment"
              />
            </div>
          ) : (
            // Non-Zeffy donation link: never embed an arbitrary page in a payment
            // iframe — send people to the provider's own page instead.
            <p className="muted small">
              Your donation form opens on your provider’s secure site:{' '}
              <a href={org.donateUrl} target="_blank" rel="noreferrer">
                open the donation page ↗
              </a>
              .
            </p>
          ))}
      </section>
    </div>
  );
}
