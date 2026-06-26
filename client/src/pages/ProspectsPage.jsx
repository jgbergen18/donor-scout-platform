import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import ProspectCard from '../components/ProspectCard';
import Modal from '../components/Modal';
import EditProspectModal from '../components/EditProspectModal';
import Icon from '../components/Icon';
import { HelpTip } from '../components/Help';
import { buildOutreachMessage, mailtoLink, firstNameOf } from '../outreach';
import { useOrg } from '../OrgContext';

const FILTERS = [
  { label: 'All', min: 0 },
  { label: 'Promising (45+)', min: 45 },
  { label: 'Top targets (75+)', min: 75 },
];

// Segment chips — matched against a prospect's reason tags (plus "un-asked").
const SEGMENTS = [
  { key: 'unasked', label: 'Un-asked' },
  { key: 'family', label: 'Family', icon: 'users', test: (r) => r.includes('family') },
  { key: 'coworker', label: 'Coworker', icon: 'building', test: (r) => /coworker/i.test(r) },
  { key: 'local', label: 'Local', icon: 'pin', test: (r) => r.includes('Local') },
  { key: 'reachable', label: 'Reachable', icon: 'mail', test: (r) => r.includes('Reachable') },
  { key: 'ukraine', label: 'Ukraine', icon: 'flag-ua', test: (r) => r.includes('Ukraine') },
];

// Cap how many cards render at once — hundreds of cards make the page sluggish.
const RENDER_LIMIT = 120;

export default function ProspectsPage() {
  const org = useOrg();
  const [prospects, setProspects] = useState([]);
  const [referredIds, setReferredIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [search, setSearch] = useState('');
  const [segments, setSegments] = useState(new Set());
  const [sort, setSort] = useState('score');
  const [scoutName, setScoutName] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const focusHandled = useRef(false);
  const [target, setTarget] = useState(null);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [{ data: p }, { data: r }, { data: me }, ai] = await Promise.all([
        api.get('/api/prospects'),
        api.get('/api/referrals'),
        api.get('/api/auth/me'),
        // AI status gates the "Draft with AI" button; if it fails we just hide it.
        api.get('/api/ai/status').catch(() => ({ data: { enabled: false } })),
      ]);
      setProspects(p.prospects || []);
      setReferredIds(new Set((r.referrals || []).map((x) => x.connection_id)));
      setScoutName(me.user?.name || '');
      setAiEnabled(!!ai.data?.enabled);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(() => {
    let list = prospects.filter((p) => p.donor_likelihood_score >= minScore);

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          (p.contact_name || '').toLowerCase().includes(q) ||
          (p.company || '').toLowerCase().includes(q)
      );
    }

    for (const key of segments) {
      if (key === 'unasked') {
        list = list.filter((p) => !referredIds.has(p.id));
      } else {
        const seg = SEGMENTS.find((s) => s.key === key);
        list = list.filter((p) => (p.score_reasons || []).some((r) => seg.test(r)));
      }
    }

    if (sort === 'name') {
      list = [...list].sort((a, b) => (a.contact_name || '').localeCompare(b.contact_name || ''));
    } else if (sort === 'followers') {
      list = [...list].sort((a, b) => (b.github_followers || 0) - (a.github_followers || 0));
    }
    return list;
  }, [prospects, minScore, search, segments, sort, referredIds]);

  function toggleSegment(key) {
    setSegments((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // Deep-link from the Dashboard worklist: open outreach for a specific prospect.
  useEffect(() => {
    if (loading || focusHandled.current) return;
    const focusId = location.state?.focusId;
    if (focusId) {
      const p = prospects.find((x) => x.id === focusId);
      if (p) openOutreach(p);
      focusHandled.current = true;
      navigate('/prospects', { replace: true, state: {} });
    }
  }, [loading, prospects, location.state, navigate]);

  const openOutreach = useCallback(
    (p) => {
      setTarget(p);
      // Seed the proven static template; "Draft with AI" can replace it on demand.
      setMessage(buildOutreachMessage(p.contact_name, scoutName, org));
      setCopied(false);
      setDraftNote('');
    },
    [scoutName, org]
  );

  // Replace the textarea with an in-voice, grounded AI draft. On any failure we
  // keep the seeded static template (graceful degradation) and show an inline note.
  async function draftWithAI() {
    if (!target) return;
    setDrafting(true);
    setDraftNote('');
    try {
      const { data } = await api.post(`/api/connections/${target.id}/draft`);
      setMessage(data.draft);
      setCopied(false);
      setDraftNote(
        data.voiced
          ? 'AI draft, written in your voice. Review before sending.'
          : 'AI draft. Review before sending.'
      );
    } catch (err) {
      // Keep the current (static) message and degrade gracefully — but tell the scout
      // WHY, since a deliberate AI-off (503) reads very differently from a transient
      // failure they might want to retry.
      const status = err?.response?.status;
      setDraftNote(
        status === 503
          ? 'AI is off. Using the standard template. (Add an ANTHROPIC_API_KEY to enable in-voice drafts.)'
          : status === 429
            ? 'Daily AI budget reached. Using the standard template. Try again after the reset.'
            : 'Couldn’t reach AI just now. Using the standard template. Try again in a moment.'
      );
    } finally {
      setDrafting(false);
    }
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the message is visible to copy manually */
    }
  }

  async function addToPipeline() {
    if (!target) return;
    setSubmitting(true);
    try {
      await api.post('/api/referrals', { connectionId: target.id });
      setReferredIds((prev) => new Set(prev).add(target.id));
      setToast(`${firstNameOf(target.contact_name)} added to your pipeline (Asked). Track it on the Pipeline page.`);
      setTarget(null);
    } catch (err) {
      setToast(err.response?.data?.error || 'Could not add to pipeline.');
    } finally {
      setSubmitting(false);
      setTimeout(() => setToast(''), 4000);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>Prospects</h1>
        <p className="page__sub">
          Your connections ranked by donor likelihood (0 to 100).{' '}
          <HelpTip label="How is this ranked?">
            Donor Scout ranks prospects by how strongly they’re connected to you, not by how
            wealthy they look. A real relationship predicts a “yes” far better than perceived
            wealth. Capacity sizes the ask, not who to ask.
          </HelpTip>
        </p>
      </div>

      <div className="prospect-controls">
        <div className="search-wrap">
          <Icon name="search" size={16} className="search-icon" />
          <input
            className="prospect-search"
            type="search"
            placeholder="Search name or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="sort-select" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="score">Sort: Score</option>
          <option value="name">Sort: Name A to Z</option>
          <option value="followers">Sort: GitHub followers</option>
        </select>
      </div>

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            className={`chip${minScore === f.min ? ' chip--active' : ''}`}
            onClick={() => setMinScore(f.min)}
          >
            {f.label}
          </button>
        ))}
        <span className="filter-bar__divider" aria-hidden="true" />
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            className={`chip${segments.has(s.key) ? ' chip--active' : ''}`}
            onClick={() => toggleSegment(s.key)}
          >
            {s.icon && <Icon name={s.icon} size={13} strokeWidth={2.25} />}
            {s.label}
          </button>
        ))}
        <span className="filter-bar__count">{visible.length} shown</span>
      </div>

      {toast && <div className="alert alert--success">{toast}</div>}

      {loading ? (
        <div className="empty">Loading prospects…</div>
      ) : prospects.length === 0 ? (
        <div className="empty">
          <p>No prospects yet.</p>
          <Link className="btn btn--primary" to="/profile">
            Import connections →
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>No prospects match these filters.</p>
          <button
            className="btn btn--ghost btn--on-light"
            onClick={() => {
              setSearch('');
              setSegments(new Set());
              setMinScore(0);
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="prospect-list">
            {visible.slice(0, RENDER_LIMIT).map((p) => (
              <ProspectCard
                key={p.id}
                prospect={p}
                referred={referredIds.has(p.id)}
                onRefer={openOutreach}
                onEdit={setEditTarget}
              />
            ))}
          </div>
          {visible.length > RENDER_LIMIT && (
            <p className="muted small list-cap-note">
              Showing the top {RENDER_LIMIT} of {visible.length}. Use search or the filters above to
              narrow down.
            </p>
          )}
        </>
      )}

      {target && (
        <Modal
          title={`Reach out to ${firstNameOf(target.contact_name)}`}
          onClose={() => setTarget(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setTarget(null)} disabled={submitting}>
                Cancel
              </button>
              <button className="btn btn--primary" onClick={addToPipeline} disabled={submitting}>
                {submitting ? 'Adding…' : 'Add to pipeline →'}
              </button>
            </>
          }
        >
          <p className="muted">
            Here’s a ready-to-send ask for <strong>{target.contact_name}</strong>
            {target.company ? ` (${target.company})` : ''}. Edit it, then copy/send and add them to
            your pipeline to track follow-up.
          </p>

          <textarea
            className="outreach-message"
            rows={10}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {draftNote && <p className="muted small outreach-note">{draftNote}</p>}

          <div className="outreach-actions">
            {aiEnabled && (
              <button
                className="btn btn--sm btn--ghost btn--on-light"
                type="button"
                onClick={draftWithAI}
                disabled={drafting}
                title="Write a personalized draft in your voice from what we know about this contact"
              >
                <Icon name="sparkles" size={14} /> {drafting ? 'Drafting…' : 'Draft in my voice'}
              </button>
            )}
            <button className="btn btn--sm btn--primary" type="button" onClick={copyMessage}>
              <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy message'}
            </button>
            {target.linkedin_url && (
              <a className="btn btn--sm btn--linkedin" href={target.linkedin_url} target="_blank" rel="noreferrer">
                <Icon name="linkedin" size={14} /> LinkedIn
              </a>
            )}
            {target.contact_email && (
              <a className="btn btn--sm btn--ghost btn--on-light" href={mailtoLink(target.contact_email, message)}>
                <Icon name="mail" size={14} /> Email
              </a>
            )}
          </div>
          <p className="muted small outreach-note">
            LinkedIn can’t pre-fill a message, so it opens their profile. Paste the copied text into a
            message there.
          </p>
        </Modal>
      )}

      {editTarget && (
        <EditProspectModal
          prospect={editTarget}
          onClose={() => setEditTarget(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
