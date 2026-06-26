import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { money } from '../api';
import Icon from '../components/Icon';
import { useOrg } from '../OrgContext';
import { useSendMode } from '../sendMode';
import { buildOutreachMessage, buildThankYouMessage, buildMatchGiftMessage } from '../outreach';

// "Tonight's 15 Minutes" — one ranked queue of the next few high-leverage actions,
// assembled from /api/today (due follow-ups, donors to thank, top un-asked prospects,
// and donors at matching-gift employers). Every action is a local write or a clipboard
// a clipboard copy, or a send the volunteer reviews first.
export default function TodayPage({ user }) {
  const org = useOrg();
  const sendMode = useSendMode();
  const scoutName = user?.name || ''; // from App (no extra /api/auth/me round-trip)
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);
  const [done, setDone] = useState(() => new Set()); // card keys resolved this session
  const [redrafts, setRedrafts] = useState({}); // referralId -> { text, aiOff, failed } (second-gift drafts)
  const [rebusy, setReBusy] = useState(null); // referralId currently drafting
  const [sending, setSending] = useState(null); // referralId currently sending
  const [notice, setNotice] = useState(''); // transient send confirmation

  async function load() {
    setLoading(true);
    try {
      // The BRIEF endpoint = the same queue, run through the daily triage pass
      // (suppress relationship-damaging items, surface forks). Degrades to the raw
      // queue when AI is off — same shape either way.
      const today = await api
        .get('/api/today/brief')
        .then((r) => r.data)
        .catch(() => api.get('/api/today').then((r) => r.data));
      setData(today);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const remove = (key) => setDone((s) => new Set(s).add(key));
  async function copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }
  // Each action optimistically removes its card so the queue visibly shrinks.
  const act = (key, p) => p.then(() => remove(key)).catch(() => {});

  // Lazily draft the in-voice second-gift re-ask (one call, on open). Falls back to the
  // editable static template the server returns when AI is off. Never sends.
  async function draftReask(id) {
    setReBusy(id);
    try {
      const { data } = await api.post(`/api/referrals/${id}/reconnect-draft`);
      setRedrafts((d) => ({ ...d, [id]: { text: data.draft || '', aiOff: false, failed: false } }));
    } catch (err) {
      const fb = err.response?.data?.fallback;
      setRedrafts((d) => ({ ...d, [id]: { text: fb || '', aiOff: err.response?.status === 503, failed: !fb } }));
    } finally {
      setReBusy(null);
    }
  }

  // Actually send the (edited) re-ask. Routes through the server's outbound chokepoint,
  // which in demo redirects every donor send to your own inbox.
  async function sendReask(id, text) {
    if (!text || !text.trim()) return;
    if (sendMode.mode === 'live' && !window.confirm('Live mode: this will email the donor directly. Continue?')) return;
    setSending(id);
    try {
      const { data } = await api.post(`/api/referrals/${id}/reconnect-send`, { text });
      const s = data.send || {};
      setNotice(s.redirected ? `Sent to your demo inbox (production would send to ${s.intended}).` : `Sent to ${s.to || 'the donor'}.`);
      setTimeout(() => setNotice(''), 6000);
      remove(`2nd-${id}`);
    } catch (err) {
      setNotice(err.response?.data?.error || 'Could not send. Check the mail setup.');
      setTimeout(() => setNotice(''), 6000);
    } finally {
      setSending(null);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="page__head"><h1>Today</h1></div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const reminders = (data?.reminders || []).filter((r) => !done.has(`rem-${r.id}`));
  const unthanked = (data?.unthanked || []).filter((r) => !done.has(`thk-${r.id}`));
  const prospects = (data?.prospects || []).filter((p) => !done.has(`pro-${p.id}`));
  const matchGifts = (data?.matchGifts || []).filter((r) => !done.has(`mat-${r.id}`));
  const secondGifts = (data?.secondGifts || []).filter((r) => !done.has(`2nd-${r.id}`));
  const total = reminders.length + unthanked.length + prospects.length + matchGifts.length + secondGifts.length;

  return (
    <div className="page">
      <div className="page__head">
        <h1>Today</h1>
        <p className="page__sub">
          Your next few actions, about 15 minutes. Review each draft, then send.
        </p>
      </div>

      {notice && <div className="card today-brief" role="status">{notice}</div>}

      {data?.triage?.enabled && (data.triage.summary || data.triage.forks?.length || data.triage.suppressed?.length) ? (
        <section className="card today-brief">
          {data.triage.summary && <p className="today-brief__summary">{data.triage.summary}</p>}
          {data.triage.forks?.length > 0 && (
            <div className="today-brief__forks">
              <h3>Worth a quick decision</h3>
              <ul>
                {data.triage.forks.map((f, i) => (
                  <li key={i}><strong>{f.title}</strong>{f.detail ? `: ${f.detail}` : ''}</li>
                ))}
              </ul>
            </div>
          )}
          {data.triage.suppressed?.length > 0 && (
            <p className="muted small today-brief__held">
              {data.triage.suppressed.length} item{data.triage.suppressed.length > 1 ? 's' : ''} held back today
              {data.triage.suppressed.map((s) => s.reason).filter(Boolean).length
                ? `: ${data.triage.suppressed.map((s) => s.reason).filter(Boolean).join('; ')}`
                : '.'}
            </p>
          )}
        </section>
      ) : null}

      {total === 0 ? (
        <section className="card empty today-empty">
          <Icon name="check" size={28} />
          <h3>You're all caught up</h3>
          <p className="muted">
            No follow-ups due, everyone's thanked, and your top prospects are queued. Come back tomorrow, or{' '}
            <Link to="/prospects">work more prospects</Link>.
          </p>
        </section>
      ) : (
        <>
          {reminders.length > 0 && (
            <section className="today-group">
              <h2>Follow-ups due <span className="today-count">{reminders.length}</span></h2>
              {reminders.map((r) => (
                <div className="card today-card" key={`rem-${r.id}`}>
                  <div className="today-card__main">
                    <span className="today-card__name">{r.contact_name || 'Someone'}</span>
                    <span className={`tag ${r.overdue ? 'tag--warn' : 'tag--muted'}`}>{r.overdue ? 'Overdue' : 'Due today'}</span>
                    {r.company && <span className="muted small">{r.company}</span>}
                  </div>
                  <div className="today-card__actions">
                    <Link className="btn btn--sm btn--ghost" to="/pipeline">Open</Link>
                    <button className="btn btn--sm btn--ghost" onClick={() => act(`rem-${r.id}`, api.post(`/api/reminders/${r.id}/snooze`, { days: 3 }))}>Snooze 3d</button>
                    <button className="btn btn--sm btn--primary" onClick={() => act(`rem-${r.id}`, api.post(`/api/reminders/${r.id}/complete`))}>
                      <Icon name="check" size={13} /> Done
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {unthanked.length > 0 && (
            <section className="today-group">
              <h2>Say thanks <span className="today-count">{unthanked.length}</span></h2>
              {unthanked.map((r) => (
                <div className="card today-card" key={`thk-${r.id}`}>
                  <div className="today-card__main">
                    <span className="today-card__name">{r.contact_name || 'A donor'}</span>
                    {r.donation_amount > 0 && <span className="tag tag--ok">{money(r.donation_amount)}</span>}
                  </div>
                  <div className="today-card__actions">
                    <button className="btn btn--sm btn--ghost" onClick={() => copy(`thk-${r.id}`, buildThankYouMessage(r.contact_name, scoutName, r.donation_amount, org))}>
                      <Icon name="copy" size={13} /> {copiedKey === `thk-${r.id}` ? 'Copied' : 'Copy thank-you'}
                    </button>
                    <button className="btn btn--sm btn--primary" onClick={() => act(`thk-${r.id}`, api.post(`/api/referrals/${r.id}/thanked`))}>
                      <Icon name="check" size={13} /> Mark thanked
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {secondGifts.length > 0 && (
            <section className="today-group">
              <h2>Reconnect for a second gift <span className="today-count">{secondGifts.length}</span></h2>
              <p className="muted small today-group__hint">These donors gave once and were thanked. A warm, specific re-ask a month or two later is the cheapest gift you can raise.</p>
              {secondGifts.map((r) => {
                const d = redrafts[r.id];
                return (
                  <div className="card today-card" key={`2nd-${r.id}`}>
                    <div className="today-card__main">
                      <span className="today-card__name">{r.contact_name || 'A past donor'}</span>
                      {r.donation_amount > 0 && <span className="tag tag--ok">{money(r.donation_amount)}</span>}
                      {r.daysAgo != null && <span className="muted small">gave {r.daysAgo}d ago</span>}
                    </div>
                    <div className="today-card__actions">
                      <button className="btn btn--sm btn--ghost" disabled={rebusy === r.id} onClick={() => draftReask(r.id)}>
                        <Icon name="edit" size={13} /> {rebusy === r.id ? 'Drafting…' : d ? 'Redraft' : 'Draft re-ask'}
                      </button>
                      <button className="btn btn--sm btn--ghost" onClick={() => act(`2nd-${r.id}`, api.post(`/api/referrals/${r.id}/reconnect`, { snooze: true }))}>Skip</button>
                      <button className="btn btn--sm btn--primary" onClick={() => act(`2nd-${r.id}`, api.post(`/api/referrals/${r.id}/reconnect`, { asked: true }))}>
                        <Icon name="check" size={13} /> Mark re-asked
                      </button>
                    </div>
                    {d && (d.text || d.failed) && (
                      <div style={{ flexBasis: '100%', marginTop: 8 }}>
                        {d.aiOff && <p className="muted small">AI is off, so this is an editable template. Add an ANTHROPIC_API_KEY to your .env for an in-voice draft.</p>}
                        {d.failed && !d.text ? (
                          <p className="muted small">Could not draft right now. Try again in a moment.</p>
                        ) : (
                          <>
                            <textarea
                              className="grant-add__textarea"
                              style={{ width: '100%' }}
                              rows={7}
                              value={d.text}
                              onChange={(e) => setRedrafts((prev) => ({ ...prev, [r.id]: { ...prev[r.id], text: e.target.value } }))}
                            />
                            <div className="today-card__actions" style={{ marginTop: 6 }}>
                              <button className="btn btn--sm btn--ghost" onClick={() => copy(`2nd-draft-${r.id}`, d.text)}>
                                <Icon name="copy" size={13} /> {copiedKey === `2nd-draft-${r.id}` ? 'Copied' : 'Copy'}
                              </button>
                              <button className="btn btn--sm btn--primary" disabled={sending === r.id || !d.text?.trim()} onClick={() => sendReask(r.id, d.text)}>
                                <Icon name="external" size={13} /> {sending === r.id ? 'Sending…' : 'Send'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {prospects.length > 0 && (
            <section className="today-group">
              <h2>Ask next <span className="today-count">{prospects.length}</span></h2>
              {prospects.map((p) => (
                <div className="card today-card" key={`pro-${p.id}`}>
                  <div className="today-card__main">
                    <span className="today-card__name">{p.contact_name || 'Unknown'}</span>
                    <span className="tag tag--muted">{p.donor_likelihood_score ?? 0}/100</span>
                    {p.company && <span className="muted small">{p.company}</span>}
                  </div>
                  <div className="today-card__actions">
                    <button className="btn btn--sm btn--ghost" onClick={() => copy(`pro-${p.id}`, buildOutreachMessage(p.contact_name, scoutName, org))}>
                      <Icon name="copy" size={13} /> {copiedKey === `pro-${p.id}` ? 'Copied' : 'Copy ask'}
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => act(`pro-${p.id}`, api.post('/api/today/snooze', { connectionId: p.id, days: 7 }))}>Not now</button>
                    <button className="btn btn--sm btn--primary" onClick={() => act(`pro-${p.id}`, api.post('/api/referrals', { connectionId: p.id }))}>
                      <Icon name="plus" size={13} /> Add to pipeline
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {matchGifts.length > 0 && (
            <section className="today-group">
              <h2>Double their gift <span className="today-count">{matchGifts.length}</span></h2>
              <p className="muted small today-group__hint">These donors work somewhere with an employer matching-gift program. A quick ask can double a gift you already have.</p>
              {matchGifts.map((r) => (
                <div className="card today-card" key={`mat-${r.id}`}>
                  <div className="today-card__main">
                    <span className="today-card__name">{r.contact_name || 'A donor'}</span>
                    <span className="tag tag--ok">{r.program}</span>
                    {r.donation_amount > 0 && <span className="muted small">gave {money(r.donation_amount)}</span>}
                  </div>
                  <div className="today-card__actions">
                    <button className="btn btn--sm btn--primary" onClick={() => copy(`mat-${r.id}`, buildMatchGiftMessage(r.contact_name, scoutName, r.company, r.program, org))}>
                      <Icon name="copy" size={13} /> {copiedKey === `mat-${r.id}` ? 'Copied' : 'Copy match-ask'}
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => remove(`mat-${r.id}`)}>Dismiss</button>
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
