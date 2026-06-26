// Browser-side CSV parsing for LinkedIn "Connections.csv" exports.
// LinkedIn prepends a "Notes:" preamble before the real header row, so we scan
// for the header (the row containing "First Name") and map columns by name.

// Tokenizer that correctly handles quoted fields, escaped quotes ("") and commas.
function tokenize(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Build donations from a tokenized grid (array-of-arrays) — works for CSV (via
// tokenize) and xlsx (via SheetJS sheet_to_json header:1). Detects columns by
// header name and EXCLUDES rows whose Campaign Title mentions Gaza (the separate
// Gazan-students campaign that shares the same Zeffy export).
// Returns { donors, excluded, campaigns }.
export function donationsFromRows(rows) {
  const empty = { donors: [], excluded: 0, campaigns: [] };
  if (!rows || !rows.length) return empty;

  let headerIdx = rows.findIndex((r) =>
    r.some((c) => /email|amount|donor|total|first name|payment date/i.test(String(c || '')))
  );
  if (headerIdx === -1) headerIdx = 0;
  const header = rows[headerIdx].map((h) => String(h || '').trim().toLowerCase());
  const find = (pred) => header.findIndex(pred);

  const iFirst = find((h) => h.includes('first name') || h === 'first');
  const iLast = find((h) => h.includes('last name') || h === 'last');
  const iName = find(
    (h) => h.includes('full name') || h.includes('donor name') || h.includes('contact name') || h === 'name' || h === 'donor'
  );
  const iEmail = find((h) => h.includes('email'));
  const iAmount = find(
    (h) => h.includes('total amount') || h.includes('amount') || h.includes('total') || h.includes('gift') || h.includes('net')
  );
  const iDate = find((h) => h.includes('date'));
  // Campaign/designation column. Prefer "campaign" (Zeffy's "Campaign Title");
  // avoid matching "refund amount" with a loose "fund".
  const iCampaign = (() => {
    const c = find((h) => h.includes('campaign'));
    if (c >= 0) return c;
    return find((h) => h === 'fund' || h.includes('form name') || h.includes('designation'));
  })();

  const at = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
  const donors = [];
  const campaigns = new Set();
  let excluded = 0;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c ?? '').trim())) continue;

    const campaign = at(row, iCampaign);
    if (campaign) campaigns.add(campaign);
    if (iCampaign >= 0 && /gaza/i.test(campaign)) {
      excluded++;
      continue; // skip the Gazan-students campaign
    }

    let name = '';
    if (iFirst >= 0 || iLast >= 0) name = [at(row, iFirst), at(row, iLast)].filter(Boolean).join(' ').trim();
    if (!name && iName >= 0) name = at(row, iName);
    const email = at(row, iEmail);
    const amount = at(row, iAmount);
    const date = at(row, iDate);
    if (!name && !email && !amount) continue;
    donors.push({ name, email, amount, date, campaign });
  }
  return { donors, excluded, campaigns: [...campaigns] };
}

export function parseDonationsCsv(text) {
  return donationsFromRows(tokenize(text));
}

// Normalize a person's display name for matching (lowercase, strip punctuation).
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse LinkedIn's "messages.csv" (from the full data export) into compact,
// per-counterparty relationship history + a writing-voice sample of the user's
// OWN sent messages. Everything stays summarized + short — we never ship the
// full transcript. Returns { history: [{name,count,sent,received,last,snippets}], voiceSample }.
//   - "self" is detected as the participant present in (nearly) every message
//     (the export owner), preferring an exact match to `selfName` when given.
//   - snippets: up to 3 most-recent short verbatim quotes per contact.
export function parseMessagesCsv(text, selfName = '') {
  const rows = tokenize(text);
  if (!rows.length) return { history: [], voiceSample: '' };

  let headerIdx = rows.findIndex(
    (r) =>
      r.some((c) => /content/i.test(String(c || ''))) &&
      r.some((c) => /^from$/i.test(String(c || '').trim()))
  );
  if (headerIdx === -1) headerIdx = rows.findIndex((r) => r.some((c) => /content/i.test(String(c || ''))));
  if (headerIdx === -1) return { history: [], voiceSample: '' };

  const header = rows[headerIdx].map((h) => String(h || '').trim().toLowerCase());
  const exact = (n) => header.indexOf(n);
  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iFrom = exact('from') >= 0 ? exact('from') : find('from', 'sender');
  const iTo = exact('to') >= 0 ? exact('to') : find('recipient', 'to');
  const iDate = find('date');
  const iContent = find('content', 'message');
  const iRecip = find('recipient profile url', 'recipient'); // group detection
  if (iFrom < 0 || iTo < 0) return { history: [], voiceSample: '' };

  const at = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');

  // Pass 1: identify "self" = the most frequent participant (in every message).
  const freq = new Map();
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    for (const i of [iFrom, iTo]) {
      const n = normName(at(row, i));
      if (n) freq.set(n, (freq.get(n) || 0) + 1);
    }
  }
  let self = normName(selfName);
  if (!freq.has(self)) {
    // selfName didn't exactly match a participant. Try a token/substring match
    // first (e.g. "Jamie B." vs "Jamie Bergen"), then fall back to frequency
    // (self is the participant present in nearly every message).
    let pick = '';
    let pickC = -1;
    if (self) {
      for (const [k, c] of freq) {
        if ((k.includes(self) || self.includes(k)) && c > pickC) ((pick = k), (pickC = c));
      }
    }
    if (!pick) for (const [k, c] of freq) if (c > pickC) ((pick = k), (pickC = c));
    self = pick;
  }

  // Pass 2: aggregate per counterparty + collect the voice sample.
  const agg = new Map();
  const voice = [];
  let voiceLen = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const fromRaw = at(row, iFrom);
    const toRaw = at(row, iTo);
    const fromN = normName(fromRaw);
    const toN = normName(toRaw);
    let direction;
    let otherRaw;
    let otherN;
    if (fromN && fromN === self) {
      direction = 'sent';
      otherRaw = toRaw;
      otherN = toN;
    } else if (toN && toN === self) {
      direction = 'received';
      otherRaw = fromRaw;
      otherN = fromN;
    } else {
      continue; // neither side is self — indeterminate, skip
    }
    if (!otherN) continue;
    // Skip anonymized / out-of-network counterparties: LinkedIn renders many as
    // the literal "LinkedIn Member", which would otherwise merge dozens of
    // unrelated people (and their verbatim quotes) into one bogus contact.
    if (otherN === 'linkedin member') continue;
    // Skip group threads — detect via the recipient-URLs column (LinkedIn puts
    // multiple recipients there, not in the TO name field).
    const recip = iRecip >= 0 ? at(row, iRecip) : '';
    if (otherRaw.includes(';') || recip.includes(';')) continue;
    const date = at(row, iDate);
    const content = iContent >= 0 ? at(row, iContent) : '';

    let a = agg.get(otherN);
    if (!a) {
      a = { name: otherRaw, count: 0, sent: 0, received: 0, last: '', snips: [] };
      agg.set(otherN, a);
    }
    a.count++;
    if (direction === 'sent') a.sent++;
    else a.received++;
    if (date && date > a.last) a.last = date; // ISO-ish dates string-sort correctly
    if (content) a.snips.push({ date, direction, text: content });
    if (direction === 'sent' && content && voiceLen < 6000) {
      const t = content.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (t) {
        voice.push(t);
        voiceLen += t.length;
      }
    }
  }

  const history = [];
  for (const a of agg.values()) {
    const snippets = a.snips
      .sort((x, y) => (x.date < y.date ? 1 : -1))
      .slice(0, 3)
      .map((s) => ({
        date: s.date,
        direction: s.direction,
        text: s.text.replace(/\s+/g, ' ').trim().slice(0, 240),
      }));
    history.push({
      name: a.name,
      count: a.count,
      sent: a.sent,
      received: a.received,
      last: a.last,
      snippets,
    });
  }
  return { history, voiceSample: voice.join('\n').slice(0, 8000) };
}

export function parseConnectionsCsv(text) {
  const rows = tokenize(text);
  if (!rows.length) return [];

  // Find the header row (LinkedIn puts a notes block above it).
  let headerIdx = rows.findIndex((r) => r.some((c) => /first name/i.test(c)));
  if (headerIdx === -1) headerIdx = 0;

  const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));

  const iFirst = col('first name');
  const iLast = col('last name');
  const iName = col('name', 'full name');
  const iEmail = col('email address', 'email', 'e-mail address');
  const iCompany = col('company', 'organization', 'current company');
  const iRole = col('position', 'role', 'title', 'current position');
  const iLoc = col('location', 'city', 'region');
  const iUrl = col('url', 'profile url', 'public profile url', 'linkedin url');

  const at = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c).trim())) continue;

    let name = [at(row, iFirst), at(row, iLast)].filter(Boolean).join(' ').trim();
    if (!name) name = at(row, iName);

    const contact = {
      contact_name: name,
      contact_email: at(row, iEmail),
      company: at(row, iCompany),
      role: at(row, iRole),
      location: at(row, iLoc),
      linkedin_url: at(row, iUrl),
    };
    if (contact.contact_name || contact.company) out.push(contact);
  }
  return out;
}
