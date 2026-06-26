// Grants workspace M1 — the per-org document library. Documents are stored as
// extracted text, org-scoped, and are the grounding source for grant reports +
// application answers (M2/M3). No AI, no send here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

const addDoc = (u, name, content, kind) => u.post('/api/documents', { name, content, kind });

test('documents: add, list (meta only), fetch full text, delete', async () => {
  const u = client();
  await u.login({ linkedinId: 'doc-1', name: 'Dora D' });
  await u.post('/api/orgs', { name: 'Doc Org' });

  const created = await addDoc(u, 'Mission statement', 'We fund coding bootcamps for displaced Ukrainians.', 'mission');
  assert.equal(created.status, 201);
  assert.equal(created.data.document.kind, 'mission');
  assert.equal(created.data.document.char_count, 'We fund coding bootcamps for displaced Ukrainians.'.length);

  const list = (await u.get('/api/documents')).data;
  assert.equal(list.documents.length, 1);
  assert.ok(list.documents[0].content === undefined, 'list returns metadata only, not full text');
  assert.ok(Array.isArray(list.kinds) && list.kinds.includes('mission'));

  const full = (await u.get(`/api/documents/${created.data.document.id}`)).data;
  assert.match(full.document.content, /coding bootcamps/);

  const del = await u.del(`/api/documents/${created.data.document.id}`);
  assert.equal(del.data.documents.length, 0);
});

test('documents: validation (name + readable text required; bad kind falls back)', async () => {
  const u = client();
  await u.login({ linkedinId: 'doc-2', name: 'Val V' });
  await u.post('/api/orgs', { name: 'Val Org' });

  assert.equal((await addDoc(u, '', 'some text', 'mission')).status, 400, 'name required');
  assert.equal((await addDoc(u, 'Empty', '   ', 'mission')).status, 400, 'readable text required');

  const odd = await addDoc(u, 'Odd kind', 'text here', 'not-a-real-kind');
  assert.equal(odd.status, 201);
  assert.equal(odd.data.document.kind, 'reference', 'unknown kind falls back to reference');
});

test('the grant generators degrade gracefully when AI is off (503, not a crash)', async () => {
  const u = client();
  await u.login({ linkedinId: 'doc-degrade', name: 'Dee D' });
  await u.post('/api/orgs', { name: 'Degrade Org' });
  await addDoc(u, 'Mission', 'We fund bootcamps.', 'mission');
  const rep = await u.post('/api/grants/report', { reportType: 'general' });
  assert.equal(rep.status, 503);
  assert.equal(rep.data.aiDisabled, true);
  const ans = await u.post('/api/grants/answer', { questions: ['What is your mission?'] });
  assert.equal(ans.status, 503);
  assert.equal(ans.data.aiDisabled, true);
});

test('documents are org-scoped — another org cannot read or delete them', async () => {
  const a = client();
  await a.login({ linkedinId: 'doc-iso-a', name: 'Ana' });
  await a.post('/api/orgs', { name: 'Iso A' });
  const doc = (await addDoc(a, 'Secret plan', 'Org A internal strategy.', 'reference')).data.document;

  const b = client();
  await b.login({ linkedinId: 'doc-iso-b', name: 'Bo' });
  await b.post('/api/orgs', { name: 'Iso B' });
  assert.equal((await b.get('/api/documents')).data.documents.length, 0, "org B sees none of org A's docs");
  assert.equal((await b.get(`/api/documents/${doc.id}`)).status, 404, "org B cannot read org A's doc");
  await b.del(`/api/documents/${doc.id}`); // no-op cross-org
  assert.equal((await a.get(`/api/documents/${doc.id}`)).status, 200, "org A's doc survived org B's delete attempt");
});
