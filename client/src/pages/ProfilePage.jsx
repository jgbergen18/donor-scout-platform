import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { money } from '../api';
import Icon from '../components/Icon';
import OrgSettings from '../components/OrgSettings';
import StrategyPicker from '../components/StrategyPicker';
import { parseConnectionsCsv, parseMessagesCsv, parseDonationsCsv, donationsFromRows } from '../csv';

export default function ProfilePage() {
  // profile
  const [company, setCompany] = useState('');
  const [pastCompanies, setPastCompanies] = useState('');
  const [city, setCity] = useState('');
  const [schools, setSchools] = useState('');
  const [goal, setGoal] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState('');
  // import
  const [contacts, setContacts] = useState([]);
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  // donation sync (Zeffy)
  const [donors, setDonors] = useState([]);
  const [donorFile, setDonorFile] = useState('');
  const [donorParsing, setDonorParsing] = useState(false);
  const [donorExcluded, setDonorExcluded] = useState(0);
  const [donorCampaigns, setDonorCampaigns] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState('');
  // Reconcile Review: per-session set of resolved unmatched-row indices + busy row.
  const [reviewResolved, setReviewResolved] = useState(() => new Set());
  const [reviewBusy, setReviewBusy] = useState(null);
  const [demoBusy, setDemoBusy] = useState('');
  const [demoMsg, setDemoMsg] = useState('');
  // relationship memory (LinkedIn messages.csv → grounded AI drafts)
  const [scoutName, setScoutName] = useState('');
  const [memBusy, setMemBusy] = useState(false);
  const [memResult, setMemResult] = useState(null);
  const [memError, setMemError] = useState('');
  const [memFile, setMemFile] = useState('');
  const [memSummary, setMemSummary] = useState(null);
  // privacy / danger zone (data portability + right to erasure)
  const [exporting, setExporting] = useState(false);
  const [privacyError, setPrivacyError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const fileInput = useRef(null);
  const navigate = useNavigate();

  async function loadProfileFields() {
    try {
      const { data } = await api.get('/api/auth/me');
      setCompany(data.user?.company || '');
      setPastCompanies(data.user?.pastCompanies || '');
      setCity(data.user?.location || '');
      setSchools(data.user?.schools || '');
      setGoal(data.user?.goalAmount ? String(data.user.goalAmount) : '');
    } catch {
      /* ignore */
    }
  }

  async function seedDemo() {
    if (
      !window.confirm(
        'Load sample data? This REPLACES your current prospects and pipeline and sets a demo profile. Best used on the demo login.'
      )
    )
      return;
    setDemoBusy('seed');
    setDemoMsg('');
    try {
      const { data } = await api.post('/api/demo/seed');
      await loadProfileFields();
      setDemoMsg(
        `Loaded ${data.connections} sample prospects, ${data.pipeline} pipeline entries with donations, and a starter Grants document library. Check the Dashboard, Today, and Grants.`
      );
    } catch {
      setDemoMsg('Could not load sample data.');
    } finally {
      setDemoBusy('');
    }
  }

  async function clearDemo() {
    if (
      !window.confirm(
        'Clear your data? This permanently deletes ALL your prospects, pipeline, follow-up reminders, and recorded donations, and resets your fundraising goal. Your relationship memory and campaigns are not affected. This cannot be undone.'
      )
    )
      return;
    setDemoBusy('clear');
    setDemoMsg('');
    try {
      await api.post('/api/demo/clear');
      setDemoMsg('Cleared your prospects, pipeline, reminders, and recorded donations.');
    } catch {
      setDemoMsg('Could not clear.');
    } finally {
      setDemoBusy('');
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/auth/me');
        setCompany(data.user?.company || '');
        setPastCompanies(data.user?.pastCompanies || '');
        setCity(data.user?.location || '');
        setSchools(data.user?.schools || '');
        setGoal(data.user?.goalAmount ? String(data.user.goalAmount) : '');
        setScoutName(data.user?.name || '');
      } catch {
        /* ignore */
      }
      loadHistorySummary();
    })();
  }, []);

  async function saveProfile(e) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileSaved(false);
    setProfileError('');
    try {
      await api.post('/api/profile', {
        company,
        pastCompanies,
        location: city,
        schools,
        goalAmount: Number(goal) || 0,
      });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 4000);
    } catch {
      setProfileError('Could not save your details.');
    } finally {
      setSavingProfile(false);
    }
  }

  function handleFile(file) {
    setError('');
    setResult(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setError('Please choose a .csv file (your LinkedIn connections export).');
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseConnectionsCsv(String(e.target.result));
        if (!parsed.length) {
          setError('No contacts found in that file. Is it a LinkedIn Connections export?');
          setContacts([]);
        } else {
          setContacts(parsed);
        }
      } catch {
        setError('Could not parse that CSV file.');
      }
    };
    reader.readAsText(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  async function upload() {
    if (!contacts.length) return;
    setUploading(true);
    setError('');
    setResult(null);
    try {
      const { data } = await api.post('/api/connections/upload', { contacts });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed. Is the API running?');
    } finally {
      setUploading(false);
    }
  }

  async function loadHistorySummary() {
    try {
      const { data } = await api.get('/api/history/summary');
      setMemSummary(data);
    } catch {
      /* ignore */
    }
  }

  async function onMessagesFile(file) {
    setMemError('');
    setMemResult(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setMemError('Please choose messages.csv from your LinkedIn data export.');
      return;
    }
    setMemFile(file.name);
    setMemBusy(true);
    try {
      const text = await file.text();
      const { history, voiceSample } = parseMessagesCsv(text, scoutName);
      if (!history.length) {
        setMemError(
          'No 1:1 message history found. Is this the messages.csv from your full LinkedIn export?'
        );
        return;
      }
      const { data } = await api.post('/api/history/upload', { history, voiceSample });
      setMemResult(data);
      await loadHistorySummary();
    } catch (e) {
      setMemError(e.response?.data?.error || 'Could not process that file.');
    } finally {
      setMemBusy(false);
    }
  }

  async function deleteHistory() {
    if (
      !window.confirm(
        'Delete all stored relationship memory (message summaries + writing-voice sample)? This cannot be undone.'
      )
    )
      return;
    setMemBusy(true);
    try {
      await api.delete('/api/history');
      setMemResult(null);
      setMemFile('');
      await loadHistorySummary();
    } catch {
      setMemError('Could not delete.');
    } finally {
      setMemBusy(false);
    }
  }

  // Data portability: download EVERYTHING this account holds as a JSON file.
  async function exportData() {
    setExporting(true);
    setPrivacyError('');
    try {
      // responseType:'text' so we save the server's pretty-printed JSON verbatim.
      const { data } = await api.get('/api/account/export', { responseType: 'text' });
      const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'donor-scout-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setPrivacyError('Could not export your data. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  // Right to erasure: permanently delete this account + all its data. Double-confirm
  // (a window.confirm AND a typed-phrase prompt) before sending; then log out.
  async function deleteAccount() {
    if (
      !window.confirm(
        'Permanently delete your account and ALL your data (prospects, pipeline, impact, relationship memory)? This cannot be undone.'
      )
    )
      return;
    const typed = window.prompt('This is irreversible. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    setDeleting(true);
    setPrivacyError('');
    try {
      await api.delete('/api/account', { data: { confirm: true } });
      // Session is gone server-side; bounce to login.
      window.location.href = '/login';
    } catch (e) {
      setPrivacyError(
        e.response?.data?.error || 'Could not delete your account. Please try again.'
      );
      setDeleting(false);
    }
  }

  async function onDonorFile(file) {
    setSyncError('');
    setSyncResult(null);
    if (!file) return;
    // Guard against a giant export freezing the tab — XLSX.read is synchronous.
    const MAX_MB = 10;
    if (file.size > MAX_MB * 1024 * 1024) {
      setSyncError(`That file is too large (over ${MAX_MB}MB). Export a smaller date range from Zeffy.`);
      return;
    }
    setDonorFile(file.name);
    setDonorParsing(true);
    try {
      let parsed;
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        const XLSX = await import('xlsx');
        // Yield a frame so the "Processing…" state paints before the sync parse.
        await new Promise((r) => setTimeout(r, 0));
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        parsed = donationsFromRows(rows);
      } else if (/\.csv$/i.test(file.name)) {
        parsed = parseDonationsCsv(await file.text());
      } else {
        setSyncError('Upload a Zeffy export (.xlsx or .csv).');
        return;
      }
      setDonors(parsed.donors);
      setDonorExcluded(parsed.excluded);
      setDonorCampaigns(parsed.campaigns);
      if (!parsed.donors.length) {
        setSyncError(
          `No matching donations found${parsed.excluded ? ` (${parsed.excluded} Gaza-campaign rows excluded)` : ''}.`
        );
      }
    } catch {
      setSyncError('Could not read that file.');
    } finally {
      setDonorParsing(false);
    }
  }

  async function syncDonations() {
    if (!donors.length) return;
    setSyncing(true);
    setSyncError('');
    try {
      const { data } = await api.post('/api/donations/reconcile', { donors });
      setSyncResult(data);
      setReviewResolved(new Set());
      setDonors([]);
      setDonorFile('');
    } catch (e) {
      setSyncError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  // Reconcile Review: resolve one unmatched donation — LINK it to a connection
  // (connectionId set) or RECORD it as a new standalone donor (connectionId null).
  async function resolveUnmatched(idx, donor, connectionId) {
    setReviewBusy(idx);
    setSyncError('');
    try {
      await api.post('/api/donations/record', { donor, connectionId: connectionId ?? null });
      setReviewResolved((s) => new Set(s).add(idx));
    } catch (e) {
      setSyncError(e.response?.data?.error || 'Could not record that donation.');
    } finally {
      setReviewBusy(null);
    }
  }
  const ignoreUnmatched = (idx) => setReviewResolved((s) => new Set(s).add(idx));

  return (
    <div className="page">
      <div className="page__head">
        <h1>Profile</h1>
        <p className="page__sub">Set up your matching signals and import your LinkedIn network.</p>
      </div>

      <section className="card profile-card">
        <div className="profile-card__intro">
          <h2>Your details</h2>
          <p className="muted">
            Tell us where you work (now and before), live, and studied so we can spot{' '}
            <strong>coworkers</strong>, <strong>local</strong>, and <strong>school</strong> connections.
            These are usually your warmest prospects. (Family is matched automatically from your name.)
          </p>
        </div>
        <form className="profile-form" onSubmit={saveProfile}>
          <label className="field">
            <span>Your company</span>
            <input type="text" value={company} placeholder="e.g. Stripe" onChange={(e) => setCompany(e.target.value)} />
          </label>
          <label className="field">
            <span>Your city</span>
            <input type="text" value={city} placeholder="e.g. San Francisco" onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="field profile-field--wide">
            <span>Past employers (comma-separated)</span>
            <input
              type="text"
              value={pastCompanies}
              placeholder="e.g. Google, McKinsey, Acme Corp"
              onChange={(e) => setPastCompanies(e.target.value)}
            />
          </label>
          <label className="field profile-field--wide">
            <span>Your schools (comma-separated)</span>
            <input
              type="text"
              value={schools}
              placeholder="e.g. Stanford University, Lincoln High School"
              onChange={(e) => setSchools(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Campaign goal ($)</span>
            <input type="number" min="0" step="100" value={goal} placeholder="e.g. 8000" onChange={(e) => setGoal(e.target.value)} />
          </label>
          <button className="btn btn--primary" type="submit" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save'}
          </button>
          {profileSaved && <span className="profile-saved">✓ Saved. Prospects re-ranked.</span>}
        </form>
        {profileError && <div className="alert alert--error">{profileError}</div>}
      </section>

      <StrategyPicker />

      <OrgSettings />

      <section className="card upload-card">
        <h2>Import LinkedIn connections</h2>
        <p className="muted">
          LinkedIn doesn’t allow apps to pull your connections automatically. Exporting the CSV is
          their official way to get your own list. It takes a minute:
        </p>
        <ol className="steps">
          <li>
            Open your{' '}
            <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noreferrer">
              LinkedIn data export page ↗
            </a>
            .
          </li>
          <li>
            Under <em>Get a copy of your data</em>, choose <strong>Connections</strong> → <em>Request archive</em>.
          </li>
          <li>
            LinkedIn emails you a <code>Connections.csv</code> (often within minutes). Download it.
          </li>
          <li>
            Drop it below. <span className="muted">No file yet? Use the included{' '}
            <code>sample_connections.csv</code> to try it now.</span>
          </li>
        </ol>

        <div
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
        >
          <input ref={fileInput} type="file" accept=".csv" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
          <div className="dropzone__icon">
            <Icon name="file" size={28} strokeWidth={1.75} />
          </div>
          {fileName ? (
            <p>
              <strong>{fileName}</strong>
              {contacts.length > 0 && <>, {contacts.length} contacts ready</>}
            </p>
          ) : (
            <p>
              <strong>Drag &amp; drop</strong> your CSV here, or click to browse
            </p>
          )}
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        {contacts.length > 0 && !result && (
          <div className="preview">
            <div className="preview__head">
              <strong>{contacts.length}</strong> contacts parsed and ready to enrich:
            </div>
            <div className="preview__scroll">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.slice(0, 8).map((c, i) => (
                    <tr key={i}>
                      <td data-label="Name">{c.contact_name || '-'}</td>
                      <td data-label="Company">{c.company || '-'}</td>
                      <td data-label="Role">{c.role || '-'}</td>
                      <td data-label="Location">{c.location || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {contacts.length > 8 && <p className="muted small">…and {contacts.length - 8} more</p>}
          </div>
        )}

        {contacts.length > 0 && !result && (
          <div className="upload-card__actions">
            <button className="btn btn--primary" onClick={upload} disabled={uploading}>
              {uploading ? 'Enriching via GitHub…' : `Enrich & score ${contacts.length} contacts`}
            </button>
            {uploading && (
              <span className="muted upload-card__hint">
                Querying the GitHub API (throttled). This can take about 10 to 20s.
              </span>
            )}
          </div>
        )}

        {result && (
          <div className="alert alert--success">
            <strong>
              Added {result.added} new
              {result.updated ? `, updated ${result.updated} existing` : ''}.
            </strong>{' '}
            {result.added > 0 &&
              `Enriched ${result.enriched} new contact${result.enriched === 1 ? '' : 's'} via GitHub. `}
            {result.skipped > 0 &&
              `Skipped ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} in the file. `}
            You now have {result.totalConnections} connections. Re-importing later merges, it won’t
            wipe this list.
            {result.enrichmentCapped && ' (Enrichment capped to respect API limits.)'}
            {result.rateLimited && ' Hit GitHub rate limit. Add a GITHUB_TOKEN for more (see SETUP.md).'}
            {!result.githubAuthenticated && ' Tip: add a GITHUB_TOKEN to enrich more contacts faster.'}
            <div className="upload-card__actions">
              <button className="btn btn--primary" onClick={() => navigate('/prospects')}>
                View ranked prospects →
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card upload-card">
        <h2>
          Add relationship memory <span className="muted small">(makes AI drafts personal)</span>
        </h2>
        <p className="muted">
          Optional: import your LinkedIn <code>messages.csv</code> so AI drafts can reference your real
          shared history and sound like you.{' '}
          <strong>Stored locally on this server, never sent anywhere</strong>. It is only used as private
          context to the AI when <em>you</em> generate a draft. Delete it anytime.
        </p>
        <ol className="steps">
          <li>
            On the same{' '}
            <a
              href="https://www.linkedin.com/mypreferences/d/download-my-data"
              target="_blank"
              rel="noreferrer"
            >
              LinkedIn data export page ↗
            </a>
            , request the <strong>larger</strong> archive (it includes <code>messages.csv</code>).
          </li>
          <li>
            Download &amp; unzip it, then find <code>messages.csv</code>.
          </li>
          <li>Choose it below. It’s summarized in your browser before anything is stored.</li>
        </ol>

        <div className="upload-card__actions">
          <label className="btn btn--on-light">
            {memBusy ? 'Processing…' : memFile || 'Choose messages.csv'}
            <input
              type="file"
              accept=".csv"
              hidden
              disabled={memBusy}
              onChange={(e) => onMessagesFile(e.target.files?.[0])}
            />
          </label>
        </div>

        {memSummary && memSummary.contacts > 0 && (
          <p className="muted small">
            Stored: relationship history for <strong>{memSummary.contacts}</strong> contacts
            {memSummary.messages ? ` (${memSummary.messages} messages)` : ''}
            {memSummary.voiceChars ? ' · writing-voice sample captured' : ''}.{' '}
            <button className="btn btn--ghost btn--sm" onClick={deleteHistory} disabled={memBusy}>
              Delete
            </button>
          </p>
        )}

        {memError && <div className="alert alert--error">{memError}</div>}
        {memResult && (
          <div className="alert alert--success">
            Stored relationship history for <strong>{memResult.stored}</strong> contacts
            {memResult.matchedToConnections
              ? `, ${memResult.matchedToConnections} matched to your prospects`
              : ''}
            .{memResult.voiceCaptured ? ' Captured your writing voice for drafts.' : ''}
          </div>
        )}
      </section>

      <section className="card sync-card">
        <div className="sync-card__head">
          <div>
            <h2>Sync donations from Zeffy</h2>
            <p className="muted small">
              Export your donations from Zeffy (the <code>All_payments</code> file) and upload it here
              (<code>.xlsx</code> or <code>.csv</code>). They’re matched to your pipeline and
              auto-recorded. Donations to the <strong>Gazan-students campaign are excluded
              automatically</strong>.
            </p>
          </div>
          <label className="btn btn--on-light">
            {donorParsing ? 'Processing…' : donorFile || 'Choose Zeffy file'}
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              hidden
              disabled={donorParsing}
              onChange={(e) => onDonorFile(e.target.files?.[0])}
            />
          </label>
        </div>

        {donors.length > 0 && !syncResult && (
          <>
            <p className="muted small sync-card__summary">
              <strong>{donors.length}</strong> donation{donors.length === 1 ? '' : 's'} ready to record
              {donorExcluded > 0 && ` · ${donorExcluded} Gaza-campaign excluded`}.
              {donorCampaigns.filter((c) => !/gaza/i.test(c)).length > 0 && (
                <> Including: {donorCampaigns.filter((c) => !/gaza/i.test(c)).join('; ')}.</>
              )}
            </p>
            <div className="upload-card__actions">
              <button className="btn btn--primary" onClick={syncDonations} disabled={syncing}>
                {syncing ? 'Recording…' : `Record ${donors.length} donation${donors.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {syncError && <div className="alert alert--error">{syncError}</div>}
        {syncResult && (
          <div className="alert alert--success">
            Recorded <strong>{syncResult.recorded}</strong> donation
            {syncResult.recorded === 1 ? '' : 's'} ({money(syncResult.amountRecorded)}).
            {syncResult.createdFromConnections > 0 &&
              ` Added ${syncResult.createdFromConnections} new pipeline entr${
                syncResult.createdFromConnections === 1 ? 'y' : 'ies'
              } from your network.`}
            {syncResult.alreadyRecorded > 0 && ` ${syncResult.alreadyRecorded} already recorded.`}
            {syncResult.unmatched > 0 &&
              ` ${syncResult.unmatched} donor${
                syncResult.unmatched === 1 ? '' : 's'
              } didn't match anyone in your network.`}
          </div>
        )}

        {syncResult?.unmatchedReview?.length > 0 &&
          syncResult.unmatchedReview.some((_, i) => !reviewResolved.has(i)) && (
            <div className="reconcile-review">
              <h3>
                Review unmatched donations{' '}
                <span className="today-count">
                  {syncResult.unmatchedReview.filter((_, i) => !reviewResolved.has(i)).length}
                </span>
              </h3>
              <p className="muted small">
                These gifts didn't auto-match anyone in your network. Link each to the right person, record it
                as a new donor, or ignore it. No money moves. This only records who gave.
              </p>
              {syncResult.unmatchedReview.map((row, i) =>
                reviewResolved.has(i) ? null : (
                  <div className="card reconcile-row" key={i}>
                    <div className="reconcile-row__who">
                      <strong>{row.name || row.email || 'Unknown donor'}</strong>
                      {row.amount > 0 && <span className="tag tag--ok">{money(row.amount)}</span>}
                      {row.email && <span className="muted small">{row.email}</span>}
                    </div>
                    <div className="reconcile-row__actions">
                      {(row.candidates || []).map((c) => (
                        <button
                          key={c.connectionId}
                          className="btn btn--sm btn--ghost"
                          disabled={reviewBusy === i}
                          title={c.company || ''}
                          onClick={() => resolveUnmatched(i, row, c.connectionId)}
                        >
                          Link to {c.name}
                          {c.confidence ? ` (${c.confidence}%)` : ''}
                        </button>
                      ))}
                      <button
                        className="btn btn--sm btn--primary"
                        disabled={reviewBusy === i}
                        onClick={() => resolveUnmatched(i, row, null)}
                      >
                        Record as new donor
                      </button>
                      <button
                        className="btn btn--sm btn--ghost"
                        disabled={reviewBusy === i}
                        onClick={() => ignoreUnmatched(i)}
                      >
                        Ignore
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
      </section>

      <section className="card">
        <h2>Demo data</h2>
        <p className="muted">
          Populate a realistic sample campaign (ranked prospects, an active pipeline, recorded
          donations, and a goal) to explore or present the app without importing anything.{' '}
          <strong>This replaces your current prospects, pipeline, and profile details</strong>, so it’s
          best used on the demo login.
        </p>
        <div className="upload-card__actions">
          <button className="btn btn--primary" onClick={seedDemo} disabled={!!demoBusy}>
            {demoBusy === 'seed' ? 'Loading…' : 'Load sample data'}
          </button>
          <button className="btn btn--ghost btn--on-light" onClick={clearDemo} disabled={!!demoBusy}>
            {demoBusy === 'clear' ? 'Clearing…' : 'Clear my data'}
          </button>
        </div>
        {demoMsg && <div className="alert alert--success">{demoMsg}</div>}
      </section>

      <section className="card">
        <h2>Privacy &amp; your data</h2>
        <p className="muted">
          You own your data. Download a complete copy of everything this account holds (your profile,
          prospects with dossiers, pipeline, impact, and relationship memory) or permanently delete
          your account. Exports and deletions only ever touch <strong>your own</strong> data.
        </p>
        <div className="upload-card__actions">
          <button className="btn btn--on-light" onClick={exportData} disabled={exporting || deleting}>
            {exporting ? 'Preparing…' : 'Export my data'}
          </button>
        </div>

        <div className="profile-card__intro" style={{ marginTop: '1.5rem' }}>
          <h2 style={{ color: 'var(--danger, #b91c1c)' }}>Danger zone</h2>
          <p className="muted">
            Permanently delete your account and all your data. This is irreversible and immediately
            ends your session.{' '}
            <strong>
              If you are the only owner of an organization with other members, transfer ownership
              first.
            </strong>
          </p>
        </div>
        <div className="upload-card__actions">
          <button className="btn btn--ghost btn--on-light" onClick={deleteAccount} disabled={deleting || exporting}>
            {deleting ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
        {privacyError && <div className="alert alert--error">{privacyError}</div>}
      </section>
    </div>
  );
}
