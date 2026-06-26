import { useEffect, useState } from 'react';
import api from '../api';
import Icon from '../components/Icon';
import { useSendMode } from '../sendMode';

const SEGMENT_LABEL = {
  all: 'All donors',
  recent: 'Recent (gave in the last 90 days)',
  lapsed: 'Lapsed (no gift in over a year)',
  recurring: 'Recurring (gave more than once)',
};

// The Newsletter workspace. Draft a donor impact update from your documents + donation
// data, style it as a real HTML email (header image, Donate button, personalization),
// preview it, pick an audience segment, and send. Every send routes through the same
// outbound guard as the rest of the app, so in demo mode each copy lands in your inbox.
export default function NewsletterPage() {
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [headerImageUrl, setHeaderImageUrl] = useState('');
  const [body, setBody] = useState('');
  const [instructions, setInstructions] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNote, setDraftNote] = useState('');

  const [previewHtml, setPreviewHtml] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  const [segments, setSegments] = useState({ all: 0, recent: 0, lapsed: 0, recurring: 0 });
  const [noEmail, setNoEmail] = useState(0);
  const [sample, setSample] = useState([]);
  const [segment, setSegment] = useState('all');

  const [sendBusy, setSendBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [sendResult, setSendResult] = useState(null);
  const [testNote, setTestNote] = useState('');
  const [history, setHistory] = useState([]);
  const sendMode = useSendMode();

  async function loadAudience() {
    try {
      const { data } = await api.get('/api/newsletter/audience');
      setSegments(data.segments || {});
      setNoEmail(data.noEmail || 0);
      setSample(data.sample || []);
    } catch {
      /* ignore */
    }
  }
  async function loadHistory() {
    try {
      const { data } = await api.get('/api/newsletter/history');
      setHistory(data.newsletters || []);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadAudience();
    loadHistory();
  }, []);

  const composed = () => ({ subject, preheader, body, headerImageUrl });

  async function preview() {
    if (!body.trim() && !subject.trim()) return;
    setPreviewBusy(true);
    try {
      const { data } = await api.post('/api/newsletter/preview', composed());
      setPreviewHtml(data.html || '');
    } catch {
      /* ignore */
    } finally {
      setPreviewBusy(false);
    }
  }

  async function draft() {
    setDraftBusy(true);
    setDraftNote('');
    try {
      const { data } = await api.post('/api/newsletter/draft', { instructions });
      setSubject(data.subject || '');
      setPreheader(data.preheader || '');
      setBody(data.body || '');
    } catch (err) {
      const fb = err.response?.data?.fallback;
      if (fb) {
        setSubject(fb.subject || '');
        setPreheader(fb.preheader || '');
        setBody(fb.body || '');
        setDraftNote(
          err.response?.data?.aiDisabled
            ? 'AI is off, so this is a basic template built from your donation totals. Add an ANTHROPIC_API_KEY for a richer draft.'
            : 'Used a basic template.'
        );
      } else {
        setDraftNote(err.response?.data?.error || 'Could not draft the newsletter.');
      }
    } finally {
      setDraftBusy(false);
    }
  }

  async function send() {
    if (sendMode.mode === 'live' && !window.confirm(`Live mode: this will email ${count} real donor${count === 1 ? '' : 's'}. Continue?`)) return;
    setSendBusy(true);
    setSendErr('');
    setSendResult(null);
    try {
      const { data } = await api.post('/api/newsletter/send', { ...composed(), segment });
      setSendResult(data);
      loadHistory();
    } catch (err) {
      setSendErr(err.response?.data?.error || 'Could not send the newsletter.');
    } finally {
      setSendBusy(false);
    }
  }

  async function sendTest() {
    setTestBusy(true);
    setTestNote('');
    try {
      const { data } = await api.post('/api/newsletter/send', { ...composed(), test: true });
      setTestNote(`Test sent to ${data.to}. Check your inbox.`);
      setTimeout(() => setTestNote(''), 6000);
    } catch (err) {
      setTestNote(err.response?.data?.error || 'Could not send the test.');
      setTimeout(() => setTestNote(''), 6000);
    } finally {
      setTestBusy(false);
    }
  }

  const count = segments[segment] ?? 0;
  const canSend = subject.trim() && body.trim();

  return (
    <div className="page">
      <div className="page__head">
        <h1>Newsletter</h1>
        <p className="page__sub">
          Draft a donor update from your documents and donation data, style it, preview it, and send.
        </p>
      </div>

      <section className="card">
        <h2 className="grant-lib__title">1. Write it</h2>
        <p className="muted small">
          The draft is grounded in your Grants document library and your real donation totals. It never invents numbers.
          The body supports <code>**bold**</code>, <code>[links](url)</code>, <code>![image](url)</code>, <code>## headings</code>,
          <code>- bullets</code>, and <code>{'{{first_name}}'}</code> for personalization.
        </p>
        <label className="field grant-add__grow">
          <span>Optional emphasis for the AI (tone or what to focus on)</span>
          <input
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. thank year-end donors and share the 2024 placement numbers"
            maxLength={1000}
          />
        </label>
        <div className="grant-output__actions">
          <button className="btn btn--primary btn--sm" disabled={draftBusy} onClick={draft}>
            <Icon name="sparkles" size={15} /> {draftBusy ? 'Writing…' : 'Draft with AI'}
          </button>
        </div>
        {draftNote && <div className="alert">{draftNote}</div>}

        <label className="field">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="An update from us" maxLength={200} />
        </label>
        <label className="field">
          <span>Preview text (the snippet shown in the inbox)</span>
          <input value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="A quick thank-you and a snapshot of your impact." maxLength={200} />
        </label>
        <label className="field">
          <span>Header image URL (optional)</span>
          <input value={headerImageUrl} onChange={(e) => setHeaderImageUrl(e.target.value)} placeholder="https://your-site.org/banner.jpg" maxLength={500} />
        </label>
        <label className="field">
          <span>Body</span>
          <textarea
            className="grant-add__textarea"
            rows={14}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Draft with AI above, or write the newsletter here. Start with: Hi {{first_name}},"
          />
        </label>
      </section>

      <section className="card">
        <div className="grant-add__row">
          <h2 className="grant-lib__title grant-add__grow">2. Preview</h2>
          <button className="btn btn--ghost btn--sm btn--on-light" disabled={previewBusy || !canSend} onClick={preview}>
            <Icon name="external" size={14} /> {previewBusy ? 'Rendering…' : 'Refresh preview'}
          </button>
        </div>
        <p className="muted small">This is exactly what a donor receives, personalized with a real donor's first name.</p>
        {previewHtml ? (
          <iframe title="Newsletter preview" srcDoc={previewHtml} style={{ width: '100%', height: 620, border: '1px solid #e6e8eb', borderRadius: 8, background: '#fff' }} />
        ) : (
          <p className="muted">Write or draft the newsletter, then refresh the preview.</p>
        )}
      </section>

      <section className="card">
        <h2 className="grant-lib__title">3. Choose the audience</h2>
        <div className="grant-add__row">
          <label className="field grant-add__kind">
            <span>Send to</span>
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              {Object.keys(SEGMENT_LABEL).map((k) => (
                <option key={k} value={k}>
                  {SEGMENT_LABEL[k]} ({segments[k] ?? 0})
                </option>
              ))}
            </select>
          </label>
          <p className="muted small grant-add__grow">
            <strong>{count}</strong> donor{count === 1 ? '' : 's'} with an email in this segment
            {noEmail > 0 ? `. ${noEmail} donor${noEmail === 1 ? '' : 's'} have no usable email and will not be included.` : '.'}
            {sample.length > 0 && <><br />For example: {sample.join(', ')}.</>}
          </p>
        </div>
      </section>

      <section className="card">
        <h2 className="grant-lib__title">4. Send</h2>
        <p className="muted small">
          Each copy goes through the same send guard as the rest of the app. In demo mode every copy is redirected to your
          own inbox, so you can preview exactly what each donor would receive. Send a test to yourself first.
        </p>
        <div className="grant-output__actions">
          <button className="btn btn--ghost btn--sm btn--on-light" disabled={testBusy || !canSend} onClick={sendTest}>
            <Icon name="external" size={14} /> {testBusy ? 'Sending…' : 'Send a test to me'}
          </button>
          <button className="btn btn--primary" disabled={sendBusy || !canSend || count === 0} onClick={send}>
            <Icon name="external" size={15} /> {sendBusy ? 'Sending…' : `Send to ${count} donor${count === 1 ? '' : 's'}`}
          </button>
        </div>
        {testNote && <div className="alert">{testNote}</div>}
        {count === 0 && <p className="muted small">No donors with an email in this segment yet.</p>}
        {sendErr && <div className="alert alert--error">{sendErr}</div>}
        {sendResult && (
          <div className="alert alert--success">
            Sent {sendResult.sent} of {sendResult.recipients}.
            {sendResult.redirected > 0 && ` All ${sendResult.redirected} were redirected to your inbox (demo mode).`}
            {sendResult.suppressed > 0 && ` ${sendResult.suppressed} skipped (unsubscribed).`}
            {sendResult.blocked > 0 && ` ${sendResult.blocked} blocked by policy.`}
            {sendResult.failed > 0 && ` ${sendResult.failed} failed.`}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="card">
          <h2 className="grant-lib__title">Recent sends</h2>
          <ul className="grant-lib">
            {history.map((n) => (
              <li className="grant-lib__item" key={n.id}>
                <div className="grant-lib__main">
                  <span className="grant-lib__name">{n.subject || '(no subject)'}</span>
                  <span className="tag tag--muted">{SEGMENT_LABEL[n.segment]?.split(' (')[0] || n.segment}</span>
                  <span className="muted small">{n.sent}/{n.recipients} sent · {String(n.created_at).slice(0, 10)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
