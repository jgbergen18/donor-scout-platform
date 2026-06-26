import { useEffect, useState } from 'react';
import api from '../api';
import { useOrg } from '../OrgContext';

// Organization onboarding + settings.
//
// - Every scout belongs to an org (the seeded "default" org if they never opt in).
// - A scout can CREATE a new org (becomes owner) or JOIN one by invite code.
//   Joining requires an empty account (no connections/referrals) — the server
//   enforces this with a 409, surfaced here as a clear message.
// - owner/admin additionally see the member list with role management, the org
//   join code (with rotate), and the per-org default fundraising strategy.
//
// The strategy PICKER for an individual scout lives in StrategyPicker.jsx; here
// owner/admin set the org-level default that new members inherit.
const STRATEGY_OPTIONS = [
  ['relationship_first', 'Relationship-first (Recommended)'],
  ['capacity_first', 'Capacity-first'],
  ['cause_fit', 'Cause-fit'],
  ['balanced', 'Balanced'],
  ['custom_weights', 'Custom weights'],
];

export default function OrgSettings() {
  const [org, setOrg] = useState(null);
  const [memberCount, setMemberCount] = useState(0);
  const [members, setMembers] = useState([]);
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Per-org cause/branding editor (owner/admin). Seeded from the live OrgContext
  // view (`brand`, kept distinct from the `org` payload above); saving PATCHes
  // /api/orgs/config then reloads so the whole app + agent rebrand.
  const brand = useOrg();
  const [causeForm, setCauseForm] = useState(() => ({
    donateUrl: brand.donateUrl || '',
    programCost: brand.programCost || '',
    dayCost: brand.dayCost || '',
    beneficiary: brand.beneficiary || '',
    beneficiaries: brand.beneficiaries || '',
    programLabel: brand.programUnit || '',
    dayLabel: brand.dayUnit || '',
  }));
  // Custom matching-gift companies (owner/admin) on top of the built-in list.
  const [matchCompanies, setMatchCompanies] = useState([]);
  const [matchBuiltIn, setMatchBuiltIn] = useState(0);
  const [matchInput, setMatchInput] = useState('');
  const [matchBusy, setMatchBusy] = useState(false);
  // Email-invitation panel (owner/admin only).
  const [invites, setInvites] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState(''); // dev convenience
  // Audit log viewer (owner/admin only) — the operator transparency surface.
  const [audit, setAudit] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);
  const AUDIT_PAGE = 25;
  // Single sign-on (Okta) — owner/admin only. The stored client secret is
  // WRITE-ONLY: the API never returns it (only `hasClientSecret`), so the field
  // stays blank and submitting it empty keeps the existing secret unchanged.
  const [sso, setSso] = useState(null); // { config, domains, redirectUri }
  const [ssoForm, setSsoForm] = useState({ issuer: '', clientId: '', clientSecret: '', jitProvisioning: false, enforced: false });
  const [groupRows, setGroupRows] = useState([]); // [{ group, role }]
  const [ssoBusy, setSsoBusy] = useState(false);
  const [newDomain, setNewDomain] = useState('');

  const isAdmin = org && (org.role === 'owner' || org.role === 'admin');

  async function loadInvites() {
    try {
      const { data } = await api.get('/api/orgs/invitations');
      setInvites(data.invitations || []);
    } catch {
      setInvites([]);
    }
  }

  // Load the org's audit log (newest-first, paginated). offset extends the list.
  async function loadAudit(offset = 0) {
    try {
      const { data } = await api.get(`/api/orgs/audit?limit=${AUDIT_PAGE}&offset=${offset}`);
      setAudit((prev) => (offset === 0 ? data.entries : [...prev, ...data.entries]));
      setAuditTotal(data.total || 0);
    } catch {
      setAudit([]);
      setAuditTotal(0);
    }
  }

  function toggleAudit() {
    const open = !auditOpen;
    setAuditOpen(open);
    if (open && audit.length === 0) loadAudit(0);
  }

  // Load the SSO config + domains and seed the editable form. The secret is never
  // returned by the API, so the secret field is always seeded blank.
  async function loadSso() {
    try {
      const { data } = await api.get('/api/orgs/sso');
      setSso(data);
      const c = data.config;
      setSsoForm({
        issuer: c?.issuer || '',
        clientId: c?.clientId || '',
        clientSecret: '', // write-only — never populated from the server
        jitProvisioning: !!c?.jitProvisioning,
        enforced: !!c?.enforced,
      });
      setGroupRows(
        c?.groupRoleMap
          ? Object.entries(c.groupRoleMap).map(([group, role]) => ({ group, role }))
          : []
      );
    } catch {
      setSso({ config: null, domains: [], redirectUri: '' });
    }
  }

  async function load() {
    try {
      const { data } = await api.get('/api/orgs/me');
      setOrg(data.org);
      setMemberCount(data.memberCount);
      try {
        const mc = await api.get('/api/match-companies');
        setMatchCompanies(mc.data.companies);
        setMatchBuiltIn(mc.data.builtInCount);
      } catch {
        /* ignore */
      }
      if (data.org && (data.org.role === 'owner' || data.org.role === 'admin')) {
        try {
          const m = await api.get('/api/orgs/members');
          setMembers(m.data.members);
        } catch {
          setMembers([]);
        }
        await loadInvites();
        await loadSso();
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(setter, text) {
    setter(text);
    setTimeout(() => setter(''), 4000);
  }

  async function addMatchCompany(e) {
    e.preventDefault();
    const name = matchInput.trim();
    if (!name) return;
    setMatchBusy(true);
    try {
      const { data } = await api.post('/api/match-companies', { name });
      setMatchCompanies(data.companies);
      setMatchInput('');
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not add that company.');
    } finally {
      setMatchBusy(false);
    }
  }
  async function removeMatchCompany(id) {
    try {
      const { data } = await api.delete(`/api/match-companies/${id}`);
      setMatchCompanies(data.companies);
    } catch {
      /* ignore */
    }
  }
  // Parse a pasted/uploaded CSV (or one-name-per-line list) → unique company names,
  // taking the first column and skipping an obvious header row.
  function parseCsvNames(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const names = lines.map((l) => l.split(',')[0].replace(/^"|"$/g, '').trim()).filter(Boolean);
    if (names.length && /^(company|companies|name|names|employer|employers|organization)s?$/i.test(names[0])) names.shift();
    return [...new Set(names)];
  }
  async function onMatchCsv(file) {
    if (!file) return;
    setMatchBusy(true);
    try {
      const names = parseCsvNames(await file.text());
      if (!names.length) {
        flash(setErr, 'No company names found in that file.');
        return;
      }
      const { data } = await api.post('/api/match-companies/bulk', { names });
      setMatchCompanies(data.companies);
      flash(setMsg, `Added ${data.added} compan${data.added === 1 ? 'y' : 'ies'}.`);
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not import that file.');
    } finally {
      setMatchBusy(false);
    }
  }

  async function createOrg(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/orgs', { name: name.trim() });
      setName('');
      flash(setMsg, 'Organization created. You are the owner.');
      await load();
    } catch (e2) {
      setErr(e2.response?.data?.error || 'Could not create organization.');
    } finally {
      setBusy(false);
    }
  }

  async function joinOrg(e) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/orgs/join', { code: joinCode.trim() });
      setJoinCode('');
      flash(setMsg, 'Joined the organization.');
      await load();
    } catch (e2) {
      setErr(e2.response?.data?.error || 'Could not join that organization.');
    } finally {
      setBusy(false);
    }
  }

  async function rotateCode() {
    setBusy(true);
    try {
      const { data } = await api.post('/api/orgs/join-code/rotate');
      setOrg((o) => ({ ...o, joinCode: data.joinCode }));
      flash(setMsg, 'New join code generated.');
    } catch {
      setErr('Could not rotate the code.');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(memberId, role) {
    try {
      const { data } = await api.patch(`/api/orgs/members/${memberId}`, { role });
      setMembers(data.members);
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not change role.');
    }
  }

  async function sendInvite(e) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteBusy(true);
    setErr('');
    setInviteLink('');
    try {
      const { data } = await api.post('/api/orgs/invitations', { email, role: inviteRole });
      setInviteEmail('');
      flash(setMsg, `Invitation sent to ${email}.`);
      // Dev convenience: server echoes devToken only outside production.
      if (data?.devToken) {
        setInviteLink(`${window.location.origin}/invite?token=${data.devToken}`);
      }
      await loadInvites();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not send the invitation.');
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(id) {
    try {
      await api.delete(`/api/orgs/invitations/${id}`);
      flash(setMsg, 'Invitation revoked.');
      await loadInvites();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not revoke the invitation.');
    }
  }

  async function setMemberActive(memberId, active) {
    try {
      const { data } = await api.patch(`/api/orgs/members/${memberId}/active`, { active });
      setMembers(data.members);
      flash(setMsg, active ? 'Member reactivated.' : 'Member deactivated.');
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not update the member.');
    }
  }

  // ── Single sign-on (Okta) ────────────────────────────────────────
  function setGroupRow(i, patch) {
    setGroupRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addGroupRow() {
    setGroupRows((rows) => [...rows, { group: '', role: 'member' }]);
  }
  function removeGroupRow(i) {
    setGroupRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function saveSso(e) {
    e.preventDefault();
    setSsoBusy(true);
    setErr('');
    // Build the group→role map from the editable rows (skip blank group names).
    const groupRoleMap = {};
    for (const { group, role } of groupRows) {
      const g = group.trim();
      if (g) groupRoleMap[g] = role;
    }
    const payload = {
      issuer: ssoForm.issuer.trim(),
      clientId: ssoForm.clientId.trim(),
      jitProvisioning: ssoForm.jitProvisioning,
      enforced: ssoForm.enforced,
      groupRoleMap,
    };
    // Only send the secret when the admin actually typed one — an empty field
    // means "keep the existing secret" (write-only; the API never returns it).
    if (ssoForm.clientSecret) payload.clientSecret = ssoForm.clientSecret;
    try {
      await api.put('/api/orgs/sso', payload);
      flash(setMsg, 'SSO configuration saved.');
      await loadSso();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not save SSO configuration.');
    } finally {
      setSsoBusy(false);
    }
  }

  async function removeSso() {
    if (!window.confirm('Remove SSO configuration? Members can still sign in with email/LinkedIn.')) return;
    try {
      await api.delete('/api/orgs/sso');
      flash(setMsg, 'SSO configuration removed.');
      await loadSso();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not remove SSO configuration.');
    }
  }

  async function addDomain(e) {
    e.preventDefault();
    const domain = newDomain.trim();
    if (!domain) return;
    try {
      await api.post('/api/orgs/sso/domains', { domain });
      setNewDomain('');
      flash(setMsg, 'Domain added. Verify it to route SSO.');
      await loadSso();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not add the domain.');
    }
  }

  async function verifyDomain(id) {
    try {
      await api.post(`/api/orgs/sso/domains/${id}/verify`);
      flash(setMsg, 'Domain verified.');
      await loadSso();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not verify the domain.');
    }
  }

  async function removeDomain(id) {
    try {
      await api.delete(`/api/orgs/sso/domains/${id}`);
      flash(setMsg, 'Domain removed.');
      await loadSso();
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not remove the domain.');
    }
  }

  async function setDefaultStrategy(strategy) {
    try {
      const { data } = await api.patch('/api/orgs/config', { defaultStrategy: strategy });
      setOrg((o) => ({ ...o, defaultStrategy: data.config.defaultStrategy }));
      flash(setMsg, 'Org default strategy updated.');
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not update strategy.');
    }
  }

  async function saveCause(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch('/api/orgs/config', {
        donateUrl: causeForm.donateUrl,
        impact: {
          programCost: Number(causeForm.programCost) || 0,
          dayCost: Number(causeForm.dayCost) || 0,
          beneficiary: causeForm.beneficiary,
          beneficiaries: causeForm.beneficiaries,
          programLabel: causeForm.programLabel,
          dayLabel: causeForm.dayLabel,
        },
      });
      // Branding lives on user.cause (from /api/auth/me); reload so the provider
      // re-fetches it and the whole app + donate links rebrand at once.
      flash(setMsg, 'Branding saved. Reloading to apply…');
      setTimeout(() => window.location.reload(), 700);
    } catch (e2) {
      flash(setErr, e2.response?.data?.error || 'Could not save branding.');
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Your organization</h2>
      <p className="muted">
        Donor Scout is multi-tenant: each nonprofit is its own organization, and your connections,
        pipeline, and donor data are visible only to people in your org.
      </p>

      {org && (
        <div className="org-current">
          <p>
            You are in <strong>{org.name}</strong> as <strong>{org.role}</strong> · {memberCount}{' '}
            member{memberCount === 1 ? '' : 's'}
          </p>
          {isAdmin && org.joinCode && (
            <p className="muted">
              Invite code: <code>{org.joinCode}</code>{' '}
              <button className="btn btn--ghost btn--sm" onClick={rotateCode} disabled={busy}>
                Rotate
              </button>
            </p>
          )}
          {isAdmin && (
            <label className="field">
              <span>Org default strategy (new members inherit this)</span>
              <select
                value={org.defaultStrategy || 'relationship_first'}
                onChange={(e) => setDefaultStrategy(e.target.value)}
              >
                {STRATEGY_OPTIONS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {isAdmin && (
        <form className="card org-cause-form" onSubmit={saveCause}>
          <h3>Cause &amp; branding</h3>
          <p className="muted small">
            How your nonprofit appears across the app: your public donation link and the impact
            economics (“$X funds one ___”). Saving re-scores prospects and reloads to apply.
          </p>
          <label className="field">
            <span>Donation link (https)</span>
            <input
              type="url"
              value={causeForm.donateUrl}
              onChange={(e) => setCauseForm({ ...causeForm, donateUrl: e.target.value })}
              placeholder="https://www.zeffy.com/en-US/donation-form/…"
            />
          </label>
          <div className="org-cause-grid">
            <label className="field">
              <span>Cost to fund one beneficiary (USD)</span>
              <input type="number" min="0" value={causeForm.programCost} onChange={(e) => setCauseForm({ ...causeForm, programCost: e.target.value })} />
            </label>
            <label className="field">
              <span>Cost of one day (USD)</span>
              <input type="number" min="0" value={causeForm.dayCost} onChange={(e) => setCauseForm({ ...causeForm, dayCost: e.target.value })} />
            </label>
            <label className="field">
              <span>Beneficiary (singular)</span>
              <input value={causeForm.beneficiary} placeholder="student" onChange={(e) => setCauseForm({ ...causeForm, beneficiary: e.target.value })} />
            </label>
            <label className="field">
              <span>Beneficiaries (plural)</span>
              <input value={causeForm.beneficiaries} placeholder="students" onChange={(e) => setCauseForm({ ...causeForm, beneficiaries: e.target.value })} />
            </label>
            <label className="field">
              <span>Program unit</span>
              <input value={causeForm.programLabel} placeholder="bootcamp" onChange={(e) => setCauseForm({ ...causeForm, programLabel: e.target.value })} />
            </label>
            <label className="field">
              <span>Day unit</span>
              <input value={causeForm.dayLabel} placeholder="day of camp" onChange={(e) => setCauseForm({ ...causeForm, dayLabel: e.target.value })} />
            </label>
          </div>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
            Save branding
          </button>
        </form>
      )}

      {isAdmin && (
        <div className="card org-match-card">
          <h3>Matching-gift companies</h3>
          <p className="muted small">
            {matchBuiltIn}+ large employers are detected automatically. Add your donors' employers
            here (or upload a CSV, one company per line) and they'll surface in the “Double their
            gift” list on Today.
          </p>
          <form className="org-match-add" onSubmit={addMatchCompany}>
            <input
              value={matchInput}
              onChange={(e) => setMatchInput(e.target.value)}
              placeholder="e.g. Acme Corporation"
              maxLength={120}
            />
            <button type="submit" className="btn btn--sm btn--primary" disabled={matchBusy}>
              Add
            </button>
            <label className="btn btn--sm btn--ghost org-match-csv">
              Upload CSV
              <input
                type="file"
                accept=".csv,.txt"
                hidden
                disabled={matchBusy}
                onChange={(e) => {
                  onMatchCsv(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </form>
          {matchCompanies.length > 0 ? (
            <div className="org-match-list">
              {matchCompanies.map((m) => (
                <span className="org-match-chip" key={m.id}>
                  {m.name}
                  <button
                    type="button"
                    className="org-match-chip__x"
                    title="Remove"
                    onClick={() => removeMatchCompany(m.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted small">No custom companies yet. The built-in list still applies.</p>
          )}
        </div>
      )}

      {isAdmin && members.length > 0 && (
        <div className="org-members">
          <h3>Members</h3>
          <ul className="org-member-list">
            {members.map((m) => {
              const inactive = m.active === 0 || m.active === false;
              // Only an owner can (de)activate an owner; admins manage members and
              // other admins. The server still enforces the sole-owner guard (409).
              const canToggle = m.role !== 'owner' || org.role === 'owner';
              return (
                <li key={m.id} style={inactive ? { opacity: 0.6 } : undefined}>
                  <span>
                    {m.name} <span className="muted">({m.email})</span>
                    {inactive && <span className="muted"> · deactivated</span>}
                  </span>
                  <span className="org-member-actions">
                    {org.role === 'owner' ? (
                      <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)}>
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                        <option value="owner">owner</option>
                      </select>
                    ) : (
                      <span className="muted">{m.role}</span>
                    )}
                    {canToggle && (
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => setMemberActive(m.id, inactive)}
                      >
                        {inactive ? 'Reactivate' : 'Deactivate'}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isAdmin && (
        <div className="org-invites">
          <h3>Invite teammates by email</h3>
          <p className="muted">
            Send a one-time link that signs the person in and adds them to this org with the role you
            pick. Owners can’t be invited. Promote an existing member to owner instead.
          </p>
          <form className="org-invite-form" onSubmit={sendInvite}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={inviteEmail}
                placeholder="teammate@example.org"
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button className="btn btn--primary" type="submit" disabled={inviteBusy || !inviteEmail.trim()}>
              {inviteBusy ? 'Sending…' : 'Send invitation'}
            </button>
          </form>

          {inviteLink && (
            <p className="muted small">
              Dev mode (no mail provider): <a href={inviteLink}>{inviteLink}</a>
            </p>
          )}

          {invites.length > 0 && (
            <ul className="org-member-list">
              {invites.map((inv) => (
                <li key={inv.id}>
                  <span>
                    {inv.email} <span className="muted">({inv.role})</span>
                  </span>
                  <button className="btn btn--ghost btn--sm" onClick={() => revokeInvite(inv.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="org-audit">
          <h3>
            Audit log{' '}
            <button className="btn btn--ghost btn--sm" onClick={toggleAudit}>
              {auditOpen ? 'Hide' : 'View'}
            </button>
          </h3>
          {auditOpen && (
            <>
              <p className="muted small">
                Append-only record of significant actions in your org (logins, role changes,
                invitations, exports, deletions). Never contains tokens or secrets.
              </p>
              {audit.length === 0 ? (
                <p className="muted small">No audit entries yet.</p>
              ) : (
                <ul className="org-member-list">
                  {audit.map((e) => (
                    <li key={e.id}>
                      <span>
                        <code>{e.action}</code>
                        {e.target ? <span className="muted"> · {e.target}</span> : null}
                      </span>
                      <span className="muted small">
                        {e.actorUserId ? `user ${e.actorUserId} · ` : ''}
                        {e.createdAt}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {audit.length < auditTotal && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => loadAudit(audit.length)}
                >
                  Load more ({auditTotal - audit.length} older)
                </button>
              )}
            </>
          )}
        </div>
      )}

      {isAdmin && sso && (
        <div className="org-sso">
          <h3>Single sign-on (Okta)</h3>
          <p className="muted">
            Let your team sign in through your own Okta (OIDC). Configure your Okta app below and
            verify the email domains your members use. People with a verified domain are routed to
            your Okta automatically from the login page.
          </p>

          {sso.config ? (
            <p className="muted small">
              SSO is <strong>configured</strong>
              {sso.config.enforced ? ' and ENFORCED (non-SSO logins are disabled for members)' : ''}.
              {sso.config.hasClientSecret ? ' A client secret is stored.' : ' No client secret stored yet.'}
            </p>
          ) : (
            <p className="muted small">SSO is not configured yet.</p>
          )}

          {sso.redirectUri && (
            <p className="muted small">
              Redirect URI to allow-list in your Okta app:{' '}
              <code>{sso.redirectUri}</code>
            </p>
          )}

          <form className="org-form" onSubmit={saveSso}>
            <label className="field">
              <span>Issuer (Okta domain URL)</span>
              <input
                type="url"
                value={ssoForm.issuer}
                placeholder="https://your-org.okta.com"
                onChange={(e) => setSsoForm((f) => ({ ...f, issuer: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Client ID</span>
              <input
                type="text"
                value={ssoForm.clientId}
                placeholder="0oaXXXXXXXXXXXX"
                onChange={(e) => setSsoForm((f) => ({ ...f, clientId: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>
                Client secret{' '}
                <span className="muted">
                  (write-only, never displayed
                  {sso.config?.hasClientSecret ? '; leave blank to keep the stored secret' : ''})
                </span>
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={ssoForm.clientSecret}
                placeholder={sso.config?.hasClientSecret ? '•••••••• (stored)' : 'Paste the Okta client secret'}
                onChange={(e) => setSsoForm((f) => ({ ...f, clientSecret: e.target.value }))}
              />
            </label>

            <fieldset className="org-sso-groups">
              <legend>Okta group → role mapping</legend>
              <p className="muted small">
                Map an Okta group name to an app role. On each login the highest-matching role is
                applied. Unmapped users get <code>member</code>.
              </p>
              {groupRows.map((row, i) => (
                <div className="org-sso-group-row" key={i}>
                  <input
                    type="text"
                    value={row.group}
                    placeholder="Okta group (e.g. donorscout-admins)"
                    onChange={(e) => setGroupRow(i, { group: e.target.value })}
                  />
                  <select value={row.role} onChange={(e) => setGroupRow(i, { role: e.target.value })}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => removeGroupRow(i)}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn--ghost btn--sm" onClick={addGroupRow}>
                Add group mapping
              </button>
            </fieldset>

            <label className="field field--check">
              <input
                type="checkbox"
                checked={ssoForm.jitProvisioning}
                onChange={(e) => setSsoForm((f) => ({ ...f, jitProvisioning: e.target.checked }))}
              />
              <span>
                Just-in-time provisioning: create a member on first SSO login (otherwise the user
                needs a pending invitation).
              </span>
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={ssoForm.enforced}
                onChange={(e) => setSsoForm((f) => ({ ...f, enforced: e.target.checked }))}
              />
              <span>
                Enforce SSO: disable email/LinkedIn sign-in for this org’s members (only enable
                once SSO works).
              </span>
            </label>

            <div className="org-sso-actions">
              <button className="btn btn--primary" type="submit" disabled={ssoBusy}>
                {ssoBusy ? 'Saving…' : 'Save SSO configuration'}
              </button>
              {sso.config && (
                <button type="button" className="btn btn--ghost" onClick={removeSso}>
                  Remove SSO
                </button>
              )}
            </div>
          </form>

          <div className="org-sso-domains">
            <h4>Email domains</h4>
            <p className="muted small">
              Only <strong>verified</strong> domains route members to your Okta. A domain can be
              claimed by one org only.
            </p>
            <form className="org-invite-form" onSubmit={addDomain}>
              <label className="field">
                <span>Add a domain</span>
                <input
                  type="text"
                  value={newDomain}
                  placeholder="acme.org"
                  onChange={(e) => setNewDomain(e.target.value)}
                />
              </label>
              <button className="btn btn--primary" type="submit" disabled={!newDomain.trim()}>
                Add domain
              </button>
            </form>
            {sso.domains.length > 0 && (
              <ul className="org-member-list">
                {sso.domains.map((d) => {
                  const verified = d.verified === 1 || d.verified === true;
                  return (
                    <li key={d.id}>
                      <span>
                        <code>{d.domain}</code>{' '}
                        <span className="muted">{verified ? '· verified' : '· unverified'}</span>
                      </span>
                      <span className="org-member-actions">
                        {!verified && (
                          <button className="btn btn--ghost btn--sm" onClick={() => verifyDomain(d.id)}>
                            Verify
                          </button>
                        )}
                        <button className="btn btn--ghost btn--sm" onClick={() => removeDomain(d.id)}>
                          Remove
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="org-onboarding">
        <form className="org-form" onSubmit={createOrg}>
          <h3>Create a new organization</h3>
          <label className="field">
            <span>Organization name</span>
            <input
              type="text"
              value={name}
              placeholder="e.g. Helping Hands Foundation"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
            Create &amp; become owner
          </button>
        </form>

        <form className="org-form" onSubmit={joinOrg}>
          <h3>Join with an invite code</h3>
          <p className="muted">You can only join from an empty account (no connections yet).</p>
          <label className="field">
            <span>Invite code</span>
            <input
              type="text"
              value={joinCode}
              placeholder="ORG-XXXXXX"
              onChange={(e) => setJoinCode(e.target.value)}
            />
          </label>
          <button className="btn" type="submit" disabled={busy || !joinCode.trim()}>
            Join organization
          </button>
        </form>
      </div>

      {msg && <div className="alert alert--success">{msg}</div>}
      {err && <div className="alert alert--error">{err}</div>}
    </section>
  );
}
