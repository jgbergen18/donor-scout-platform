// AI in-voice outreach drafts: graceful degradation (503 without a key), org
// isolation (a cross-org connection id → 404, no existence leak), and a pure
// unit test of the grounded context assembly — it must include the scout's
// voice sample + the real facts and invent NOTHING the app doesn't hold.
//
// Offline: the harness deletes ANTHROPIC_API_KEY, so the route never reaches the
// real Anthropic API; the 503 guard returns before any SDK call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';
import { __draftInternals } from '../server.js';

after(() => closeServer());

test('draft route degrades gracefully without an API key (503, not crash)', async () => {
  const u = client();
  await u.login({ linkedinId: 'draft-503' });
  await u.post('/api/orgs', { name: 'Draft Org' });
  await u.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Dana Lead', company: 'Acme', linkedin_url: 'https://l/dana' }],
  });
  const connId = (await u.get('/api/prospects')).data.prospects[0].id;

  const res = await u.post(`/api/connections/${connId}/draft`, {});
  assert.equal(res.status, 503, 'no ANTHROPIC_API_KEY → graceful 503');
  assert.match(res.data.error, /ANTHROPIC_API_KEY/, 'message tells the user how to enable it');
});

test('draft route is org-scoped: a cross-org connection id returns 404', async () => {
  // User A owns a connection in org A.
  const a = client();
  await a.login({ linkedinId: 'draft-iso-a' });
  await a.post('/api/orgs', { name: 'Draft Org A' });
  await a.post('/api/connections/upload', {
    contacts: [{ contact_name: 'Owned By A', company: 'Acme', linkedin_url: 'https://l/a' }],
  });
  const connId = (await a.get('/api/prospects')).data.prospects[0].id;

  // User B in a separate org must not be able to draft against A's id → 404,
  // not 503 — existence is not leaked even when AI is off.
  const b = client();
  await b.login({ linkedinId: 'draft-iso-b' });
  await b.post('/api/orgs', { name: 'Draft Org B' });
  const res = await b.post(`/api/connections/${connId}/draft`, {});
  assert.equal(res.status, 404, 'cross-org connection id must 404 before the AI guard');
});

test('draftContext grounds on the voice sample + real facts and invents nothing', () => {
  const { draftContext } = __draftInternals;
  const conn = {
    contact_name: 'Sam Rivera',
    company: 'Globex',
    role: 'Engineer',
    location: 'Kyiv',
    score_reasons: JSON.stringify([{ label: 'Same school' }]),
    github_username: null,
    dossier_json: null,
  };
  const scout = { name: 'Alex Kim', company: 'Initech', past_companies: null, location: null, schools: null };
  const history = [
    { message_count: 6, sent_count: 3, received_count: 3, last_interaction: '2025-01-02', snippets: '["hey!"]' },
  ];
  const voiceSample = 'hey hope all is well, quick note —';

  const ctx = draftContext(conn, scout, history, voiceSample, null);

  // Voice signal carried through verbatim, and voiced is derivable from its presence.
  assert.equal(ctx.voiceSample, voiceSample);
  // Real, app-held facts are present.
  assert.equal(ctx.facts.contact.name, 'Sam Rivera');
  assert.equal(ctx.facts.contact.company, 'Globex');
  assert.deepEqual(ctx.facts.contact.relationshipSignals, ['Same school']);
  assert.equal(ctx.facts.you.name, 'Alex Kim');
  assert.equal(ctx.facts.sharedHistory[0].totalMessages, 6);

  // Null Object: absent dossier resolves to null, not fabricated.
  assert.equal(ctx.dossier, null);

  // Invents nothing — the serialized context contains no wealth/income/net-worth
  // keys (the app holds none, so the model is never handed any).
  const json = JSON.stringify(ctx).toLowerCase();
  for (const forbidden of ['networth', 'net_worth', 'income', 'salary', 'wealth']) {
    assert.ok(!json.includes(forbidden), `context must not contain "${forbidden}"`);
  }
});

test('draftSystem states the no-fabrication rule and switches register on the voice sample', () => {
  const { draftSystem } = __draftInternals;
  const cfg = { orgName: 'Code for Ukraine', impact: { programCost: 800, beneficiary: 'student', programLabel: 'bootcamp' } };

  const voiced = draftSystem(cfg, true);
  const neutral = draftSystem(cfg, false);

  assert.match(voiced, /NEVER invent/i, 'forbids fabrication');
  assert.match(voiced, /Code for Ukraine/, 'names the cause');
  assert.match(voiced, /\$800/, 'states the impact economics');
  assert.match(voiced, /voiceSample/, 'voiced register references the writing sample');
  assert.match(neutral, /warm, plain, friendly/i, 'neutral register when no sample');
  assert.notEqual(voiced, neutral, 'the two registers differ');
});
