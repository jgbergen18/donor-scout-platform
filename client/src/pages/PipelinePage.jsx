import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { money } from '../api';
import Modal from '../components/Modal';
import Icon from '../components/Icon';
import { buildOutreachMessage, buildThankYouMessage, mailtoLink, firstNameOf } from '../outreach';
import { useOrg } from '../OrgContext';

const STAGES = [
  { key: 'to_ask', label: 'To ask' },
  { key: 'asked', label: 'Asked' },
  { key: 'following_up', label: 'Following up' },
  { key: 'donated', label: 'Donated' },
  { key: 'declined', label: 'Declined' },
];
const STAGE_ORDER = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const stageLabel = (k) => STAGES.find((s) => s.key === k)?.label || k;

export default function PipelinePage() {
  const org = useOrg();
  const [referrals, setReferrals] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [scoutName, setScoutName] = useState('');
  const [loading, setLoading] = useState(true);
  const [outreach, setOutreach] = useState(null); // referral being messaged
  const [outreachMode, setOutreachMode] = useState('ask'); // 'ask' | 'thank'
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const [donateTarget, setDonateTarget] = useState(null);
  const [amount, setAmount] = useState('');
  const [savingDonation, setSavingDonation] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [receiptCopied, setReceiptCopied] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'ok'|'error', text } — transient page feedback

  // Auto-disarm the "Remove?" confirm so a stray click can't leave it armed and delete
  // on the next accidental click. Clears ~4s after arming.
  useEffect(() => {
    if (!confirmRemoveId) return;
    const t = setTimeout(() => setConfirmRemoveId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmRemoveId]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function load() {
    setLoading(true);
    try {
      const [{ data: r }, { data: me }, { data: rem }, { data: ai }] = await Promise.all([
        api.get('/api/referrals'),
        api.get('/api/auth/me'),
        api.get('/api/reminders'),
        api.get('/api/ai/status').catch(() => ({ data: { enabled: false } })),
      ]);
      setReferrals(r.referrals || []);
      setReminders(rem.reminders || []);
      setScoutName(me.user?.name || '');
      setAiEnabled(!!ai.enabled);
    } finally {
      setLoading(false);
    }
  }

  async function loadReminders() {
    try {
      const { data } = await api.get('/api/reminders');
      setReminders(data.reminders || []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    load();
  }, []);

  // The next OPEN reminder per referral (earliest due first — the API already
  // orders by due_date), so each row can surface complete/snooze on its cadence.
  const nextReminderByReferral = useMemo(() => {
    const m = new Map();
    for (const r of reminders) if (!m.has(r.referral_id)) m.set(r.referral_id, r);
    return m;
  }, [reminders]);

  async function completeReminder(id) {
    try {
      await api.post(`/api/reminders/${id}/complete`, {});
    } catch {
      /* ignore */
    }
    await loadReminders();
    // The legacy follow_up_date column moves with the cadence — refresh referrals.
    const { data } = await api.get('/api/referrals');
    setReferrals(data.referrals || []);
  }

  async function snoozeReminder(id) {
    try {
      await api.post(`/api/reminders/${id}/snooze`, { days: 3 });
    } catch {
      /* ignore */
    }
    await loadReminders();
    const { data } = await api.get('/api/referrals');
    setReferrals(data.referrals || []);
  }

  const counts = useMemo(() => {
    const c = {};
    for (const r of referrals) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [referrals]);

  const ordered = useMemo(
    () =>
      [...referrals].sort(
        (a, b) =>
          (STAGE_ORDER[a.status] ?? 9) - (STAGE_ORDER[b.status] ?? 9) ||
          (a.follow_up_date || '').localeCompare(b.follow_up_date || '')
      ),
    [referrals]
  );

  async function patchReferral(id, fields) {
    const { data } = await api.patch(`/api/referrals/${id}`, fields);
    setReferrals((rs) => rs.map((r) => (r.id === id ? data.referral : r)));
    // Stage / date changes can seed, reschedule, or close reminders server-side.
    if (fields.status !== undefined || fields.follow_up_date !== undefined) loadReminders();
  }

  function setLocalNote(id, note) {
    setReferrals((rs) => rs.map((r) => (r.id === id ? { ...r, note } : r)));
  }

  async function removeReferral(id) {
    const removed = referrals.find((r) => r.id === id);
    try {
      await api.delete(`/api/referrals/${id}`);
      setReferrals((rs) => rs.filter((r) => r.id !== id));
      setToast({ type: 'ok', text: `Removed ${removed?.contact_name || 'the contact'} from your pipeline.` });
    } catch (err) {
      // Surface the failure — don't leave the row looking gone when it isn't.
      setToast({ type: 'error', text: err.response?.data?.error || 'Couldn’t remove that. It’s still in your pipeline. Try again.' });
    } finally {
      setConfirmRemoveId(null);
    }
  }

  function openOutreach(r, mode = 'ask') {
    setOutreach(r);
    setOutreachMode(mode);
    setMessage(
      mode === 'thank'
        ? buildThankYouMessage(r.contact_name, scoutName, r.donation_amount, org)
        : buildOutreachMessage(r.contact_name, scoutName, org)
    );
    setCopied(false);
    setDraftNote('');
  }

  // Replace the textarea with an AI thank-you in the scout's voice, grounded in the
  // real gift + its impact. On any failure (incl. no-AI 503) keep/seed the static
  // template (the server returns it as `fallback`) so the loop can always close.
  async function thankWithAI() {
    if (!outreach) return;
    setDrafting(true);
    setDraftNote('');
    try {
      const { data } = await api.post(`/api/referrals/${outreach.id}/thank-you`);
      setMessage(data.draft);
      setCopied(false);
      setDraftNote(
        data.voiced
          ? 'AI thank-you, written in your voice. Review before sending.'
          : 'AI thank-you. Review before sending.'
      );
    } catch (err) {
      const fb = err.response?.data?.fallback;
      if (fb) setMessage(fb);
      setDraftNote('Couldn’t draft with AI. Using the standard thank-you.');
    } finally {
      setDrafting(false);
    }
  }

  // Mark a donated referral thanked (closes it on the "awaiting thanks" surface).
  async function markThanked(id) {
    try {
      const { data } = await api.post(`/api/referrals/${id}/thanked`, {});
      setReferrals((rs) => rs.map((r) => (r.id === id ? data.referral : r)));
    } catch {
      /* ignore */
    }
  }

  async function viewReceipt(r) {
    try {
      const { data } = await api.get(`/api/referrals/${r.id}/receipt`);
      setReceipt(data.receipt);
      setReceiptCopied(false);
    } catch {
      /* ignore */
    }
  }

  function receiptText(rc) {
    if (!rc) return '';
    return [
      `Acknowledgement of gift: ${rc.org || ''}`.trim(),
      '',
      `Donor: ${rc.donor || 'n/a'}`,
      `Amount: ${money(rc.amount)}`,
      rc.date ? `Date: ${rc.date}` : null,
      rc.impact ? `Impact: This gift ${rc.impact}.` : null,
      '',
      rc.disclaimer,
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  async function copyReceipt() {
    try {
      await navigator.clipboard.writeText(receiptText(receipt));
      setReceiptCopied(true);
      setTimeout(() => setReceiptCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  // Donated referrals not yet thanked — the "awaiting thanks" prompt.
  const awaitingThanks = useMemo(
    () => referrals.filter((r) => r.donation_received && !r.thanked_at),
    [referrals]
  );

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }

  async function recordDonation() {
    const value = Number(amount);
    if (!value || value <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    setSavingDonation(true);
    setError('');
    try {
      const { data } = await api.post(`/api/referrals/${donateTarget.id}/donation`, { amount: value });
      setReferrals((rs) => rs.map((r) => (r.id === donateTarget.id ? data.referral : r)));
      loadReminders(); // donating closes the cadence
      setDonateTarget(null);
      setAmount('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record donation.');
    } finally {
      setSavingDonation(false);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>Pipeline</h1>
        <p className="page__sub">Track every ask from first outreach to donation.</p>
      </div>

      {toast && (
        <div className={`alert ${toast.type === 'error' ? 'alert--error' : 'alert--success'}`} role="status">
          {toast.text}
        </div>
      )}

      <div className="stage-summary">
        {STAGES.map((s) => (
          <div key={s.key} className={`stage-pill stage-pill--${s.key}`}>
            <span className="stage-pill__count">{counts[s.key] || 0}</span>
            <span className="stage-pill__label">{s.label}</span>
          </div>
        ))}
      </div>

      {awaitingThanks.length > 0 && (
        <section className="card thanks-prompt">
          <div className="thanks-prompt__head">
            <h2>
              <Icon name="heart" size={16} /> Thank your donors
            </h2>
            <span className="muted small">
              {awaitingThanks.length} {awaitingThanks.length === 1 ? 'donor' : 'donors'} awaiting a thank-you
            </span>
          </div>
          <ul className="thanks-prompt__list">
            {awaitingThanks.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.contact_name}</strong>{' '}
                  <span className="muted small">{money(r.donation_amount)}</span>
                </div>
                <div className="thanks-prompt__actions">
                  <button className="btn btn--sm btn--donate" onClick={() => openOutreach(r, 'thank')}>
                    <Icon name="heart" size={13} /> Thank
                  </button>
                  <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => viewReceipt(r)}>
                    Receipt
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

      {loading ? (
        <div className="empty">Loading pipeline…</div>
      ) : referrals.length === 0 ? (
        <div className="empty">
          <p>Your pipeline is empty.</p>
          <Link className="btn btn--primary" to="/prospects">
            Find prospects to reach out to →
          </Link>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table pipeline-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Stage</th>
                  <th>Follow-up</th>
                  <th>Note</th>
                  <th>Outreach</th>
                  <th>Donation</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => (
                  <tr key={r.id} className={r.status === 'donated' ? 'row--donated' : ''}>
                    <td data-label="Contact">
                      <strong>{r.contact_name}</strong>
                      {r.company && <div className="muted small">{r.company}</div>}
                    </td>
                    <td data-label="Stage">
                      <select
                        className={`stage-select stage-select--${r.status}`}
                        value={r.status}
                        onChange={(e) => patchReferral(r.id, { status: e.target.value })}
                      >
                        {STAGES.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Follow-up">
                      <input
                        type="date"
                        className="followup-input"
                        value={r.follow_up_date || ''}
                        onChange={(e) => patchReferral(r.id, { follow_up_date: e.target.value })}
                      />
                      {(() => {
                        const rem = nextReminderByReferral.get(r.id);
                        if (!rem) return null;
                        return (
                          <div className="reminder-cell">
                            <span className={`reminder-step small ${rem.overdue ? 'reminder--overdue' : 'muted'}`}>
                              step {rem.step_index + 1}
                              {rem.overdue ? ' · overdue' : rem.due ? ' · due' : ''}
                            </span>
                            <div className="reminder-actions">
                              <button
                                className="btn btn--sm btn--primary"
                                title="Mark this step done and advance the cadence"
                                onClick={() => completeReminder(rem.id)}
                              >
                                Done
                              </button>
                              <button
                                className="btn btn--sm btn--ghost btn--on-light"
                                title="Remind me in 3 days"
                                onClick={() => snoozeReminder(rem.id)}
                              >
                                Snooze
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    <td data-label="Note">
                      <input
                        type="text"
                        className="note-input"
                        placeholder="Add a note…"
                        value={r.note || ''}
                        onChange={(e) => setLocalNote(r.id, e.target.value)}
                        onBlur={() => patchReferral(r.id, { note: r.note || '' })}
                      />
                    </td>
                    <td data-label="Outreach" className="pipeline-table__outreach">
                      {r.donation_received ? (
                        <button className="btn btn--sm btn--donate" onClick={() => openOutreach(r, 'thank')}>
                          <Icon name="heart" size={13} /> Thank
                        </button>
                      ) : (
                        <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => openOutreach(r)}>
                          <Icon name="mail" size={13} /> Message
                        </button>
                      )}
                      {r.linkedin_url && (
                        <a className="icon-link" href={r.linkedin_url} target="_blank" rel="noreferrer" title="Open LinkedIn">
                          in
                        </a>
                      )}
                      {confirmRemoveId === r.id ? (
                        <button className="btn btn--sm btn--danger" onClick={() => removeReferral(r.id)}>
                          Remove?
                        </button>
                      ) : (
                        <button
                          className="icon-btn"
                          title="Remove from pipeline"
                          onClick={() => setConfirmRemoveId(r.id)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                    <td data-label="Donation" className="table__action">
                      {r.donation_received ? (
                        <>
                          <span className="pill pill--ok">{money(r.donation_amount)}</span>
                          <button
                            className="btn btn--sm btn--ghost btn--on-light"
                            title="View the gift acknowledgement"
                            onClick={() => viewReceipt(r)}
                          >
                            Receipt
                          </button>
                          {r.thanked_at && (
                            <span className="pill pill--thanked" title="Donor thanked">
                              <Icon name="check" size={12} /> Thanked
                            </span>
                          )}
                        </>
                      ) : (
                        <button className="btn btn--sm btn--primary" onClick={() => setDonateTarget(r)}>
                          Record
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {outreach && (
        <Modal
          title={`${outreachMode === 'thank' ? 'Thank' : 'Message'} ${firstNameOf(outreach.contact_name)}`}
          onClose={() => setOutreach(null)}
          footer={
            <>
              {outreachMode === 'thank' && !outreach.thanked_at && (
                <button
                  className="btn btn--ghost btn--on-light"
                  onClick={async () => {
                    await markThanked(outreach.id);
                    setOutreach(null);
                  }}
                >
                  Mark thanked
                </button>
              )}
              <button className="btn btn--primary" onClick={() => setOutreach(null)}>
                Done
              </button>
            </>
          }
        >
          {outreachMode === 'thank' && (
            <p className="muted">
              A warm thank-you for <strong>{outreach.contact_name}</strong>’s gift of{' '}
              {money(outreach.donation_amount)}. Edit it, copy/send, then mark them thanked.
            </p>
          )}
          <textarea
            className="outreach-message"
            rows={10}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {draftNote && <p className="muted small outreach-note">{draftNote}</p>}
          <div className="outreach-actions">
            {outreachMode === 'thank' && aiEnabled && (
              <button
                className="btn btn--sm btn--ghost btn--on-light"
                type="button"
                onClick={thankWithAI}
                disabled={drafting}
                title="Write a personalized thank-you in your voice, grounded in the gift and its impact"
              >
                <Icon name="sparkles" size={14} /> {drafting ? 'Drafting…' : 'Draft in my voice'}
              </button>
            )}
            <button className="btn btn--sm btn--primary" type="button" onClick={copyMessage}>
              <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy message'}
            </button>
            {outreach.linkedin_url && (
              <a className="btn btn--sm btn--linkedin" href={outreach.linkedin_url} target="_blank" rel="noreferrer">
                <Icon name="linkedin" size={14} /> LinkedIn
              </a>
            )}
            {outreach.contact_email && (
              <a
                className="btn btn--sm btn--ghost btn--on-light"
                href={mailtoLink(outreach.contact_email, message, outreachMode === 'thank' ? 'Thank you 🇺🇦' : undefined)}
              >
                <Icon name="mail" size={14} /> Email
              </a>
            )}
          </div>
        </Modal>
      )}

      {donateTarget && (
        <Modal
          title={`Record a donation from ${donateTarget.contact_name}`}
          onClose={() => setDonateTarget(null)}
          footer={
            <>
              <button className="btn btn--ghost btn--on-light" onClick={() => setDonateTarget(null)} disabled={savingDonation}>
                Cancel
              </button>
              <button className="btn btn--primary" onClick={recordDonation} disabled={savingDonation}>
                {savingDonation ? 'Saving…' : 'Record donation'}
              </button>
            </>
          }
        >
          <p className="muted">Logs the donation and moves them to “Donated.” Impact updates instantly.</p>
          <div className="quick-amounts">
            {[57.14, 200, 800].map((v) => (
              <button
                key={v}
                className={`chip${Number(amount) === v ? ' chip--active' : ''}`}
                onClick={() => setAmount(String(v))}
              >
                {money(v)}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Amount (USD)</span>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              autoFocus
              placeholder="800"
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && recordDonation()}
            />
          </label>
          {error && <div className="alert alert--error">{error}</div>}
        </Modal>
      )}

      {receipt && (
        <Modal
          title="Gift acknowledgement"
          onClose={() => setReceipt(null)}
          footer={
            <>
              <button className="btn btn--sm btn--primary" type="button" onClick={copyReceipt}>
                <Icon name={receiptCopied ? 'check' : 'copy'} size={14} />{' '}
                {receiptCopied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn btn--ghost" onClick={() => setReceipt(null)}>
                Close
              </button>
            </>
          }
        >
          <div className="receipt">
            <div className="receipt__row">
              <span className="muted">Organization</span>
              <strong>{receipt.org || 'n/a'}</strong>
            </div>
            <div className="receipt__row">
              <span className="muted">Donor</span>
              <strong>{receipt.donor || 'n/a'}</strong>
            </div>
            <div className="receipt__row">
              <span className="muted">Amount</span>
              <strong>{money(receipt.amount)}</strong>
            </div>
            {receipt.date && (
              <div className="receipt__row">
                <span className="muted">Date</span>
                <strong>{receipt.date}</strong>
              </div>
            )}
            {receipt.impact && (
              <div className="receipt__row">
                <span className="muted">Impact</span>
                <strong>This gift {receipt.impact}.</strong>
              </div>
            )}
          </div>
          <p className="muted small outreach-note">{receipt.disclaimer}</p>
        </Modal>
      )}
    </div>
  );
}
