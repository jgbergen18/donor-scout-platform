import { useState } from 'react';
import api from '../api';
import Modal from './Modal';

const CONF_LABEL = {
  confirmed: '✓ Verified',
  high: 'High confidence',
  medium: '~ Unverified',
  low: '⚠ Likely wrong',
};

export default function EditProspectModal({ prospect, onClose, onChanged }) {
  const [current, setCurrent] = useState(prospect);
  const [form, setForm] = useState({
    contact_name: prospect.contact_name || '',
    company: prospect.company || '',
    role: prospect.role || '',
    location: prospect.location || '',
    contact_email: prospect.contact_email || '',
  });
  const [relink, setRelink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function saveFields() {
    setBusy('save');
    setError('');
    try {
      const { data } = await api.patch(`/api/connections/${prospect.id}`, form);
      setCurrent(data.connection);
      onChanged?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save.');
    } finally {
      setBusy('');
    }
  }

  async function github(action) {
    setBusy('gh');
    setError('');
    const body =
      action === 'relink' ? { username: relink } : action === 'confirm' ? { confirm: true } : { clear: true };
    try {
      const { data } = await api.patch(`/api/connections/${prospect.id}/github`, body);
      setCurrent(data.connection);
      setRelink('');
      onChanged?.();
    } catch (e) {
      setError(e.response?.data?.error || 'GitHub update failed.');
    } finally {
      setBusy('');
    }
  }

  async function del() {
    setBusy('del');
    setError('');
    try {
      await api.delete(`/api/connections/${prospect.id}`);
      onChanged?.();
      onClose?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not delete.');
      setBusy('');
    }
  }

  const gh = current;

  return (
    <Modal
      title={`Edit ${prospect.contact_name || 'prospect'}`}
      onClose={onClose}
      footer={
        <>
          {confirmDelete ? (
            <button className="btn btn--sm btn--danger" onClick={del} disabled={busy === 'del'}>
              {busy === 'del' ? 'Deleting…' : 'Confirm delete'}
            </button>
          ) : (
            <button className="btn btn--sm btn--danger-text" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          <span className="footer-spacer" />
          <button className="btn btn--ghost btn--on-light" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" onClick={saveFields} disabled={busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="edit-grid">
        <label className="field"><span>Name</span><input value={form.contact_name} onChange={set('contact_name')} /></label>
        <label className="field"><span>Company</span><input value={form.company} onChange={set('company')} /></label>
        <label className="field"><span>Role</span><input value={form.role} onChange={set('role')} /></label>
        <label className="field"><span>Location</span><input value={form.location} onChange={set('location')} /></label>
        <label className="field field--wide"><span>Email</span><input value={form.contact_email} onChange={set('contact_email')} /></label>
      </div>

      <div className="gh-manage">
        <div className="gh-manage__head">
          <strong>GitHub match</strong>
          {gh.github_username && gh.github_confidence && (
            <span className={`conf-badge conf-badge--${gh.github_confidence}`}>
              {CONF_LABEL[gh.github_confidence] || gh.github_confidence}
            </span>
          )}
        </div>

        {gh.github_username ? (
          <p className="muted small">
            <a href={`https://github.com/${gh.github_username}`} target="_blank" rel="noreferrer">
              @{gh.github_username}
            </a>
            {' · '}
            {(gh.github_followers || 0).toLocaleString()} followers · {gh.github_repos || 0} repos
            {(gh.github_confidence === 'low' || gh.github_confidence === 'medium') &&
              '. Unverified, so it isn’t counting toward the score. Confirm if right, or fix below.'}
          </p>
        ) : (
          <p className="muted small">No GitHub match. Add one below if you know their username.</p>
        )}

        <div className="gh-manage__actions">
          {gh.github_username && gh.github_confidence !== 'confirmed' && (
            <button className="btn btn--sm btn--primary" onClick={() => github('confirm')} disabled={busy === 'gh'}>
              Confirm match
            </button>
          )}
          {gh.github_username && (
            <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => github('clear')} disabled={busy === 'gh'}>
              Clear match
            </button>
          )}
        </div>

        <div className="gh-relink">
          <span className="gh-relink__at">@</span>
          <input
            placeholder="correct-github-username"
            value={relink}
            onChange={(e) => setRelink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && relink.trim() && github('relink')}
          />
          <button className="btn btn--sm btn--primary" onClick={() => github('relink')} disabled={busy === 'gh' || !relink.trim()}>
            Relink
          </button>
        </div>
      </div>

      {confirmDelete && (
        <p className="muted small">
          Deleting removes this prospect from your list. Any pipeline entry for them stays.
        </p>
      )}
      {error && <div className="alert alert--error">{error}</div>}
    </Modal>
  );
}
