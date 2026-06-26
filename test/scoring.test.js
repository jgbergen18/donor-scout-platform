// Scoring under multi-tenancy: relationship-first output is unchanged, component
// sub-scores (affinity/propensity) are persisted, and per-org cause config drives
// the propensity signal. (The SELECTABLE strategy mechanism is Pass 2 — here we
// only verify the foundation the strategy layer will build on.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, closeServer } from './helpers.js';

after(() => closeServer());

test('relationship-first ranking + persisted component sub-scores', async () => {
  const u = client();
  // Profile gives a coworker affinity signal for "Acme".
  await u.login({ linkedinId: 'score-user', name: 'Jane Acme' });
  await u.post('/api/orgs', { name: 'Scoring Org' });
  await u.post('/api/profile', { company: 'Acme', location: 'Boston' });

  const res = await u.post('/api/connections/upload', {
    contacts: [
      // Coworker + reachable + local → high affinity, low capacity.
      { contact_name: 'Coworker Pal', contact_email: 'pal@acme.test', company: 'Acme', role: 'Engineer', location: 'Boston', linkedin_url: 'https://l/pal' },
      // Big-company stranger, no relationship → high capacity, low affinity.
      { contact_name: 'Stranger Exec', company: 'Google', role: 'VP', location: 'Mountain View', linkedin_url: 'https://l/exec' },
    ],
  });
  assert.equal(res.data.added, 2);

  const prospects = (await u.get('/api/prospects')).data.prospects;
  const pal = prospects.find((p) => p.contact_name === 'Coworker Pal');
  const exec = prospects.find((p) => p.contact_name === 'Stranger Exec');

  // Relationship-first: the coworker outranks the big-company stranger.
  assert.ok(pal.donor_likelihood_score > exec.donor_likelihood_score, 'relationship beats capacity in rank');
  // Component sub-scores are persisted and sensible.
  assert.ok(pal.affinity_score > 0, 'coworker has affinity');
  assert.ok(exec.capacity_score > pal.capacity_score, 'exec has more capacity');
  // Capacity is display-only here: the stranger has high capacity but lower rank.
  assert.ok(exec.affinity_score < pal.affinity_score);
});

test('per-org cause config drives propensity scoring', async () => {
  const owner = client();
  await owner.login({ linkedinId: 'cause-owner' });
  await owner.post('/api/orgs', { name: 'Cause Org' });

  // Reconfigure the org's cause affinity to a custom keyword + weight.
  const cfg = await owner.patch('/api/orgs/config', {
    affinity: { keywords: ['penguins'], label: 'Penguin tie', weight: 40 },
  });
  assert.equal(cfg.status, 200);

  await owner.post('/api/connections/upload', {
    contacts: [
      { contact_name: 'Penguin Person', company: 'Penguins Inc', role: 'Analyst', linkedin_url: 'https://l/peng' },
    ],
  });
  const prospects = (await owner.get('/api/prospects')).data.prospects;
  const p = prospects.find((x) => x.contact_name === 'Penguin Person');
  assert.ok(p.propensity_score > 0, 'custom org keyword fires the propensity signal');
  assert.ok(p.score_reasons.includes('Penguin tie'), 'org-configured label appears in reasons');
});
