import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { money } from '../api';
import Icon from '../components/Icon';

const CHANNEL_LABEL = { linkedin: 'LinkedIn', email: 'Email', text: 'Text', in_person: 'In person' };
const KIND_LABEL = { ask: 'First ask', followup: 'Follow-up', thanks: 'Thank-you' };

function aiErrMsg(e) {
  const d = e?.response?.data;
  if (d?.aiDisabled) return 'AI is off. Add an ANTHROPIC_API_KEY to enable the agent.';
  if (d?.budgetExhausted) return 'Daily AI budget reached. Try again later.';
  return d?.error || e?.message || 'AI request failed.';
}

export default function CampaignPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null); // { campaign, actions, progress }
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiRemaining, setAiRemaining] = useState(null); // org's remaining daily AI budget ($), null = unknown
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // create-campaign form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', goalAmount: '', deadline: '', constraints: '' });

  // planner / per-action busy state
  const [planning, setPlanning] = useState(false);
  const [strategy, setStrategy] = useState('');
  const [busyAction, setBusyAction] = useState(null); // action id currently working
  const [copiedId, setCopiedId] = useState(null);

  async function loadCampaigns() {
    setLoading(true);
    try {
      const [{ data }, ai] = await Promise.all([
        api.get('/api/campaigns'),
        api.get('/api/ai/status').then((r) => r.data).catch(() => ({ enabled: false })),
      ]);
      setAiEnabled(!!ai.enabled);
      setAiRemaining(typeof ai.remainingUsd === 'number' ? ai.remainingUsd : null);
      setCampaigns(data.campaigns || []);
      setActiveId((cur) => cur || data.campaigns?.[0]?.id || null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCampaigns();
  }, []);

  async function loadDetail(id) {
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      const { data } = await api.get(`/api/campaigns/${id}`);
      setDetail(data);
      setStrategy('');
    } catch {
      setDetail(null);
    }
  }

  useEffect(() => {
    loadDetail(activeId);
  }, [activeId]);

  async function createCampaign(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Give your campaign a name.');
      return;
    }
    try {
      const { data } = await api.post('/api/campaigns', {
        name: form.name.trim(),
        goalAmount: Number(form.goalAmount) || 0,
        deadline: form.deadline || null,
        constraints: form.constraints.trim() || null,
      });
      setForm({ name: '', goalAmount: '', deadline: '', constraints: '' });
      setShowForm(false);
      await loadCampaigns();
      setActiveId(data.campaign.id);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not create the campaign.');
    }
  }

  async function deleteCampaign(id) {
    if (!window.confirm('Delete this campaign and its planned actions? Your prospects and pipeline are untouched.')) return;
    await api.delete(`/api/campaigns/${id}`);
    const remaining = campaigns.filter((c) => c.id !== id);
    setCampaigns(remaining);
    setActiveId(remaining[0]?.id || null);
  }

  async function runPlanner() {
    if (!activeId) return;
    setPlanning(true);
    setError('');
    setStrategy('');
    try {
      const { data } = await api.post(`/api/campaigns/${activeId}/plan`);
      setStrategy(data.message || data.strategy || '');
      await loadDetail(activeId);
      await loadCampaigns(); // refresh progress chips in the switcher
    } catch (err) {
      setError(aiErrMsg(err));
    } finally {
      setPlanning(false);
    }
  }

  function patchActionLocal(updated) {
    setDetail((d) => (d ? { ...d, actions: d.actions.map((a) => (a.id === updated.id ? updated : a)) } : d));
  }

  async function approve(action) {
    setBusyAction(action.id);
    try {
      const { data } = await api.post(`/api/actions/${action.id}/approve`);
      patchActionLocal(data.action);
      await loadCampaigns();
    } catch (err) {
      setError(aiErrMsg(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function skip(action) {
    setBusyAction(action.id);
    try {
      const { data } = await api.patch(`/api/actions/${action.id}`, { status: 'skipped' });
      patchActionLocal(data.action);
      await loadCampaigns();
    } catch {
      /* ignore */
    } finally {
      setBusyAction(null);
    }
  }

  async function changeAsk(action, value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    try {
      const { data } = await api.patch(`/api/actions/${action.id}`, { suggestedAsk: n });
      patchActionLocal(data.action);
    } catch {
      /* ignore */
    }
  }

  async function draftMessage(action) {
    setBusyAction(action.id);
    setError('');
    try {
      const { data } = await api.post(`/api/actions/${action.id}/draft`);
      patchActionLocal(data.action);
    } catch (err) {
      setError(aiErrMsg(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function copyDraft(action) {
    try {
      await navigator.clipboard.writeText(action.draft || '');
      setCopiedId(action.id);
      setTimeout(() => setCopiedId((c) => (c === action.id ? null : c)), 1500);
    } catch {
      /* ignore */
    }
  }

  const activeCampaign = useMemo(
    () => campaigns.find((c) => c.id === activeId) || detail?.campaign || null,
    [campaigns, activeId, detail]
  );
  const actions = detail?.actions || [];
  const proposed = actions.filter((a) => a.status === 'proposed');
  const approved = actions.filter((a) => a.status === 'approved');
  const skipped = actions.filter((a) => a.status === 'skipped');
  const progress = detail?.progress || activeCampaign?.progress;
  const goal = activeCampaign?.goalAmount || 0;
  const raised = progress?.raised || 0;
  const projected = progress?.projectedValue || 0;
  // AI is on but the org's daily budget is spent → warn + disable planning up front,
  // instead of letting a click fail. Uses the remaining budget already in hand.
  const budgetExhausted = aiEnabled && aiRemaining !== null && aiRemaining <= 0;

  if (loading) {
    return (
      <div className="page">
        <div className="page__head">
          <h1>Campaign agent</h1>
        </div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head campaign-head">
        <div>
          <h1>Campaign agent</h1>
          <p className="page__sub">
            Set a goal. The agent ranks who to ask, for how much, and drafts each message in your voice. You
            approve, edit, or skip, and send when you're ready.
          </p>
        </div>
        <button className="btn btn--primary btn--sm" onClick={() => setShowForm((s) => !s)}>
          <Icon name="plus" size={15} /> New campaign
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {showForm && (
        <form className="card campaign-form" onSubmit={createCampaign}>
          <h3>New campaign</h3>
          <div className="campaign-form__grid">
            <label className="field field--wide">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Year-end push for Code for Ukraine"
                maxLength={120}
              />
            </label>
            <label className="field">
              <span>Goal (USD)</span>
              <input
                type="number"
                min="0"
                value={form.goalAmount}
                onChange={(e) => setForm({ ...form, goalAmount: e.target.value })}
                placeholder="5000"
              />
            </label>
            <label className="field">
              <span>Deadline</span>
              <input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              />
            </label>
            <label className="field field--wide">
              <span>Constraints for the agent (optional)</span>
              <input
                value={form.constraints}
                onChange={(e) => setForm({ ...form, constraints: e.target.value })}
                placeholder="Don't ask family. Keep asks under $250. Prefer email."
                maxLength={2000}
              />
            </label>
          </div>
          <div className="campaign-form__actions">
            <button type="submit" className="btn btn--primary btn--sm">
              Create campaign
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {campaigns.length === 0 && !showForm ? (
        <section className="card empty campaign-empty">
          <Icon name="target" size={28} />
          <h3>No campaigns yet</h3>
          <p className="muted">
            Create a campaign with a goal, and the agent will turn your scored network into a ranked, ready-to-send
            plan. <Link to="/prospects">Import your connections</Link> first if you haven't.
          </p>
          <button className="btn btn--primary" onClick={() => setShowForm(true)}>
            <Icon name="plus" size={16} /> Create your first campaign
          </button>
        </section>
      ) : (
        <>
          {campaigns.length > 0 && (
            <div className="campaign-switcher">
              {campaigns.map((c) => (
                <button
                  key={c.id}
                  className={`campaign-tab${c.id === activeId ? ' campaign-tab--on' : ''}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <span className="campaign-tab__name">{c.name}</span>
                  {c.goalAmount > 0 && (
                    <span className="campaign-tab__meta">
                      {money(c.progress?.raised || 0)} / {money(c.goalAmount)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {activeCampaign && (
            <>
              <section className="card goal-card campaign-goal">
                <div className="goal-card__top">
                  <div>
                    <h2>{activeCampaign.name}</h2>
                    {activeCampaign.constraints && (
                      <p className="muted small campaign-goal__constraints">
                        <Icon name="check" size={13} /> {activeCampaign.constraints}
                      </p>
                    )}
                  </div>
                  <div className="campaign-goal__right">
                    {goal > 0 && (
                      <span className="goal-card__nums">
                        {money(raised)} <span className="muted">of {money(goal)}</span>
                      </span>
                    )}
                    <button
                      className="btn btn--ghost btn--sm btn--danger-text"
                      onClick={() => deleteCampaign(activeCampaign.id)}
                      title="Delete campaign"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
                {goal > 0 && (
                  <>
                    <div className="progress">
                      <div className="progress__bar" style={{ width: `${Math.min(100, (raised / goal) * 100)}%` }} />
                    </div>
                    <p className="muted small">
                      {Math.round((raised / goal) * 100)}% raised · {money(projected)} more projected from{' '}
                      {(progress?.counts?.proposed || 0) + (progress?.counts?.approved || 0)} live actions
                      {activeCampaign.deadline ? ` · by ${activeCampaign.deadline}` : ''}
                    </p>
                  </>
                )}
              </section>

              <div className="campaign-plan-bar">
                <div>
                  <h2>Action plan</h2>
                  <p className="muted small">
                    {proposed.length} to review · {approved.length} approved · {skipped.length} skipped
                  </p>
                </div>
                {aiEnabled ? (
                  <button className="btn btn--primary" onClick={runPlanner} disabled={planning || budgetExhausted}>
                    <Icon name="sparkles" size={16} /> {planning ? 'Planning…' : actions.length ? 'Plan more asks' : 'Generate plan'}
                  </button>
                ) : (
                  <span className="muted small campaign-ai-off">
                    <Icon name="sparkles" size={14} /> Agent is off. Add an <code>ANTHROPIC_API_KEY</code> to enable
                    planning.
                  </span>
                )}
              </div>

              {budgetExhausted && (
                <div className="alert alert--warn">
                  <Icon name="sparkles" size={14} /> Today’s AI budget is used up. Planning and drafting resume after the
                  daily reset. You can still approve, edit, and send the moves already staged.
                </div>
              )}

              {strategy && <div className="card campaign-strategy"><Icon name="sparkles" size={15} /> {strategy}</div>}

              {actions.length === 0 ? (
                <section className="card empty">
                  <p className="muted">
                    {aiEnabled
                      ? 'No actions yet. Click "Generate plan" and the agent will rank your warmest, highest-value asks.'
                      : 'AI planning is off. You can still work prospects from the Prospects and Pipeline pages.'}
                  </p>
                </section>
              ) : (
                <div className="action-list">
                  {[...proposed, ...approved, ...skipped].map((a) => (
                    <ActionCard
                      key={a.id}
                      action={a}
                      busy={busyAction === a.id}
                      copied={copiedId === a.id}
                      aiEnabled={aiEnabled}
                      onApprove={() => approve(a)}
                      onSkip={() => skip(a)}
                      onChangeAsk={(v) => changeAsk(a, v)}
                      onDraft={() => draftMessage(a)}
                      onCopy={() => copyDraft(a)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ActionCard({ action, busy, copied, aiEnabled, onApprove, onSkip, onChangeAsk, onDraft, onCopy }) {
  const [askDraft, setAskDraft] = useState(String(action.suggestedAsk || 0));
  useEffect(() => setAskDraft(String(action.suggestedAsk || 0)), [action.suggestedAsk]);
  const isProposed = action.status === 'proposed';
  const isSkipped = action.status === 'skipped';

  return (
    <section className={`card action-card action-card--${action.status}`}>
      <div className="action-card__head">
        <div className="action-card__who">
          <span className="action-card__name">{action.contactName || 'Unknown'}</span>
          <span className="action-card__tags">
            <span className="tag tag--muted">{KIND_LABEL[action.kind] || action.kind}</span>
            <span className="tag tag--muted">{CHANNEL_LABEL[action.channel] || action.channel}</span>
            {action.status === 'approved' && <span className="stage-pill stage-pill--to_ask"><span className="stage-pill__label">In pipeline</span></span>}
            {isSkipped && <span className="tag tag--muted">Skipped</span>}
          </span>
        </div>
        <div className="action-card__metrics">
          <span className="action-metric">
            <strong>{action.pYes}%</strong>
            <span className="muted small">likely</span>
          </span>
          <span className="action-metric">
            <strong>{money(action.expectedValue)}</strong>
            <span className="muted small">expected</span>
          </span>
        </div>
      </div>

      {action.rationale && <p className="action-card__rationale">{action.rationale}</p>}
      {action.hook && (
        <p className="action-card__hook">
          <Icon name="sparkles" size={13} /> {action.hook}
        </p>
      )}

      {action.draft && (
        <div className="action-card__draft">
          <pre className="outreach-message">{action.draft}</pre>
          <button className="btn btn--sm btn--ghost" onClick={onCopy}>
            <Icon name="copy" size={13} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {!isSkipped && (
        <div className="action-card__bar">
          <label className="action-ask">
            <span className="muted small">Ask</span>
            <input
              type="number"
              min="0"
              value={askDraft}
              onChange={(e) => setAskDraft(e.target.value)}
              onBlur={() => Number(askDraft) !== action.suggestedAsk && onChangeAsk(askDraft)}
            />
          </label>
          <div className="action-card__buttons">
            {aiEnabled && (
              <button className="btn btn--sm btn--on-light" onClick={onDraft} disabled={busy}>
                <Icon name="sparkles" size={13} /> {busy ? 'Drafting…' : action.draft ? 'Redraft' : 'Draft message'}
              </button>
            )}
            {isProposed && (
              <>
                <button className="btn btn--sm btn--primary" onClick={onApprove} disabled={busy}>
                  <Icon name="check" size={13} /> Approve
                </button>
                <button className="btn btn--sm btn--ghost" onClick={onSkip} disabled={busy}>
                  <Icon name="x" size={13} /> Skip
                </button>
              </>
            )}
            {action.status === 'approved' && (
              <Link className="btn btn--sm btn--ghost" to="/pipeline">
                <Icon name="arrowRight" size={13} /> In pipeline
              </Link>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
