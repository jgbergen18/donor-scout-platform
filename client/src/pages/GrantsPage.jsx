import { useEffect, useState } from 'react';
import api from '../api';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import { extractText, ACCEPTED_DOC_TYPES } from '../docparse';

const KIND_LABEL = {
  mission: 'Mission',
  program: 'Program',
  impact: 'Impact',
  financial: 'Financials',
  prior_report: 'Prior report',
  application: 'Grant application',
  reference: 'Reference',
};

// The Grants workspace. M1: a per-org document library. Upload PDF/DOCX/TXT or paste
// text; it is extracted in the browser and stored as text. Reports and application
// answers (built on this library plus your donation data) come next.
export default function GrantsPage() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('reference');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [viewing, setViewing] = useState(null); // full doc being viewed
  // report generator
  const [reportType, setReportType] = useState('funder_update');
  const [instructions, setInstructions] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [report, setReport] = useState('');
  const [reportErr, setReportErr] = useState('');
  const [reportCopied, setReportCopied] = useState(false);
  // application answers
  const [questions, setQuestions] = useState('');
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answers, setAnswers] = useState([]);
  const [answerErr, setAnswerErr] = useState('');

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/api/documents');
      setDocs(data.documents || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function addDoc(name, content) {
    if (!content.trim()) {
      setError('No readable text was found. Try a different file or paste the text.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/documents', { name, kind, content });
      await load();
      setPasteName('');
      setPasteText('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that document.');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const text = await extractText(file);
      await addDoc(file.name.replace(/\.[^.]+$/, ''), text);
    } catch (err) {
      setError(err.message || 'Could not read that file.');
      setBusy(false);
    }
  }

  async function view(id) {
    try {
      const { data } = await api.get(`/api/documents/${id}`);
      setViewing(data.document);
    } catch {
      /* ignore */
    }
  }

  async function remove(id) {
    if (!window.confirm('Remove this document from your library?')) return;
    try {
      const { data } = await api.delete(`/api/documents/${id}`);
      setDocs(data.documents || []);
    } catch {
      /* ignore */
    }
  }

  const aiErr = (err, fallback) =>
    err.response?.data?.aiDisabled ? 'AI is off. Add an ANTHROPIC_API_KEY to your .env to use this.' : err.response?.data?.error || fallback;

  async function generateReport() {
    setReportBusy(true);
    setReportErr('');
    setReport('');
    try {
      const { data } = await api.post('/api/grants/report', { reportType, instructions });
      setReport(data.report || '');
    } catch (err) {
      setReportErr(aiErr(err, 'Could not generate the report.'));
    } finally {
      setReportBusy(false);
    }
  }

  async function draftAnswers() {
    const qs = questions.split('\n').map((q) => q.trim()).filter(Boolean);
    if (!qs.length) {
      setAnswerErr('Add at least one question, one per line.');
      return;
    }
    setAnswerBusy(true);
    setAnswerErr('');
    setAnswers([]);
    try {
      const { data } = await api.post('/api/grants/answer', { questions: qs });
      setAnswers(data.answers || []);
    } catch (err) {
      setAnswerErr(aiErr(err, 'Could not draft answers.'));
    } finally {
      setAnswerBusy(false);
    }
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      setReportCopied(true);
      setTimeout(() => setReportCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  function downloadReport() {
    const blob = new Blob([report], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'grant-report.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>Grants</h1>
        <p className="page__sub">
          Your document library. Add your mission, programs, impact, and prior reports once. Grant reports and
          application answers will draw on these documents and your donation data.
        </p>
      </div>

      <section className="card grant-add">
        <div className="grant-add__row">
          <label className="field grant-add__kind">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          {!pasteMode ? (
            <label className={`btn btn--primary grant-add__file${busy ? ' is-busy' : ''}`}>
              <Icon name="plus" size={15} /> {busy ? 'Reading…' : 'Upload a file'}
              <input type="file" accept={ACCEPTED_DOC_TYPES} hidden disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          ) : null}
          <button className="btn btn--ghost btn--on-light" type="button" onClick={() => setPasteMode((m) => !m)}>
            {pasteMode ? 'Upload a file instead' : 'Or paste text'}
          </button>
        </div>
        <p className="muted small grant-add__hint">Accepts PDF, Word (.docx), and text files. Files are read in your browser; only the text is saved.</p>

        {pasteMode && (
          <div className="grant-add__paste">
            <label className="field">
              <span>Document name</span>
              <input value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="2024 program overview" maxLength={200} />
            </label>
            <textarea
              className="grant-add__textarea"
              rows={8}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the text of the document here."
            />
            <button
              className="btn btn--primary btn--sm"
              type="button"
              disabled={busy || !pasteName.trim() || !pasteText.trim()}
              onClick={() => addDoc(pasteName.trim(), pasteText)}
            >
              {busy ? 'Saving…' : 'Add document'}
            </button>
          </div>
        )}

        {error && <div className="alert alert--error">{error}</div>}
      </section>

      <section className="card">
        <h2 className="grant-lib__title">Document library <span className="today-count">{docs.length}</span></h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="muted">No documents yet. Add your mission statement, a program description, or your latest impact summary to get started.</p>
        ) : (
          <ul className="grant-lib">
            {docs.map((d) => (
              <li className="grant-lib__item" key={d.id}>
                <div className="grant-lib__main">
                  <span className="grant-lib__name">{d.name}</span>
                  <span className="tag tag--muted">{KIND_LABEL[d.kind] || d.kind}</span>
                  <span className="muted small">{(d.char_count || 0).toLocaleString()} chars</span>
                </div>
                <div className="grant-lib__actions">
                  <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => view(d.id)}>View</button>
                  <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => remove(d.id)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="grant-lib__title">Generate a report</h2>
        <p className="muted small">
          Drafts a report from your documents and your real donation data. It uses only that material and marks anything
          missing as [needs input]. Review and edit before you send it.
        </p>
        <div className="grant-add__row">
          <label className="field grant-add__kind">
            <span>Report type</span>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)}>
              <option value="funder_update">Funder update</option>
              <option value="impact_report">Impact report</option>
              <option value="board_report">Board report</option>
              <option value="general">Grant final report</option>
            </select>
          </label>
          <label className="field grant-add__grow">
            <span>Extra instructions (optional)</span>
            <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. focus on the 2024 cohort; keep it under one page" maxLength={1500} />
          </label>
          <button className="btn btn--primary" disabled={reportBusy || docs.length === 0} onClick={generateReport}>
            <Icon name="sparkles" size={15} /> {reportBusy ? 'Writing…' : 'Generate report'}
          </button>
        </div>
        {docs.length === 0 && <p className="muted small">Add at least one document above first.</p>}
        {reportErr && <div className="alert alert--error">{reportErr}</div>}
        {report && (
          <div className="grant-output">
            <textarea className="grant-add__textarea" rows={16} value={report} onChange={(e) => setReport(e.target.value)} />
            <div className="grant-output__actions">
              <button className="btn btn--sm btn--primary" onClick={copyReport}>
                <Icon name={reportCopied ? 'check' : 'copy'} size={14} /> {reportCopied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn btn--sm btn--ghost btn--on-light" onClick={downloadReport}>Download .md</button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="grant-lib__title">Answer application questions</h2>
        <p className="muted small">
          Paste the application questions, one per line. It drafts an answer to each from your documents and data, and
          marks anything missing as [needs input].
        </p>
        <textarea
          className="grant-add__textarea"
          rows={6}
          value={questions}
          onChange={(e) => setQuestions(e.target.value)}
          placeholder={"Describe your organization's mission.\nWhat outcomes did you achieve last year?\nHow will you use this grant?"}
        />
        <div className="grant-output__actions">
          <button className="btn btn--primary btn--sm" disabled={answerBusy || !questions.trim()} onClick={draftAnswers}>
            <Icon name="sparkles" size={15} /> {answerBusy ? 'Drafting…' : 'Draft answers'}
          </button>
        </div>
        {answerErr && <div className="alert alert--error">{answerErr}</div>}
        {answers.length > 0 && (
          <div className="grant-answers">
            {answers.map((a, i) => (
              <div className="grant-answer" key={i}>
                <p className="grant-answer__q">{a.question}</p>
                <textarea
                  className="grant-add__textarea"
                  rows={5}
                  value={a.answer}
                  onChange={(e) => setAnswers((prev) => prev.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))}
                />
                <button className="btn btn--sm btn--ghost btn--on-light" onClick={() => navigator.clipboard.writeText(a.answer).catch(() => {})}>
                  Copy answer
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {viewing && (
        <Modal
          title={viewing.name}
          onClose={() => setViewing(null)}
          footer={<button className="btn btn--primary" onClick={() => setViewing(null)}>Close</button>}
        >
          <p className="muted small">{KIND_LABEL[viewing.kind] || viewing.kind} · {(viewing.char_count || 0).toLocaleString()} characters</p>
          <pre className="grant-doc-text">{viewing.content}</pre>
        </Modal>
      )}
    </div>
  );
}
