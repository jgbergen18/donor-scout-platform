// Audit Batch C — pins the hot-path read indexes into existence so a future schema
// edit can't silently drop them and regress every prospects/Today/Brief load to a
// full table scan. (Correctness of the queries is covered by the feature suites; this
// just guards the index set.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeServer } from './helpers.js'; // boots the app (SKIP_LISTEN) → runs the DDL
const { db } = await import('../server.js');

after(() => closeServer());

test('the hot-path indexes are created at boot', () => {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name)
  );
  for (const idx of [
    'idx_connections_user_org_score',
    'idx_referrals_user_org',
    'idx_referrals_user_org_conn',
    'idx_agent_actions_user_org_brief',
    'idx_agent_actions_campaign',
    'idx_donations_referral',
    'idx_reminders_queue',
  ]) {
    assert.ok(names.has(idx), `missing index: ${idx}`);
  }
});
