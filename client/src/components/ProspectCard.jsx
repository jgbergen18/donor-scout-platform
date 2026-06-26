import { memo, useState } from 'react';
import api from '../api';
import Icon from './Icon';
import ReasonTag from './ReasonTag';

function scoreClass(score) {
  if (score >= 45) return 'score--high';
  if (score >= 22) return 'score--mid';
  return 'score--low';
}

// Capacity sizes the ask, it doesn't drive the rank — shown as a separate badge.
function capacityInfo(score) {
  if (score >= 50) return { level: 'high', label: 'High capacity' };
  if (score >= 25) return { level: 'medium', label: 'Medium capacity' };
  return { level: 'modest', label: 'Modest capacity' };
}

const CONF_SHORT = { confirmed: '✓ verified', medium: '~ unverified', low: '⚠ check match' };

const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

function ProspectCard({ prospect, referred, onRefer, onEdit }) {
  const p = prospect;
  const cap = capacityInfo(p.capacity_score || 0);

  // AI dossier — self-contained per card. Seeded from the prospect payload so a
  // previously-generated dossier shows without a refetch; generated on demand.
  const [dossier, setDossier] = useState(p.dossier || null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate(refresh = false) {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post(`/api/connections/${p.id}/dossier`, { refresh });
      setDossier(data.dossier);
      setOpen(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate the dossier.');
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  function onDossierClick() {
    if (loading) return;
    if (dossier) setOpen((o) => !o);
    else generate(false);
  }

  return (
    <article className="prospect-card">
      <div className={`prospect-card__score ${scoreClass(p.donor_likelihood_score)}`}>
        <span className="prospect-card__score-num">{p.donor_likelihood_score}</span>
        <span className="prospect-card__score-label">score</span>
      </div>

      <div className="prospect-card__main">
        <h3 className="prospect-card__name">{p.contact_name || 'Unnamed contact'}</h3>
        <p className="prospect-card__role">
          {p.role || 'Unknown role'}
          {p.company ? ' · ' : ''}
          {p.company && <strong>{p.company}</strong>}
        </p>

        {p.score_reasons?.length > 0 && (
          <div className="reason-tags">
            {p.score_reasons.map((r, i) => (
              <ReasonTag key={i} text={r} />
            ))}
          </div>
        )}

        <div className="prospect-card__tags">
          <span
            className={`cap-badge cap-badge--${cap.level}`}
            title="Suggested ask size (company, seniority, GitHub). Does not affect the rank."
          >
            <Icon name="dollar" size={11} strokeWidth={2.25} /> {cap.label}
          </span>
          {p.location && (
            <span className="tag tag--muted">
              <Icon name="pin" size={11} strokeWidth={2.25} /> {p.location}
            </span>
          )}
        </div>

        <div className="prospect-card__github">
          {p.github_username ? (
            <a
              href={`https://github.com/${p.github_username}`}
              target="_blank"
              rel="noreferrer"
              className="gh-link"
            >
              <span className="gh-dot" /> @{p.github_username}
            </a>
          ) : (
            <span className="gh-link gh-link--none">No GitHub match</span>
          )}
          {p.github_username && (
            <span className="prospect-card__gh-stats">
              {p.github_followers.toLocaleString()} followers · {p.github_repos} repos
            </span>
          )}
          {p.github_username && p.github_confidence && p.github_confidence !== 'high' && (
            <span className={`conf-badge conf-badge--${p.github_confidence}`}>
              {CONF_SHORT[p.github_confidence] || p.github_confidence}
            </span>
          )}
        </div>
      </div>

      <div className="prospect-card__action">
        {referred ? (
          <span className="btn btn--referred" aria-disabled="true">
            ✓ In pipeline
          </span>
        ) : (
          <button className="btn btn--primary" onClick={() => onRefer(p)}>
            Reach out
          </button>
        )}
        <button
          className={`card-ai-btn${dossier ? ' card-ai-btn--ready' : ''}`}
          onClick={onDossierClick}
          disabled={loading}
          title="Generate an AI donor dossier from what we know about this contact"
        >
          <Icon name="sparkles" size={13} />{' '}
          {loading ? 'Thinking…' : dossier ? (open ? 'Hide dossier' : 'View dossier') : 'AI dossier'}
        </button>
        <button className="card-edit-btn" onClick={() => onEdit(p)} title="Edit / fix GitHub match">
          <Icon name="edit" size={13} /> Edit
        </button>
      </div>

      {open && (
        <div className="prospect-card__dossier">
          {error ? (
            <p className="dossier__error">{error}</p>
          ) : dossier ? (
            <>
              <div className="dossier__head">
                <span className="dossier__title">
                  <Icon name="sparkles" size={13} /> AI dossier
                </span>
                <span className={`conf-badge conf-badge--${dossier.confidence}`}>
                  {CONF_LABEL[dossier.confidence] || dossier.confidence}
                </span>
              </div>
              <p className="dossier__summary">{dossier.summary}</p>

              <div className="dossier__field">
                <span className="dossier__label">Why they might give</span>
                <p>{dossier.whyTheyMightGive}</p>
              </div>
              <div className="dossier__field">
                <span className="dossier__label">Suggested ask</span>
                <p>{dossier.suggestedAsk}</p>
              </div>
              {dossier.conversationHooks?.length > 0 && (
                <div className="dossier__field">
                  <span className="dossier__label">Conversation hooks</span>
                  <ul className="dossier__hooks">
                    {dossier.conversationHooks.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="dossier__foot">
                <button
                  className="dossier__regen"
                  onClick={() => generate(true)}
                  disabled={loading}
                  type="button"
                >
                  {loading ? 'Regenerating…' : '↻ Regenerate'}
                </button>
                <span className="muted small">AI-generated from known facts. Verify before acting.</span>
              </div>
            </>
          ) : (
            <p className="muted small">Generating…</p>
          )}
        </div>
      )}
    </article>
  );
}

// Memoized so cards don't re-render when only modal/search state changes — critical
// with hundreds of prospects (a single keystroke in the outreach box re-rendered all).
export default memo(ProspectCard);
