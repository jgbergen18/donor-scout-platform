/**
 * LinkedIn Donor Scout with Impact Tracking — Code for Ukraine
 * ------------------------------------------------------------------
 * Single-file Express backend:
 *   - "Sign In with LinkedIn using OpenID Connect" (real OAuth) + a clearly
 *     labeled demo-login fallback.
 *   - SQLite (better-sqlite3) with auto-created tables.
 *   - Real GitHub API enrichment (throttled, rate-limit aware).
 *   - Donor scoring: company tier (40) + GitHub signals (40) + role (20).
 *   - JSON APIs for connections, prospects, referrals, donations, impact.
 */

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import sqliteSessionStoreFactory from 'better-sqlite3-session-store';
import passport from 'passport';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import axios from 'axios';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSE } from './cause.config.js';
import {
  DEFAULT_STRATEGY_KEY,
  STRATEGY_KEYS,
  resolveStrategy,
  combineScore,
  normalizeWeights,
  strategyCatalog,
} from './lib/strategies/index.js';
import {
  status as aiStatus,
  configureSpendStore,
  aiEnabled,
  generateJSON,
  generateText,
  MODELS,
  AIDisabledError,
  AIBudgetError,
  mapWithConcurrency,
  preflight as aiPreflight,
} from './lib/ai.js';
import { generatePlan, generateReply } from './lib/campaign.js';
import { generateDraft, enforceDonationLink } from './lib/brief.js';
import { classifyReply, triageToday } from './lib/triage.js';
import { generateGrantReport, answerGrantQuestions, REPORT_TYPES } from './lib/grants.js';
import { generateNewsletter, buildNewsletterEmail } from './lib/newsletter.js';
import { matchProgramFor, matchProgramWith, compileCustom, MATCH_PROGRAM_COUNT } from './lib/matchgifts.js';
import { createMailer, magicLinkEmail, invitationEmail } from './lib/mailer.js';
import { resolveOutbound, decorateRedirect, parseAllowlist } from './lib/sendguard.js';
import { signUnsubToken, verifyUnsubToken } from './lib/unsubscribe.js';
import { createSecretBox } from './lib/secrets.js';
import { resolveSsoUser } from './lib/sso.js';
import * as oidc from 'openid-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Config & impact constants
// ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
// Public base URL of THIS API (used to build the exact OIDC redirect_uri that
// must be allow-listed in each org's Okta app). Defaults to the local dev API.
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'http://localhost:5000';
const IS_PROD = process.env.NODE_ENV === 'production';
// Going live (emailing real donors) REQUIRES a real signing secret. Without SECRETS_KEY,
// unsubscribe tokens would be signed with the PUBLIC dev key (lib/unsubscribe) and could be
// forged to mass-suppress donors across tenants. Tie the requirement to SEND_MODE=live (the
// actual trigger), not just NODE_ENV=production, so a staging/VPS box can't go live on the
// insecure default. Demo (redirect mode) + tests are unaffected.
if (String(process.env.SEND_MODE || '').toLowerCase() === 'live' && !process.env.SECRETS_KEY) {
  throw new Error('SECRETS_KEY is required when SEND_MODE=live (it signs unsubscribe tokens).');
}

// SESSION_SECRET must be set in production — silently falling back to the public dev
// literal would let anyone forge a signed session cookie and impersonate any user in
// any org (defeating the session-derived orgScope isolation). Fail loudly at boot in
// prod; keep the convenience literal only off the prod path. Exported for unit tests.
export function resolveSessionSecret(isProd, val) {
  if (isProd && !val) throw new Error('SESSION_SECRET is required in production.');
  return val || 'dev-secret-change-me';
}

// Centralized input caps — one source of truth so a guard and its user-facing message
// (and any future change) can't drift apart.
const LIMITS = {
  uploadContacts: 5000,
  reconcileDonors: 5000,
  historyRows: 20000,
  voiceSampleChars: 8000,
  bulkMatchCompanies: 2000,
};

// Impact math — sourced from cause.config.js so the tool retargets to any
// nonprofit by editing one file (here it's the Code for Ukraine bootcamp).
const COST_PER_BOOTCAMP = CAUSE.impact.programCost; // funds one beneficiary through the program
const BOOTCAMP_DAYS = CAUSE.impact.programDays;
const COST_PER_DAY = CAUSE.impact.dayCost; // funds a single day

// ────────────────────────────────────────────────────────────────
// Database — auto-create on startup
// ────────────────────────────────────────────────────────────────
// DATA_DIR is overridable (the test harness points it at a throwaway temp dir so
// suites run against an isolated SQLite file and never touch the real scout.db).
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'scout.db'));
db.pragma('journal_mode = WAL');
// Foreign keys: better-sqlite3 turns these ON by default, but set it EXPLICITLY so the
// app never silently relies on a library/build default. The schema's FK declarations and
// the manual FK-safe cascade deletes (donations -> referrals -> users, campaign family,
// reminders) all depend on enforcement being on; a silent flip to OFF would let orphaned
// donor data accumulate. This makes the guarantee load-bearing and auditable.
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    linkedin_id     TEXT UNIQUE,
    email           TEXT,
    name            TEXT,
    profile_picture TEXT,
    company         TEXT,
    past_companies  TEXT,
    location        TEXT,
    schools         TEXT,
    goal_amount     REAL DEFAULT 0,
    team_id         INTEGER,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS teams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    invite_code TEXT UNIQUE,
    goal_amount REAL DEFAULT 0,
    created_by  INTEGER,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id   INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    role      TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS connections (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                INTEGER NOT NULL,
    contact_name           TEXT,
    contact_email          TEXT,
    company                TEXT,
    role                   TEXT,
    location               TEXT,
    linkedin_url           TEXT,
    github_username        TEXT,
    donor_likelihood_score INTEGER DEFAULT 0,
    github_followers       INTEGER DEFAULT 0,
    github_repos           INTEGER DEFAULT 0,
    github_confidence      TEXT,
    github_bio             TEXT,
    company_tier           TEXT,
    capacity_score         INTEGER DEFAULT 0,
    score_reasons          TEXT,
    created_at             TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL,
    connection_id     INTEGER,
    contact_name      TEXT,
    contact_email     TEXT,
    company           TEXT,
    linkedin_url      TEXT,
    referred_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    status            TEXT DEFAULT 'asked',
    note              TEXT,
    follow_up_date    TEXT,
    donation_received INTEGER DEFAULT 0,
    donation_amount   REAL DEFAULT 0,
    donation_date     TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Per-gift donations LEDGER (the keystone). One row per gift, append-only via the
  -- recordGift() funnel — never overwritten. The three donation_* columns on the
  -- referral row are kept as a DENORMALIZED CACHE (received = EXISTS a gift, amount =
  -- SUM of gifts, date = MAX gift date over this referral's ledger rows), refreshed in
  -- the SAME transaction as every insert, so every existing read path keeps working
  -- unchanged. Org-scoped (user_id, org_id). A UNIQUE (org_id, user_id, dedupe_key)
  -- index makes re-imports idempotent (same referral+amount+day = one gift). This is
  -- the spine the retention features (LYBUNT, recurring, anniversaries, statements)
  -- build on, none of which the single-column model could express.
  CREATE TABLE IF NOT EXISTS donations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    org_id        INTEGER NOT NULL,
    referral_id   INTEGER NOT NULL,
    connection_id INTEGER,
    amount        REAL NOT NULL,
    donated_at    TEXT NOT NULL,            -- gift date/time (YYYY-MM-DD[ HH:MM:SS])
    source        TEXT DEFAULT 'manual',    -- manual | reconcile | backfill | demo
    dedupe_key    TEXT NOT NULL,            -- referral_id|amount|YYYY-MM-DD
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referral_id) REFERENCES referrals(id)
  );

  -- Outreach cadence: a sequence of scheduled follow-up reminders per referral.
  -- Each row is ONE step of the cadence (step_index 0,1,2,…) with a due_date and an
  -- open/closed state (done_at NULL → open; set → completed/closed). Org-scoped via
  -- the parent referral's user_id+org_id (denormalized here so every reminder query
  -- can scope by (user_id, org_id) the same way every other table does). Completing
  -- a step seeds the NEXT step in the cadence; snoozing just moves due_date.
  CREATE TABLE IF NOT EXISTS follow_up_reminders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id  INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    org_id       INTEGER NOT NULL,
    step_index   INTEGER NOT NULL DEFAULT 0,
    due_date     TEXT NOT NULL,            -- YYYY-MM-DD, matches follow_up_date format
    done_at      TEXT,                     -- NULL = open; timestamp = completed/closed
    closed_reason TEXT,                    -- 'completed' | 'donated' | 'declined' | NULL
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referral_id) REFERENCES referrals(id)
  );

  CREATE TABLE IF NOT EXISTS code_x_impact (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                  INTEGER UNIQUE NOT NULL,
    total_referred_donations REAL DEFAULT 0,
    num_referrals_converted  INTEGER DEFAULT 0,
    num_students_supported   INTEGER DEFAULT 0,
    num_days_funded          INTEGER DEFAULT 0,
    last_updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Multi-tenancy: each nonprofit is an organization; its cause config lives in
  -- org_config (seeded from cause.config.js) so the tool can host many orgs.
  CREATE TABLE IF NOT EXISTS organizations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE,
    created_by  INTEGER,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS org_config (
    org_id      INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Relationship memory: per-contact history distilled from the LinkedIn full
  -- export (messages). Stored LOCALLY, per user; powers grounded AI drafting.
  CREATE TABLE IF NOT EXISTS contact_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    org_id           INTEGER,
    connection_id    INTEGER,
    match_name       TEXT,
    last_interaction TEXT,
    message_count    INTEGER DEFAULT 0,
    sent_count       INTEGER DEFAULT 0,
    received_count   INTEGER DEFAULT 0,
    snippets         TEXT,
    source           TEXT DEFAULT 'messages',
    updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- A per-user writing-voice sample (the user's own sent messages), used so
  -- AI drafts sound like the scout. Stored locally, per user.
  CREATE TABLE IF NOT EXISTS voice_profiles (
    user_id    INTEGER PRIMARY KEY,
    org_id     INTEGER,
    sample     TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- ── SaaS auth Phase 1 (docs/saas-auth-okta.md) ────────────────────────────
  -- identities decouples the credential (how you sign in) from the person (the
  -- users row). A user can have several: 'magic_link' | 'linkedin' | 'demo'
  -- today, 'okta' later — adding a method never orphans an existing user. Org
  -- isolation is IMPLICIT via the owning user's org_id (a user has exactly one
  -- org), so identities itself carries no org_id. provider_sub semantics:
  --   linkedin   → OIDC sub (today's users.linkedin_id)
  --   demo       → literal 'demo-user' (teammates keep 'demo-teammate-*' ids)
  --   magic_link → the canonical (lowercased, trimmed) email — the verified
  --                email IS the magic-link identity.
  CREATE TABLE IF NOT EXISTS identities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    provider     TEXT NOT NULL,        -- 'magic_link' | 'linkedin' | 'demo'
    provider_sub TEXT NOT NULL,        -- subject/id from the method
    email        TEXT,                 -- email captured at link time (nullable for legacy)
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, provider_sub),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

  -- Passwordless email magic-link tokens. Account-bound, not org-bound — the org
  -- resolves at consume time via the matched/created user. The raw token is NEVER
  -- stored: only sha256(raw) hex. Single-use (consumed_at) + short expiry.
  CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,         -- canonical lowercased email
    token_hash  TEXT NOT NULL,         -- sha256(rawToken) hex; raw NEVER stored
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,                  -- set on single-use consumption
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_mlt_hash ON magic_link_tokens(token_hash);

  -- Email invitations — generalize the org join_code: an owner/admin invites a
  -- specific email + role; the invitee gets a token that drops them into THAT org
  -- with THAT role. org_id is the inviting org and is the isolation invariant —
  -- accept reads org/role from the ROW, never from request input.
  CREATE TABLE IF NOT EXISTS invitations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL,      -- inviting org; isolation invariant
    email       TEXT NOT NULL,         -- canonical lowercased
    role        TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member' (NOT 'owner')
    token_hash  TEXT NOT NULL,         -- sha256(raw); raw NEVER stored
    invited_by  INTEGER,               -- actor user_id
    expires_at  TEXT NOT NULL,
    accepted_at TEXT,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_inv_hash ON invitations(token_hash);
  CREATE INDEX IF NOT EXISTS idx_inv_org_email ON invitations(org_id, email);

  -- Append-only audit scaffold. org-scoped (nullable for pre-org events). NEVER
  -- stores raw tokens, links, or secrets — only dotted verbs + a freeform target
  -- (email / user id / role). No read endpoint in Phase 1 (reader is a fast-follow).
  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER,             -- org context (nullable for pre-org events)
    actor_user_id INTEGER,            -- who did it (null for unauthenticated)
    action        TEXT NOT NULL,       -- dotted verb (auth.login, invite.created, …)
    target        TEXT,                -- freeform: email / user id / role (NO tokens, NO secrets)
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at);

  -- ── SaaS auth Phase 2: per-org Okta OIDC SSO (BYO IdP) ────────────────────
  -- Each org configures its OWN Okta OIDC app. The client_secret is encrypted at
  -- rest (app-level node:crypto, key from SECRETS_KEY) and is NEVER returned by an
  -- API. group_role_map is JSON mapping an Okta group claim → an app role. JIT +
  -- enforced are 0/1 toggles. PK is org_id: at most one IdP config per org.
  CREATE TABLE IF NOT EXISTS org_idp_config (
    org_id            INTEGER PRIMARY KEY,
    type              TEXT NOT NULL DEFAULT 'okta_oidc',
    issuer            TEXT NOT NULL,      -- Okta issuer URL (discovery base)
    client_id         TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,      -- AES-256-GCM ciphertext; raw secret NEVER stored/returned
    group_role_map    TEXT,               -- JSON: { "OktaGroupName": "owner|admin|member" }
    jit_provisioning  INTEGER NOT NULL DEFAULT 0, -- 1 → first SSO login creates the user
    enforced          INTEGER NOT NULL DEFAULT 0, -- 1 → disable non-SSO logins for this org
    created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  -- Email domains that route a user to an org's IdP. A domain MUST be verified
  -- before it can claim users (anti-takeover) — an unverified domain never routes
  -- SSO. UNIQUE(domain): a domain belongs to at most one org globally, so an Okta
  -- token's email domain can resolve to exactly one tenant.
  CREATE TABLE IF NOT EXISTS org_domains (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER NOT NULL,       -- owning org; isolation invariant
    domain        TEXT NOT NULL,          -- canonical lowercased, e.g. acme.org
    verified      INTEGER NOT NULL DEFAULT 0, -- 1 → may route/claim users
    verify_token  TEXT,                   -- opaque DNS/email verification token (stub-checkable)
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (domain),
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_org_domains_org ON org_domains(org_id);
  -- The reminders queue query filters by (user_id, org_id) on OPEN rows ordered by
  -- due_date; this index serves both the queue and the per-referral lookup.
  CREATE INDEX IF NOT EXISTS idx_reminders_queue ON follow_up_reminders(user_id, org_id, done_at, due_date);
  CREATE INDEX IF NOT EXISTS idx_reminders_referral ON follow_up_reminders(referral_id);

  -- The Campaign Agent (reconciled from main): a goal-driven operation. A campaign
  -- holds the goal + the volunteer's constraints; agent_actions are the proposed
  -- asks the planner produced (approve/edit/skip queue); agent_runs is a planning
  -- audit log. org_id carries the tenant; NOTHING here sends — actions become
  -- pipeline referrals ('to_ask') on approval and the human sends each message by hand.
  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    org_id      INTEGER,
    name        TEXT NOT NULL,
    goal_amount REAL DEFAULT 0,
    deadline    TEXT,
    constraints TEXT,
    status      TEXT DEFAULT 'active',
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS agent_actions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id    INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    org_id         INTEGER,
    connection_id  INTEGER,
    contact_name   TEXT,
    kind           TEXT DEFAULT 'ask',
    channel        TEXT,
    suggested_ask  INTEGER DEFAULT 0,
    p_yes          INTEGER DEFAULT 0,
    expected_value REAL DEFAULT 0,
    rationale      TEXT,
    hook           TEXT,
    draft          TEXT,
    scheduled_date TEXT,
    status         TEXT DEFAULT 'proposed',
    referral_id    INTEGER,
    created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id    INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    org_id         INTEGER,
    model          TEXT,
    num_candidates INTEGER DEFAULT 0,
    num_actions    INTEGER DEFAULT 0,
    strategy       TEXT,
    created_at     TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- L2 nightly Standing Planner: per-campaign idempotency ledger so the background
  -- tick plans each campaign at most once per day (the UNIQUE index is the guard).
  -- org_id is carried for tenant-scoped reads; the runner derives it from the
  -- campaign row, NEVER a session (the cron has no req.user).
  CREATE TABLE IF NOT EXISTS nightly_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL,
    run_date    TEXT NOT NULL,
    num_moves   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nightly_runs ON nightly_runs(campaign_id, run_date);
`);

// Lightweight migration: add columns to databases created before these fields existed.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('users', 'company', 'TEXT');
ensureColumn('users', 'location', 'TEXT');
ensureColumn('users', 'goal_amount', 'REAL DEFAULT 0');
ensureColumn('users', 'schools', 'TEXT');
ensureColumn('users', 'past_companies', 'TEXT');
ensureColumn('users', 'team_id', 'INTEGER');
ensureColumn('users', 'demo_mode', 'INTEGER DEFAULT 0');
ensureColumn('connections', 'is_demo', 'INTEGER DEFAULT 0');
// Backfill membership rows for anyone who had a team before the many-to-many model.
db.prepare(`
  INSERT OR IGNORE INTO team_members (team_id, user_id, role)
  SELECT u.team_id, u.id, CASE WHEN t.created_by = u.id THEN 'owner' ELSE 'member' END
    FROM users u JOIN teams t ON t.id = u.team_id
   WHERE u.team_id IS NOT NULL
`).run();
ensureColumn('connections', 'score_reasons', 'TEXT');
ensureColumn('connections', 'linkedin_url', 'TEXT');
ensureColumn('connections', 'github_confidence', 'TEXT');
ensureColumn('connections', 'github_bio', 'TEXT');
ensureColumn('connections', 'capacity_score', 'INTEGER DEFAULT 0');
// AI donor dossier: a cached JSON brief per connection + when it was generated.
ensureColumn('connections', 'dossier_json', 'TEXT');
ensureColumn('connections', 'dossier_at', 'TEXT');
ensureColumn('referrals', 'company', 'TEXT');
ensureColumn('referrals', 'linkedin_url', 'TEXT');
ensureColumn('referrals', "status", "TEXT DEFAULT 'asked'");
ensureColumn('referrals', 'note', 'TEXT');
ensureColumn('referrals', 'follow_up_date', 'TEXT');
// Stewardship: timestamp the scout marks a donated referral as thanked. NULL =
// the gift has landed but the donor hasn't been thanked yet (the "awaiting
// thanks" surface). Set once via the mark-thanked / thank-you flow.
ensureColumn('referrals', 'thanked_at', 'TEXT');
// Retention: timestamp the scout sent (or dismissed) a SECOND-GIFT re-ask for this gift.
// NULL = eligible for the re-ask lane; set = already prompted, so the donor leaves the
// lane DURABLY (not just while a follow-up reminder happens to be open). One re-ask per
// gift; a real second gift removes them anyway (the lane requires exactly one gift).
ensureColumn('referrals', 'second_ask_at', 'TEXT');

// ── Multi-tenancy (ENFORCED) ─────────────────────────────────────────────────
// Each nonprofit is an organization. Every org-owned row carries org_id, a user
// belongs to exactly one org, and EVERY data query is scoped by the caller's
// org_id (see orgScope()/requireOrgRole() below). This block is the schema +
// idempotent backfill; the enforcement lives in the routes.
ensureColumn('users', 'org_id', 'INTEGER');
ensureColumn('connections', 'org_id', 'INTEGER');
ensureColumn('referrals', 'org_id', 'INTEGER');
ensureColumn('teams', 'org_id', 'INTEGER');
ensureColumn('code_x_impact', 'org_id', 'INTEGER');

// Org-level role (owner|admin|member) + per-user fundraising strategy. `strategy`
// is the per-user selectable ranking strategy (NULL → org default →
// relationship_first); `strategy_weights` holds the custom_weights bag. Resolved
// by strategyForUser() and combined at score time by the registry in
// lib/strategies/index.js. The scorer reads per-org cause config regardless.
ensureColumn('users', 'org_role', "TEXT DEFAULT 'member'");
ensureColumn('users', 'strategy', 'TEXT'); // NULL → org default → 'relationship_first'
ensureColumn('users', 'strategy_weights', 'TEXT'); // JSON {affinity,propensity,capacity}, custom only

// Org invite path, distinct from team invite codes.
ensureColumn('organizations', 'join_code', 'TEXT');

// Self-serve onboarding: the only persisted bit of onboarding state. Every
// checklist step's DONE state is DERIVED from the user's real data on each
// GET /api/onboarding (see that route); this flag just records that the scout
// dismissed/finished the checklist so we stop showing it. 0 = show, 1 = hidden.
ensureColumn('users', 'onboarding_dismissed', 'INTEGER DEFAULT 0');

// SaaS auth Phase 1: per-user deactivation. is_active=0 blocks login by ANY
// method while preserving the user's data + donor attribution (see the login
// paths + requireAuth). Backfill (below) leaves all existing users active.
ensureColumn('users', 'is_active', 'INTEGER DEFAULT 1');

// Component sub-scores persisted on every connection so a future strategy layer
// (Pass 2) can recombine affinity/propensity/capacity into a new rank WITHOUT
// recomputing the underlying signals. donor_likelihood_score stays the final rank.
ensureColumn('connections', 'affinity_score', 'INTEGER DEFAULT 0');
ensureColumn('connections', 'propensity_score', 'INTEGER DEFAULT 0');
// "Tonight's 15 Minutes": a prospect can be snoozed off the daily Today queue
// until this date (YYYY-MM-DD); null = never snoozed.
ensureColumn('connections', 'snooze_until', 'TEXT');

// L2 nightly Standing Planner: agent_actions double as the "Moves" the nightly tick
// stages. source distinguishes 'nightly' moves from on-demand 'manual' plans;
// approval_tier ('ask' = net-new, surfaced first | 'routine') is display grouping for
// the Morning Brief; brief_date stamps the day a nightly move was staged.
ensureColumn('agent_actions', 'source', "TEXT DEFAULT 'manual'");
ensureColumn('agent_actions', 'approval_tier', 'TEXT');
ensureColumn('agent_actions', 'brief_date', 'TEXT');

const DEFAULT_ORG_SLUG = 'default';
// The org-level default fundraising strategy. Relationship-first is the product's
// evidence-based default (relationship strength predicts a "yes" better than wealth).
// Sourced from the strategy registry so server.js and lib/strategies stay in sync.
const DEFAULT_STRATEGY = DEFAULT_STRATEGY_KEY;

function seedDefaultOrg() {
  let org = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(DEFAULT_ORG_SLUG);
  if (!org) {
    const info = db
      .prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)')
      .run(CAUSE.orgName, DEFAULT_ORG_SLUG);
    org = { id: info.lastInsertRowid };
  }
  if (!db.prepare('SELECT 1 FROM org_config WHERE org_id = ?').get(org.id)) {
    db.prepare('INSERT INTO org_config (org_id, config_json) VALUES (?, ?)').run(
      org.id,
      JSON.stringify({ ...CAUSE, defaultStrategy: DEFAULT_STRATEGY })
    );
  }
  return org.id;
}
const DEFAULT_ORG_ID = seedDefaultOrg();

// Backfill #1: pre-multi-tenancy rows directly owned by a user-blind scope.
for (const t of ['users', 'connections', 'referrals', 'teams', 'code_x_impact']) {
  db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`).run(DEFAULT_ORG_ID);
}
// Backfill #2: derive org_id from the OWNING USER for tables that joined late.
// Done per owning user (never a blanket default) so a row can't land in the wrong
// org once non-default orgs exist. Idempotent — only touches NULLs.
for (const t of ['connections', 'referrals', 'code_x_impact', 'contact_history']) {
  db.prepare(
    `UPDATE ${t} SET org_id = (SELECT u.org_id FROM users u WHERE u.id = ${t}.user_id) ` +
      `WHERE org_id IS NULL AND user_id IN (SELECT id FROM users)`
  ).run();
}
// teams are owned via created_by; voice_profiles via its PK user_id.
db.prepare(
  'UPDATE teams SET org_id = (SELECT u.org_id FROM users u WHERE u.id = teams.created_by) ' +
    'WHERE org_id IS NULL AND created_by IN (SELECT id FROM users)'
).run();
db.prepare(
  'UPDATE voice_profiles SET org_id = (SELECT u.org_id FROM users u WHERE u.id = voice_profiles.user_id) ' +
    'WHERE org_id IS NULL'
).run();
// Any stragglers (orphaned rows) fall into the default org so nothing is unscoped.
for (const t of ['contact_history', 'voice_profiles']) {
  db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`).run(DEFAULT_ORG_ID);
}

// ── Per-gift donations ledger: indexes + idempotent backfill ─────────────────
// Runs AFTER referrals.org_id is fully backfilled (above), so every seeded ledger
// row carries a real org_id. Backfill seeds ONE synthetic 'backfill' gift per
// already-donated referral that has no ledger row yet — idempotent (the NOT EXISTS
// guard + the unique dedupe index make it safe to run on every boot). NULL/0-amount
// donated flags get no row, so we never fabricate a gift. Pre-ledger multi-gift
// history is unrecoverable from a single overwritten column — that loss is accepted.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_dedupe   ON donations(org_id, user_id, dedupe_key);
  CREATE INDEX        IF NOT EXISTS idx_donations_referral ON donations(referral_id);
  CREATE INDEX        IF NOT EXISTS idx_donations_user_org_date ON donations(user_id, org_id, donated_at);
`);

// Read-side indexes for the hot per-user/per-org scans (prospects, Today/Brief
// assembly, plan candidates). Created after the org_id/agent_actions columns exist
// (ensureColumn above). Pure read wins; negligible write cost at this scale. Without
// these, listProspects / listReferrals / the Brief read full-scan + filesort.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_connections_user_org_score ON connections(user_id, org_id, donor_likelihood_score DESC);
  CREATE INDEX IF NOT EXISTS idx_referrals_user_org         ON referrals(user_id, org_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_user_org_conn    ON referrals(user_id, org_id, connection_id);
  CREATE INDEX IF NOT EXISTS idx_agent_actions_user_org_brief ON agent_actions(user_id, org_id, source, brief_date);
  CREATE INDEX IF NOT EXISTS idx_agent_actions_campaign      ON agent_actions(campaign_id, user_id, org_id, connection_id, status);
`);
db.prepare(`
  INSERT OR IGNORE INTO donations (user_id, org_id, referral_id, connection_id, amount, donated_at, source, dedupe_key)
  SELECT r.user_id, r.org_id, r.id, r.connection_id, r.donation_amount,
         COALESCE(r.donation_date, r.referred_at, CURRENT_TIMESTAMP),
         'backfill',
         r.id || '|' || r.donation_amount || '|' || substr(COALESCE(r.donation_date, r.referred_at, CURRENT_TIMESTAMP), 1, 10)
    FROM referrals r
   WHERE r.donation_received = 1 AND r.donation_amount > 0
     AND r.org_id IS NOT NULL AND r.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM donations d WHERE d.referral_id = r.id)
`).run();

// Backfill #3: roles. Everyone without a role is a 'member'; then promote exactly
// one owner per org (organizations.created_by if present, else the lowest user id
// in that org) so every org — including 'default' — has an administrator.
db.prepare("UPDATE users SET org_role = 'member' WHERE org_role IS NULL").run();
for (const org of db.prepare('SELECT id, created_by FROM organizations').all()) {
  const hasOwner = db
    .prepare("SELECT 1 FROM users WHERE org_id = ? AND org_role = 'owner'")
    .get(org.id);
  if (hasOwner) continue;
  let ownerId = org.created_by;
  if (!ownerId || !db.prepare('SELECT 1 FROM users WHERE id = ? AND org_id = ?').get(ownerId, org.id)) {
    ownerId = db.prepare('SELECT MIN(id) AS id FROM users WHERE org_id = ?').get(org.id)?.id || null;
  }
  if (ownerId) db.prepare("UPDATE users SET org_role = 'owner' WHERE id = ?").run(ownerId);
}

// Backfill #4: generate a join_code for any org missing one.
function genOrgJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  let code;
  do {
    code = 'ORG-' + Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (db.prepare('SELECT 1 FROM organizations WHERE join_code = ?').get(code));
  return code;
}
for (const org of db.prepare('SELECT id FROM organizations WHERE join_code IS NULL').all()) {
  db.prepare('UPDATE organizations SET join_code = ? WHERE id = ?').run(genOrgJoinCode(), org.id);
}

// Backfill #5: ensure org_config carries a defaultStrategy (older seeds lacked it).
for (const row of db.prepare('SELECT org_id, config_json FROM org_config').all()) {
  try {
    const cfg = JSON.parse(row.config_json);
    if (!cfg.defaultStrategy) {
      cfg.defaultStrategy = DEFAULT_STRATEGY;
      db.prepare('UPDATE org_config SET config_json = ? WHERE org_id = ?').run(
        JSON.stringify(cfg),
        row.org_id
      );
    }
  } catch {
    /* leave malformed config alone; getOrgConfig falls back to CAUSE */
  }
}

// Backfill #6 (SaaS auth Phase 1): cover the is_active column-add — any row that
// predates the column (NULL) is treated as active. Idempotent.
db.prepare('UPDATE users SET is_active = 1 WHERE is_active IS NULL').run();

// Backfill #7 (SaaS auth Phase 1): give every existing user exactly ONE identity
// row derived from linkedin_id, so NO current login breaks once lookups go
// identity-first. Re-runnable: INSERT OR IGNORE on the (provider, provider_sub)
// UNIQUE, and we only consider users that have no identity yet.
//   linkedin_id = 'demo-user'        → (demo, 'demo-user')
//   LIKE 'demo-teammate-%'           → (demo, <linkedin_id>)
//   LIKE 'test-%' (test DBs only)    → (linkedin, <linkedin_id>)
//   any other non-null               → (linkedin, <linkedin_id>)
//   null linkedin_id                 → skip (matched by email at magic-link time,
//                                      gets a magic_link identity then)
{
  const _insertIdentityBackfill = db.prepare(
    'INSERT OR IGNORE INTO identities (user_id, provider, provider_sub, email) VALUES (?, ?, ?, ?)'
  );
  const usersNeedingIdentity = db
    .prepare(
      'SELECT id, linkedin_id, email FROM users ' +
        'WHERE linkedin_id IS NOT NULL AND id NOT IN (SELECT user_id FROM identities)'
    )
    .all();
  for (const u of usersNeedingIdentity) {
    const provider = u.linkedin_id === 'demo-user' || u.linkedin_id?.startsWith('demo-teammate-') ? 'demo' : 'linkedin';
    _insertIdentityBackfill.run(u.id, provider, u.linkedin_id, u.email || null);
  }
}

// Backfill #8 (outreach cadence): migrate the OLD single follow_up_date into the
// new follow_up_reminders model WITHOUT breaking referrals that already had one.
// For every still-OPEN referral (not donated/declined) that has a follow_up_date
// but no reminder yet, create a step-0 reminder at that date. Idempotent: the
// NOT EXISTS guard means re-running never duplicates, and referrals with no date
// stay un-seeded (they'll get a cadence the next time they're marked "asked").
db.prepare(
  `INSERT INTO follow_up_reminders (referral_id, user_id, org_id, step_index, due_date)
     SELECT r.id, r.user_id, r.org_id, 0, r.follow_up_date
       FROM referrals r
      WHERE r.follow_up_date IS NOT NULL
        AND r.follow_up_date <> ''
        AND r.status NOT IN ('donated', 'declined')
        AND NOT EXISTS (SELECT 1 FROM follow_up_reminders fr WHERE fr.referral_id = r.id)`
).run();

const setUserOrgIfNull = db.prepare('UPDATE users SET org_id = ? WHERE id = ? AND org_id IS NULL');
const _orgConfigStmt = db.prepare('SELECT config_json FROM org_config WHERE org_id = ?');
const _userOrgStmt = db.prepare('SELECT org_id FROM users WHERE id = ?');

// Per-org cause config (impact economics + affinity keywords), falling back to
// the static cause.config.js default. The seam for true per-tenant behavior.
function getOrgConfig(orgId) {
  try {
    const row = _orgConfigStmt.get(orgId);
    if (row?.config_json) return JSON.parse(row.config_json);
  } catch {
    /* fall through to default */
  }
  return CAUSE;
}
function orgConfigForUserId(userId) {
  return getOrgConfig(_userOrgStmt.get(userId)?.org_id || DEFAULT_ORG_ID);
}

// ── Autonomy policy (the "dial": shed LABOR, keep AUTHORITY) ──────────────────
// Per-org settings that control how much the AI layer does without a per-action
// human click. CRUCIAL: autonomy NEVER touches transmission — "auto-accept" only
// applies REVERSIBLE pipeline moves (advance/snooze/decline) and SUPPRESSES queue
// items; it never sends a message and never records a gift (money decisions stay a
// human fork). Defaults are ON per the deployment directive; togglable per org.
const AUTONOMY_DEFAULTS = { autoAcceptReplies: true, autoApplyTriage: true, autoApproveMoves: true, policy: '' };
function getAutonomy(orgId) {
  const cfg = getOrgConfig(orgId);
  const a = cfg && typeof cfg.autonomy === 'object' && cfg.autonomy ? cfg.autonomy : {};
  return {
    autoAcceptReplies: a.autoAcceptReplies !== undefined ? !!a.autoAcceptReplies : AUTONOMY_DEFAULTS.autoAcceptReplies,
    autoApplyTriage: a.autoApplyTriage !== undefined ? !!a.autoApplyTriage : AUTONOMY_DEFAULTS.autoApplyTriage,
    // L2: auto-approve the nightly Standing Planner's moves. "Approve" only QUEUES a
    // to_ask referral — it NEVER sends — so this governs the human's attention, not
    // safety. Default ON per the deployment directive; togglable per org.
    autoApproveMoves: a.autoApproveMoves !== undefined ? !!a.autoApproveMoves : AUTONOMY_DEFAULTS.autoApproveMoves,
    policy: typeof a.policy === 'string' ? a.policy.slice(0, 2000) : '',
  };
}

// Validate a user-supplied donation URL: https only (http allowed for localhost/dev),
// length-capped, else the fallback. The donate link lands in client hrefs/iframes AND
// is the SOLE allowed link in AI drafts/replies, so a raw config string is never trusted.
function cleanDonateUrl(raw, fallback = null) {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  try {
    const u = new URL(s);
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal)) return s.slice(0, 500);
  } catch {
    /* invalid */
  }
  return fallback;
}

// The per-org cause the CLIENT brands from (orgName + impact economics + a validated,
// resolved donate link). Attached to the user object so OrgContext rebrands the whole
// app per tenant, falling back to the static cause.config.js defaults on the client.
function causePublic(orgId) {
  const c = getOrgConfig(orgId);
  // The organization's real name (organizations table) is AUTHORITATIVE for
  // branding — a cloned config_json may still carry the default cause's name.
  const org = findOrgById.get(orgId);
  return { orgName: (org && org.name) || c.orgName, impact: c.impact, donateUrl: donateUrlForOrg(orgId) };
}

// ── Outreach cadence ─────────────────────────────────────────────
// The default follow-up CADENCE: when a prospect is marked "asked", we schedule a
// sequence of reminders at these day-offsets from the ask (+3d, +1w, +2w). Each
// offset is relative to the PREVIOUS step's due date so the gaps stay even even if
// a step is completed late. Configurable per org via org_config.followUpCadenceDays
// (an array of positive integers). resolveCadence() validates + falls back here so a
// malformed org config can never break seeding.
const DEFAULT_FOLLOW_UP_CADENCE = [3, 7, 14];
function resolveCadence(orgId) {
  const raw = getOrgConfig(orgId)?.followUpCadenceDays;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((n) => Number.isInteger(n) && n > 0)
  ) {
    return raw;
  }
  return DEFAULT_FOLLOW_UP_CADENCE;
}
// Add N days to a YYYY-MM-DD (or "today" when no base) and return YYYY-MM-DD.
function addDays(baseYmd, days) {
  const d = baseYmd ? new Date(`${baseYmd}T00:00:00Z`) : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Persist the AI dollar budget across restarts (the in-memory guard would
// otherwise reset to a full budget every boot — a crash-loop could re-spend).
db.exec(
  'CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER, usd_spent REAL)'
);
const _aiUsageLoad = db.prepare('SELECT window_start, usd_spent FROM ai_usage WHERE id = 1');
const _aiUsageSave = db.prepare(
  'INSERT INTO ai_usage (id, window_start, usd_spent) VALUES (1, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, usd_spent = excluded.usd_spent'
);
configureSpendStore({
  load: () => {
    const r = _aiUsageLoad.get();
    return r ? { windowStart: r.window_start, usdSpent: r.usd_spent } : null;
  },
  save: (windowStart, usdSpent) => _aiUsageSave.run(windowStart, usdSpent),
});

// ────────────────────────────────────────────────────────────────
// User helpers
// ────────────────────────────────────────────────────────────────
const findUserByLinkedInId = db.prepare('SELECT * FROM users WHERE linkedin_id = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(
  'INSERT INTO users (linkedin_id, email, name, profile_picture) VALUES (?, ?, ?, ?)'
);
const updateUser = db.prepare(
  'UPDATE users SET email = ?, name = ?, profile_picture = ? WHERE id = ?'
);
const updateUserProfile = db.prepare(
  'UPDATE users SET company = ?, past_companies = ?, location = ?, schools = ?, goal_amount = ? WHERE id = ?'
);
const ensureImpactRow = db.prepare(
  'INSERT OR IGNORE INTO code_x_impact (user_id, org_id) VALUES (?, ?)'
);

// ── Identities: credential-from-person decoupling (SaaS auth Phase 1) ────────
// Lookups become identity-first via findUserByIdentity(); writes go to BOTH the
// identities row and (for LinkedIn/demo) users.linkedin_id, which is KEPT so the
// demo-teammate-% exclusions, publicUser.isDemo, and findUserByLinkedInId still
// work. A user has exactly one org, so identities needs no org_id.
const insertIdentity = db.prepare(
  'INSERT OR IGNORE INTO identities (user_id, provider, provider_sub, email) VALUES (?, ?, ?, ?)'
);
const findIdentity = db.prepare(
  'SELECT * FROM identities WHERE provider = ? AND provider_sub = ?'
);

// Resolve a user by one of their identities (joins to users). Returns the full
// users row or undefined.
function findUserByIdentity(provider, providerSub) {
  const id = findIdentity.get(provider, providerSub);
  return id ? findUserById.get(id.user_id) : undefined;
}

// Email canonicalization in ONE place (lowercase + trim) so the same person can
// never fork into two accounts via case/whitespace differences.
function canonicalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function upsertUser({ linkedin_id, email, name, profile_picture }) {
  const existing = findUserByLinkedInId.get(linkedin_id);
  let user;
  if (existing) {
    updateUser.run(email, name, profile_picture, existing.id);
    user = findUserById.get(existing.id);
  } else {
    const info = insertUser.run(linkedin_id, email, name, profile_picture);
    user = findUserById.get(info.lastInsertRowid);
  }
  setUserOrgIfNull.run(DEFAULT_ORG_ID, user.id); // assign new users to the default org
  user = findUserById.get(user.id); // re-read so org_id is populated
  ensureImpactRow.run(user.id, user.org_id || DEFAULT_ORG_ID); // every user has a seeded impact row
  // Ensure a LinkedIn/demo identity row exists so future logins resolve via
  // identities (identity-first) while staying fully backward compatible. The
  // provider mirrors the backfill mapping: 'demo-user'/'demo-teammate-*' → demo.
  const provider =
    linkedin_id === 'demo-user' || String(linkedin_id).startsWith('demo-teammate-') ? 'demo' : 'linkedin';
  insertIdentity.run(user.id, provider, linkedin_id, email || null);
  return user;
}

// ── Magic-link user resolution (SaaS auth Phase 1) ───────────────────────────
// A brand-new magic-link user is created EXACTLY as a new demo/LinkedIn user is:
// assigned to DEFAULT_ORG_ID (setUserOrgIfNull), org_role='member', a seeded
// impact row, plus a magic_link identity keyed on the canonical email. They then
// see the existing create-org / join-by-code onboarding (inDefaultOrg=true).
const insertMagicLinkUser = db.prepare(
  'INSERT INTO users (email, name) VALUES (?, ?)'
);
// Match an existing account by email (case-insensitive), used when no
// magic_link identity exists yet (e.g. a backfilled LinkedIn/demo user signing
// in by email for the first time).
const findUserByEmailCI = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?');

function upsertMagicLinkUser({ email, name, orgId, role }) {
  const canon = canonicalizeEmail(email);
  // 1. Existing magic_link identity → same account.
  let user = findUserByIdentity('magic_link', canon);
  // 2. Else an existing user with that email (backfilled LinkedIn/demo, or an
  //    invited-then-created user) → adopt it and attach a magic_link identity.
  if (!user) user = findUserByEmailCI.get(canon);
  if (!user) {
    // 3. Brand-new account.
    const info = insertMagicLinkUser.run(canon, name || canon);
    user = findUserById.get(info.lastInsertRowid);
  }
  // Place the user: an invite supplies org+role from its ROW; otherwise default
  // org as 'member' (only if not already in an org — never moves an existing user).
  if (orgId) {
    setUserOrgRole.run(orgId, role || 'member', user.id);
  } else {
    setUserOrgIfNull.run(DEFAULT_ORG_ID, user.id);
  }
  user = findUserById.get(user.id);
  ensureImpactRow.run(user.id, user.org_id || DEFAULT_ORG_ID);
  insertIdentity.run(user.id, 'magic_link', canon, canon);
  return user;
}

// ────────────────────────────────────────────────────────────────
// SaaS auth Phase 1 — TokenService, audit log, mailer instance
// ────────────────────────────────────────────────────────────────
// One hardened, auditable token implementation shared by BOTH magic-link and
// invitations (DRY — both need issue/hash/verify/consume with the same security
// posture). Security posture: the RAW token is returned to the caller exactly
// once at issue time and NEVER stored; only sha256(raw) hex lives in the DB.
// Verification looks up by that hash and confirms with a constant-time compare,
// so there is no early-return timing oracle. Single-use is enforced by the
// caller stamping consumed_at/accepted_at inside a transaction.
const sha256Hex = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

const TokenService = {
  // Issue a new opaque token. Returns { raw, hash, expiresAt }. The raw value is
  // the ONLY copy the caller may surface (dev/test) or hand to the mailer.
  issue(ttlMs) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = sha256Hex(raw);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return { raw, hash, expiresAt };
  },
  // Constant-time confirm that a presented raw token matches a stored hash. Both
  // operands are fixed-length sha256 hex, so timingSafeEqual never throws on a
  // length mismatch and leaks no timing signal distinguishing the failure modes.
  matches(raw, storedHash) {
    if (!raw || !storedHash) return false;
    const a = Buffer.from(sha256Hex(raw), 'utf8');
    const b = Buffer.from(String(storedHash), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },
  // True if a row (with expires_at + consumed_at/accepted_at) is still live.
  isLive(row, consumedField) {
    if (!row) return false;
    if (row[consumedField]) return false;
    return new Date(row.expires_at).getTime() > Date.now();
  },
};

// ── Audit log (append-only scaffold) ─────────────────────────────
// recordAudit is fire-and-forget: wrapped in try/catch so an audit failure can
// NEVER break the underlying operation. NEVER pass a raw token, link, or secret
// as `target` — only emails / ids / roles.
const _insertAudit = db.prepare(
  'INSERT INTO audit_log (org_id, actor_user_id, action, target) VALUES (?, ?, ?, ?)'
);
function recordAudit({ orgId = null, actorUserId = null, action, target = null }) {
  try {
    _insertAudit.run(orgId, actorUserId, action, target);
  } catch (err) {
    console.error('[audit] failed to record', action, err?.message);
  }
}

// Single mailer instance (console adapter by default — see lib/mailer.js).
const mailer = createMailer();

// ── Outbound chokepoint ──────────────────────────────────────────
// EVERY app-sent DONOR-FACING email (outreach, thank-you, second-gift re-ask,
// newsletter) goes through sendOutbound(). (Auth mail, the magic-link and invitation
// emails, is intentionally exempt: it must reach the real recipient, not the operator
// inbox.) The recipient allowlist in lib/sendguard
// (SEND_ALLOWLIST / SEND_MODE) governs who can actually be reached. In demo/dev the
// default clamps every recipient to the operator's own inbox (jgbergen18@gmail.com),
// redirecting donor sends so nothing reaches a real donor by accident. Set SEND_MODE=live
// (or widen SEND_ALLOWLIST) to go fully live. Returns a result the route surfaces to the UI.
console.log(`[Send] outbound mode=${process.env.SEND_MODE || 'redirect'} allowlist=[${parseAllowlist().join(', ')}]`);
async function sendOutbound({ to, subject, text, html, headers, kind = 'outreach', orgId, userId }) {
  // Opt-out is enforced FIRST, ahead of the allowlist, on the REAL intended recipient
  // (never the redirected operator address) so every donor-facing send respects an
  // unsubscribe. Auth mail does not flow through here, so it is unaffected.
  const intended = String(to || '').trim().toLowerCase();
  if (orgId && intended && isSuppressedStmt.get(orgId, intended)) {
    recordAudit({ orgId, actorUserId: userId, action: 'send.suppressed', target: `${kind}:${intended}` });
    return { delivered: false, suppressed: true, intended: to, adapter: mailer.name };
  }
  const decision = resolveOutbound(to);
  if (decision.action === 'block') {
    recordAudit({ orgId, actorUserId: userId, action: 'send.blocked', target: `${kind}:${to || 'unknown'}` });
    return { delivered: false, blocked: true, intended: to, adapter: mailer.name };
  }
  // Drop email headers on a redirected (demo) copy: the per-recipient List-Unsubscribe token
  // belongs to a REAL donor, and a demo copy lands in the operator inbox — we must not put a
  // live donor's one-click opt-out token there.
  const hdrs = decision.redirected ? undefined : headers;
  const payload = decision.redirected
    ? { to: decision.to, ...decorateRedirect({ subject, text, html }, decision.intended) }
    : { to: decision.to, subject, text, html, ...(hdrs ? { headers: hdrs } : {}) };
  await mailer.send(payload);
  recordAudit({ orgId, actorUserId: userId, action: 'send.delivered', target: `${kind}:${decision.intended || decision.to}` });
  return {
    delivered: true,
    to: decision.to,
    redirected: !!decision.redirected,
    intended: decision.intended || decision.to,
    adapter: mailer.name,
  };
}

// ── Magic-link & invitation prepared statements ──────────────────
const insertMagicToken = db.prepare(
  'INSERT INTO magic_link_tokens (email, token_hash, expires_at) VALUES (?, ?, ?)'
);
const findMagicTokenByHash = db.prepare(
  'SELECT * FROM magic_link_tokens WHERE token_hash = ?'
);
const consumeMagicToken = db.prepare(
  "UPDATE magic_link_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL"
);
const countLiveMagicTokens = db.prepare(
  "SELECT COUNT(*) AS n FROM magic_link_tokens WHERE email = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP"
);
const pruneMagicTokens = db.prepare(
  "DELETE FROM magic_link_tokens WHERE expires_at < datetime('now', '-1 day') OR consumed_at < datetime('now', '-1 day')"
);

const insertInvitation = db.prepare(
  'INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const findInvitationByHash = db.prepare('SELECT * FROM invitations WHERE token_hash = ?');
const acceptInvitationStmt = db.prepare(
  'UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND accepted_at IS NULL'
);
// Supersede prior live invites for the same org+email when re-inviting.
const supersedeInvitations = db.prepare(
  "UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE org_id = ? AND email = ? AND accepted_at IS NULL"
);
// A live (unexpired, unaccepted) invitation for an email, newest first. Checked
// on plain magic-link consume too, so an invited user who instead requests a
// magic link still lands in the inviting org.
const findLiveInvitationByEmail = db.prepare(
  "SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1"
);
const listOrgInvitations = db.prepare(
  "SELECT id, email, role, expires_at AS expiresAt, created_at AS createdAt, invited_by AS invitedBy " +
    "FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY id DESC"
);
const findInvitationInOrg = db.prepare('SELECT * FROM invitations WHERE id = ? AND org_id = ?');
const revokeInvitation = db.prepare(
  "UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND org_id = ? AND accepted_at IS NULL"
);

// Per-user activation flag (deactivation preserves data + donor attribution).
const setUserActive = db.prepare('UPDATE users SET is_active = ? WHERE id = ? AND org_id = ?');

// ────────────────────────────────────────────────────────────────
// SaaS auth Phase 2 — per-org Okta OIDC SSO (BYO IdP)
// ────────────────────────────────────────────────────────────────
// App-level secret box: encrypts/decrypts each org's Okta client_secret at rest.
// Constructed once at boot so the prod "SECRETS_KEY required" check fires early
// (in non-prod it warns + falls back to a dev key — see lib/secrets.js).
const secretBox = createSecretBox();

// org_idp_config prepared statements. The encrypted secret is written/read here;
// it is NEVER selected into any API response (publicIdpConfig() strips it).
const upsertIdpConfig = db.prepare(`
  INSERT INTO org_idp_config (org_id, type, issuer, client_id, client_secret_enc, group_role_map, jit_provisioning, enforced, updated_at)
  VALUES (@org_id, 'okta_oidc', @issuer, @client_id, @client_secret_enc, @group_role_map, @jit_provisioning, @enforced, CURRENT_TIMESTAMP)
  ON CONFLICT(org_id) DO UPDATE SET
    issuer = excluded.issuer,
    client_id = excluded.client_id,
    client_secret_enc = excluded.client_secret_enc,
    group_role_map = excluded.group_role_map,
    jit_provisioning = excluded.jit_provisioning,
    enforced = excluded.enforced,
    updated_at = CURRENT_TIMESTAMP
`);
const findIdpConfigByOrg = db.prepare('SELECT * FROM org_idp_config WHERE org_id = ?');
const deleteIdpConfigByOrg = db.prepare('DELETE FROM org_idp_config WHERE org_id = ?');

// org_domains prepared statements. domain is globally UNIQUE so a verified domain
// resolves to exactly one org (the email→org routing key). Only VERIFIED domains
// route SSO (anti-takeover).
const insertOrgDomain = db.prepare(
  'INSERT INTO org_domains (org_id, domain, verified, verify_token) VALUES (?, ?, 0, ?)'
);
const listOrgDomains = db.prepare(
  'SELECT id, domain, verified, created_at AS createdAt FROM org_domains WHERE org_id = ? ORDER BY domain'
);
const findDomainInOrg = db.prepare('SELECT * FROM org_domains WHERE id = ? AND org_id = ?');
const findVerifiedDomain = db.prepare(
  'SELECT * FROM org_domains WHERE domain = ? AND verified = 1'
);
const markDomainVerified = db.prepare(
  'UPDATE org_domains SET verified = 1 WHERE id = ? AND org_id = ?'
);
const deleteOrgDomain = db.prepare('DELETE FROM org_domains WHERE id = ? AND org_id = ?');

// Strip the secret + shape the IdP config for API responses. The encrypted secret
// is NEVER returned; we only signal whether one is configured.
function publicIdpConfig(row) {
  if (!row) return null;
  let groupRoleMap = null;
  try {
    groupRoleMap = row.group_role_map ? JSON.parse(row.group_role_map) : null;
  } catch {
    groupRoleMap = null;
  }
  return {
    type: row.type,
    issuer: row.issuer,
    clientId: row.client_id,
    hasClientSecret: !!row.client_secret_enc, // boolean only — never the secret
    groupRoleMap,
    jitProvisioning: row.jit_provisioning === 1,
    enforced: row.enforced === 1,
    updatedAt: row.updated_at,
  };
}

// Extract the (lowercased) domain from an email, or null.
function emailDomain(email) {
  const at = canonicalizeEmail(email).split('@');
  return at.length === 2 && at[1] ? at[1] : null;
}

// Resolve a verified email domain → org → IdP config. Returns { org, config } or
// null. This is the email→org ROUTING used by /api/auth/sso/start. ONLY verified
// domains match (findVerifiedDomain), so an unverified/foreign domain never routes.
function resolveOrgForEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return null;
  const dom = findVerifiedDomain.get(domain);
  if (!dom) return null;
  const config = findIdpConfigByOrg.get(dom.org_id);
  if (!config) return null;
  return { org: findOrgById.get(dom.org_id), config };
}

// True if the org enforces SSO (non-SSO logins disabled for its members).
function orgEnforcesSso(orgId) {
  const c = findIdpConfigByOrg.get(orgId);
  return !!(c && c.enforced === 1);
}

// JIT/invite user creation for SSO, mirroring upsertMagicLinkUser's onboarding
// (org+role from the resolved ROW, a seeded impact row, an okta identity). Used
// by the injected ops below; org/role NEVER come from IdP-supplied input.
function createSsoUser({ email, orgId, role, sub, inviteId }) {
  const canon = canonicalizeEmail(email);
  // A brand-new SSO user. Name defaults to the email local-part / email.
  const info = insertMagicLinkUser.run(canon || sub, canon || sub);
  const user = findUserById.get(info.lastInsertRowid);
  setUserOrgRole.run(orgId, role || 'member', user.id);
  ensureImpactRow.run(user.id, orgId);
  insertIdentity.run(user.id, 'okta', sub, canon || null);
  if (inviteId) acceptInvitationStmt.run(inviteId);
  return findUserById.get(user.id);
}

// Match an existing user by email but ONLY within the resolving org — never
// across tenants (cross-org safety).
const findUserByEmailInOrg = db.prepare(
  'SELECT * FROM users WHERE LOWER(email) = ? AND org_id = ?'
);

// The injected operations resolveSsoUser() calls — server-side prepared statements
// here; the tests inject in-memory fakes instead. Keeping these thin keeps the
// security-critical logic (lib/sso.js) pure + offline-testable.
const ssoOps = {
  findUserByIdentity,
  findUserByEmailInOrg: (email, orgId) => findUserByEmailInOrg.get(canonicalizeEmail(email), orgId),
  findLiveInvitation: (email, orgId) => {
    const inv = findLiveInvitationByEmail.get(canonicalizeEmail(email));
    return inv && inv.org_id === orgId ? inv : null;
  },
  setUserRole: (userId, orgId, role) => setUserOrgRole.run(orgId, role, userId),
  ensureIdentity: (userId, provider, sub, email) => insertIdentity.run(userId, provider, sub, email),
  createUser: createSsoUser,
  reload: (userId) => findUserById.get(userId),
};

// Discover + build the openid-client Configuration for an org's Okta. This is the
// ONLY network call in the SSO flow (discovery + later code-exchange/JWKS). It is
// NEVER reached in tests (which drive resolveSsoUser directly / use the fake-claims
// hook). The decrypted client_secret lives only in memory for the request.
async function oidcConfigForOrg(cfgRow) {
  const clientSecret = secretBox.decrypt(cfgRow.client_secret_enc);
  return oidc.discovery(new URL(cfgRow.issuer), cfgRow.client_id, clientSecret);
}

// ────────────────────────────────────────────────────────────────
// Donor scoring — RELATIONSHIP-LED. Grounded in fundraising's core principle
// that affinity (linkage) qualifies WHO to ask, while capacity only sizes the
// ASK AMOUNT — so capacity must not drive the ranking.
//
//   donor_likelihood_score (the rank) = Relationship (≤90) + cause boost (≤32),
//       capped at 100. Relationship = family / schoolmate / coworker /
//       reachable(email) / local. Cause = Ukraine ties / education-nonprofit.
//       NO company tier, title, or GitHub here — those are capacity, not "do I
//       know them," and were polluting the ranking with big-company strangers.
//
//   capacity_score (separate, display only, tiebreaker) = company tier + GitHub
//       + role seniority. Shown as a "capacity / suggested ask" badge.
//
// Relationship is computed RELATIVE TO the logged-in scout, so it can be
// recomputed when the scout updates their company/city/schools.
// ────────────────────────────────────────────────────────────────
const TIER_1_UNICORNS = [
  'google', 'alphabet', 'meta', 'facebook', 'apple', 'amazon', 'microsoft',
  'netflix', 'nvidia', 'stripe', 'openai', 'anthropic', 'databricks', 'snowflake',
  'tesla', 'spacex', 'uber', 'airbnb', 'linkedin', 'salesforce', 'adobe', 'figma',
];
const TIER_2_SCALEUPS = [
  'datadog', 'coinbase', 'instacart', 'doordash', 'plaid', 'brex', 'ramp',
  'notion', 'vercel', 'gitlab', 'hashicorp', 'confluent', 'twilio', 'cloudflare',
  'shopify', 'square', 'block', 'robinhood', 'gusto', 'rippling', 'scale ai',
];

// Very common surnames — a shared one is a weaker "family" signal, so we discount it.
const COMMON_SURNAMES = new Set([
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis',
  'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson',
  'thomas', 'taylor', 'moore', 'martin', 'lee', 'perez', 'thompson', 'white', 'harris',
  'sanchez', 'clark', 'ramirez', 'lewis', 'robinson', 'walker', 'young', 'allen', 'king',
  'wright', 'scott', 'torres', 'nguyen', 'hill', 'green', 'adams', 'nelson', 'baker',
  'hall', 'rivera', 'campbell', 'mitchell', 'carter', 'roberts',
  'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'wu', 'zhou', 'kim', 'park',
  'singh', 'kumar', 'patel',
]);

// Cause-affinity keyword sets — these are the module-level (cause.config.js)
// defaults. Per-org scoring reads the org's own config instead (see
// propensitySignals(contact, cfg) and scoreProspect(contact, scout, cfg)), so a
// non-default tenant ranks against ITS cause, not Code for Ukraine's.

// ── normalization helpers ──
const norm = (s) =>
  (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const tokenize = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
const lastNameOf = (fullName) => {
  const t = norm(fullName).split(/\s+/).filter(Boolean);
  return t.length ? t[t.length - 1] : '';
};
const companyCore = (s) =>
  norm(s).replace(/\b(inc|llc|ltd|corp|co|company|the|gmbh|plc|group)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ── dedupe keys for incremental import ──
// LinkedIn profile URL is unique per person → the most reliable match.
const normUrl = (u) =>
  (u || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
// name+company only counts as a match when BOTH are present (avoids merging
// two different people who share a common name and have no company listed).
const dedupeNameKey = (name, company) => {
  const n = norm(name);
  const co = norm(company);
  return n && co ? `${n}|${co}` : '';
};

// ── Capacity (max 35 after scaling) ──
function classifyCompany(company) {
  const c = norm(company);
  if (!c) return { tier: 'unknown', points: 0 };
  if (TIER_1_UNICORNS.some((k) => c.includes(k))) return { tier: 'tier_1_unicorn', points: 40 };
  if (TIER_2_SCALEUPS.some((k) => c.includes(k))) return { tier: 'tier_2_scaleup', points: 25 };
  return { tier: 'tier_3_other', points: 10 };
}

function githubPoints(followers = 0, repos = 0) {
  let p = 0;
  if (followers >= 1000) p += 24;
  else if (followers >= 500) p += 18;
  else if (followers >= 100) p += 12;
  else if (followers >= 20) p += 7;
  else if (followers >= 1) p += 3;

  if (repos >= 50) p += 16;
  else if (repos >= 20) p += 11;
  else if (repos >= 10) p += 6;
  else if (repos >= 1) p += 2;
  return Math.min(40, p);
}

const EXEC_KEYWORDS = [
  'founder', 'co-founder', 'cofounder', 'ceo', 'cto', 'cfo', 'coo', 'chief',
  'vp', 'vice president', 'president', 'partner', 'investor', 'director',
  'head of', 'owner', 'managing',
];
const SENIOR_KEYWORDS = ['principal', 'staff', 'senior', 'lead', 'manager', 'architect'];

function rolePoints(role) {
  const r = norm(role);
  if (!r) return 0;
  if (EXEC_KEYWORDS.some((k) => r.includes(k))) return 20;
  if (SENIOR_KEYWORDS.some((k) => r.includes(k))) return 12;
  return 6;
}

// True if one of the scout's schools appears in the connection's company, role,
// or GitHub bio. Catches people who work at / publicly list the school. (LinkedIn
// doesn't export connections' education, so true classmates who've moved on can't
// be detected from any available data.)
function schoolMatch(contact, scout) {
  const schools = (scout?.schools || '')
    .split(',')
    .map((s) => norm(s))
    .filter((s) => s.length >= 4);
  if (!schools.length) return false;
  const hay = norm(`${contact.company} ${contact.role} ${contact.github_bio || ''}`);
  return schools.some((s) => hay.includes(s));
}

// ── Affinity (max 50) — relative to the logged-in scout ──
function affinitySignals(contact, scout) {
  const reasons = [];
  let pts = 0;

  // Family — shared surname with the scout.
  const scoutSurname = lastNameOf(scout?.name);
  const contactSurname = lastNameOf(contact.contact_name);
  if (scoutSurname && contactSurname && scoutSurname === contactSurname) {
    const common = COMMON_SURNAMES.has(scoutSurname);
    pts += common ? 15 : 30;
    reasons.push(common ? '👪 Possible family (common name)' : '👪 Possible family');
  }

  // Schoolmate — one of the scout's schools shows up in the connection's profile.
  if (schoolMatch(contact, scout)) {
    pts += 26;
    reasons.push('🎓 Shared school');
  }

  // Coworker — shares one of the scout's employers (current or past).
  const cc = companyCore(contact.company);
  if (cc.length >= 3) {
    const overlaps = (s) => s.length >= 3 && (s === cc || s.includes(cc) || cc.includes(s));
    const current = companyCore(scout?.company);
    const past = (scout?.past_companies || '').split(',').map((s) => companyCore(s)).filter(Boolean);
    if (overlaps(current)) {
      pts += 22;
      reasons.push('🏢 Coworker');
    } else if (past.some(overlaps)) {
      pts += 20;
      reasons.push('🏢 Former coworker');
    }
  }

  // Reachable — their email is in the export. LinkedIn only shares it for closer
  // ties, and practically you can contact them off-platform — both raise response.
  if (contact.contact_email) {
    pts += 18;
    reasons.push('✉️ Reachable');
  }

  // Local — shares a city/region token with the scout.
  const scoutLoc = new Set(tokenize(scout?.location));
  if (scoutLoc.size && tokenize(contact.location).some((t) => scoutLoc.has(t))) {
    pts += 10;
    reasons.push('📍 Local');
  }

  return { points: Math.min(90, pts), reasons };
}

// ── Propensity (max = affinity.weight + causeAlignment.weight) — cause fit ──
// Reads the per-org cause config (keywords + weights + labels) so each tenant
// scores propensity against ITS OWN cause; falls back to cause.config.js.
function propensitySignals(contact, cfg = CAUSE) {
  const reasons = [];
  let pts = 0;
  const causeAffinity = cfg.affinity || CAUSE.affinity;
  const causeAlignment = cfg.causeAlignment || CAUSE.causeAlignment;
  const hay = norm(`${contact.company} ${contact.role} ${contact.location}`);
  if ((causeAffinity.keywords || []).some((k) => hay.includes(k))) {
    pts += causeAffinity.weight; // a personal tie to the cause is a top predictor of giving
    reasons.push(causeAffinity.label);
  }
  if ((causeAlignment.keywords || []).some((k) => hay.includes(k))) {
    pts += causeAlignment.weight;
    reasons.push(causeAlignment.label);
  }
  return { points: Math.min(causeAffinity.weight + causeAlignment.weight, pts), reasons };
}

// How much a GitHub match contributes to capacity, by confidence. A low-confidence
// (likely-wrong) match contributes NOTHING, so bad name matches can't inflate the
// score — until the scout confirms or relinks it (→ 'confirmed', full weight).
const GH_CONFIDENCE_WEIGHT = { confirmed: 1, high: 1, medium: 0.6, low: 0 };

// Estimate how likely a GitHub search hit is actually this contact, from how well
// the profile's name/login/location/company corroborate the contact.
function matchConfidence(contact, gh) {
  const nameTokens = tokenize(contact.contact_name);
  const ghNameTokens = new Set(tokenize(gh.name || ''));
  const loginTokens = new Set((gh.login || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const inName = nameTokens.filter((t) => ghNameTokens.has(t)).length;
  const inLogin = nameTokens.filter((t) => loginTokens.has(t)).length;

  let pts = 0;
  if (inName >= 2) pts += 3; // both first & last names on the profile
  else if (inName === 1) pts += 1;
  if (inName < 2 && inLogin >= 1) pts += 1; // login segment matches a name
  if (contact.location && gh.location) {
    const cl = new Set(tokenize(contact.location));
    if (tokenize(gh.location).some((t) => cl.has(t))) pts += 1;
  }
  if (contact.company && gh.company) {
    const cc = companyCore(contact.company);
    if (cc && companyCore(gh.company).includes(cc)) pts += 2;
  }
  if (pts >= 3) return 'high';
  if (pts >= 1) return 'medium';
  return 'low';
}

/**
 * Score one prospect (a connection-shaped object) relative to the scout (the
 * logged-in user), using the scout's ORG cause config (cfg).
 *
 * Two layers (the STRATEGY pattern — see lib/strategies/index.js):
 *
 *   1. Pure COMPONENT sub-scores — affinityScore (relationship), propensityScore
 *      (cause fit), capacityScore (giving capacity). These are signal-derived,
 *      strategy-independent, and persisted on the connections row.
 *   2. The final RANK (`score` / donor_likelihood_score) — produced by the
 *      scout's selected FundraisingStrategy combining those components. The
 *      default strategy (relationship_first) reproduces today's output exactly:
 *      min(100, affinity + propensity), with capacity ignored in the rank.
 *
 * Because the components are persisted, switching strategy only re-COMBINES them
 * (no GitHub calls, no profile re-read). The strategy is resolved from the scout
 * (user.strategy → org default → relationship_first) via strategyForUser().
 *
 * Works both at upload time and when re-scoring stored rows.
 */
function scoreProspect(contact, scout, cfg = CAUSE) {
  const tier = classifyCompany(contact.company);

  // Capacity — sizes the ask; only some strategies let it drive the rank.
  const ghWeight = contact.github_username
    ? GH_CONFIDENCE_WEIGHT[contact.github_confidence] ?? 1
    : 0;
  const ghPoints = Math.round(githubPoints(contact.github_followers || 0, contact.github_repos || 0) * ghWeight);
  const capacityScore = Math.min(100, tier.points + ghPoints + rolePoints(contact.role));

  // Component sub-scores — relationship + cause fit. Strategy-independent.
  const aff = affinitySignals(contact, scout);
  const prop = propensitySignals(contact, cfg);
  const reasons = [...aff.reasons, ...prop.reasons];

  // The propensity component is intentionally capped low; the strategies that
  // weight it (cause_fit/balanced/custom) lift it onto a 0..100 scale, so we
  // hand the combiner the cap (propensityMax) it needs to do that scaling.
  const causeAffinity = (cfg.affinity || CAUSE.affinity);
  const causeAlignment = (cfg.causeAlignment || CAUSE.causeAlignment);
  const propensityMax = (causeAffinity.weight || 0) + (causeAlignment.weight || 0);

  const components = {
    affinityScore: aff.points,
    propensityScore: prop.points,
    propensityMax,
    capacityScore,
  };

  // Resolve the scout's chosen strategy and combine the components into the rank.
  // strategyForUser falls back safely (org default → relationship_first), so a
  // missing/unknown strategy can never break scoring.
  const resolved = strategyForUser(scout);
  const score = combineScore(components, resolved);

  return {
    score,
    reasons,
    companyTier: tier.tier,
    capacityScore,
    affinityScore: aff.points,
    propensityScore: prop.points,
    strategy: resolved.key,
  };
}

// ────────────────────────────────────────────────────────────────
// GitHub enrichment — REAL API, throttled + rate-limit aware
// ────────────────────────────────────────────────────────────────
const HAS_GH_TOKEN = !!process.env.GITHUB_TOKEN;
// Search API sub-limit: 30/min authenticated, 10/min unauthenticated.
const SEARCH_INTERVAL_MS = HAS_GH_TOKEN ? 800 : 1600;
const MAX_ENRICH = HAS_GH_TOKEN ? 30 : 8; // cap per upload to respect quotas

const github = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 12000,
  headers: {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'code-for-ukraine-donor-scout',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(HAS_GH_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastSearchAt = 0;
async function throttleSearch() {
  const wait = lastSearchAt + SEARCH_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

function isRateLimited(err) {
  const status = err?.response?.status;
  const remaining = err?.response?.headers?.['x-ratelimit-remaining'];
  return status === 429 || (status === 403 && remaining === '0');
}

/**
 * Find the most likely GitHub user for a contact by name (+ location), then
 * pull followers / public repos / company. Returns null when no match.
 * Throws on rate-limit so the caller can stop the batch gracefully.
 */
async function enrichContact({ contact_name, location, company }) {
  if (!contact_name) return null;

  const runSearch = async (withLocation) => {
    await throttleSearch();
    let q = `${contact_name} in:fullname`;
    if (withLocation && location) {
      const city = String(location).split(',')[0].trim();
      if (city) q += ` location:"${city}"`;
    }
    const res = await github.get('/search/users', { params: { q, per_page: 1 } });
    return res.data?.items?.[0] || null;
  };

  // Prefer a name+location match; fall back to name-only if nothing found.
  let top = await runSearch(true);
  if (!top && location) top = await runSearch(false);
  if (!top) return { github_username: null };

  const detail = await github.get(`/users/${top.login}`);
  return {
    github_username: top.login,
    github_followers: detail.data.followers ?? 0,
    github_repos: detail.data.public_repos ?? 0,
    github_company: detail.data.company || null,
    github_bio: detail.data.bio || null,
    github_confidence: matchConfidence({ contact_name, location, company }, detail.data),
  };
}

// ────────────────────────────────────────────────────────────────
// Impact recomputation
// ────────────────────────────────────────────────────────────────
const impactAgg = db.prepare(`
  SELECT
    COALESCE(SUM(donation_amount), 0)                          AS total,
    COALESCE(SUM(CASE WHEN donation_received = 1 THEN 1 ELSE 0 END), 0) AS converted
  FROM referrals WHERE user_id = ? AND org_id = ?
`);
const upsertImpact = db.prepare(`
  UPDATE code_x_impact
     SET total_referred_donations = ?,
         num_referrals_converted  = ?,
         num_students_supported   = ?,
         num_days_funded          = ?,
         org_id                   = ?,
         last_updated_at          = CURRENT_TIMESTAMP
   WHERE user_id = ?
`);

function recomputeImpact(userId) {
  // org_id is derived from the OWNING user's row (never from a request), so the
  // impact aggregate only ever sums that user's own in-org referrals.
  const orgId = _userOrgStmt.get(userId)?.org_id || DEFAULT_ORG_ID;
  ensureImpactRow.run(userId, orgId);
  const { total, converted } = impactAgg.get(userId, orgId);
  // Per-org impact economics (falls back to cause.config.js defaults).
  const cfg = getOrgConfig(orgId);
  const costBootcamp = cfg.impact?.programCost || COST_PER_BOOTCAMP;
  const costDay = cfg.impact?.dayCost || COST_PER_DAY;
  const students = Math.floor(total / costBootcamp);
  const days = Math.floor(total / costDay);
  // Stamp the row with the user's CURRENT org so it stays consistent after a join.
  upsertImpact.run(total, converted, students, days, orgId, userId);
  return { total, converted, students, days };
}

// ────────────────────────────────────────────────────────────────
// Passport — OpenID Connect (LinkedIn) + session plumbing
// ────────────────────────────────────────────────────────────────
const LINKEDIN_CONFIGURED = !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
const LINKEDIN_REDIRECT_URI =
  process.env.LINKEDIN_CALLBACK_URL || 'http://localhost:5000/api/auth/linkedin/callback';
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// Passport only manages the session here (serialize/deserialize). The LinkedIn
// OpenID Connect dance itself is performed manually in the routes below — this is
// far more reliable with LinkedIn than passport-openidconnect, and surfaces the
// exact failure reason instead of a generic redirect.
passport.serializeUser((user, cb) => cb(null, user.id));
passport.deserializeUser((id, cb) => {
  try {
    cb(null, findUserById.get(id) || null);
  } catch (err) {
    cb(err);
  }
});

// ────────────────────────────────────────────────────────────────
// Express app
// ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// ── Observability ───────────────────────────────────────────────
// Process start time for liveness uptime. Mounted FIRST, before any auth,
// rate limiter, session, or body parser, so the probes are fast and cheap and
// can never be caught by the /api rate limiter or the SPA catch-all below.
const PROCESS_START = Date.now();

// Structured request logging. No new dependency — a single JSON line per request
// via console. Deliberately logs ONLY non-sensitive request metadata (method,
// path, status, duration, a per-request id). It NEVER logs request bodies,
// headers, cookies, query strings, tokens, or any PII. Quiet under NODE_ENV=test
// (so the suite isn't spammed and stays fast) and gated by LOG_REQUESTS so it
// can be turned off in any environment. Default: on, except under test.
const LOG_REQUESTS =
  process.env.LOG_REQUESTS === '1' ||
  (process.env.LOG_REQUESTS !== '0' && process.env.NODE_ENV !== 'test');
// Liveness/readiness probes are noisy (a load balancer hits them every few
// seconds). Skip them at info level to avoid drowning real traffic.
const PROBE_PATHS = new Set(['/healthz', '/readyz']);
app.use((req, res, next) => {
  // A request id: reuse an upstream one if present, else mint a short one.
  const reqId =
    (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) ||
    crypto.randomBytes(8).toString('hex');
  req.id = reqId;
  res.setHeader('x-request-id', reqId);
  if (!LOG_REQUESTS || PROBE_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    // Note: req.path only — never req.originalUrl — so query strings (which may
    // carry tokens/email) are excluded from the log line.
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'request',
        time: new Date().toISOString(),
        id: reqId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      })
    );
  });
  next();
});

// GET /healthz — liveness. No auth, no DB. Confirms the process is up and the
// event loop is responsive. Safe for a container HEALTHCHECK / LB liveness probe.
// Returns only non-sensitive process metadata.
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - PROCESS_START) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// GET /readyz — readiness. No auth. Runs a trivial SELECT 1 to confirm the DB is
// reachable; 200 {ready} on success, 503 {not_ready} on failure. Never leaks the
// underlying error to the caller (only logs it server-side).
app.get('/readyz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'readyz_failed', id: req.id }));
    res.status(503).json({ status: 'not_ready' });
  }
});

// Security headers. CSP is disabled because Express serves the SPA in prod and
// the app embeds the Zeffy donation iframe — a strict default policy would block
// both. The other helmet protections (HSTS, noSniff, frameguard, etc.) stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_URL, credentials: true }));
// JSON body parsers: a tight 256kb default, with 12mb headroom ONLY for the
// authenticated CSV-import endpoints. The selector is mounted AFTER auth (below)
// so anonymous callers can never be forced to parse a multi-MB body.
const jsonSmall = express.json({ limit: '256kb' });
const jsonLarge = express.json({ limit: '12mb' });
const LARGE_BODY_PATHS = new Set([
  '/api/connections/upload',
  '/api/donations/reconcile',
  '/api/history/upload',
]);

// Rate limiting. A generous global cap on the API (a dashboard load fires a
// handful of requests via Promise.all), plus a tighter cap exported for the
// expensive AI endpoints to mount individually.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
export const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Please slow down.' },
});
// Tight limiter for magic-link issuance (token minting). Mounted ONLY on the
// request route. Even when rate-limited we keep the no-existence-leak contract
// by returning 200 (see the handler) rather than the limiter's default 429.
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 5 requests / 15 min per IP in prod/dev. The offline test suite shares one IP
  // (127.0.0.1) across many cases, so we lift the cap under test — the limiter's
  // behavior (200, no leak) is still exercised, but it doesn't starve the suite.
  limit: process.env.NODE_ENV === 'test' ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(200).json({ ok: true }),
});
app.use('/api', apiLimiter);
// Persist sessions in SQLite (reusing the app's better-sqlite3 connection) so
// logins survive server restarts — the default in-memory store loses them.
const SqliteSessionStore = sqliteSessionStoreFactory(session);
// Under test, use express-session's default in-memory store. The SQLite store
// always starts an un-unref'd cleanup setInterval (its `clear` option can't be
// turned off — `x || true` in the lib), which would keep the node:test process
// alive forever. Prod keeps the persistent SQLite-backed store.
const sessionStore =
  process.env.NODE_ENV === 'test'
    ? undefined
    : new SqliteSessionStore({
        client: db,
        expired: { clear: true, intervalMs: 24 * 60 * 60 * 1000 }, // prune expired daily
      });
app.use(
  session({
    store: sessionStore,
    secret: resolveSessionSecret(IS_PROD, process.env.SESSION_SECRET),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Parse JSON bodies AFTER auth is resolved, so the 12mb limit is only ever
// reachable by an authenticated caller on a known large-body route; everyone
// else gets the tight 256kb default and a fast 413.
app.use((req, res, next) => {
  const big = LARGE_BODY_PATHS.has(req.path) && req.isAuthenticated && req.isAuthenticated();
  return (big ? jsonLarge : jsonSmall)(req, res, next);
});

// Generic deactivation message reused by every login path + requireAuth.
const DEACTIVATED_MSG = 'This account has been deactivated.';
// Shown when an org enforces SSO and a member tries a non-SSO login method.
const SSO_REQUIRED_MSG = 'Your organization requires single sign-on (SSO).';

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    // deserializeUser re-reads the users row on every request, so flipping
    // is_active=0 locks an already-logged-in user out on their NEXT call.
    if (req.user && req.user.is_active === 0) {
      return req.logout(() => res.status(403).json({ error: DEACTIVATED_MSG }));
    }
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// ── Multi-tenancy enforcement primitives ────────────────────────
// THE isolation convention: org_id is ALWAYS derived from the session user here,
// never from the request body/params/query. Every org-owned query binds this
// value, so a user in org A can never read or write org B's rows.
function orgScope(req) {
  return req.user?.org_id || DEFAULT_ORG_ID;
}

// Gate admin endpoints by org-level role. Layered ON TOP OF requireAuth (which
// must run first). Reads req.user.org_role — owner|admin|member.
function requireOrgRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.includes(req.user.org_role)) return next();
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  };
}

// Resolve a user's effective fundraising strategy: user choice → org default →
// 'relationship_first'. Returns the rich { key, strategy, weights } object from the
// strategy registry (the FACTORY); pure once the org default is read here. Used by
// scoring (combineScore) and by the strategy API.
function strategyForUser(u) {
  if (!u) return resolveStrategy(null, DEFAULT_STRATEGY);
  const orgDefault = getOrgConfig(u.org_id || DEFAULT_ORG_ID).defaultStrategy || DEFAULT_STRATEGY;
  return resolveStrategy(u, orgDefault);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    profilePicture: u.profile_picture,
    company: u.company || null,
    pastCompanies: u.past_companies || null,
    location: u.location || null,
    schools: u.schools || null,
    goalAmount: u.goal_amount || 0,
    teamId: u.team_id || null,
    isDemo: u.linkedin_id === 'demo-user',
    demoMode: !!u.demo_mode,
    isActive: u.is_active === 0 ? false : true,
    // Org context (read-only on the user object; mutated only via /api/orgs/*).
    orgId: u.org_id || DEFAULT_ORG_ID,
    orgRole: u.org_role || 'member',
    inDefaultOrg: (u.org_id || DEFAULT_ORG_ID) === DEFAULT_ORG_ID,
    // Resolved strategy KEY (user choice → org default → relationship_first).
    // The full catalog + weights are served by GET /api/strategies.
    strategy: strategyForUser(u).key,
    orgDefaultStrategy: getOrgConfig(u.org_id || DEFAULT_ORG_ID).defaultStrategy || DEFAULT_STRATEGY,
    // Per-org branding/cause the client (OrgContext) rebrands the whole app from.
    cause: causePublic(u.org_id || DEFAULT_ORG_ID),
  };
}

// ── Auth routes ─────────────────────────────────────────────────
app.get('/api/auth/config', (req, res) => {
  // magicLinkEnabled is always true: the console mailer is the default, so the
  // passwordless email-link option works with zero email setup.
  res.json({ linkedinEnabled: LINKEDIN_CONFIGURED, githubEnrichment: HAS_GH_TOKEN, magicLinkEnabled: true });
});

// AI availability + remaining daily spend (drives graceful degradation in the
// UI). Auth-gated so spend telemetry isn't exposed to anonymous clients.
app.get('/api/ai/status', requireAuth, (req, res) => res.json(aiStatus(orgScope(req))));

// Outbound send mode — drives the trust chip + first-live-send confirm in the UI. Authed
// so the operator inbox isn't exposed to anonymous clients. redirect = demo (every send
// goes to the operator inbox); live = real donors are emailed.
app.get('/api/system/send-mode', requireAuth, (req, res) => {
  res.json({ mode: (process.env.SEND_MODE || 'redirect').toLowerCase(), redirectTo: parseAllowlist()[0] || '' });
});

// Step 1 — start the OpenID Connect dance: redirect the user to LinkedIn.
app.get('/api/auth/linkedin', (req, res) => {
  if (!LINKEDIN_CONFIGURED) {
    return res.redirect(`${CLIENT_URL}/login?error=linkedin_not_configured`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.linkedinState = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    scope: 'openid profile email',
  });
  res.redirect(`${LINKEDIN_AUTH_URL}?${params.toString()}`);
});

// Step 2 — LinkedIn redirects back here with ?code & ?state. Exchange the code for
// tokens, fetch the user profile, create the session, and bounce to the dashboard.
app.get('/api/auth/linkedin/callback', async (req, res) => {
  const fail = (reason) =>
    res.redirect(`${CLIENT_URL}/login?error=auth_failed&reason=${encodeURIComponent(reason)}`);

  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      console.error('[LinkedIn] provider error:', error, error_description);
      return fail(error_description || error);
    }
    if (!code) return fail('missing_code');
    if (!state || state !== req.session.linkedinState) {
      console.error('[LinkedIn] state mismatch (session lost?)');
      return fail('state_mismatch');
    }
    delete req.session.linkedinState;

    // Exchange the authorization code for an access token (form-encoded body).
    const tokenRes = await axios.post(
      LINKEDIN_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      console.error('[LinkedIn] no access_token in token response:', tokenRes.data);
      return fail('no_token');
    }

    // Fetch the member's profile from the OIDC userinfo endpoint.
    const ui = await axios.get(LINKEDIN_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = ui.data || {};
    const user = upsertUser({
      linkedin_id: j.sub,
      email: j.email || null,
      name: j.name || [j.given_name, j.family_name].filter(Boolean).join(' ') || 'LinkedIn User',
      profile_picture: j.picture || null,
    });

    // A deactivated user cannot authenticate by ANY method, LinkedIn included.
    if (user.is_active === 0) return fail('account_deactivated');
    // If the user's org enforces SSO, non-SSO methods (LinkedIn) are disabled.
    if (orgEnforcesSso(user.org_id)) return fail('sso_required');

    req.login(user, (loginErr) => {
      if (loginErr) {
        console.error('[LinkedIn] req.login failed:', loginErr);
        return fail('login_failed');
      }
      recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', target: 'linkedin' });
      console.log(`[LinkedIn] login success: ${user.name} (id ${user.id})`);
      return res.redirect(`${CLIENT_URL}/dashboard`);
    });
  } catch (e) {
    const detail = e.response?.data?.error_description || e.response?.data?.error || e.message;
    console.error('[LinkedIn] callback exception:', e.response?.status || '', e.response?.data || e.message);
    return fail(detail || 'exception');
  }
});

// Clearly-labeled demo login (NOT a fake LinkedIn login) — seeds a demo user.
app.post('/api/auth/demo', (req, res, next) => {
  let user = upsertUser({
    linkedin_id: 'demo-user',
    email: 'demo@codeforukraine.org',
    name: 'Demo Scout',
    profile_picture: null,
  });
  if (user.is_active === 0) return res.status(403).json({ error: DEACTIVATED_MSG });
  // Land the public demo on a populated app: seed sample data on first demo login.
  // Idempotent — skipped once demo_mode is on, and re-seeds if someone toggled it off.
  if (!user.demo_mode) {
    try {
      enableDemoSampleData(user.id);
      user = findUserById.get(user.id);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'demo_seed_failed', err: String(e?.message || e) }));
    }
  }
  req.login(user, (err) => {
    if (err) return next(err);
    recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', target: 'demo' });
    res.json({ user: publicUser(user) });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ── Passwordless magic-link auth (SaaS auth Phase 1) ─────────────────────────
// The no-password fallback. Two endpoints: request (mint + email a one-time
// link) and consume (verify the link, resolve/onboard the user, log in).
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LIVE_MAGIC_TOKENS = 3; // per-email cap on live unconsumed tokens
// Surface the raw token to the client ONLY in dev/test, NEVER in production.
const EXPOSE_DEV_TOKEN = !IS_PROD || process.env.NODE_ENV === 'test';

// Request a magic link. ALWAYS 200 with an identical body whether or not the
// email maps to a user (NO existence leak). Rate-limited by IP (the limiter
// also returns 200) plus a per-email live-token cap. The raw link goes ONLY to
// the mailer; the raw token is echoed as devToken solely in dev/test.
app.post('/api/auth/magic-link/request', magicLinkLimiter, (req, res) => {
  const email = canonicalizeEmail(req.body?.email);
  // Even a malformed/empty email returns 200 (no signal). We simply don't mint.
  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  let devToken;
  if (looksLikeEmail && countLiveMagicTokens.get(email).n < MAX_LIVE_MAGIC_TOKENS) {
    pruneMagicTokens.run(); // opportunistic cleanup (daily-prune philosophy)
    const { raw, hash, expiresAt } = TokenService.issue(MAGIC_LINK_TTL_MS);
    insertMagicToken.run(email, hash, expiresAt);
    const link = `${CLIENT_URL}/auth/magic?token=${raw}`;
    const { subject, text, html } = magicLinkEmail(link);
    // Audit issuance for ALL requests incl. unknown emails — this row never
    // reveals existence to the caller (no read endpoint in Phase 1).
    recordAudit({ action: 'magic_link.issued', target: email });
    mailer.send({ to: email, subject, text, html, meta: { token: raw } }).catch((e) =>
      console.error('[magic-link] mailer error:', e?.message)
    );
    if (EXPOSE_DEV_TOKEN) devToken = raw;
  }
  res.json(EXPOSE_DEV_TOKEN && devToken ? { ok: true, devToken } : { ok: true });
});

// Consume a magic link → verify, resolve/onboard the user, establish a session.
// Single generic error for ALL failure modes (not found / expired / used) so no
// timing or message oracle distinguishes them.
app.post('/api/auth/magic-link/consume', (req, res, next) => {
  const raw = (req.body?.token || '').toString();
  const GENERIC = 'This sign-in link is invalid or has expired.';
  const row = raw ? findMagicTokenByHash.get(sha256Hex(raw)) : null;
  // Constant-time confirm + liveness. matches() guards against a hash collision
  // fed by request input; isLive() rejects consumed/expired uniformly.
  if (!row || !TokenService.matches(raw, row.token_hash) || !TokenService.isLive(row, 'consumed_at')) {
    return res.status(400).json({ error: GENERIC });
  }
  const email = canonicalizeEmail(row.email);

  // Resolve the user transactionally so single-use consumption + create/place is
  // atomic. newUserResolution: existing → invited → brand-new.
  let user;
  try {
    user = db.transaction(() => {
      // Atomically claim the token; if another request already consumed it, abort.
      if (consumeMagicToken.run(row.id).changes !== 1) throw new Error('already_consumed');
      // 1. Existing account (by magic_link identity, else by email).
      let existing = findUserByIdentity('magic_link', email) || findUserByEmailCI.get(email);
      if (existing) {
        // Block deactivated BEFORE login (the throw rolls back the consume so a
        // reactivated user can still use a fresh link).
        if (existing.is_active === 0) throw new Error('deactivated');
        insertIdentity.run(existing.id, 'magic_link', email, email); // ensure identity
        return findUserById.get(existing.id);
      }
      // 2. A live invitation for this email → create in THAT org with THAT role.
      const invite = findLiveInvitationByEmail.get(email);
      if (invite) {
        acceptInvitationStmt.run(invite.id);
        const u = upsertMagicLinkUser({ email, orgId: invite.org_id, role: invite.role });
        recordAudit({ orgId: invite.org_id, actorUserId: u.id, action: 'invite.accepted', target: email });
        return u;
      }
      // 3. Brand-new account in the default org (existing onboarding).
      return upsertMagicLinkUser({ email });
    })();
  } catch (err) {
    if (err.message === 'deactivated') return res.status(403).json({ error: DEACTIVATED_MSG });
    // already_consumed or any race → the same generic invalid-link message.
    return res.status(400).json({ error: GENERIC });
  }

  // 'enforced' toggle: an org that requires SSO disables non-SSO logins for its
  // members. The magic-link was consumed (single-use) but we refuse the session.
  if (orgEnforcesSso(user.org_id)) {
    return res.status(403).json({ error: SSO_REQUIRED_MSG });
  }

  req.login(user, (err) => {
    if (err) return next(err);
    recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'magic_link.consumed', target: email });
    recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', target: 'magic_link' });
    res.json({ user: publicUser(user) });
  });
});

// ── Invitations: accept (public — the invite IS the credential) ──────────────
// Org + role come from the invitation ROW, never request input, so an invite for
// org A can only ever place the user in org A. Single generic error for all
// failures. The create/list/revoke admin endpoints live in the org section below.
app.post('/api/orgs/invitations/accept', (req, res, next) => {
  const raw = (req.body?.token || '').toString();
  const GENERIC = 'This invitation is invalid or has expired.';
  const row = raw ? findInvitationByHash.get(sha256Hex(raw)) : null;
  if (!row || !TokenService.matches(raw, row.token_hash) || !TokenService.isLive(row, 'accepted_at')) {
    return res.status(400).json({ error: GENERIC });
  }
  const email = canonicalizeEmail(row.email);
  const orgId = row.org_id; // from the ROW — the isolation invariant
  const role = row.role === 'admin' ? 'admin' : 'member'; // never 'owner'

  let user;
  try {
    user = db.transaction(() => {
      if (acceptInvitationStmt.run(row.id).changes !== 1) throw new Error('already_accepted');
      const existing = findUserByIdentity('magic_link', email) || findUserByEmailCI.get(email);
      if (existing) {
        if (existing.is_active === 0) throw new Error('deactivated');
        // Same empty-account guard as /api/orgs/join: an existing user with data
        // can't be silently moved across orgs (would orphan cross-org rows).
        if (existing.org_id !== orgId && (userHasConnections.get(existing.id) || userHasReferrals.get(existing.id))) {
          throw new Error('not_empty');
        }
        setUserOrgRole.run(orgId, role, existing.id);
        ensureImpactRow.run(existing.id, orgId);
        insertIdentity.run(existing.id, 'magic_link', email, email);
        return findUserById.get(existing.id);
      }
      // No user yet → create in the inviting org with the invited role.
      return upsertMagicLinkUser({ email, orgId, role });
    })();
  } catch (err) {
    if (err.message === 'deactivated') return res.status(403).json({ error: DEACTIVATED_MSG });
    if (err.message === 'not_empty') {
      return res.status(409).json({
        error: 'You can only accept an invitation from an empty account. Clear your connections and pipeline first.',
      });
    }
    return res.status(400).json({ error: GENERIC });
  }

  req.login(user, (err) => {
    if (err) return next(err);
    recordAudit({ orgId, actorUserId: user.id, action: 'invite.accepted', target: email });
    recordAudit({ orgId, actorUserId: user.id, action: 'auth.login', target: 'invite' });
    res.json({ user: publicUser(user) });
  });
});

// ── Per-org Okta OIDC SSO (SaaS auth Phase 2) ────────────────────────────────
// THREE pieces: (1) /start resolves a VERIFIED email domain → org → IdP config,
// then redirects to that org's Okta with PKCE + state + nonce; (2) /callback lets
// openid-client verify the ID-token (signature + issuer + audience + nonce) and
// then runs the PURE resolveSsoUser(); (3) a NODE_ENV=test fake-claims hook that
// drives the SAME finalize path with INJECTED, already-verified claims (no
// network) so the security logic is fully offline-testable.
//
// REAL end-to-end requires a real Okta tenant + HTTPS (Secure cookies + the OIDC
// redirect) — it CANNOT run in CI. The discovery/code-exchange/token-verification
// network calls below are exercised only against a live Okta; tests cover the
// resolution logic via resolveSsoUser + the fake-claims hook.

// Shared: given ALREADY-VERIFIED claims + the resolved org/config, run the pure
// resolver, enforce the deactivation/cross-org gates (as tagged errors), and
// establish the session. Returns via the provided onOk/onErr callbacks so both
// the browser redirect flow and the JSON test hook can reuse it.
function finalizeSsoLogin(req, { claims, org, config }, { onOk, onErr }) {
  let result;
  try {
    result = resolveSsoUser({ claims, org, config, ops: ssoOps });
  } catch (err) {
    recordAudit({ orgId: org?.id || null, action: 'auth.sso_failed', target: err.code || 'error' });
    return onErr(err);
  }
  const { user } = result;
  req.login(user, (err) => {
    if (err) return onErr(err);
    recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', target: 'okta' });
    if (result.created) {
      recordAudit({ orgId: user.org_id, actorUserId: user.id, action: 'sso.provisioned', target: canonicalizeEmail(claims.email) });
    }
    return onOk(user);
  });
}

// Step 1 — start SSO. Resolve email → verified domain → org → IdP config, then
// redirect to that org's Okta authorize endpoint with PKCE + state + nonce. If the
// domain doesn't route to an SSO org we 302 back to the login page with a flag so
// the SPA offers the fallback methods (magic-link / LinkedIn / demo).
app.get('/api/auth/sso/start', async (req, res) => {
  const email = canonicalizeEmail(req.query?.email);
  const noSso = () => res.redirect(`${CLIENT_URL}/login?sso=unavailable`);
  const resolved = email ? resolveOrgForEmail(email) : null;
  if (!resolved) return noSso();
  try {
    const config = await oidcConfigForOrg(resolved.config);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    // Stash the per-flow secrets in the session (server-side) so the callback can
    // verify state/nonce + complete PKCE. org_id is the resolved tenant.
    req.session.sso = { orgId: resolved.org.id, codeVerifier, state, nonce, loginHint: email };
    const redirectUri = `${API_PUBLIC_URL}/api/auth/sso/callback`;
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile groups',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      login_hint: email,
    });
    recordAudit({ orgId: resolved.org.id, action: 'sso.start', target: emailDomain(email) });
    return res.redirect(url.href);
  } catch (e) {
    console.error('[sso] start failed:', e?.message);
    return res.redirect(`${CLIENT_URL}/login?error=sso_failed`);
  }
});

// Step 2 — Okta redirects back with ?code&state. openid-client exchanges the code
// AND verifies the ID-token (signature via JWKS + issuer + audience + nonce +
// PKCE). We then hand the VERIFIED claims to the pure resolver.
app.get('/api/auth/sso/callback', async (req, res) => {
  const fail = (reason) =>
    res.redirect(`${CLIENT_URL}/login?error=sso_failed&reason=${encodeURIComponent(reason)}`);
  const flow = req.session.sso;
  if (!flow) return fail('state_lost');
  const cfgRow = findIdpConfigByOrg.get(flow.orgId);
  if (!cfgRow) return fail('no_config');
  try {
    const config = await oidcConfigForOrg(cfgRow);
    const currentUrl = new URL(`${API_PUBLIC_URL}${req.originalUrl}`);
    // openid-client checks state, PKCE, ID-token signature/issuer/audience/nonce.
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    const claims = tokens.claims(); // VERIFIED ID-token claims
    delete req.session.sso;
    const org = findOrgById.get(flow.orgId);
    return finalizeSsoLogin(
      req,
      { claims: { sub: claims.sub, email: claims.email, groups: claims.groups, iss: claims.iss }, org, config: cfgRow },
      {
        onOk: () => res.redirect(`${CLIENT_URL}/dashboard`),
        onErr: (err) => fail(err.code || 'login_failed'),
      }
    );
  } catch (e) {
    console.error('[sso] callback failed:', e?.message);
    return fail('verification_failed');
  }
});

// Test-only login: create/sign-in an arbitrary user so the node:test suites can
// exercise multi-user, multi-org isolation. Mounted ONLY when NODE_ENV==='test'
// so it is never part of the production HTTP surface.
if (process.env.NODE_ENV === 'test') {
  app.post('/api/test/login', (req, res, next) => {
    const lid = String(req.body?.linkedinId || `test-${crypto.randomBytes(4).toString('hex')}`);
    const user = upsertUser({
      linkedin_id: lid,
      email: req.body?.email || `${lid}@test.local`,
      name: req.body?.name || lid,
      profile_picture: null,
    });
    if (user.is_active === 0) return res.status(403).json({ error: DEACTIVATED_MSG });
    req.login(user, (err) => (err ? next(err) : res.json({ user: publicUser(user) })));
  });

  // Retrieve the latest raw magic-link token for an email, straight from the
  // console mailer's in-memory stash — keeps the offline test suite from needing
  // real email (mirrors /api/test/login). Test env only.
  app.get('/api/test/last-magic-link', (req, res) => {
    res.json({ token: mailer.lastTokenFor(canonicalizeEmail(req.query?.email)) });
  });

  // SSO fake-claims hook (test env only) — mirrors /api/test/login but for the
  // Okta SSO path. It SKIPS the live OIDC handshake (which needs a real Okta +
  // HTTPS and can't run in CI) and feeds INJECTED, already-verified claims into
  // the SAME finalizeSsoLogin → resolveSsoUser path the real callback uses. So the
  // security-critical resolution logic (JIT / existing match / group→role /
  // deactivated block / cross-org safety / issuer check) is exercised end-to-end
  // over HTTP, offline. The body's email picks the routing org via its verified
  // domain (never trusts an org id from input).
  app.post('/api/test/sso-callback', (req, res, next) => {
    const claims = {
      sub: String(req.body?.sub || ''),
      email: canonicalizeEmail(req.body?.email),
      groups: req.body?.groups,
      iss: req.body?.iss,
    };
    const resolved = resolveOrgForEmail(claims.email);
    if (!resolved) return res.status(400).json({ error: 'no_sso_for_domain' });
    // If the caller didn't inject an issuer, default it to the org's configured
    // one so the happy path passes the issuer assertion (a real token always
    // carries iss; tests opt into a mismatch by supplying a wrong iss).
    if (!claims.iss) claims.iss = resolved.config.issuer;
    return finalizeSsoLogin(
      req,
      { claims, org: resolved.org, config: resolved.config },
      {
        onOk: (user) => res.json({ user: publicUser(user) }),
        onErr: (err) => {
          if (err.code === 'deactivated') return res.status(403).json({ error: DEACTIVATED_MSG });
          if (err.code === 'cross_org' || err.code === 'issuer_mismatch') {
            return res.status(403).json({ error: err.message });
          }
          if (err.code === 'no_invite') return res.status(403).json({ error: err.message });
          return next(err);
        },
      }
    );
  });
}

// Update the scout's own company + city, then re-rank their connections so the
// new coworker / local affinity signals take effect immediately.
app.post('/api/profile', requireAuth, (req, res) => {
  const company = (req.body?.company || '').trim() || null;
  const pastCompanies = (req.body?.pastCompanies || '').trim() || null;
  const location = (req.body?.location || '').trim() || null;
  const schools = (req.body?.schools || '').trim() || null;
  const goal = Math.max(0, Number(req.body?.goalAmount) || 0);
  updateUserProfile.run(company, pastCompanies, location, schools, goal, req.user.id);
  const user = findUserById.get(req.user.id);
  const rescored = rescoreUserConnections(user);
  res.json({ user: publicUser(user), rescored });
});

// ── Fundraising strategy: the per-user, org-defaulted ranking choice ──────
// The STRATEGY pattern's selection layer. The strategy decides how the persisted
// component sub-scores (affinity/propensity/capacity) combine into the rank; the
// registry + combiner live in lib/strategies/index.js. Relationship-first stays
// the default everywhere (it's labeled "Recommended" and reproduces today's rank).
const setUserStrategy = db.prepare(
  'UPDATE users SET strategy = ?, strategy_weights = ? WHERE id = ? AND org_id = ?'
);

// Surface the catalog + the caller's resolved choice + the org default, so the
// picker can preselect correctly. Auth-gated (no anon strategy telemetry).
app.get('/api/strategies', requireAuth, (req, res) => {
  const resolved = strategyForUser(req.user);
  const orgDefault =
    getOrgConfig(req.user.org_id || DEFAULT_ORG_ID).defaultStrategy || DEFAULT_STRATEGY;
  res.json({
    strategies: strategyCatalog(),
    current: resolved.key,
    orgDefault,
    // Only meaningful for custom_weights; null otherwise so the UI hides sliders.
    weights: resolved.weights,
  });
});

// Set the caller's own strategy, then re-rank ONLY their connections (org/user
// scoped — never touches another scout's rows). Mirrors how /api/profile
// re-ranks after a profile edit. Validates the key against the registry and
// normalizes custom weights server-side (clamp >=0, sum to 1 — no score injection).
app.post('/api/profile/strategy', requireAuth, (req, res) => {
  const key = String(req.body?.strategy || '');
  if (!KNOWN_STRATEGY_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown strategy.' });
  }
  // Custom weights are persisted only for custom_weights; other strategies clear
  // them so a stale weight bag can't linger and confuse a later custom switch.
  let weightsJson = null;
  if (key === 'custom_weights') {
    const w = normalizeWeights(req.body?.weights);
    weightsJson = JSON.stringify(w);
  }
  setUserStrategy.run(key, weightsJson, req.user.id, orgScope(req));
  const user = findUserById.get(req.user.id);
  // Signals are unchanged on a strategy switch — recombine persisted sub-scores.
  const rescored = recombineUserConnections(user);
  res.json({ user: publicUser(user), current: key, rescored });
});

// ── Organizations: onboarding, roles, members, per-org config ────
// An org is a nonprofit tenant. Every flow here derives org_id from the SESSION
// (req.user), never from the request body, and admin actions are gated by
// requireOrgRole. join_code is the org invite path (distinct from team codes).
const findOrgById = db.prepare('SELECT * FROM organizations WHERE id = ?');
const findOrgByJoinCode = db.prepare('SELECT * FROM organizations WHERE join_code = ?');
const insertOrg = db.prepare(
  'INSERT INTO organizations (name, slug, created_by, join_code) VALUES (?, ?, ?, ?)'
);
const insertOrgConfig = db.prepare('INSERT INTO org_config (org_id, config_json) VALUES (?, ?)');
const setOrgConfig = db.prepare(
  'UPDATE org_config SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE org_id = ?'
);
const setUserOrgRole = db.prepare('UPDATE users SET org_id = ?, org_role = ? WHERE id = ?');
const setUserRoleOnly = db.prepare('UPDATE users SET org_role = ? WHERE id = ? AND org_id = ?');
const setOrgJoinCode = db.prepare('UPDATE organizations SET join_code = ? WHERE id = ?');
const countOrgMembers = db.prepare(
  // Real scouts only — exclude the synthetic demo teammates from the head count.
  // (COALESCE so magic-link users with a NULL linkedin_id are still counted —
  // NULL NOT LIKE … is NULL, which would silently drop them.)
  "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND COALESCE(linkedin_id, '') NOT LIKE 'demo-teammate-%'"
);
const orgMemberRows = db.prepare(`
  SELECT u.id, u.name, u.email, u.org_role AS role,
         CASE WHEN u.is_active = 0 THEN 0 ELSE 1 END AS active,
         COALESCE(ci.total_referred_donations, 0) AS raised,
         COALESCE(ci.num_referrals_converted, 0)  AS donations
    FROM users u
    LEFT JOIN code_x_impact ci ON ci.user_id = u.id
   WHERE u.org_id = ? AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
   ORDER BY raised DESC, u.name COLLATE NOCASE ASC
`);
const userHasConnections = db.prepare(
  'SELECT 1 FROM connections WHERE user_id = ? LIMIT 1'
);
const userHasReferrals = db.prepare('SELECT 1 FROM referrals WHERE user_id = ? LIMIT 1');
const countOrgOwners = db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND org_role = 'owner'"
);

function genOrgCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'ORG-' + Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (findOrgByJoinCode.get(code));
  return code;
}

function orgPayload(user) {
  const org = findOrgById.get(user.org_id || DEFAULT_ORG_ID);
  if (!org) return { org: null, memberCount: 0 };
  const role = user.org_role || 'member';
  const cfg = getOrgConfig(org.id);
  const isAdmin = role === 'owner' || role === 'admin';
  return {
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role,
      // The join code is privileged (anyone with it can join) → owner/admin only.
      joinCode: isAdmin ? org.join_code : null,
      defaultStrategy: cfg.defaultStrategy || DEFAULT_STRATEGY,
      // Autonomy dial — readable by all members (drives the UI), changed by admins.
      autonomy: getAutonomy(org.id),
    },
    memberCount: countOrgMembers.get(org.id).n,
  };
}

app.get('/api/orgs/me', requireAuth, (req, res) => {
  res.json(orgPayload(req.user));
});

// Set the org's autonomy dial (owner/admin). Merges into org_config.autonomy. This
// only governs how much the AI layer does without a per-action click — it can NEVER
// enable sending or auto-recording gifts (those paths have no autonomy switch).
app.patch('/api/orgs/autonomy', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const cfg = getOrgConfig(orgId);
  const next = getAutonomy(orgId);
  if (req.body?.autoAcceptReplies !== undefined) next.autoAcceptReplies = !!req.body.autoAcceptReplies;
  if (req.body?.autoApplyTriage !== undefined) next.autoApplyTriage = !!req.body.autoApplyTriage;
  if (req.body?.autoApproveMoves !== undefined) next.autoApproveMoves = !!req.body.autoApproveMoves;
  if (req.body?.policy !== undefined) next.policy = String(req.body.policy || '').slice(0, 2000);
  setOrgConfig.run(JSON.stringify({ ...cfg, autonomy: next }), orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'autonomy.updated', target: JSON.stringify(next).slice(0, 120) });
  res.json({ autonomy: next });
});

// Create a new org → caller becomes owner; clone cause.config.js into org_config.
app.post('/api/orgs', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required.' });
  const slug =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) +
    '-' + crypto.randomBytes(3).toString('hex');
  const tx = db.transaction(() => {
    const info = insertOrg.run(name, slug, req.user.id, genOrgCode());
    const orgId = info.lastInsertRowid;
    // Fresh org is immediately usable: clone the static cause defaults.
    insertOrgConfig.run(orgId, JSON.stringify({ ...CAUSE, orgName: name, defaultStrategy: DEFAULT_STRATEGY }));
    setUserOrgRole.run(orgId, 'owner', req.user.id);
    ensureImpactRow.run(req.user.id, orgId);
    return orgId;
  });
  tx();
  res.status(201).json(orgPayload(findUserById.get(req.user.id)));
});

// Join an existing org by code → caller becomes a member. HARD RULE: the caller
// must have ZERO connections/referrals (otherwise 409), so switching orgs never
// orphans cross-org rows. Unknown code → 404 (no existence leak).
app.post('/api/orgs/join', requireAuth, (req, res) => {
  const code = (req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter an organization code.' });
  const org = findOrgByJoinCode.get(code);
  if (!org) return res.status(404).json({ error: 'No organization found with that code.' });
  if (org.id === (req.user.org_id || DEFAULT_ORG_ID)) {
    return res.json(orgPayload(req.user)); // already a member — no-op
  }
  if (userHasConnections.get(req.user.id) || userHasReferrals.get(req.user.id)) {
    return res.status(409).json({
      error:
        'You can only join a new organization from an empty account. Clear your connections and pipeline first.',
    });
  }
  const tx = db.transaction(() => {
    setUserOrgRole.run(org.id, 'member', req.user.id);
    ensureImpactRow.run(req.user.id, org.id);
  });
  tx();
  res.json(orgPayload(findUserById.get(req.user.id)));
});

// Org member list (owner/admin only), scoped to the caller's org.
app.get('/api/orgs/members', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  res.json({ members: orgMemberRows.all(orgScope(req)) });
});

// Change a member's role. Only owner/admin; only an owner may create/replace an
// owner; the sole owner can never be demoted (would orphan the org).
app.patch('/api/orgs/members/:id', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const targetId = Number(req.params.id);
  const newRole = String(req.body?.role || '').trim();
  if (!['owner', 'admin', 'member'].includes(newRole)) {
    return res.status(400).json({ error: 'Role must be owner, admin, or member.' });
  }
  const orgId = orgScope(req);
  const target = findUserById.get(targetId);
  if (!target || target.org_id !== orgId) {
    return res.status(404).json({ error: 'Member not found.' });
  }
  const actorRole = req.user.org_role;
  // Only an owner may set or remove the owner role.
  if ((newRole === 'owner' || target.org_role === 'owner') && actorRole !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can change the owner role.' });
  }
  // The sole owner cannot be demoted.
  if (target.org_role === 'owner' && newRole !== 'owner' && countOrgOwners.get(orgId).n <= 1) {
    return res.status(409).json({ error: 'Assign another owner before changing this one.' });
  }
  const oldRole = target.org_role;
  setUserRoleOnly.run(newRole, targetId, orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'role.changed', target: `${targetId}:${oldRole}->${newRole}` });
  res.json({ members: orgMemberRows.all(orgId) });
});

// Deactivate / reactivate a member (owner/admin). Deactivation flips is_active=0,
// which locks the user out of EVERY login method and their next request, while
// preserving all their data + donor attribution (they stay, flagged, in the
// member list). Only an owner may (de)activate an owner; the sole owner cannot
// be deactivated (mirrors the sole-owner-cannot-be-demoted rule).
app.patch('/api/orgs/members/:id/active', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const targetId = Number(req.params.id);
  const active = req.body?.active === true || req.body?.active === 1;
  const orgId = orgScope(req);
  const target = findUserById.get(targetId);
  if (!target || target.org_id !== orgId) {
    return res.status(404).json({ error: 'Member not found.' });
  }
  if (target.org_role === 'owner' && req.user.org_role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can change an owner.' });
  }
  // Sole owner cannot be deactivated (would orphan the org).
  if (!active && target.org_role === 'owner' && countOrgOwners.get(orgId).n <= 1) {
    return res.status(409).json({ error: 'Assign another owner before deactivating this one.' });
  }
  setUserActive.run(active ? 1 : 0, targetId, orgId);
  recordAudit({
    orgId,
    actorUserId: req.user.id,
    action: active ? 'user.reactivated' : 'user.deactivated',
    target: String(targetId),
  });
  res.json({ members: orgMemberRows.all(orgId) });
});

// ── Invitations (owner/admin) — generalize the org join_code ─────────────────
// Invite a specific email + role; the invitee gets a token that drops them into
// THIS org with THAT role. org_id is always orgScope(req) — never request input.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
app.post('/api/orgs/invitations', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const email = canonicalizeEmail(req.body?.email);
  const role = String(req.body?.role || 'member');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  // Owner cannot be invited — ownership transfer is a separate role change.
  if (role !== 'admin' && role !== 'member') {
    return res.status(400).json({ error: 'Role must be admin or member.' });
  }
  const orgId = orgScope(req);
  const { raw, hash, expiresAt } = TokenService.issue(INVITE_TTL_MS);
  const id = db.transaction(() => {
    supersedeInvitations.run(orgId, email); // re-inviting supersedes prior live invites
    return insertInvitation.run(orgId, email, role, hash, req.user.id, expiresAt).lastInsertRowid;
  })();
  const org = findOrgById.get(orgId);
  const link = `${CLIENT_URL}/invite?token=${raw}`;
  const { subject, text, html } = invitationEmail(org?.name, role, link);
  mailer.send({ to: email, subject, text, html, meta: { token: raw } }).catch((e) =>
    console.error('[invite] mailer error:', e?.message)
  );
  recordAudit({ orgId, actorUserId: req.user.id, action: 'invite.created', target: `${email}:${role}` });
  const body = { invitation: { id, email, role, expiresAt } };
  if (EXPOSE_DEV_TOKEN) body.devToken = raw;
  res.status(201).json(body);
});

// List this org's pending invitations (token never returned).
app.get('/api/orgs/invitations', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  res.json({ invitations: listOrgInvitations.all(orgScope(req)) });
});

// Revoke a pending invitation — for THIS org only (404 if it belongs to another).
app.delete('/api/orgs/invitations/:id', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const inv = findInvitationInOrg.get(id, orgId);
  if (!inv) return res.status(404).json({ error: 'Invitation not found.' });
  revokeInvitation.run(id, orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'invite.revoked', target: inv.email });
  res.json({ ok: true });
});

// Rotate the org join code (owner/admin).
app.post('/api/orgs/join-code/rotate', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const code = genOrgCode();
  setOrgJoinCode.run(code, orgScope(req));
  res.json({ joinCode: code });
});

// Update per-org config: impact economics, affinity keywords, defaultStrategy
// (owner/admin only). Validates defaultStrategy against the known strategy keys.
// Single source of truth: the strategy registry's own key list (lib/strategies).
const KNOWN_STRATEGY_KEYS = new Set(STRATEGY_KEYS);
app.patch('/api/orgs/config', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const cfg = getOrgConfig(orgId);
  const b = req.body || {};

  if (b.defaultStrategy !== undefined) {
    if (!KNOWN_STRATEGY_KEYS.has(b.defaultStrategy)) {
      return res.status(400).json({ error: 'Unknown defaultStrategy.' });
    }
    cfg.defaultStrategy = b.defaultStrategy;
  }
  // Impact economics — clamp to non-negative numbers; ignore anything malformed.
  if (b.impact && typeof b.impact === 'object') {
    cfg.impact = { ...(cfg.impact || {}) };
    for (const k of ['programCost', 'dayCost', 'programDays']) {
      if (b.impact[k] !== undefined) {
        const n = Number(b.impact[k]);
        if (Number.isFinite(n) && n >= 0) cfg.impact[k] = n;
      }
    }
    for (const k of ['beneficiary', 'beneficiaries', 'programLabel', 'dayLabel']) {
      if (typeof b.impact[k] === 'string') cfg.impact[k] = b.impact[k].slice(0, 120);
    }
  }
  // Affinity / cause-alignment keyword sets (kept simple: arrays of strings).
  for (const key of ['affinity', 'causeAlignment']) {
    if (b[key] && typeof b[key] === 'object') {
      cfg[key] = { ...(cfg[key] || {}) };
      if (Array.isArray(b[key].keywords)) {
        cfg[key].keywords = b[key].keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 50);
      }
      if (typeof b[key].label === 'string') cfg[key].label = b[key].label.slice(0, 80);
      if (b[key].weight !== undefined) {
        const w = Number(b[key].weight);
        if (Number.isFinite(w) && w >= 0) cfg[key].weight = w;
      }
    }
  }
  if (typeof b.orgName === 'string' && b.orgName.trim()) cfg.orgName = b.orgName.trim().slice(0, 120);

  // Per-org donation link — validated (https, or http on localhost). An empty string
  // clears the override (falls back to the default); a non-empty invalid URL is ignored.
  if (b.donateUrl !== undefined) {
    if (String(b.donateUrl).trim() === '') delete cfg.donateUrl;
    else {
      const v = cleanDonateUrl(b.donateUrl, null);
      if (v) cfg.donateUrl = v;
    }
  }

  // Follow-up cadence: an array of positive day-offsets (e.g. [3,7,14] → +3d/+1w/
  // +2w). Sanitized to positive integers, capped at 8 steps; ignored if malformed
  // (resolveCadence then falls back to the default). Only affects NEW seedings.
  if (b.followUpCadenceDays !== undefined) {
    const arr = Array.isArray(b.followUpCadenceDays) ? b.followUpCadenceDays : [];
    const clean = arr
      .map((n) => Math.trunc(Number(n)))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 8);
    if (clean.length > 0) cfg.followUpCadenceDays = clean;
  }

  setOrgConfig.run(JSON.stringify(cfg), orgId);
  // Re-score every member's connections so new economics/keywords take effect.
  for (const m of db.prepare('SELECT id FROM users WHERE org_id = ?').all(orgId)) {
    const scout = findUserById.get(m.id);
    if (scout) rescoreUserConnections(scout);
  }
  res.json({ config: cfg });
});

// ── Self-serve onboarding checklist ─────────────────────────────────────────
// GET /api/onboarding computes a first-run checklist whose every step's DONE state
// is DERIVED from the scout's REAL data (org-scoped via orgScope(req)) — the user
// never self-marks a step. The only persisted state is users.onboarding_dismissed,
// flipped by POST /api/onboarding/dismiss, so once the scout finishes or dismisses
// the checklist we stop showing it. All counts are scoped to (user_id, org_id) so a
// scout only ever sees their OWN signals — never another tenant's or teammate's.
const onbConnCount = db.prepare(
  // Real imports only — demo-mode rows (is_demo=1) must not flip the "import your
  // connections" step (the step should reflect a genuine import, not demo data).
  'SELECT COUNT(*) AS n FROM connections WHERE user_id = ? AND org_id = ? AND is_demo = 0'
);
const onbReferralCount = db.prepare(
  'SELECT COUNT(*) AS n FROM referrals WHERE user_id = ? AND org_id = ?'
);
const setOnboardingDismissed = db.prepare(
  'UPDATE users SET onboarding_dismissed = ? WHERE id = ?'
);

// Build the derived checklist for the current scout. Pure (reads only) so both the
// GET route and tests can reason about it the same way.
function buildOnboarding(user) {
  const orgId = user.org_id || DEFAULT_ORG_ID;
  // Profile: at least one of the relationship/affinity signals is set.
  const profileSet = !!(user.company || user.location || user.schools);
  const connectionCount = onbConnCount.get(user.id, orgId).n;
  const referralCount = onbReferralCount.get(user.id, orgId).n;
  // Strategy chosen: the scout made an explicit choice (a non-NULL users.strategy).
  // NULL means "inherit the org default" — i.e. they haven't picked yet.
  const strategyChosen = !!user.strategy;
  // Org/team: the scout has left the shared default org — i.e. created or joined
  // their own nonprofit, where their donor data is private to their team. The
  // default org is the catch-all everyone lands in at signup, so membership there
  // (even alongside other scouts) is NOT "your org" and never counts.
  const inDefaultOrg = orgId === DEFAULT_ORG_ID;
  const hasOrgOrTeam = !inDefaultOrg;

  const steps = [
    {
      key: 'profile',
      title: 'Set up your profile',
      description:
        'Add your company, city, and schools so Donor Scout can rank prospects by how strongly they’re connected to you.',
      done: profileSet,
      href: '/profile',
      cta: 'Edit profile',
    },
    {
      key: 'connections',
      title: 'Import your connections',
      description:
        'Upload your LinkedIn connections (CSV) so we can score and rank who to reach out to first.',
      done: connectionCount > 0,
      href: '/prospects',
      cta: 'Import connections',
    },
    {
      key: 'strategy',
      title: 'Pick a fundraising strategy',
      description:
        'Choose how prospects are ranked. Relationship-first is recommended. A real relationship predicts a “yes” better than perceived wealth.',
      done: strategyChosen,
      href: '/profile',
      cta: 'Choose strategy',
    },
    {
      key: 'org',
      title: 'Create or join your organization',
      description:
        'Set up your nonprofit so your donor data stays private to your team, then invite teammates.',
      done: hasOrgOrTeam,
      href: '/profile',
      cta: 'Set up org',
      optional: true,
    },
    {
      key: 'referral',
      title: 'Reach out to your first prospect',
      description:
        'Move someone into your pipeline and send your first ask. Capacity sizes the ask; the relationship earns the yes.',
      done: referralCount > 0,
      href: '/prospects',
      cta: 'Reach out',
    },
  ];

  // Progress counts REQUIRED steps; optional steps still flip to done but never
  // block "complete". The checklist is complete once every required step is done.
  const required = steps.filter((s) => !s.optional);
  const completed = required.filter((s) => s.done).length;
  const complete = completed === required.length;
  return {
    steps,
    completedSteps: completed,
    totalSteps: required.length,
    complete,
    dismissed: !!user.onboarding_dismissed,
  };
}

app.get('/api/onboarding', requireAuth, (req, res) => {
  res.json(buildOnboarding(req.user));
});

// Persist (or clear) the dismissal flag. Body { dismissed?: boolean } — defaults to
// true so the common "Dismiss" button can POST an empty body.
app.post('/api/onboarding/dismiss', requireAuth, (req, res) => {
  const dismissed = req.body?.dismissed === false ? 0 : 1;
  setOnboardingDismissed.run(dismissed, req.user.id);
  res.json(buildOnboarding(findUserById.get(req.user.id)));
});

// ── Audit reader (owner/admin transparency surface) ──────────────────────────
// GET /api/orgs/audit — the org's append-only audit_log, newest-first, paginated.
// Org-scoped (orgScope(req)) so an admin only ever sees THEIR org's entries, never
// another tenant's. The audit_log table by construction holds NO tokens/secrets —
// only dotted verbs + a freeform target (email/id/role) — so nothing privileged
// leaks here. Owner/admin only (layered on requireAuth, mirrors the other admin
// endpoints).
const auditPageStmt = db.prepare(`
  SELECT id, actor_user_id AS actorUserId, action, target, created_at AS createdAt
    FROM audit_log
   WHERE org_id = ?
   ORDER BY id DESC
   LIMIT ? OFFSET ?
`);
const auditCountStmt = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?');
app.get('/api/orgs/audit', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  // Clamp pagination to sane bounds (default 50/page, max 200).
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const total = auditCountStmt.get(orgId).n;
  const entries = auditPageStmt.all(orgId, limit, offset);
  res.json({ entries, total, limit, offset });
});

// ── Org / manager analytics (owner/admin, org-scoped) ────────────────────────
// GET /api/orgs/analytics — a whole-org rollup ACROSS every scout, distinct from
// the per-scout /api/impact + /api/stats dashboard. Owner/admin only (members get
// 403) and every query binds orgScope(req) so NO other tenant's rows are counted.
// Reuses the same aggregation shape as the team leaderboard (per-member impact)
// and per-org impact economics (getOrgConfig) so the numbers stay consistent.

// Stage funnel: how many referrals sit in each pipeline stage, org-wide. The
// `donated` count is derived from donation_received (the authoritative flag set on
// a recorded donation) so it matches `totalRaised`/conversion even if a row's
// status text drifts. Demo-teammate scouts are excluded to mirror the leaderboard.
const orgStageCounts = db.prepare(`
  SELECT r.status AS status, COUNT(*) AS n
    FROM referrals r
    JOIN users u ON u.id = r.user_id
   WHERE r.org_id = ?
     AND u.org_id = ?
     AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
   GROUP BY r.status
`);
// Org totals over the same (org-scoped, non-demo-teammate) referral population.
const orgReferralTotals = db.prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN r.donation_received = 1 THEN 1 ELSE 0 END), 0) AS donations,
         COALESCE(SUM(CASE WHEN r.donation_received = 1 THEN r.donation_amount ELSE 0 END), 0) AS raised,
         COALESCE(SUM(CASE WHEN r.status IN ('asked','following_up','donated','declined') THEN 1 ELSE 0 END), 0) AS asks
    FROM referrals r
    JOIN users u ON u.id = r.user_id
   WHERE r.org_id = ?
     AND u.org_id = ?
     AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
`);
// # of scouts in the org who have at least one referral (active fundraisers).
const orgActiveScouts = db.prepare(`
  SELECT COUNT(DISTINCT r.user_id) AS n
    FROM referrals r
    JOIN users u ON u.id = r.user_id
   WHERE r.org_id = ?
     AND u.org_id = ?
     AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
`);
// Per-scout breakdown: every real member, with their asks/donations/raised. LEFT
// JOIN so even scouts with no pipeline yet appear (zeros), like the leaderboard.
const orgScoutBreakdown = db.prepare(`
  SELECT u.id, u.name, u.email, u.org_role AS role,
         COALESCE(COUNT(r.id), 0) AS totalReferrals,
         COALESCE(SUM(CASE WHEN r.status IN ('asked','following_up','donated','declined') THEN 1 ELSE 0 END), 0) AS asks,
         COALESCE(SUM(CASE WHEN r.donation_received = 1 THEN 1 ELSE 0 END), 0) AS donations,
         COALESCE(SUM(CASE WHEN r.donation_received = 1 THEN r.donation_amount ELSE 0 END), 0) AS raised
    FROM users u
    LEFT JOIN referrals r ON r.user_id = u.id AND r.org_id = ?
   WHERE u.org_id = ?
     AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
   GROUP BY u.id
   ORDER BY raised DESC, donations DESC, u.name COLLATE NOCASE ASC
`);
// Per-segment conversion: each org-scoped referral joined to its originating
// connection's score_reasons (the relationship/cause segments, e.g. "family",
// "coworker", "Ukraine ties"). One row per referral; reasons are exploded in JS
// since they're a JSON array. donation_received drives the converted count.
const orgReferralSegments = db.prepare(`
  SELECT r.id AS referral_id, r.donation_received AS donated, c.score_reasons AS score_reasons
    FROM referrals r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN connections c ON c.id = r.connection_id AND c.org_id = r.org_id
   WHERE r.org_id = ?
     AND u.org_id = ?
     AND COALESCE(u.linkedin_id, '') NOT LIKE 'demo-teammate-%'
`);

app.get('/api/orgs/analytics', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req); // org_id from the session — never request input
  const cfg = getOrgConfig(orgId);
  const costBootcamp = cfg.impact?.programCost || COST_PER_BOOTCAMP;
  const costDay = cfg.impact?.dayCost || COST_PER_DAY;

  // ── Stage funnel: counts per stage + sequential conversion rates ──
  const stageCountRows = orgStageCounts.all(orgId, orgId);
  const stageCounts = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0]));
  for (const row of stageCountRows) {
    if (Object.prototype.hasOwnProperty.call(stageCounts, row.status)) stageCounts[row.status] = row.n;
  }
  const totals = orgReferralTotals.get(orgId, orgId);
  // Authoritative donated count = recorded donations (donation_received), so the
  // funnel agrees with totals/conversion regardless of any stale status text.
  stageCounts.donated = totals.donations;
  // Reached the "asked or further" funnel: everyone who's been contacted.
  const reached = stageCounts.asked + stageCounts.following_up + totals.donations + stageCounts.declined;
  const queuedPlusReached = stageCounts.to_ask + reached;
  const funnel = {
    counts: stageCounts,
    conversion: {
      // to_ask → asked: of prospects queued, how many have actually been asked.
      to_ask_to_asked: queuedPlusReached ? reached / queuedPlusReached : 0,
      // asked → following_up: of those asked, how many are being followed up.
      asked_to_following_up: reached ? (stageCounts.following_up + totals.donations) / reached : 0,
      // following_up → donated: of those engaged past the ask, how many gave.
      following_up_to_donated:
        stageCounts.following_up + totals.donations
          ? totals.donations / (stageCounts.following_up + totals.donations)
          : 0,
      // Overall: donations / asks (the headline org conversion).
      overall: totals.asks ? totals.donations / totals.asks : 0,
    },
  };

  // ── Org totals (raised, beneficiaries via per-org economics, scouts, asks) ──
  const orgTotals = {
    raised: totals.raised,
    asks: totals.asks,
    donations: totals.donations,
    totalReferrals: totals.total,
    beneficiariesFunded: Math.floor(totals.raised / costBootcamp),
    daysFunded: Math.floor(totals.raised / costDay),
    activeScouts: orgActiveScouts.get(orgId, orgId).n,
    conversionRate: totals.asks ? totals.donations / totals.asks : 0,
  };

  // ── Per-segment conversion (group by connection score_reasons) ──
  const segMap = new Map(); // segment label → { asks, donations }
  for (const row of orgReferralSegments.all(orgId, orgId)) {
    const labels = safeParse(row.score_reasons, []).map((r) => (r && r.label) || r).filter(Boolean);
    const seen = new Set(); // a referral counts ONCE per distinct segment
    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);
      const bucket = segMap.get(label) || { asks: 0, donations: 0 };
      bucket.asks += 1;
      if (row.donated) bucket.donations += 1;
      segMap.set(label, bucket);
    }
  }
  const segments = Array.from(segMap.entries())
    .map(([segment, b]) => ({
      segment,
      asks: b.asks,
      donations: b.donations,
      conversionRate: b.asks ? b.donations / b.asks : 0,
    }))
    // Best-converting first, then by volume — what a manager wants to lead with.
    .sort((a, b) => b.conversionRate - a.conversionRate || b.asks - a.asks);

  // ── Per-scout breakdown table ──
  const scouts = orgScoutBreakdown.all(orgId, orgId).map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    role: s.role,
    asks: s.asks,
    donations: s.donations,
    raised: s.raised,
    totalReferrals: s.totalReferrals,
    beneficiariesFunded: Math.floor(s.raised / costBootcamp),
    conversionRate: s.asks ? s.donations / s.asks : 0,
  }));

  res.json({
    funnel,
    totals: orgTotals,
    segments,
    scouts,
    economics: {
      costPerBootcamp: costBootcamp,
      costPerDay: costDay,
      beneficiaries: cfg.impact?.beneficiaries || CAUSE.impact.beneficiaries,
      orgName: cfg.orgName || CAUSE.orgName,
    },
  });
});

// ── Per-org Okta SSO administration (owner/admin, org-scoped) ────────────────
// All endpoints derive org_id from orgScope(req) (the session) — NEVER from the
// body — so an admin can only ever configure THEIR org's SSO. The client_secret
// is encrypted at rest on write and is NEVER returned (publicIdpConfig strips it).
const GROUP_ROLE_VALUES = new Set(['owner', 'admin', 'member']);

// Read the current IdP config (secret stripped) + this org's domains. Lets the
// admin UI render the SSO setup state without ever seeing the secret.
app.get('/api/orgs/sso', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  res.json({
    config: publicIdpConfig(findIdpConfigByOrg.get(orgId)),
    domains: listOrgDomains.all(orgId),
    redirectUri: `${API_PUBLIC_URL}/api/auth/sso/callback`, // must be allow-listed in Okta
  });
});

// Create/update the org's Okta OIDC config. The client_secret is encrypted at
// rest; on update, omitting clientSecret keeps the existing one. group_role_map
// is validated to map arbitrary group names → {owner|admin|member} only.
app.put('/api/orgs/sso', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const b = req.body || {};
  const issuer = (b.issuer || '').toString().trim();
  const clientId = (b.clientId || '').toString().trim();
  if (!issuer || !/^https?:\/\//.test(issuer)) {
    return res.status(400).json({ error: 'A valid issuer URL is required.' });
  }
  if (!clientId) return res.status(400).json({ error: 'A client ID is required.' });

  const existing = findIdpConfigByOrg.get(orgId);
  // Secret: required on first create; on update an absent secret keeps the prior.
  let secretEnc;
  if (typeof b.clientSecret === 'string' && b.clientSecret.length > 0) {
    secretEnc = secretBox.encrypt(b.clientSecret);
  } else if (existing) {
    secretEnc = existing.client_secret_enc;
  } else {
    return res.status(400).json({ error: 'A client secret is required.' });
  }

  // Validate group_role_map: an object of { groupName: 'owner'|'admin'|'member' }.
  let groupRoleMap = existing?.group_role_map || null;
  if (b.groupRoleMap !== undefined) {
    if (b.groupRoleMap === null) {
      groupRoleMap = null;
    } else if (typeof b.groupRoleMap === 'object' && !Array.isArray(b.groupRoleMap)) {
      const clean = {};
      for (const [g, role] of Object.entries(b.groupRoleMap)) {
        if (GROUP_ROLE_VALUES.has(role)) clean[String(g)] = role;
      }
      groupRoleMap = JSON.stringify(clean);
    } else {
      return res.status(400).json({ error: 'groupRoleMap must be an object of group → role.' });
    }
  }

  upsertIdpConfig.run({
    org_id: orgId,
    issuer,
    client_id: clientId,
    client_secret_enc: secretEnc,
    group_role_map: groupRoleMap,
    jit_provisioning: b.jitProvisioning ? 1 : 0,
    enforced: b.enforced ? 1 : 0,
  });
  recordAudit({ orgId, actorUserId: req.user.id, action: 'sso.config_updated', target: issuer });
  res.json({ config: publicIdpConfig(findIdpConfigByOrg.get(orgId)) }); // secret NEVER returned
});

// Remove the org's SSO config (disables SSO for the org; fallback logins remain).
app.delete('/api/orgs/sso', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  deleteIdpConfigByOrg.run(orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'sso.config_removed', target: String(orgId) });
  res.json({ ok: true });
});

// Add a domain to claim (starts UNVERIFIED — cannot route SSO until verified).
// Globally unique: a domain already claimed by any org is rejected (anti-takeover).
app.post('/api/orgs/sso/domains', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const domain = (req.body?.domain || '').toString().trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ error: 'A valid domain is required.' });
  }
  // A verification token the operator would publish (DNS TXT) or click (email).
  // The actual DNS/email check is STUBBED for now (see /verify), but the
  // verified GATE + token exist so the model is complete and anti-takeover holds.
  const verifyToken = crypto.randomBytes(16).toString('hex');
  try {
    const id = insertOrgDomain.run(orgId, domain, verifyToken).lastInsertRowid;
    recordAudit({ orgId, actorUserId: req.user.id, action: 'sso.domain_added', target: domain });
    res.status(201).json({ domain: { id, domain, verified: false }, verifyToken });
  } catch (e) {
    // UNIQUE(domain) violation → the domain is already claimed (by this or another
    // org). Same generic message either way — never reveal another tenant's claim.
    return res.status(409).json({ error: 'That domain is already claimed.' });
  }
});

// List this org's domains.
app.get('/api/orgs/sso/domains', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  res.json({ domains: listOrgDomains.all(orgScope(req)) });
});

// Verify a domain. The DNS-TXT / emailed-link check is STUBBED (always succeeds
// here) — but the verified GATE is real: only after this flips verified=1 can the
// domain route SSO / claim users. A real deployment performs the actual check
// before flipping the flag.
app.post('/api/orgs/sso/domains/:id/verify', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const dom = findDomainInOrg.get(id, orgId);
  if (!dom) return res.status(404).json({ error: 'Domain not found.' });
  // The DNS-TXT / emailed-link ownership check is STUBBED (succeeds offline for dev).
  // Self-verifying a domain with no proof of ownership is a tenant-takeover vector
  // (it routes that domain's SSO users — and JIT-provisions them if enabled — into
  // this org). So HARD-GATE it in production until the real check ships: never flip
  // verified=1 in prod from this stub. The token is already minted at domain-add time.
  if (IS_PROD) {
    return res.status(501).json({ error: 'Domain verification is not yet available. Contact support to verify your domain.' });
  }
  // TODO(real-deploy): resolve DNS TXT _donorscout-verify=<verify_token> (or confirm
  // an emailed link), make the token single-use, THEN flip verified. Dev-only below.
  markDomainVerified.run(id, orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'sso.domain_verified', target: dom.domain });
  res.json({ domain: { id, domain: dom.domain, verified: true } });
});

// Remove a domain (THIS org only — 404 if it belongs to another).
app.delete('/api/orgs/sso/domains/:id', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const dom = findDomainInOrg.get(id, orgId);
  if (!dom) return res.status(404).json({ error: 'Domain not found.' });
  deleteOrgDomain.run(id, orgId);
  recordAudit({ orgId, actorUserId: req.user.id, action: 'sso.domain_removed', target: dom.domain });
  res.json({ ok: true });
});

// ── Teams / competition leaderboard (membership = many-to-many) ──
// Teams are ORG-SCOPED: org_id = the creator's org. Lookups + join-by-code below
// always filter by the caller's org so a team can never be seen or joined across
// tenants (cross-org join returns the same 404 as an unknown code — no leak).
const findTeam = db.prepare('SELECT * FROM teams WHERE id = ?');
const findTeamByCode = db.prepare('SELECT * FROM teams WHERE invite_code = ? AND org_id = ?');
const insertTeam = db.prepare(
  'INSERT INTO teams (name, invite_code, goal_amount, created_by, org_id) VALUES (?, ?, ?, ?, ?)'
);
const updateTeam = db.prepare('UPDATE teams SET name = ?, goal_amount = ? WHERE id = ? AND created_by = ?');
const setUserTeam = db.prepare('UPDATE users SET team_id = ? WHERE id = ?'); // active team
const addMember = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)');
const removeMember = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?');
const isMember = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?');
const userTeams = db.prepare(`
  SELECT t.id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id
   WHERE tm.user_id = ? ORDER BY t.name COLLATE NOCASE
`);
// REAL leaderboard: each member's row is their own live impact aggregate, joined
// org-scoped. We pin both the membership and the impact row to the team's org so a
// leaderboard only ever shows members of THAT org and sums THAT org's referrals —
// even if a user somehow belongs to teams across orgs, no other org's numbers leak
// in. (`code_x_impact` is keyed by (user_id, org_id), so the join is org-exact.)
const teamMembers = db.prepare(`
  SELECT u.id, u.name,
         COALESCE(ci.total_referred_donations, 0) AS raised,
         COALESCE(ci.num_referrals_converted, 0)  AS donations,
         COALESCE(ci.num_students_supported, 0)   AS students
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id AND u.org_id = ?
    LEFT JOIN code_x_impact ci ON ci.user_id = u.id AND ci.org_id = ?
   WHERE tm.team_id = ?
   ORDER BY raised DESC, donations DESC, u.name ASC
`);
const teamReferralStats = db.prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN donation_received = 1 THEN 1 ELSE 0 END), 0) AS converted
    FROM referrals
   WHERE org_id = ?
     AND user_id IN (SELECT user_id FROM team_members WHERE team_id = ?)
`);

const _teamCodeExists = db.prepare('SELECT 1 FROM teams WHERE invite_code = ?');
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (_teamCodeExists.get(code)); // globally unique (invite_code is UNIQUE)
  return code;
}

function teamPayload(user) {
  const teams = userTeams.all(user.id);
  let activeId = user.team_id;
  if (!teams.some((t) => t.id === activeId)) activeId = teams[0]?.id ?? null;
  const teamsList = teams.map((t) => ({ id: t.id, name: t.name, isActive: t.id === activeId }));
  if (!activeId) return { teams: teamsList, team: null };

  const team = findTeam.get(activeId);
  if (!team) return { teams: teamsList, team: null };
  // The team lives in exactly one org; the leaderboard is scoped to that org so it
  // only ever shows that tenant's members with that tenant's numbers.
  const teamOrgId = team.org_id || DEFAULT_ORG_ID;
  const members = teamMembers.all(teamOrgId, teamOrgId, team.id);
  const raised = members.reduce((s, m) => s + m.raised, 0);
  const refStats = teamReferralStats.get(teamOrgId, team.id);

  // Per-org impact economics drive the team goal + impact figures — consistent
  // with /api/impact (buildImpact). Falls back to the cause.config.js defaults.
  const cfg = getOrgConfig(teamOrgId);
  const costBootcamp = cfg.impact?.programCost || COST_PER_BOOTCAMP;
  const costDay = cfg.impact?.dayCost || COST_PER_DAY;
  const aggregate = {
    raised,
    donations: refStats.converted,
    totalReferrals: refStats.total,
    studentsFunded: Math.floor(raised / costBootcamp),
    daysFunded: Math.floor(raised / costDay),
    conversionRate: refStats.total ? refStats.converted / refStats.total : 0,
  };
  return {
    teams: teamsList,
    team: {
      id: team.id,
      name: team.name,
      inviteCode: team.invite_code,
      goalAmount: team.goal_amount || 0,
      memberCount: members.length,
      isOwner: team.created_by === user.id,
    },
    aggregate,
    // Surface the org's economics so the client labels match the live figures
    // (e.g. "$X = 1 bootcamp") instead of the hardcoded static cause config.
    economics: {
      costPerBootcamp: costBootcamp,
      costPerDay: costDay,
      beneficiaries: cfg.impact?.beneficiaries || CAUSE.impact.beneficiaries,
      orgName: cfg.orgName || CAUSE.orgName,
    },
    leaderboard: members.map((m, i) => ({ rank: i + 1, ...m, isYou: m.id === user.id })),
  };
}

app.get('/api/team', requireAuth, (req, res) => res.json(teamPayload(req.user)));

app.post('/api/team', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name is required.' });
  const goal = Math.max(0, Number(req.body?.goalAmount) || 0);
  // The team is stamped with the creator's org so it stays inside this tenant.
  const info = insertTeam.run(name, genInviteCode(), goal, req.user.id, orgScope(req));
  addMember.run(info.lastInsertRowid, req.user.id, 'owner');
  setUserTeam.run(info.lastInsertRowid, req.user.id);
  res.status(201).json(teamPayload(findUserById.get(req.user.id)));
});

app.post('/api/team/join', requireAuth, (req, res) => {
  const code = (req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter an invite code.' });
  // Scoped by the caller's org: a code for a team in another org yields no row,
  // so we return the SAME 404 as an unknown code (no cross-org existence leak).
  const team = findTeamByCode.get(code, orgScope(req));
  if (!team) return res.status(404).json({ error: 'No team found with that code.' });
  addMember.run(team.id, req.user.id, 'member');
  setUserTeam.run(team.id, req.user.id);
  res.json(teamPayload(findUserById.get(req.user.id)));
});

// Switch which of your teams is active (the one the Team page shows).
app.post('/api/team/switch', requireAuth, (req, res) => {
  const teamId = Number(req.body?.teamId);
  if (!teamId || !isMember.get(teamId, req.user.id)) {
    return res.status(404).json({ error: 'You are not a member of that team.' });
  }
  setUserTeam.run(teamId, req.user.id);
  res.json(teamPayload(findUserById.get(req.user.id)));
});

app.patch('/api/team', requireAuth, (req, res) => {
  const team = req.user.team_id ? findTeam.get(req.user.team_id) : null;
  if (!team) return res.status(404).json({ error: 'No active team.' });
  if (team.created_by !== req.user.id) return res.status(403).json({ error: 'Only the team owner can edit it.' });
  const name = (req.body?.name || '').trim() || team.name;
  const goal =
    req.body?.goalAmount !== undefined ? Math.max(0, Number(req.body.goalAmount) || 0) : team.goal_amount;
  updateTeam.run(name, goal, team.id, req.user.id);
  res.json(teamPayload(findUserById.get(req.user.id)));
});

app.post('/api/team/leave', requireAuth, (req, res) => {
  const leaveId = req.user.team_id;
  if (leaveId) {
    removeMember.run(leaveId, req.user.id);
    const remaining = userTeams.all(req.user.id);
    setUserTeam.run(remaining[0]?.id ?? null, req.user.id);
  }
  res.json(teamPayload(findUserById.get(req.user.id)));
});

// ── Demo data (for exploring / presenting) ──────────────────────
// Scoped to (user_id, org_id) so a clear can only ever touch the caller's own
// rows in their own org — never another tenant's data.
const wipeUserData = (userId, orgId) => {
  db.prepare('DELETE FROM follow_up_reminders WHERE user_id = ? AND org_id = ?').run(userId, orgId);
  db.prepare('DELETE FROM donations WHERE user_id = ? AND org_id = ?').run(userId, orgId); // before referrals (FK)
  db.prepare('DELETE FROM connections WHERE user_id = ? AND org_id = ?').run(userId, orgId);
  db.prepare('DELETE FROM referrals WHERE user_id = ? AND org_id = ?').run(userId, orgId);
};

app.post('/api/demo/clear', requireAuth, (req, res) => {
  wipeUserData(req.user.id, orgScope(req));
  db.prepare('UPDATE users SET goal_amount = 0, demo_mode = 0 WHERE id = ?').run(req.user.id);
  recomputeImpact(req.user.id);
  res.json({ ok: true });
});

// ---- Shared demo content (used by both the full reset and the additive toggle) ----
const DEMO_PROFILE = {
  company: 'Stripe',
  pastCompanies: 'Shopify, McKinsey & Company',
  location: 'Toronto, Canada',
  schools: 'University of Toronto, Northern Secondary School',
};

// Sample Grants document library so a demo org can generate a real grant report. These
// give the report + answer generators concrete mission, program, outcome, and financial
// material (with a beneficiary story and honest challenge) to ground on, alongside the
// seeded donation data. Kept consistent with the Code for Ukraine cause.
const DEMO_DOCUMENTS = [
  {
    name: 'Mission and overview',
    kind: 'mission',
    content:
      'Code for Ukraine is a nonprofit that funds and runs intensive coding bootcamps for Ukrainians displaced by the war. Our mission is to help displaced Ukrainians rebuild stable careers in technology, wherever they have resettled.\n\n' +
      'The problem: Since 2022, millions of Ukrainians have been forced to leave their homes. Many are skilled professionals whose careers were interrupted, and who now face language barriers, gaps in local networks, and the cost of retraining in a new country. Technology offers remote, well paid, location independent work, but the path in is hard to navigate alone.\n\n' +
      'What we do: We provide full scholarships to a 12 week, full time software engineering bootcamp, paired with mentorship and job placement support. Students learn full stack web development, build real projects, and are matched with volunteer mentors who are working engineers. We support them through the job search until they are placed.\n\n' +
      'Our belief: A real relationship and a real skill, not charity alone, are what rebuild a career. We measure success by jobs secured and careers restarted, not by how many people attend a class.',
  },
  {
    name: 'Bootcamp program description',
    kind: 'program',
    content:
      'The Code for Ukraine Bootcamp is a 12 week, full time program in full stack web development. Each cohort enrolls 20 to 30 students. The curriculum covers HTML, CSS, JavaScript, React, Node.js, databases, and professional engineering practices including version control, testing, and code review.\n\n' +
      'Structure: Students attend live instruction four days a week and work on project based assignments. In the final three weeks they build a capstone project and complete mock technical interviews. Every student is paired with a volunteer mentor, a working software engineer who meets with them weekly.\n\n' +
      'Support: All tuition is covered by scholarship. We provide a laptop to students who need one, a stipend for internet access, and translation support for those still building English fluency. After graduation, our placement team works with each graduate on their resume, portfolio, and interview preparation, and introduces them to hiring partners until they are placed.\n\n' +
      'Eligibility: The program is open to Ukrainians displaced since 2022. We prioritize applicants who have some prior exposure to technical work but cannot afford to retrain, and we run the program twice a year.',
  },
  {
    name: '2024 impact and outcomes',
    kind: 'impact',
    content:
      'In 2024, Code for Ukraine ran two bootcamp cohorts and served 38 students. Of those, 24 completed the full program, a completion rate of 63 percent. Within six months of graduating, 17 graduates secured paid roles in technology, a placement rate of 71 percent among those who completed. The average starting salary reported by placed graduates was 52,000 dollars per year.\n\n' +
      'Beyond placement, 22 of the 24 graduates said the program improved their confidence and sense of stability, based on our end of program survey. We also grew our volunteer mentor pool to 19 working engineers.\n\n' +
      'Challenges: The most common difficulty students reported was balancing a full time program with the demands of resettlement, including housing instability and caregiving. Two students had to withdraw mid cohort for this reason. In response, we added a part time evening track for the 2025 cohorts and expanded our stipend support.\n\n' +
      'Beneficiary story: Olena, a former accountant from Kharkiv, joined our spring 2024 cohort after eighteen months without stable work. She said, "For the first time since we left, I have a plan and a skill that travels with me anywhere." Three months after graduating she was hired as a junior front end developer at a logistics company. Name used with permission.',
  },
  {
    name: 'Annual budget and financials',
    kind: 'financial',
    content:
      'Code for Ukraine operates on an annual budget of approximately 420,000 dollars. The cost to put one student through the full bootcamp, including instruction, mentorship, the laptop and internet stipend, and placement support, is approximately 5,000 dollars per student.\n\n' +
      'Spending breakdown for 2024: 78 percent of expenses went directly to program delivery (instructors, mentor coordination, student stipends, and laptops), 14 percent to fundraising and donor stewardship, and 8 percent to administration and overhead.\n\n' +
      'Revenue sources: individual donations through our donor network, employer matching gifts, a small number of foundation grants, and in kind contributions of mentor time and curriculum. We are working to diversify our funding so that no single source exceeds 40 percent of revenue.\n\n' +
      'Individual gifts are processed through Zeffy, which passes 100 percent of each donation to the organization.',
  },
];
// Each teammate's standing derives from real backing referrals (donated amounts +
// some still-pending asks) so every team stat — raised, donations, students, and
// conversion rate — stays internally consistent with the leaderboard.
const DEMO_TEAMMATES = [
  { name: 'Teammate A', donated: [800, 700, 500, 400], asked: 6 },
  { name: 'Teammate B', donated: [800, 500, 300], asked: 5 },
  { name: 'Teammate C', donated: [500, 400, 250], asked: 4 },
  { name: 'Teammate D', donated: [800], asked: 3 },
  { name: 'Teammate E', donated: [200, 125], asked: 3 },
];
// Teammates are scoped per team (linkedin_id `demo-teammate-<teamId>-<n>`) so
// enabling demo on one team never touches another team's teammates.
const demoTeammateLid = (teamId, n) => `demo-teammate-${teamId}-${n}`;

const scoutSurname = (scout) => {
  const parts = (scout?.name || 'Jamie Bergen').trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : 'Bergen';
};
// All demo contacts point at the operator's OWN email + LinkedIn page, so the mock
// data contains zero real addresses or domains and nothing can ever reach a real person
// (belt-and-suspenders on top of the outbound send guard in lib/sendguard.js).
const DEMO_EMAIL = 'jgbergen18@gmail.com';
const DEMO_LINKEDIN = 'https://www.linkedin.com/in/jamiebergen/';
const demoLinkedinUrl = () => DEMO_LINKEDIN;

function demoSampleContacts(surname) {
  const sl = surname.toLowerCase();
  const gh = (u, f, r, bio) => ({ github_username: u, github_followers: f, github_repos: r, github_confidence: 'high', github_bio: bio || null });
  return [
    { contact_name: `Rachel ${surname}`, contact_email: DEMO_EMAIL, company: 'Self-employed', role: 'Interior Designer', location: 'Ottawa, Canada' },
    { contact_name: `Daniel ${surname}`, contact_email: DEMO_EMAIL, company: 'Northbridge Health', role: 'Operations Manager', location: 'Toronto, Canada' },
    { contact_name: 'Priya Sharma', contact_email: DEMO_EMAIL, company: 'Stripe', role: 'VP of Engineering', location: 'Toronto, Canada', ...gh('priyacodes', 1800, 47, 'Eng leader. University of Toronto alum.') },
    { contact_name: 'Marcus Webb', contact_email: DEMO_EMAIL, company: 'University of Toronto', role: 'Professor of Computer Science', location: 'Toronto, Canada' },
    { contact_name: 'Oksana Melnyk', contact_email: DEMO_EMAIL, company: 'Razom for Ukraine', role: 'Program Lead', location: 'Kyiv, Ukraine' },
    { contact_name: 'Janet Olsen', contact_email: DEMO_EMAIL, company: 'Shopify', role: 'Senior Product Manager', location: 'Toronto, Canada' },
    { contact_name: 'David Kim', contact_email: DEMO_EMAIL, company: 'Google', role: 'Director of Engineering', location: 'Mountain View, USA', ...gh('dkimg', 920, 31) },
    { contact_name: 'Elena Petrov', contact_email: DEMO_EMAIL, company: 'Nvidia', role: 'Principal Engineer', location: 'Lviv, Ukraine', ...gh('epetrov', 540, 22) },
    { contact_name: 'Sara Lindqvist', contact_email: DEMO_EMAIL, company: 'Toronto District School Board', role: 'Teacher', location: 'Toronto, Canada' },
    { contact_name: 'Tomas Rivera', contact_email: DEMO_EMAIL, company: 'Stripe', role: 'Software Engineer', location: 'Remote', ...gh('trivera', 210, 64) },
    { contact_name: 'Robert Vance', contact_email: DEMO_EMAIL, company: 'McKinsey & Company', role: 'Partner', location: 'New York, USA' },
    { contact_name: 'Aisha Khan', contact_email: DEMO_EMAIL, company: 'Acme Corp', role: 'Data Analyst', location: 'London, UK' },
    { contact_name: 'Greg Nolan', company: 'Nolan Bakery', role: 'Owner', location: 'Hamilton, Canada' },
    { contact_name: 'Lia Romano', contact_email: DEMO_EMAIL, company: 'Datadog', role: 'Engineering Manager', location: 'Boston, USA' },
    { contact_name: 'Yuki Tanaka', contact_email: DEMO_EMAIL, company: 'Vercel', role: 'Developer Advocate', location: 'Tokyo, Japan', ...gh('yukidev', 3100, 88, 'DevRel. I love teaching.') },
    { contact_name: 'Hassan Ali', contact_email: DEMO_EMAIL, company: 'University of Toronto', role: 'Research Associate', location: 'Toronto, Canada' },
    { contact_name: 'Chloe Martin', company: 'Freelance', role: 'Marketing Consultant', location: 'Toronto, Canada' },
    { contact_name: 'Ivan Bondarenko', contact_email: DEMO_EMAIL, company: 'Kyiv Digital', role: 'Software Engineer', location: 'Kyiv, Ukraine', ...gh('ivanbond', 95, 40) },
    { contact_name: 'Nina Schwartz', contact_email: DEMO_EMAIL, company: 'Foundation for Education', role: 'Director', location: 'Berlin, Germany' },
    { contact_name: 'Peter Zhang', company: 'Microsoft', role: 'Staff Engineer', location: 'Seattle, USA', ...gh('pzhangdev', 760, 53) },
    { contact_name: 'Maya Cohen', contact_email: DEMO_EMAIL, company: 'Stripe', role: 'Technical Recruiter', location: 'Toronto, Canada' },
    { contact_name: 'Omar Haddad', contact_email: DEMO_EMAIL, company: 'Bright Futures NGO', role: 'Volunteer Coordinator', location: 'Toronto, Canada' },
    // More employers with well-known matching-gift programs, plus a few varied profiles
    // so the network, the prospect ranking, and the "double their gift" worklist are full.
    { contact_name: 'Sofia Bianchi', contact_email: DEMO_EMAIL, company: 'Apple', role: 'Design Lead', location: 'Cupertino, USA' },
    { contact_name: 'Grace Liu', contact_email: DEMO_EMAIL, company: 'Amazon', role: 'Senior Product Manager', location: 'Seattle, USA' },
    { contact_name: 'Noah Bergman', contact_email: DEMO_EMAIL, company: 'Meta', role: 'Software Engineer', location: 'Menlo Park, USA', ...gh('noahb', 410, 28) },
    { contact_name: 'Anya Volkov', contact_email: DEMO_EMAIL, company: 'Deloitte', role: 'Senior Consultant', location: 'Toronto, Canada' },
    { contact_name: 'Liam OConnor', contact_email: DEMO_EMAIL, company: 'Salesforce', role: 'Account Executive', location: 'Dublin, Ireland' },
    { contact_name: 'Olena Tkachenko', contact_email: DEMO_EMAIL, company: 'Kyiv School of Economics', role: 'Lecturer', location: 'Kyiv, Ukraine' },
    { contact_name: 'Ben Carter', company: 'Carter & Sons Plumbing', role: 'Owner', location: 'Mississauga, Canada' },
    { contact_name: 'Sam Reed', contact_email: DEMO_EMAIL, company: 'Self-employed', role: 'Photographer', location: 'Vancouver, Canada' },
  ];
}

function demoPipelinePlan(surname) {
  const base = new Date();
  const day = (n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  return [
    // Donated — a mix incl. matching-gift employers (Google, Microsoft, Amazon) so the
    // "double their gift" worklist populates, a fresh gift awaiting a thank-you, and a
    // recurring donor (multiple gifts) so the per-gift donations ledger shows depth.
    ['Priya Sharma', 'donated', { amount: 800, date: day(-26) }],
    ['Oksana Melnyk', 'donated', { amount: 250, date: day(-5) }],
    ['David Kim', 'donated', { amount: 500, date: day(-9) }], // Google → match-gift
    ['Peter Zhang', 'donated', { amount: 300, date: day(-16) }], // Microsoft → match-gift
    ['Grace Liu', 'donated', { amount: 150, date: day(-2) }], // Amazon → match-gift + awaiting thanks
    ['Yuki Tanaka', 'donated', { gifts: [{ amount: 50, date: day(-92) }, { amount: 50, date: day(-61) }, { amount: 50, date: day(-30) }] }], // recurring → ledger depth
    ['Nina Schwartz', 'donated', { amount: 120, date: day(-45), thanked: true }], // single gift, thanked, 45d ago → second-gift re-ask lane
    // Following up — each with an OPEN cadence reminder (some overdue, some due today)
    // so the Today "Follow-ups due" queue and the pipeline reminder badges populate.
    [`Daniel ${surname}`, 'following_up', { note: 'Said yes in principle, resending the link.', reminderDue: day(-3) }],
    ['Marcus Webb', 'following_up', { note: 'Left a voicemail. Try email next.', reminderDue: day(0) }],
    ['Anya Volkov', 'following_up', { note: 'Wants to give via her employer match.', reminderDue: day(1) }],
    // Asked — reminders across the next two weeks (one overdue, one due today).
    ['Janet Olsen', 'asked', { reminderDue: day(2) }],
    ['Tomas Rivera', 'asked', { reminderDue: day(-1) }],
    ['Maya Cohen', 'asked', { reminderDue: day(5) }],
    ['Hassan Ali', 'asked', { note: 'Met at the alumni mixer.', reminderDue: day(0) }],
    // To ask — top un-asked prospects sitting in the pipeline, ready to go.
    ['Sara Lindqvist', 'to_ask', {}],
    ['Ivan Bondarenko', 'to_ask', {}],
    ['Sofia Bianchi', 'to_ask', {}],
    // Declined — keeps the funnel honest.
    ['Robert Vance', 'declined', { note: 'Not this quarter. Circle back in Q4.' }],
  ];
}

// Insert demo prospects + pipeline for a user, scoring against `scout`.
// tagged=true flags rows is_demo (additive mode); both modes skip duplicates so
// repeated runs don't pile up.
function seedDemoProspects(userId, scout, { tagged } = {}) {
  const surname = scoutSurname(scout);
  const orgId = scout.org_id || DEFAULT_ORG_ID; // demo data lives in the scout's own org
  const cfg = getOrgConfig(orgId);
  const insertStmt = tagged ? insertDemoConnection : insertConnection;
  const existingUrls = new Set(connectionsForUser.all(userId, orgId).map((c) => c.linkedin_url));
  let connections = 0;
  db.transaction(() => {
    for (const raw of demoSampleContacts(surname)) {
      const conn = {
        contact_name: raw.contact_name,
        contact_email: raw.contact_email || null,
        company: raw.company || null,
        role: raw.role || null,
        location: raw.location || null,
        linkedin_url: demoLinkedinUrl(raw.contact_name),
        github_username: raw.github_username || null,
        github_followers: raw.github_followers || 0,
        github_repos: raw.github_repos || 0,
        github_confidence: raw.github_confidence || null,
        github_bio: raw.github_bio || null,
      };
      if (existingUrls.has(conn.linkedin_url)) continue;
      const s = scoreProspect(conn, scout, cfg);
      insertStmt.run({
        user_id: userId,
        org_id: orgId,
        ...conn,
        donor_likelihood_score: s.score,
        company_tier: s.companyTier,
        capacity_score: s.capacityScore,
        affinity_score: s.affinityScore,
        propensity_score: s.propensityScore,
        score_reasons: JSON.stringify(s.reasons),
      });
      connections++;
    }
  })();

  const conns = connectionsForUser.all(userId, orgId);
  const byName = (n) => conns.find((c) => c.contact_name === n);
  const referredIds = new Set(
    db.prepare('SELECT connection_id FROM referrals WHERE user_id = ? AND org_id = ?')
      .all(userId, orgId)
      .map((r) => r.connection_id)
  );
  let pipeline = 0;
  db.transaction(() => {
    for (const [name, status, opt] of demoPipelinePlan(surname)) {
      const conn = byName(name);
      if (!conn || referredIds.has(conn.id)) continue;
      const info = insertReferral.run({
        user_id: userId,
        org_id: orgId,
        connection_id: conn.id,
        contact_name: conn.contact_name,
        contact_email: conn.contact_email,
        company: conn.company,
        linkedin_url: conn.linkedin_url,
        status,
      });
      const id = info.lastInsertRowid;
      if (status === 'donated') {
        // Support a single gift (opt.amount/date) OR a recurring series (opt.gifts).
        const gifts = opt.gifts || [{ amount: opt.amount, date: opt.date }];
        for (const g of gifts) {
          recordGift({ userId, orgId, referralId: id, connectionId: conn.id, amount: g.amount, date: `${g.date} 12:00:00`, source: 'demo' });
        }
        // Some demo donors are already thanked (so the second-gift re-ask lane has data).
        if (opt.thanked) markReferralThanked.run(id, userId, orgId);
      } else {
        // Set the follow-up date column to match the reminder, and seed an OPEN cadence
        // reminder at that date (so both the pipeline date + the reminder badge show).
        const follow = opt.reminderDue || opt.follow || null;
        if (opt.note || follow) updateReferralFields.run(status, opt.note || null, follow, id, userId, orgId);
        if (opt.reminderDue) seedCadence(getReferral.get(id, userId, orgId), orgId, opt.reminderDue);
      }
      pipeline++;
    }
  })();
  recomputeImpact(userId);
  return { connections, pipeline };
}

// Create/update the placeholder teammates and add them to a team (idempotent).
// Teammates (and their backing data) live in the SAME org as the team, so the
// demo leaderboard never crosses tenants.
function seedDemoTeammates(teamId) {
  const team = findTeam.get(teamId);
  const orgId = team?.org_id || DEFAULT_ORG_ID;
  const findByLid = db.prepare('SELECT * FROM users WHERE linkedin_id = ?');
  const insertUser = db.prepare('INSERT INTO users (linkedin_id, name, org_id, org_role) VALUES (?, ?, ?, ?)');
  const setNameTeam = db.prepare('UPDATE users SET name = ?, team_id = ?, org_id = ? WHERE id = ?');
  const mkConn = db.prepare(
    'INSERT INTO connections (user_id, org_id, contact_name, donor_likelihood_score, is_demo) VALUES (?, ?, ?, 40, 1)'
  );
  const today = new Date().toISOString().slice(0, 10);
  const uids = [];
  db.transaction(() => {
    DEMO_TEAMMATES.forEach((t, idx) => {
      const lid = demoTeammateLid(teamId, idx + 1);
      const existing = findByLid.get(lid);
      const uid = existing ? existing.id : insertUser.run(lid, t.name, orgId, 'member').lastInsertRowid;
      setNameTeam.run(t.name, teamId, orgId, uid);
      addMember.run(teamId, uid, 'member');
      // Rebuild this teammate's backing prospects + referrals so re-runs don't stack.
      db.prepare('DELETE FROM follow_up_reminders WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM donations WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM referrals WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM connections WHERE user_id = ?').run(uid);
      let n = 0;
      for (const amt of t.donated) {
        const nm = `${t.name} supporter ${++n}`;
        const cid = mkConn.run(uid, orgId, nm).lastInsertRowid;
        const rid = insertReferral.run({
          user_id: uid, org_id: orgId, connection_id: cid, contact_name: nm, contact_email: null, company: null, linkedin_url: null, status: 'donated',
        }).lastInsertRowid;
        recordGift({ userId: uid, orgId, referralId: rid, connectionId: cid, amount: amt, date: `${today} 12:00:00`, source: 'demo' });
      }
      for (let i = 0; i < t.asked; i++) {
        const nm = `${t.name} prospect ${++n}`;
        const cid = mkConn.run(uid, orgId, nm).lastInsertRowid;
        insertReferral.run({
          user_id: uid, org_id: orgId, connection_id: cid, contact_name: nm, contact_email: null, company: null, linkedin_url: null, status: 'asked',
        });
      }
      uids.push(uid);
    });
  })();
  for (const uid of uids) recomputeImpact(uid);
}

function removeDemoTeammates(teamId) {
  if (!teamId) return;
  const ids = db
    .prepare('SELECT id FROM users WHERE linkedin_id LIKE ?')
    .all(`demo-teammate-${teamId}-%`)
    .map((r) => r.id);
  db.transaction(() => {
    for (const id of ids) {
      db.prepare('DELETE FROM team_members WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM code_x_impact WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM follow_up_reminders WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM donations WHERE user_id = ?').run(id); // before referrals (FK)
      db.prepare('DELETE FROM referrals WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM connections WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  })();
}

// Seed the sample Grants document library for an org, idempotently (skip any document
// whose name already exists, so re-running never duplicates and a user's own documents
// are never touched). insertDocStmt is defined later but resolved at call (request) time.
function seedDemoDocuments(userId, orgId) {
  const exists = db.prepare('SELECT 1 FROM documents WHERE org_id = ? AND name = ?');
  db.transaction(() => {
    for (const d of DEMO_DOCUMENTS) {
      if (exists.get(orgId, d.name)) continue;
      insertDocStmt.run({ org_id: orgId, user_id: userId, name: d.name, kind: d.kind, content: d.content, char_count: d.content.length });
    }
  })();
}

// Full reset to a clean sample account (Profile page "Load sample data").
app.post('/api/demo/seed', requireAuth, (req, res) => {
  const userId = req.user.id;
  const orgId = orgScope(req);
  updateUserProfile.run(
    DEMO_PROFILE.company,
    DEMO_PROFILE.pastCompanies,
    DEMO_PROFILE.location,
    DEMO_PROFILE.schools,
    10000,
    userId
  );
  wipeUserData(userId, orgId);
  // Clean any prior demo campaign family too (wipeUserData leaves campaigns alone, by
  // design — /api/demo/clear must not touch them — so reset them here for a clean demo).
  deleteAcctAgentActions.run(userId, orgId);
  deleteAcctAgentRuns.run(userId, orgId);
  deleteAcctNightlyRuns.run(userId, orgId);
  deleteAcctCampaigns.run(userId, orgId);
  const result = seedDemoProspects(userId, findUserById.get(userId), { tagged: false });
  // Seed one active campaign so the Campaign + Brief surfaces have real content.
  const deadline = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  insertCampaign.run({
    user_id: userId, org_id: orgId, name: 'Year-end push',
    goal_amount: 10000, deadline,
    constraints: "Don't ask family. Keep first asks under $250. Prefer email.",
  });
  // A starter Grants document library so reports + application answers have real material.
  seedDemoDocuments(userId, orgId);
  res.json({ ...result, documents: DEMO_DOCUMENTS.length });
});

// Layer sample data ON TOP of a user's account (used by the header toggle AND
// auto-applied on demo login so the public demo lands already populated).
function enableDemoSampleData(userId) {
  const real = findUserById.get(userId);
  // Score the demo prospects against a demo-flavored profile so school/coworker/
  // local signals show, but leave the user's actual profile untouched.
  const demoScout = {
    ...real,
    company: DEMO_PROFILE.company,
    past_companies: DEMO_PROFILE.pastCompanies,
    location: DEMO_PROFILE.location,
    schools: DEMO_PROFILE.schools,
  };
  const result = seedDemoProspects(userId, demoScout, { tagged: true });

  if (!real.goal_amount) db.prepare('UPDATE users SET goal_amount = 10000 WHERE id = ?').run(userId);

  let teamId = real.team_id;
  if (!teamId) {
    const info = insertTeam.run('Code for Ukraine (demo)', genInviteCode(), 50000, userId, real.org_id || DEFAULT_ORG_ID);
    teamId = info.lastInsertRowid;
    addMember.run(teamId, userId, 'owner');
    setUserTeam.run(teamId, userId);
  }
  seedDemoTeammates(teamId);

  db.prepare('UPDATE users SET demo_mode = 1 WHERE id = ?').run(userId);
  recomputeImpact(userId);
  return result;
}

// Additive demo mode (header toggle) — layers sample data ON TOP of current data,
// without touching the user's real profile, plus a populated team leaderboard.
app.post('/api/demo/enable', requireAuth, (req, res) => {
  res.json({ active: true, ...enableDemoSampleData(req.user.id) });
});

// Remove everything additive demo mode added.
app.post('/api/demo/disable', requireAuth, (req, res) => {
  const userId = req.user.id;
  const demoConnIds = db
    .prepare('SELECT id FROM connections WHERE user_id = ? AND is_demo = 1')
    .all(userId)
    .map((r) => r.id);
  db.transaction(() => {
    for (const id of demoConnIds) {
      // Drop reminders on these referrals before the referrals themselves.
      db.prepare(
        'DELETE FROM follow_up_reminders WHERE referral_id IN ' +
          '(SELECT id FROM referrals WHERE user_id = ? AND connection_id = ?)'
      ).run(userId, id);
      db.prepare(
        'DELETE FROM donations WHERE referral_id IN ' +
          '(SELECT id FROM referrals WHERE user_id = ? AND connection_id = ?)'
      ).run(userId, id); // before referrals (FK)
      db.prepare('DELETE FROM referrals WHERE user_id = ? AND connection_id = ?').run(userId, id);
    }
    db.prepare('DELETE FROM connections WHERE user_id = ? AND is_demo = 1').run(userId);
  })();
  removeDemoTeammates(req.user.team_id);
  db.prepare('UPDATE users SET demo_mode = 0 WHERE id = ?').run(userId);
  recomputeImpact(userId);
  res.json({ active: false });
});

app.post('/api/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// ── GitHub rate-limit visibility ────────────────────────────────
app.get('/api/github/rate-limit', requireAuth, async (req, res) => {
  try {
    const r = await github.get('/rate_limit');
    res.json({
      authenticated: HAS_GH_TOKEN,
      search: r.data.resources.search,
      core: r.data.resources.core,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch GitHub rate limit', authenticated: HAS_GH_TOKEN });
  }
});

// ── Connections: upload CSV-parsed contacts, enrich, score ──────
const countConnections = db.prepare(
  'SELECT COUNT(*) AS n FROM connections WHERE user_id = ? AND org_id = ?'
);
// Merge an incoming contact into an existing row (keeps github_* enrichment).
const updateConnectionMerge = db.prepare(`
  UPDATE connections SET
    contact_name = @contact_name, contact_email = @contact_email, company = @company,
    role = @role, location = @location, linkedin_url = @linkedin_url,
    donor_likelihood_score = @donor_likelihood_score, company_tier = @company_tier,
    capacity_score = @capacity_score, affinity_score = @affinity_score,
    propensity_score = @propensity_score, score_reasons = @score_reasons
  WHERE id = @id AND user_id = @user_id AND org_id = @org_id
`);
const insertConnection = db.prepare(`
  INSERT INTO connections
    (user_id, org_id, contact_name, contact_email, company, role, location, linkedin_url,
     github_username, donor_likelihood_score, github_followers, github_repos, github_confidence, github_bio,
     company_tier, capacity_score, affinity_score, propensity_score, score_reasons)
  VALUES (@user_id, @org_id, @contact_name, @contact_email, @company, @role, @location, @linkedin_url,
          @github_username, @donor_likelihood_score, @github_followers, @github_repos, @github_confidence, @github_bio,
          @company_tier, @capacity_score, @affinity_score, @propensity_score, @score_reasons)
`);
// Same insert, but flags the row as demo data so it can be cleanly removed later.
const insertDemoConnection = db.prepare(`
  INSERT INTO connections
    (user_id, org_id, contact_name, contact_email, company, role, location, linkedin_url,
     github_username, donor_likelihood_score, github_followers, github_repos, github_confidence, github_bio,
     company_tier, capacity_score, affinity_score, propensity_score, score_reasons, is_demo)
  VALUES (@user_id, @org_id, @contact_name, @contact_email, @company, @role, @location, @linkedin_url,
          @github_username, @donor_likelihood_score, @github_followers, @github_repos, @github_confidence, @github_bio,
          @company_tier, @capacity_score, @affinity_score, @propensity_score, @score_reasons, 1)
`);

// Re-score all of a scout's connections against their current profile (used when
// the scout updates their own company/city — no GitHub calls, just recompute).
// Org-scoped reads: a scout's connections are always (user_id, org_id) so a
// stale/forged session org_id can never surface another tenant's rows.
const connectionsForUser = db.prepare(
  'SELECT * FROM connections WHERE user_id = ? AND org_id = ?'
);
const updateConnectionScore = db.prepare(
  `UPDATE connections SET donor_likelihood_score = ?, score_reasons = ?, company_tier = ?,
     capacity_score = ?, affinity_score = ?, propensity_score = ?
   WHERE id = ? AND user_id = ? AND org_id = ?`
);
function rescoreUserConnections(scout) {
  const orgId = scout.org_id || DEFAULT_ORG_ID;
  const cfg = getOrgConfig(orgId);
  const conns = connectionsForUser.all(scout.id, orgId);
  const tx = db.transaction(() => {
    for (const c of conns) {
      const s = scoreProspect(c, scout, cfg);
      updateConnectionScore.run(
        s.score, JSON.stringify(s.reasons), s.companyTier, s.capacityScore,
        s.affinityScore, s.propensityScore, c.id, scout.id, orgId
      );
    }
  });
  tx();
  return conns.length;
}

// Strategy switch: the relationship / cause / capacity SIGNALS are unchanged — only
// the way they're combined into the final rank differs. So recombine the already-
// persisted component sub-scores (affinity_score / propensity_score / capacity_score)
// through the selected strategy instead of re-deriving every signal via
// scoreProspect(). Same output, materially less work. Full scoreProspect stays for
// profile edits / SCORING_VERSION backfills, where the underlying signals can change.
const updateConnectionRank = db.prepare(
  'UPDATE connections SET donor_likelihood_score = ? WHERE id = ? AND user_id = ? AND org_id = ?'
);
function recombineUserConnections(scout) {
  const orgId = scout.org_id || DEFAULT_ORG_ID;
  const cfg = getOrgConfig(orgId);
  const causeAffinity = cfg.affinity || CAUSE.affinity;
  const causeAlignment = cfg.causeAlignment || CAUSE.causeAlignment;
  const propensityMax = (causeAffinity.weight || 0) + (causeAlignment.weight || 0);
  const resolved = strategyForUser(scout);
  const conns = connectionsForUser.all(scout.id, orgId);
  const tx = db.transaction(() => {
    for (const c of conns) {
      const score = combineScore(
        {
          affinityScore: c.affinity_score || 0,
          propensityScore: c.propensity_score || 0,
          propensityMax,
          capacityScore: c.capacity_score || 0,
        },
        resolved
      );
      updateConnectionRank.run(score, c.id, scout.id, orgId);
    }
  });
  tx();
  return conns.length;
}

// One-time re-score when the scoring model changes, so existing lists re-rank
// without anyone having to re-save or re-import.
db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)');
// Bumped: connections now persist affinity_score/propensity_score component
// sub-scores. The existing backfill re-scores everyone so those columns populate
// (donor_likelihood_score / ranking is unchanged — relationship-first output is
// byte-for-byte the same as v4).
const SCORING_VERSION = 'v5-component-subscores';
const scoringVer = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('scoring_version');
if (scoringVer?.value !== SCORING_VERSION) {
  try {
    const userIds = db.prepare('SELECT DISTINCT user_id FROM connections').all();
    let total = 0;
    for (const { user_id } of userIds) {
      const scout = findUserById.get(user_id);
      if (scout) total += rescoreUserConnections(scout);
    }
    db.prepare(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('scoring_version', SCORING_VERSION);
    if (total) console.log(`Re-scored ${total} connections for scoring model ${SCORING_VERSION}.`);
  } catch (e) {
    console.error('Scoring backfill failed:', e.message);
  }
}

app.post('/api/connections/upload', requireAuth, async (req, res) => {
  const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty "contacts" array.' });
  }
  if (contacts.length > LIMITS.uploadContacts) {
    return res.status(413).json({ error: `Too many contacts (max ${LIMITS.uploadContacts.toLocaleString()} per upload).` });
  }

  const userId = req.user.id;
  const orgId = orgScope(req); // org_id from the session — never from the body
  const cfg = getOrgConfig(orgId); // per-org cause config drives the scoring

  // Incremental import: build lookup maps from existing connections so we can
  // MERGE duplicates instead of replacing the whole list.
  const existing = connectionsForUser.all(userId, orgId);
  const byUrl = new Map();
  const byEmail = new Map();
  const byNameCo = new Map();
  for (const e of existing) {
    if (e.linkedin_url) byUrl.set(normUrl(e.linkedin_url), e);
    if (e.contact_email) byEmail.set(e.contact_email.toLowerCase(), e);
    const k = dedupeNameKey(e.contact_name, e.company);
    if (k) byNameCo.set(k, e);
  }
  const findExisting = (c) => {
    if (c.linkedin_url) { const m = byUrl.get(normUrl(c.linkedin_url)); if (m) return m; }
    if (c.contact_email) { const m = byEmail.get(c.contact_email.toLowerCase()); if (m) return m; }
    const k = dedupeNameKey(c.contact_name, c.company);
    if (k) { const m = byNameCo.get(k); if (m) return m; }
    return null;
  };
  const keysOf = (c) => {
    const ks = [];
    if (c.linkedin_url) ks.push('u:' + normUrl(c.linkedin_url));
    if (c.contact_email) ks.push('e:' + c.contact_email.toLowerCase());
    const k = dedupeNameKey(c.contact_name, c.company);
    if (k) ks.push('n:' + k);
    return ks;
  };

  let enrichedCount = 0;
  let rateLimited = false;
  let enrichmentCapped = false;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const inserts = [];
  const updates = [];
  const seenKeys = new Set(); // within-batch dedupe
  const updatedIds = new Set();

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i] || {};
    const contact = {
      contact_name: (c.contact_name || c.name || '').trim(),
      contact_email: (c.contact_email || c.email || '').trim() || null,
      company: (c.company || '').trim() || null,
      role: (c.role || c.position || '').trim() || null,
      location: (c.location || '').trim() || null,
      linkedin_url: (c.linkedin_url || c.url || '').trim() || null,
    };
    if (!contact.contact_name && !contact.company) continue; // skip blank rows
    const ks = keysOf(contact);

    // 1) Matches an existing connection → merge in place (keep github enrichment).
    const match = findExisting(contact);
    if (match) {
      if (!updatedIds.has(match.id)) {
        const merged = {
          contact_name: contact.contact_name || match.contact_name,
          contact_email: contact.contact_email || match.contact_email,
          company: contact.company || match.company,
          role: contact.role || match.role,
          location: contact.location || match.location,
          linkedin_url: contact.linkedin_url || match.linkedin_url,
          github_username: match.github_username,
          github_followers: match.github_followers,
          github_repos: match.github_repos,
          github_confidence: match.github_confidence,
          github_bio: match.github_bio,
        };
        const s = scoreProspect(merged, req.user, cfg);
        updates.push({
          id: match.id,
          user_id: userId,
          org_id: orgId,
          ...merged,
          donor_likelihood_score: s.score,
          company_tier: s.companyTier,
          capacity_score: s.capacityScore,
          affinity_score: s.affinityScore,
          propensity_score: s.propensityScore,
          score_reasons: JSON.stringify(s.reasons),
        });
        updatedIds.add(match.id);
        updated++;
      }
      ks.forEach((k) => seenKeys.add(k));
      continue;
    }

    // 2) Duplicate within this same file → skip.
    if (ks.length && ks.some((k) => seenKeys.has(k))) {
      skipped++;
      continue;
    }

    // 3) New contact → enrich (capped) + score + insert.
    let github = null;
    if (contact.contact_name) {
      if (rateLimited) {
        /* skip enrichment after a rate-limit hit */
      } else if (enrichedCount >= MAX_ENRICH) {
        enrichmentCapped = true;
      } else {
        try {
          const result = await enrichContact(contact);
          if (result && result.github_username) {
            github = result;
            enrichedCount++;
          }
        } catch (err) {
          if (isRateLimited(err)) rateLimited = true;
        }
      }
    }

    const connLike = {
      ...contact,
      github_username: github?.github_username || null,
      github_followers: github?.github_followers || 0,
      github_repos: github?.github_repos || 0,
      github_confidence: github?.github_confidence || null,
      github_bio: github?.github_bio || null,
    };
    const s = scoreProspect(connLike, req.user, cfg);
    inserts.push({
      user_id: userId,
      org_id: orgId,
      ...connLike,
      donor_likelihood_score: s.score,
      company_tier: s.companyTier,
      capacity_score: s.capacityScore,
      affinity_score: s.affinityScore,
      propensity_score: s.propensityScore,
      score_reasons: JSON.stringify(s.reasons),
    });
    ks.forEach((k) => seenKeys.add(k));
    added++;
  }

  const applyAll = db.transaction(() => {
    for (const row of inserts) insertConnection.run(row); // each row carries org_id
    for (const u of updates) updateConnectionMerge.run(u); // scoped by (id,user,org)
  });
  applyAll();

  res.json({
    added,
    updated,
    skipped,
    totalConnections: countConnections.get(userId, orgId).n,
    enriched: enrichedCount,
    enrichmentCapped,
    rateLimited,
    githubAuthenticated: HAS_GH_TOKEN,
  });
});

// ── Relationship memory: ingest the LinkedIn full export (messages) ─────────
// The client parses messages.csv locally and posts compact per-contact history
// (last-contacted, exchange counts, a few short verbatim snippets) plus a
// writing-voice sample (the user's own sent messages). Stored locally, per user.
const deleteHistoryForUser = db.prepare(
  'DELETE FROM contact_history WHERE user_id = ? AND org_id = ?'
);
const deleteVoiceForUser = db.prepare(
  'DELETE FROM voice_profiles WHERE user_id = ? AND org_id = ?'
);
const insertHistory = db.prepare(`
  INSERT INTO contact_history
    (user_id, org_id, connection_id, match_name, last_interaction,
     message_count, sent_count, received_count, snippets, source)
  VALUES (@user_id, @org_id, @connection_id, @match_name, @last_interaction,
          @message_count, @sent_count, @received_count, @snippets, @source)
`);
const upsertVoice = db.prepare(`
  INSERT INTO voice_profiles (user_id, org_id, sample) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET sample = excluded.sample, updated_at = CURRENT_TIMESTAMP
`);
const historySummary = db.prepare(`
  SELECT COUNT(*) AS contacts, COALESCE(SUM(message_count), 0) AS messages,
         MAX(last_interaction) AS lastInteraction
    FROM contact_history WHERE user_id = ? AND org_id = ?
`);

app.post('/api/history/upload', requireAuth, (req, res) => {
  const items = Array.isArray(req.body?.history) ? req.body.history : null;
  const voiceSample =
    typeof req.body?.voiceSample === 'string' ? req.body.voiceSample.slice(0, LIMITS.voiceSampleChars) : '';
  if (!items) return res.status(400).json({ error: 'Provide a "history" array.' });
  if (items.length > LIMITS.historyRows) return res.status(413).json({ error: `Too many history rows (max ${LIMITS.historyRows.toLocaleString()}).` });

  const userId = req.user.id;
  const orgId = orgScope(req);

  // Match each counterparty to an existing connection by normalized name.
  const byName = new Map();
  for (const c of connectionsForUser.all(userId, orgId)) {
    const k = norm(c.contact_name);
    if (k) byName.set(k, c.id);
  }

  let matched = 0;
  const rows = [];
  for (const it of items) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const connId = byName.get(norm(name)) || null;
    if (connId) matched++;
    let snippets = [];
    if (Array.isArray(it.snippets)) {
      snippets = it.snippets
        .slice(0, 3)
        .map((s) => ({
          date: String(s?.date || '').slice(0, 40),
          direction: s?.direction === 'sent' ? 'sent' : 'received',
          text: String(s?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        }))
        .filter((s) => s.text);
    }
    rows.push({
      user_id: userId,
      org_id: orgId,
      connection_id: connId,
      match_name: name.slice(0, 200),
      last_interaction: String(it.last || '').slice(0, 40) || null,
      message_count: Math.min(1_000_000, Math.max(0, parseInt(it.count, 10) || 0)),
      sent_count: Math.min(1_000_000, Math.max(0, parseInt(it.sent, 10) || 0)),
      received_count: Math.min(1_000_000, Math.max(0, parseInt(it.received, 10) || 0)),
      snippets: JSON.stringify(snippets),
      source: 'messages',
    });
  }

  const tx = db.transaction(() => {
    deleteHistoryForUser.run(userId, orgId); // idempotent re-ingest
    for (const r of rows) insertHistory.run(r);
    if (voiceSample) upsertVoice.run(userId, orgId, voiceSample);
  });
  tx();

  res.json({ stored: rows.length, matchedToConnections: matched, voiceCaptured: !!voiceSample });
});

// Privacy: wipe all stored relationship memory for the user ("delete my data").
// Org-scoped: can only ever touch the caller's own rows in the caller's org.
app.delete('/api/history', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const tx = db.transaction(() => {
    deleteHistoryForUser.run(req.user.id, orgId);
    deleteVoiceForUser.run(req.user.id, orgId);
  });
  tx();
  res.json({ ok: true });
});

// ── Account data portability + erasure (GDPR baseline) ───────────────────────
// These two endpoints let an authenticated user export and permanently delete
// THEIR OWN data. Both are STRICTLY scoped to (req.user.id, orgScope(req)) — the
// same isolation convention every other org-owned query uses — so a caller can
// never reach another user's or another org's rows.

// Prepared statements for the per-user data tables, all (user_id, org_id)-scoped
// (identities + team_members are account-level, keyed by user_id alone — see the
// schema notes: identities carries no org_id; team_members joins teams, which are
// themselves org-scoped). Defined here so both export and delete reuse them.
const exportConnectionsStmt = db.prepare(
  'SELECT * FROM connections WHERE user_id = ? AND org_id = ? ORDER BY id'
);
const exportReferralsStmt = db.prepare(
  'SELECT * FROM referrals WHERE user_id = ? AND org_id = ? ORDER BY id'
);
const exportRemindersStmt = db.prepare(
  'SELECT * FROM follow_up_reminders WHERE user_id = ? AND org_id = ? ORDER BY id'
);
const exportImpactStmt = db.prepare(
  'SELECT * FROM code_x_impact WHERE user_id = ? AND org_id = ?'
);
const exportHistoryStmt = db.prepare(
  'SELECT * FROM contact_history WHERE user_id = ? AND org_id = ? ORDER BY id'
);
const exportVoiceLenStmt = db.prepare(
  'SELECT length(sample) AS len, updated_at FROM voice_profiles WHERE user_id = ? AND org_id = ?'
);
const exportIdentitiesStmt = db.prepare(
  // Provider + when linked only — provider_sub/email can be sign-in secrets, so we
  // surface only the method names (the caller knows their own email already).
  'SELECT provider, created_at FROM identities WHERE user_id = ? ORDER BY id'
);
const exportTeamMembershipsStmt = db.prepare(`
  SELECT t.id AS teamId, t.name AS teamName, tm.role, tm.joined_at AS joinedAt
    FROM team_members tm JOIN teams t ON t.id = tm.team_id
   WHERE tm.user_id = ? AND t.org_id = ?
   ORDER BY t.id
`);

// GET /api/account/export — the caller's own data as a downloadable JSON document.
// Org-scoped to the caller; never another user's/org's data. The raw voice sample
// is small (≤8000 chars), so we include it inline for genuine portability, but we
// also report its presence/size explicitly. Audited (no secrets in the audit row).
app.get('/api/account/export', requireAuth, (req, res) => {
  const userId = req.user.id;
  const orgId = orgScope(req);
  const u = req.user;

  // Recompute first so the exported impact aggregate matches the live figures.
  recomputeImpact(userId);

  const voice = exportVoiceLenStmt.get(userId, orgId);
  const voiceSampleRow =
    voice && voice.len
      ? db.prepare('SELECT sample FROM voice_profiles WHERE user_id = ? AND org_id = ?').get(userId, orgId)
      : null;

  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 'donor-scout/account-export/v1',
    profile: {
      id: u.id,
      name: u.name,
      email: u.email,
      company: u.company || null,
      pastCompanies: u.past_companies || null,
      location: u.location || null,
      schools: u.schools || null,
      goalAmount: u.goal_amount || 0,
      orgId,
      orgRole: u.org_role || 'member',
      createdAt: u.created_at || null,
    },
    connections: exportConnectionsStmt.all(userId, orgId), // includes dossier_json
    referrals: exportReferralsStmt.all(userId, orgId),
    followUpReminders: exportRemindersStmt.all(userId, orgId),
    impact: exportImpactStmt.get(userId, orgId) || null,
    contactHistory: exportHistoryStmt.all(userId, orgId),
    voiceProfile: {
      // Presence + size always; the sample itself is small enough to ship inline.
      exists: !!(voice && voice.len),
      chars: voice?.len || 0,
      updatedAt: voice?.updated_at || null,
      sample: voiceSampleRow?.sample || null,
    },
    identities: exportIdentitiesStmt.all(userId), // provider names + dates only
    teamMemberships: exportTeamMembershipsStmt.all(userId, orgId),
  };

  recordAudit({ orgId, actorUserId: userId, action: 'account.exported', target: String(userId) });

  // Download semantics: a filename + JSON body. The SPA fetches with credentials
  // and saves the blob, but Content-Disposition makes a direct hit download too.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="donor-scout-export-${userId}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Per-user erasure statements. team_members/identities are keyed by user_id alone
// (account-level); the rest are (user_id, org_id)-scoped to stay tenant-isolated.
const deleteAcctConnections = db.prepare('DELETE FROM connections WHERE user_id = ? AND org_id = ?');
const deleteAcctReminders = db.prepare('DELETE FROM follow_up_reminders WHERE user_id = ? AND org_id = ?');
const deleteAcctDonations = db.prepare('DELETE FROM donations WHERE user_id = ? AND org_id = ?');
const deleteAcctReferrals = db.prepare('DELETE FROM referrals WHERE user_id = ? AND org_id = ?');
const deleteAcctImpact = db.prepare('DELETE FROM code_x_impact WHERE user_id = ? AND org_id = ?');
const deleteAcctTeamMembers = db.prepare('DELETE FROM team_members WHERE user_id = ?');
const deleteAcctIdentities = db.prepare('DELETE FROM identities WHERE user_id = ?');
// Campaign family: agent_actions/agent_runs FK -> campaigns, campaigns FK -> users, so
// these MUST be cleared before deleteAcctUser or the FK (enforced) would reject it.
const deleteAcctAgentActions = db.prepare('DELETE FROM agent_actions WHERE user_id = ? AND org_id = ?');
const deleteAcctAgentRuns = db.prepare('DELETE FROM agent_runs WHERE user_id = ? AND org_id = ?');
const deleteAcctNightlyRuns = db.prepare('DELETE FROM nightly_runs WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ? AND org_id = ?)');
const deleteAcctCampaigns = db.prepare('DELETE FROM campaigns WHERE user_id = ? AND org_id = ?');
const deleteAcctUser = db.prepare('DELETE FROM users WHERE id = ?');

// DELETE /api/account — RIGHT TO ERASURE. Permanently (hard-)deletes the caller's
// own account and ALL their per-user data. Distinct from is_active deactivation
// (which preserves data + donor attribution) — this is genuine erasure.
//
// SAFEGUARD (mirrors the sole-owner-cannot-be-demoted/deactivated guards): a user
// who is the SOLE OWNER of an org that still has OTHER members is blocked (409) —
// they must transfer ownership first, or the org would be orphaned. A last-member
// owner (the only person left in the org) MAY delete; we then clean up the now-
// empty org's config + the org row itself so no dangling tenant remains.
//
// Requires an explicit confirmation field from the client. Audited BEFORE the row
// is gone (the audit row outlives the user). Transactional. Ends the session.
app.delete('/api/account', requireAuth, (req, res, next) => {
  // Explicit, unambiguous confirmation — protects against accidental destruction.
  if (req.body?.confirm !== true && req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required to delete your account.' });
  }

  const userId = req.user.id;
  const orgId = orgScope(req);
  const isOwner = req.user.org_role === 'owner';
  const owners = countOrgOwners.get(orgId).n;
  const members = countOrgMembers.get(orgId).n;

  // Sole owner of an org that still has OTHER (real) members → must transfer first.
  // countOrgMembers excludes synthetic demo teammates, so a solo owner with only
  // demo teammates is treated as the last member and allowed to delete.
  if (isOwner && owners <= 1 && members > 1) {
    return res.status(409).json({
      error: 'You are the only owner of an organization with other members. Transfer ownership before deleting your account.',
    });
  }

  // Whether this user is the last real member → the org becomes empty and is cleaned up.
  const orgBecomesEmpty = members <= 1;
  const org = orgBecomesEmpty ? findOrgById.get(orgId) : null;
  // Never delete the shared default org, even if it momentarily looks empty.
  const cleanupOrg = orgBecomesEmpty && org && org.id !== DEFAULT_ORG_ID;

  // Audit BEFORE deletion so the operator-visible trail records the erasure even
  // though the actor row is about to disappear (audit_log is append-only).
  recordAudit({ orgId, actorUserId: userId, action: 'account.deleted', target: String(userId) });

  const tx = db.transaction(() => {
    // Find this user's teams BEFORE removing memberships, so we can clean up any
    // teams that become empty (and any demo teammates seeded under them).
    const myTeamIds = userTeams.all(userId).map((t) => t.id);

    deleteAcctConnections.run(userId, orgId);
    deleteAcctReminders.run(userId, orgId);
    deleteAcctDonations.run(userId, orgId); // before referrals (FK)
    deleteAcctReferrals.run(userId, orgId);
    deleteAcctImpact.run(userId, orgId);
    // Campaign family before the user row (FK-safe): actions/runs -> campaigns -> user.
    deleteAcctAgentActions.run(userId, orgId);
    deleteAcctAgentRuns.run(userId, orgId);
    deleteAcctNightlyRuns.run(userId, orgId);
    deleteAcctCampaigns.run(userId, orgId);
    deleteHistoryForUser.run(userId, orgId);
    deleteVoiceForUser.run(userId, orgId);
    deleteAcctTeamMembers.run(userId);
    deleteAcctIdentities.run(userId);

    // Clean up teams the user owned/belonged to that are now empty of real members.
    for (const tid of myTeamIds) {
      const t = findTeam.get(tid);
      if (!t) continue;
      // Remove any synthetic demo teammates the user seeded under this team.
      removeDemoTeammates(tid);
      const left = db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?').get(tid).n;
      if (left === 0) db.prepare('DELETE FROM teams WHERE id = ?').run(tid);
    }

    deleteAcctUser.run(userId);

    // Last member out → tear down the empty (non-default) org + its config.
    if (cleanupOrg) {
      db.prepare('DELETE FROM documents WHERE org_id = ?').run(orgId);
      db.prepare('DELETE FROM org_match_companies WHERE org_id = ?').run(orgId);
      db.prepare('DELETE FROM org_config WHERE org_id = ?').run(orgId);
      db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
    }
  });
  tx();

  // End the session — the account no longer exists, so any lingering cookie must die.
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.json({ ok: true, deleted: true }));
  });
});

// Summary of stored relationship memory (drives the Profile UI).
app.get('/api/history/summary', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const s = historySummary.get(req.user.id, orgId);
  const v = db
    .prepare('SELECT length(sample) AS len FROM voice_profiles WHERE user_id = ? AND org_id = ?')
    .get(req.user.id, orgId);
  res.json({
    contacts: s?.contacts || 0,
    messages: s?.messages || 0,
    lastInteraction: s?.lastInteraction || null,
    voiceChars: v?.len || 0,
  });
});

// ── Prospects: ranked by donor score ────────────────────────────
const listProspects = db.prepare(`
  SELECT * FROM connections
   WHERE user_id = ? AND org_id = ? AND donor_likelihood_score >= ?
   ORDER BY donor_likelihood_score DESC, capacity_score DESC, github_followers DESC, contact_name ASC
`);

// Attach parsed reason tags (and any cached AI dossier) to a connection row.
function withReasons(c) {
  if (!c) return c;
  let reasons = [];
  try {
    reasons = c.score_reasons ? JSON.parse(c.score_reasons) : [];
  } catch {
    reasons = [];
  }
  let dossier = null;
  try {
    dossier = c.dossier_json ? JSON.parse(c.dossier_json) : null;
  } catch {
    dossier = null;
  }
  const { dossier_json, ...rest } = c;
  return { ...rest, score_reasons: reasons, dossier };
}

app.get('/api/prospects', requireAuth, (req, res) => {
  const minScore = Number(req.query.minScore) || 0;
  res.json({ prospects: listProspects.all(req.user.id, orgScope(req), minScore).map(withReasons) });
});

// ── Edit / delete a prospect, or fix its GitHub match ───────────
// Every direct-object statement is keyed by (id, user_id, org_id): a connection
// belonging to another org yields 0 rows → the route returns 404 (no existence leak).
const updateConnectionFields = db.prepare(`
  UPDATE connections SET
    contact_name = @contact_name, contact_email = @contact_email, company = @company,
    role = @role, location = @location, linkedin_url = @linkedin_url
  WHERE id = @id AND user_id = @user_id AND org_id = @org_id
`);
const updateConnectionGithub = db.prepare(`
  UPDATE connections SET
    github_username = @github_username, github_followers = @github_followers,
    github_repos = @github_repos, github_confidence = @github_confidence, github_bio = @github_bio
  WHERE id = @id AND user_id = @user_id AND org_id = @org_id
`);
const deleteConnectionById = db.prepare(
  'DELETE FROM connections WHERE id = ? AND user_id = ? AND org_id = ?'
);

function rescoreConnection(id, scout) {
  const orgId = scout.org_id || DEFAULT_ORG_ID;
  const row = getConnection.get(id, scout.id, orgId);
  if (!row) return null;
  const s = scoreProspect(row, scout, getOrgConfig(orgId));
  updateConnectionScore.run(
    s.score, JSON.stringify(s.reasons), s.companyTier, s.capacityScore,
    s.affinityScore, s.propensityScore, id, scout.id, orgId
  );
  return getConnection.get(id, scout.id, orgId);
}

app.patch('/api/connections/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const conn = getConnection.get(id, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });
  const b = req.body || {};
  const pick = (key) => (b[key] !== undefined ? String(b[key]).trim() || null : conn[key]);
  updateConnectionFields.run({
    id,
    user_id: req.user.id,
    org_id: orgId,
    contact_name: pick('contact_name'),
    contact_email: pick('contact_email'),
    company: pick('company'),
    role: pick('role'),
    location: pick('location'),
    linkedin_url: pick('linkedin_url'),
  });
  res.json({ connection: withReasons(rescoreConnection(id, req.user)) });
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
  const info = deleteConnectionById.run(Number(req.params.id), req.user.id, orgScope(req));
  if (!info.changes) return res.status(404).json({ error: 'Prospect not found.' });
  res.json({ ok: true });
});

// Fix the GitHub match: relink to a username, confirm the current guess, or clear it.
app.patch('/api/connections/:id/github', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const conn = getConnection.get(id, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });
  const b = req.body || {};

  if (b.clear) {
    updateConnectionGithub.run({
      id, user_id: req.user.id, org_id: orgId,
      github_username: null, github_followers: 0, github_repos: 0, github_confidence: null, github_bio: null,
    });
  } else if (b.confirm) {
    if (!conn.github_username) return res.status(400).json({ error: 'No match to confirm.' });
    updateConnectionGithub.run({
      id, user_id: req.user.id, org_id: orgId,
      github_username: conn.github_username, github_followers: conn.github_followers,
      github_repos: conn.github_repos, github_confidence: 'confirmed', github_bio: conn.github_bio,
    });
  } else if (b.username) {
    const login = String(b.username).replace(/^@/, '').trim();
    if (!login) return res.status(400).json({ error: 'Provide a GitHub username.' });
    try {
      const detail = await github.get(`/users/${encodeURIComponent(login)}`);
      updateConnectionGithub.run({
        id, user_id: req.user.id, org_id: orgId,
        github_username: detail.data.login, github_followers: detail.data.followers || 0,
        github_repos: detail.data.public_repos || 0, github_confidence: 'confirmed', github_bio: detail.data.bio || null,
      });
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) return res.status(404).json({ error: `GitHub user "${login}" not found.` });
      if (isRateLimited(e)) return res.status(429).json({ error: 'GitHub rate limit reached. Try again shortly.' });
      return res.status(502).json({ error: 'Could not reach GitHub.' });
    }
  } else {
    return res.status(400).json({ error: 'Provide username, confirm, or clear.' });
  }

  res.json({ connection: withReasons(rescoreConnection(id, req.user)) });
});

// ── AI donor dossier ────────────────────────────────────────────
// Synthesizes a prospect's KNOWN facts (LinkedIn profile, GitHub match, your
// shared message history, the relationship signals that drove their score) into
// a short, relationship-led brief: who they are, why they might give to *this*
// cause, a modest suggested ask sized to the cause's impact units, and a couple
// of genuine conversation openers. Grounded only in the facts we pass — the
// model is told never to invent employer/wealth/personal details. The dossier is
// cached on the row; degrades to a clear 503 when no ANTHROPIC_API_KEY is set.
const historyForConnection = db.prepare(
  'SELECT * FROM contact_history WHERE user_id = ? AND org_id = ? AND connection_id = ?'
);
const saveDossier = db.prepare(
  'UPDATE connections SET dossier_json = ?, dossier_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND org_id = ?'
);

// Structured-output schema. Note the API's json_schema limits: every object
// needs additionalProperties:false + required, and string length / numeric
// bounds are not supported — we keep guidance in the prompt instead.
const DOSSIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    whyTheyMightGive: { type: 'string' },
    suggestedAsk: { type: 'string' },
    conversationHooks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['summary', 'whyTheyMightGive', 'suggestedAsk', 'conversationHooks', 'confidence'],
};

function safeParse(json, fallback) {
  try {
    return json ? JSON.parse(json) : fallback;
  } catch {
    return fallback;
  }
}

// Cause-aware system prompt: states the impact economics so the ask is sized to
// real units, and the relationship-led / no-fabrication principles.
function dossierSystem(cfg) {
  const im = cfg.impact || {};
  const unit = im.programCost
    ? `About $${im.programCost} funds one ${im.beneficiary || 'beneficiary'} through the full ${im.programLabel || 'program'}` +
      (im.dayCost ? `, and about $${im.dayCost} funds one ${im.dayLabel || 'day'}.` : '.')
    : '';
  return [
    `You write a brief, practical fundraising dossier that helps a volunteer decide how to approach someone in their own network about donating to ${cfg.orgName}.`,
    unit && `Impact economics: ${unit} Size the suggested ask to these units, and keep it modest and appropriate to how well the volunteer actually knows the person.`,
    `Principles: This is relationship-led fundraising — the people most likely to say yes are the ones the volunteer genuinely knows, not the wealthiest-looking. Use ONLY the facts provided. Never fabricate an employer, income, net worth, or personal detail. Be warm, specific, and honest. If the signal is thin, say so plainly and set confidence to "low".`,
    `Fields: summary = 1–2 sentences on who they are and the relationship; whyTheyMightGive = tie the cause to any genuine affinity in the facts; suggestedAsk = a modest dollar range mapped to an impact unit; conversationHooks = 2–3 genuine, non-salesy openers grounded in the facts; confidence = low | medium | high based on how much real signal exists.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Assemble only the facts we actually hold, so the model has nothing to invent.
function dossierFacts(conn, scout, history) {
  const reasons = safeParse(conn.score_reasons, []).map((r) => r.label || r);
  return {
    contact: {
      name: conn.contact_name || null,
      company: conn.company || null,
      role: conn.role || null,
      location: conn.location || null,
      github: conn.github_username
        ? {
            username: conn.github_username,
            followers: conn.github_followers,
            publicRepos: conn.github_repos,
            bio: conn.github_bio || null,
            matchConfidence: conn.github_confidence || null,
          }
        : null,
      relationshipSignals: reasons,
    },
    you: {
      name: scout.name || null,
      company: scout.company || null,
      pastCompanies: scout.past_companies || null,
      location: scout.location || null,
      schools: scout.schools || null,
    },
    sharedHistory: history.map((h) => ({
      totalMessages: h.message_count,
      youSent: h.sent_count,
      theyReplied: h.received_count,
      lastInteraction: h.last_interaction || null,
      snippets: safeParse(h.snippets, []),
    })),
  };
}

app.post('/api/connections/:id/dossier', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const conn = getConnection.get(id, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });

  // Return the cached dossier unless the caller explicitly asks to regenerate.
  if (conn.dossier_json && !req.body?.refresh) {
    const cached = safeParse(conn.dossier_json, null);
    if (cached) return res.json({ dossier: cached, cached: true });
  }
  if (!aiEnabled()) {
    return res
      .status(503)
      .json({ error: 'AI dossiers are off. Add an ANTHROPIC_API_KEY to your .env to enable them.' });
  }

  const cfg = getOrgConfig(orgId);
  const history = historyForConnection.all(req.user.id, orgId, id);
  const facts = dossierFacts(conn, req.user, history);

  try {
    const dossier = await generateJSON({
      orgId, // per-tenant AI budget (orgScope(req) above)
      model: MODELS.strategy, // judgement-heavy → the strategy-tier model
      system: dossierSystem(cfg),
      prompt:
        'Here are the known facts (JSON). Use ONLY these; do not invent details. ' +
        'Where a section is weakly supported, keep it short and lower the confidence.\n\n' +
        JSON.stringify(facts, null, 2),
      schema: DOSSIER_SCHEMA,
      maxTokens: 1200,
      thinking: true,
    });
    saveDossier.run(JSON.stringify(dossier), id, req.user.id, orgId);
    res.json({ dossier, cached: false });
  } catch (e) {
    if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message });
    if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message });
    console.error('Dossier generation failed:', e.message);
    res.status(502).json({ error: 'Could not generate the dossier. Please try again shortly.' });
  }
});

// ── AI in-voice outreach draft ──────────────────────────────────
// Generates a short, warm, ready-to-send outreach message in the SCOUT'S OWN
// voice, grounded ONLY in the facts we already hold for this prospect — the
// connection row, the relationship signals, the shared contact_history, the
// cached dossier (when present), the cause's impact economics, and the scout's
// own past messages (voice_profiles.sample). The result drops into the existing
// editable textarea in the "Reach out" modal; the human always reviews/edits
// before sending. Transient (NOT cached — no new columns). Degrades to a clear
// 503 when no ANTHROPIC_API_KEY is set, and the modal keeps its static template.
//
// Patterns: this REUSES the Dossier's fact assembly (dossierFacts) as the single
// source of truth for "what we know" — draftFacts is a thin Template-Method-style
// wrapper that adds the voice sample + cached dossier AROUND it rather than
// re-gathering facts. The voiced/neutral register is a lightweight prompt-level
// Strategy (one boolean, not a class hierarchy), and absent voice/dossier resolve
// to null Null Objects the prompt treats as "no extra signal".
const voiceSampleForUser = db.prepare('SELECT sample FROM voice_profiles WHERE user_id = ? AND org_id = ?');

// Cause-aware system prompt for the draft — built analogously to dossierSystem,
// stating the impact economics so the ask is sized to real units, and enforcing
// the no-fabrication / relationship-over-wealth / in-voice / human-edited rules.
// `voiced` selects the in-voice vs. warm-neutral register (the Strategy branch).
function draftSystem(cfg, voiced) {
  const im = cfg.impact || {};
  const unit = im.programCost
    ? `About $${im.programCost} funds one ${im.beneficiary || 'beneficiary'} through the full ${im.programLabel || 'program'}` +
      (im.dayCost ? `, and about $${im.dayCost} funds one ${im.dayLabel || 'day'}.` : '.')
    : '';
  return [
    `You write a short, warm, ready-to-send outreach message for a volunteer asking someone in their own network to donate to ${cfg.orgName}.`,
    voiced
      ? `Voice: a sample of the volunteer's OWN past messages is provided as "voiceSample". Match its tone, length, warmth, greeting/sign-off style, and punctuation so the note sounds genuinely like them — do not imitate facts from the sample, only the style.`
      : `Voice: no writing sample is available, so write in a warm, plain, friendly register — like a real personal note, not marketing copy.`,
    unit && `Impact economics: ${unit} If you name a number, size the ask to these units, keep it modest, and match it to how well the volunteer actually knows the person — closeness, not capacity, drives the warmth.`,
    `Principles: This is relationship-led fundraising. Use ONLY the facts provided. NEVER invent or imply an employer, income, net worth, or any personal detail not in the facts. If the relationship signal is thin, keep the note short and generic rather than manufacturing intimacy or false urgency. No guilt-tripping, no implied surveillance of the person's wealth or job. Be specific only where a real fact supports it.`,
    `Format: address the prospect by their FIRST name, write a few short paragraphs, and sign off with the volunteer's FIRST name. Write plainly and directly, with short sentences and everyday words. Do NOT use em dashes or en dashes. Avoid filler like "genuinely" or "truly". Output only the message text, ready to paste and send. No preamble, no subject line, no quotes.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Assemble the grounded, voiced context for one draft. REUSES dossierFacts() (the
// connection row, relationship signals, scout profile, and shared history) and
// wraps it with the scout's voice sample + the cached dossier — no duplicate
// fact-gathering, no fields the app doesn't hold. Pure function → unit-testable
// without an API key. Absent voice/dossier resolve to null (Null Object).
function draftContext(conn, scout, history, voiceSample, cachedDossier) {
  return {
    facts: dossierFacts(conn, scout, history),
    voiceSample: voiceSample || null,
    dossier: cachedDossier || null, // whyTheyMightGive / suggestedAsk / conversationHooks
  };
}

app.post('/api/connections/:id/draft', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const conn = getConnection.get(id, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });

  if (!aiEnabled()) {
    return res.status(503).json({
      error: 'AI drafting is off. Add an ANTHROPIC_API_KEY to your .env to enable it.',
    });
  }

  const cfg = getOrgConfig(orgId);
  const history = historyForConnection.all(req.user.id, orgId, id);
  const voiceSample = voiceSampleForUser.get(req.user.id, orgId)?.sample || null;
  const cachedDossier = safeParse(conn.dossier_json, null);
  const voiced = !!voiceSample;
  const context = draftContext(conn, req.user, history, voiceSample, cachedDossier);

  try {
    const draft = await generateText({
      orgId, // per-tenant AI budget (orgScope(req) above)
      model: MODELS.draft, // high-volume drafting → the cheap draft-tier model (Haiku)
      system: draftSystem(cfg, voiced),
      prompt:
        'Write the outreach message using ONLY these facts (JSON). Do not invent any detail ' +
        'not present here. If a section is empty or thin, keep the note short and generic.\n\n' +
        JSON.stringify(context, null, 2),
      maxTokens: 600,
      cacheSystem: true,
      thinking: false, // REQUIRED — MODELS.draft (Haiku) is not ADAPTIVE_OK
    });
    res.json({ draft, voiced, source: 'ai' });
  } catch (e) {
    if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message });
    if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message });
    console.error('Draft generation failed:', e.message);
    res.status(502).json({ error: 'Could not generate a draft. Please try again shortly.' });
  }
});

// Exported for offline unit tests (pure context assembly + system prompt).
export const __draftInternals = { draftContext, draftSystem, dossierFacts };

// ── Thank-you / receipt stewardship ─────────────────────────────
// Closing the donor loop after a gift lands. THREE pieces, all org-scoped:
//   1. An AI thank-you draft (POST /api/referrals/:id/thank-you) that REUSES the
//      in-voice draft grounding — dossierFacts() for shared history/signals +
//      the scout's voice_profiles sample — and ties the gift to the CONCRETE
//      impact it funds via the per-org economics. Editable, human-reviewed,
//      degrades to a static template (the same shape as buildThankYouMessage)
//      with a clear 503 when no ANTHROPIC_API_KEY.
//   2. A receipt (GET /api/referrals/:id/receipt): a plain acknowledgement
//      record — donor, amount, date, org, the impact funded. NOT a tax receipt;
//      Zeffy is the processor of record and issues those.
//   3. A "donors awaiting thanks" list (GET /api/referrals/awaiting-thanks):
//      donated && not yet thanked, prompting the scout, plus a mark-thanked
//      action (POST /api/referrals/:id/thanked).
// thanked_at is the single source of truth for "already thanked".

// Phrase the CONCRETE impact a real donation amount funds, using the per-org
// impact economics (getOrgConfig). Pure + shared by the thank-you grounding and
// the receipt so both speak the same units. Returns null when nothing's known
// so the prompt/receipt simply omits impact rather than inventing it.
function impactForAmount(amount, cfg) {
  const amt = Number(amount) || 0;
  const im = cfg?.impact || {};
  if (amt <= 0 || !im.programCost) return null;
  const beneficiaries = Math.floor(amt / im.programCost);
  const days = im.dayCost ? Math.floor(amt / im.dayCost) : 0;
  let summary;
  if (beneficiaries >= 1) {
    const noun = beneficiaries === 1 ? im.beneficiary || 'beneficiary' : im.beneficiaries || `${im.beneficiary || 'beneficiary'}s`;
    summary = `funds ${beneficiaries} ${noun} through the full ${im.programLabel || 'program'}`;
  } else if (days >= 1) {
    summary = `covers about ${days} ${days === 1 ? im.dayLabel || 'day' : (im.dayLabel || 'day') + 's'}`;
  } else {
    summary = `goes directly to ${cfg.orgName || 'the cause'}`;
  }
  return { amount: amt, beneficiaries, days, programCost: im.programCost, dayCost: im.dayCost || null, summary };
}

// Cause-aware system prompt for the thank-you — mirrors draftSystem's structure
// (same voiced/neutral Strategy branch, same no-fabrication rules) but its job is
// gratitude after a gift, not an ask. States the concrete impact the gift funds.
function thankYouSystem(cfg, voiced) {
  return [
    `You write a short, warm, sincere THANK-YOU note from a volunteer to someone in their network who has just DONATED to ${cfg.orgName}. The gift has already been made — this is gratitude and stewardship, never another ask.`,
    voiced
      ? `Voice: a sample of the volunteer's OWN past messages is provided as "voiceSample". Match its tone, length, warmth, greeting/sign-off style, and punctuation so the note sounds genuinely like them — imitate only the style, not any facts from the sample.`
      : `Voice: no writing sample is available, so write in a warm, plain, personal register — like a real thank-you note, not marketing copy.`,
    `Impact: an "impact" object describes the CONCRETE thing this specific gift funds. Mention it warmly and specifically to close the loop, but state ONLY what is in that object — do not inflate or invent numbers.`,
    `Principles: Use ONLY the facts provided. NEVER invent or imply an employer, income, net worth, the donor's motivation, or any detail not in the facts. No guilt-tripping, no second ask, no implied surveillance. Be specific only where a real fact supports it; if the shared history is thin, keep it short and heartfelt.`,
    `Format: address the donor by their FIRST name, write a couple of short paragraphs, and sign off with the volunteer's FIRST name. Write plainly and directly, with short sentences and everyday words. Do NOT use em dashes or en dashes. Avoid filler like "genuinely" or "truly". Output only the message text, ready to paste and send. No preamble, no subject line, no quotes.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Assemble the grounded thank-you context. REUSES dossierFacts() (shared history,
// relationship signals, scout profile) exactly like draftContext, and adds the
// real donation + its concrete impact. Pure → unit-testable offline. Holds NO
// field the app doesn't actually have; absent voice/impact resolve to null.
function thankYouContext(referral, conn, scout, history, voiceSample, cfg) {
  return {
    facts: dossierFacts(conn, scout, history),
    donation: {
      amount: Number(referral.donation_amount) || 0,
      date: referral.donation_date || null,
      org: cfg.orgName || null,
    },
    impact: impactForAmount(referral.donation_amount, cfg),
    voiceSample: voiceSample || null,
  };
}

// Build the acknowledgement (receipt) record for a donated referral. Pure: shapes
// the donor/amount/date/org/impact into a structured record the scout can view or
// copy. Explicitly an ACKNOWLEDGEMENT — Zeffy issues the official tax receipt.
function buildReceipt(referral, cfg) {
  const impact = impactForAmount(referral.donation_amount, cfg);
  return {
    kind: 'acknowledgement',
    disclaimer:
      'This is a personal acknowledgement of the gift, not an official tax receipt. ' +
      `Donations are processed by Zeffy, which issues the official tax receipt of record for ${cfg.orgName || 'the organization'}.`,
    donor: referral.contact_name || null,
    amount: Number(referral.donation_amount) || 0,
    date: referral.donation_date || null,
    org: cfg.orgName || null,
    impact: impact ? impact.summary : null,
    impactDetail: impact,
  };
}

// Static fallback thank-you — used when AI is off / errors, mirroring the client's
// buildThankYouMessage so the scout always has an editable starting point.
function staticThankYou(referral, scout, cfg) {
  const first = (referral.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const me = (scout?.name || '').trim().split(/\s+/)[0] || '';
  const impact = impactForAmount(referral.donation_amount, cfg);
  const impactLine = impact ? ` Your gift ${impact.summary}.` : '';
  return (
    `Hi ${first},\n\n` +
    `Thank you for your donation to ${cfg.orgName || 'the cause'}.${impactLine} I appreciate your support.\n\n` +
    `I'll share updates on the impact. Thank you again.` +
    (me ? `\n\n${me}` : '')
  );
}

// Static fallback second-gift re-ask — used when AI is off / errors. Grounded ONLY in
// the donor's real prior gift (amount + its impact) and the canonical donation link, so
// the scout always has an editable, link-safe starting point even without a key.
function staticSecondAsk(referral, scout, cfg, donateUrl) {
  const first = (referral.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const me = (scout?.name || '').trim().split(/\s+/)[0] || '';
  const amt = Number(referral.donation_amount) || 0;
  const impact = impactForAmount(amt, cfg);
  const impactLine = impact ? ` Your last gift ${impact.summary}.` : '';
  const link = donateUrl ? `\n\n${donateUrl}` : '';
  return (
    `Hi ${first},\n\n` +
    `Thank you again for supporting ${cfg.orgName || 'the cause'}${amt > 0 ? ` with your $${amt} gift` : ''}.` +
    `${impactLine} The work is still going, and I wanted to ask if you'd consider giving again. ` +
    `Anything you can do would mean a lot.` +
    link +
    (me ? `\n\n${me}` : '')
  );
}

// Donated-but-not-yet-thanked referrals for the calling scout (org-scoped). Drives
// the "donors awaiting thanks" surface; thanked_at IS NULL is the gate.
const listAwaitingThanks = db.prepare(
  `SELECT * FROM referrals
     WHERE user_id = ? AND org_id = ?
       AND donation_received = 1
       AND thanked_at IS NULL
   ORDER BY donation_date DESC, referred_at DESC`
);
const markReferralThanked = db.prepare(
  `UPDATE referrals SET thanked_at = COALESCE(thanked_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND user_id = ? AND org_id = ?`
);

// ── Retention: second-gift detector (Stewardship-on-rails Tier-0) ────────────
// The cheapest, most compounding fundraising lever is the SECOND gift, yet a donated +
// thanked donor falls out of every working surface. This deterministic detector (zero
// AI) resurfaces a donor who gave ONCE, was thanked, and whose single gift is now
// 30-90 days old — the window to re-ask. The window self-bounds: a stale import (all
// gifts >90 days old) yields an empty lane, never a flood. Tunable constants:
const SECOND_GIFT = { minDays: 30, maxDays: 90, cap: 10, reaskCooldownDays: 21 };
// Org-scoped (user_id, org_id) like every owned read. "Exactly one gift" via the ledger
// COUNT, "no open ask" via NOT EXISTS an open reminder, "already thanked" via thanked_at.
const listSecondGiftCandidates = db.prepare(`
  SELECT r.* FROM referrals r
   WHERE r.user_id = ? AND r.org_id = ?
     AND r.donation_received = 1
     AND r.status = 'donated'          -- a settled donor; a manual stage change opts them out
     AND r.thanked_at IS NOT NULL
     AND r.second_ask_at IS NULL       -- not already re-asked / dismissed for this gift
     AND (SELECT COUNT(*) FROM donations d WHERE d.referral_id = r.id) = 1
     AND date(r.donation_date) <= date('now', ?)
     AND date(r.donation_date) >= date('now', ?)
     AND NOT EXISTS (
       SELECT 1 FROM follow_up_reminders fr WHERE fr.referral_id = r.id AND fr.done_at IS NULL
     )
   ORDER BY r.donation_date ASC
`);
// Stamp that a second-gift re-ask was sent or dismissed (durable lane removal; keeps the
// first stamp). Org-scoped so a cross-tenant id can never mutate another org's referral.
const markSecondAsk = db.prepare(
  `UPDATE referrals SET second_ask_at = COALESCE(second_ask_at, ?)
     WHERE id = ? AND user_id = ? AND org_id = ?`
);

// Assemble the second-gift lane: run the detector, then collapse to donor IDENTITY
// (canonical email, else normalized name). The ledger's dedupe_key is per-REFERRAL, so a
// donor split across two referral rows could surface twice or read as "one gift" twice —
// drop anyone whose identity appears on more than one gifted referral (they are not a
// clean one-gift donor), and never surface the same identity twice. (Two distinct,
// email-less donors who share a name collapse to one key and are conservatively
// suppressed — a rare, safe false-negative.) `allReferrals` is the already-loaded full
// list, so this adds no extra DB scan.
function secondGiftLane(userId, orgId, allReferrals) {
  const identity = (r) => canonicalizeEmail(r.contact_email) || norm(r.contact_name || '');
  const giftedCount = new Map();
  for (const r of allReferrals) {
    if (!r.donation_received) continue;
    const k = identity(r);
    if (k) giftedCount.set(k, (giftedCount.get(k) || 0) + 1);
  }
  const rows = listSecondGiftCandidates.all(
    userId, orgId, `-${SECOND_GIFT.minDays} days`, `-${SECOND_GIFT.maxDays} days`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = identity(r);
    if (k && (giftedCount.get(k) || 0) > 1) continue; // same donor on another gifted referral
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    const ts = Date.parse(`${String(r.donation_date || '').slice(0, 10)}T00:00:00`);
    const daysAgo = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 86400000)) : null;
    out.push({
      id: r.id,
      contact_name: r.contact_name,
      company: r.company,
      donation_amount: r.donation_amount,
      donation_date: r.donation_date,
      daysAgo,
    });
    if (out.length >= SECOND_GIFT.cap) break;
  }
  return out;
}

// GET the scout's donated donors who still need a thank-you (org-scoped).
app.get('/api/referrals/awaiting-thanks', requireAuth, (req, res) => {
  res.json({ referrals: listAwaitingThanks.all(req.user.id, orgScope(req)) });
});

// AI thank-you draft. Reuses the in-voice draft grounding; 503 + static fallback
// when AI is off; cross-org id → 404 before the AI guard (no existence leak).
app.post('/api/referrals/:id/thank-you', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  if (!referral.donation_received) {
    return res.status(400).json({ error: 'No donation recorded for this referral yet.' });
  }

  const cfg = getOrgConfig(orgId);
  const fallback = staticThankYou(referral, req.user, cfg);

  if (!aiEnabled()) {
    // Graceful 503: the message tells the user how to enable it, and we still hand
    // back the editable static template so the loop can be closed without AI.
    return res.status(503).json({
      error: 'AI thank-you drafting is off. Add an ANTHROPIC_API_KEY to your .env to enable it.',
      fallback,
    });
  }

  // Ground on the same facts the outreach draft uses, when the connection still exists.
  const conn = referral.connection_id ? getConnection.get(referral.connection_id, req.user.id, orgId) : null;
  const history = conn ? historyForConnection.all(req.user.id, orgId, referral.connection_id) : [];
  const voiceSample = voiceSampleForUser.get(req.user.id, orgId)?.sample || null;
  const voiced = !!voiceSample;
  const context = thankYouContext(
    referral,
    conn || { contact_name: referral.contact_name, company: referral.company },
    req.user,
    history,
    voiceSample,
    cfg
  );

  try {
    const draft = await generateText({
      orgId, // per-tenant AI budget (orgScope(req) above)
      model: MODELS.draft, // high-volume drafting → the cheap draft-tier model (Haiku)
      system: thankYouSystem(cfg, voiced),
      prompt:
        'Write the thank-you note using ONLY these facts (JSON). Do not invent any detail ' +
        'not present here, and do not make another ask. If the shared history is thin, keep it short and heartfelt.\n\n' +
        JSON.stringify(context, null, 2),
      maxTokens: 600,
      cacheSystem: true,
      thinking: false, // REQUIRED — MODELS.draft (Haiku) is not ADAPTIVE_OK
    });
    res.json({ draft, voiced, source: 'ai' });
  } catch (e) {
    if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message, fallback });
    if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message, fallback });
    console.error('Thank-you generation failed:', e.message);
    res.status(502).json({ error: 'Could not generate a thank-you. Using the standard template.', fallback });
  }
});

// View/copy the acknowledgement receipt for a donated referral (org-scoped).
app.get('/api/referrals/:id/receipt', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  if (!referral.donation_received) {
    return res.status(400).json({ error: 'No donation recorded for this referral yet.' });
  }
  res.json({ receipt: buildReceipt(referral, getOrgConfig(orgId)) });
});

// Mark a donated referral as thanked (idempotent — keeps the first timestamp).
app.post('/api/referrals/:id/thanked', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  markReferralThanked.run(id, req.user.id, orgId);
  res.json({ referral: getReferral.get(id, req.user.id, orgId) });
});

// AI second-gift re-ask draft for a previously-thanked donor. LAZY (one Haiku call on
// human open — never a fan-out), NO-SEND (returned for the human to copy/send by hand),
// 503 + editable static fallback when AI is off. Cross-org id → 404 before the AI guard.
app.post('/api/referrals/:id/reconnect-draft', requireAuth, aiLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  if (!referral.donation_received) {
    return res.status(400).json({ error: 'No donation recorded for this referral yet.' });
  }
  const cfg = getOrgConfig(orgId);
  const donateUrl = donateUrlForOrg(orgId); // server-sourced; never from the client
  // Run the static fallback through the same link guard as the AI path (belt-and-
  // suspenders: it only ever carries the canonical donateUrl, so nothing is stripped).
  const fallback = enforceDonationLink(staticSecondAsk(referral, req.user, cfg, donateUrl), donateUrl);

  if (!aiEnabled()) {
    return res.status(503).json({
      error: 'AI drafting is off. Add an ANTHROPIC_API_KEY to your .env to enable it.',
      fallback,
    });
  }

  // Ground on the same facts the outreach draft uses, when the connection still exists.
  const conn = referral.connection_id ? getConnection.get(referral.connection_id, req.user.id, orgId) : null;
  const voiceSample = voiceSampleForUser.get(req.user.id, orgId)?.sample || '';
  try {
    const draft = await generateDraft({
      prospect: conn ? withReasonStrings(conn) : { contact_name: referral.contact_name, company: referral.company },
      history: conn ? loadHistory(req.user.id, orgId, referral.connection_id) : null,
      voiceSample,
      cause: cfg,
      kind: 'second_ask',
      amount: Number(referral.donation_amount) || 0, // the real prior gift — grounds the re-ask
      donateUrl,
      scoutFirstName: (req.user.name || '').trim().split(/\s+/)[0] || '',
      orgId,
    });
    res.json({ draft, voiced: !!voiceSample, source: 'ai' });
  } catch (e) {
    if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message, fallback });
    if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message, fallback });
    console.error('Second-ask generation failed:', e.message);
    res.status(502).json({ error: 'Could not generate a draft. Using the standard template.', fallback });
  }
});

// Record that the human sent a second-gift re-ask (or snooze it). NO send, NO gift: it
// only schedules a follow-up reminder, which both removes the donor from the second-gift
// lane (the detector excludes referrals with an open reminder) and re-enters them into
// the normal reminders cadence to watch for a response. Reuses seedCadence (idempotent —
// it only seeds when no reminder is open, always true for a second-gift candidate).
app.post('/api/referrals/:id/reconnect', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  const snooze = !!req.body?.snooze;
  // Durably remove the donor from the second-gift lane (one prompt per gift). "Mark
  // re-asked" also re-enters them into the reminders cadence so the human follows up on
  // the response; "Skip" just dismisses with no reminder. The durable stamp (not a
  // transient open reminder) is what keeps them out after the cadence later completes.
  markSecondAsk.run(nowStamp(), id, req.user.id, orgId);
  if (!snooze) seedCadence(referral, orgId, addDays(todayYmd(), SECOND_GIFT.reaskCooldownDays));
  res.json({ ok: true, snoozed: snooze });
});

// Actually SEND the second-gift re-ask email. Routes through the outbound chokepoint
// (the demo allowlist clamps the recipient to the operator's inbox). On a successful
// send it stamps second_ask_at and re-enters the reminders cadence (same as marking
// re-asked), so the donor leaves the lane and we watch for a response.
app.post('/api/referrals/:id/reconnect-send', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to send — draft the message first.' });
  const to = String(referral.contact_email || '').trim();
  if (!to) return res.status(400).json({ error: 'No email on file for this donor.' });
  const cfg = getOrgConfig(orgId);
  const subject = String(req.body?.subject || `A note from ${cfg.orgName || 'us'}`).slice(0, 200);
  try {
    const send = await sendOutbound({ to, subject, text, kind: 'second_ask', orgId, userId: req.user.id });
    if (!send.delivered) return res.status(202).json({ ok: false, send }); // blocked by policy, not an error
    markSecondAsk.run(nowStamp(), id, req.user.id, orgId);
    seedCadence(referral, orgId, addDays(todayYmd(), SECOND_GIFT.reaskCooldownDays));
    res.json({ ok: true, send });
  } catch (e) {
    console.error('reconnect-send failed:', e.message);
    res.status(502).json({ error: 'Could not send the email. Check the mail provider configuration.' });
  }
});

// Exported for offline unit tests (pure stewardship assembly + system prompt).
export const __stewardshipInternals = { thankYouContext, thankYouSystem, impactForAmount, buildReceipt, staticThankYou, staticSecondAsk };

// ── Referrals / outreach pipeline ───────────────────────────────
const PIPELINE_STAGES = ['to_ask', 'asked', 'following_up', 'donated', 'declined'];
// Stages that mean the ask is RESOLVED — closing them closes any open reminders.
const CLOSING_STAGES = new Set(['donated', 'declined']);

const getConnection = db.prepare(
  'SELECT * FROM connections WHERE id = ? AND user_id = ? AND org_id = ?'
);
const findReferralForConnection = db.prepare(
  'SELECT * FROM referrals WHERE user_id = ? AND org_id = ? AND connection_id = ?'
);
const insertReferral = db.prepare(`
  INSERT INTO referrals (user_id, org_id, connection_id, contact_name, contact_email, company, linkedin_url, status)
  VALUES (@user_id, @org_id, @connection_id, @contact_name, @contact_email, @company, @linkedin_url, @status)
`);
const listReferrals = db.prepare(
  'SELECT * FROM referrals WHERE user_id = ? AND org_id = ? ORDER BY referred_at DESC'
);
const getReferral = db.prepare('SELECT * FROM referrals WHERE id = ? AND user_id = ? AND org_id = ?');
const deleteReferralById = db.prepare(
  'DELETE FROM referrals WHERE id = ? AND user_id = ? AND org_id = ?'
);
const updateReferralFields = db.prepare(
  'UPDATE referrals SET status = ?, note = ?, follow_up_date = ? WHERE id = ? AND user_id = ? AND org_id = ?'
);
const setReferralFollowUp = db.prepare(
  'UPDATE referrals SET follow_up_date = ? WHERE id = ? AND user_id = ? AND org_id = ?'
);
// ── Donations ledger funnel (recordGift) ─────────────────────────────────────
// EVERY recorded gift goes through recordGift(): it appends one row to the donations
// ledger AND refreshes the referral's denormalized donation_* cache in the same write
// path, so no caller can desync the cache from the ledger. The old markDonation/
// markDonationDated overwrite statements are intentionally gone — there is exactly one
// way to record a gift now. nowStamp() matches the existing reconcile timestamp shape.
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const insertDonationRow = db.prepare(`
  INSERT OR IGNORE INTO donations (user_id, org_id, referral_id, connection_id, amount, donated_at, source, dedupe_key)
  VALUES (@user_id, @org_id, @referral_id, @connection_id, @amount, @donated_at, @source, @dedupe_key)
`);
// Recompute the referral's cache columns from the ledger (received = EXISTS,
// amount = SUM, date = MAX). Scoped by (id, user_id, org_id) so it can never touch
// another tenant's row even if a bad referral_id is passed.
const refreshDonationCache = db.prepare(`
  UPDATE referrals SET
    donation_received = (SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM donations WHERE referral_id = @referral_id),
    donation_amount   = COALESCE((SELECT SUM(amount) FROM donations WHERE referral_id = @referral_id), 0),
    donation_date     = (SELECT MAX(donated_at) FROM donations WHERE referral_id = @referral_id),
    status            = CASE WHEN (SELECT COUNT(*) FROM donations WHERE referral_id = @referral_id) > 0 THEN 'donated' ELSE status END
  WHERE id = @referral_id AND user_id = @user_id AND org_id = @org_id
`);
const listDonationsForReferral = db.prepare(
  'SELECT id, amount, donated_at, source, created_at FROM donations WHERE referral_id = ? AND user_id = ? AND org_id = ? ORDER BY donated_at DESC, id DESC'
);
const deleteDonationsForReferral = db.prepare(
  'DELETE FROM donations WHERE referral_id = ? AND user_id = ? AND org_id = ?'
);

// recordGift — THE single funnel for recording a gift. Appends a ledger row and
// refreshes the cache. Returns { inserted }: false means the gift was a duplicate
// (same referral+amount+day) and was idempotently ignored by the dedupe index, so the
// caller can honestly report "already recorded" instead of a misleading success.
// MUST run inside a transaction — callers either already own one (reconcile, demo
// seeders) or use recordGiftTx (single-gift routes).
function recordGift({ userId, orgId, referralId, connectionId = null, amount, date, source = 'manual' }) {
  const amt = Number(amount) || 0;
  // Never fabricate a gift. A non-positive amount is not a donation — refuse it here
  // so NO caller can flip donation_received=1 / status='donated' for a zero/negative
  // "gift" (matches the backfill's `donation_amount > 0` invariant). Defense in depth:
  // the routes also validate, but this is the single chokepoint that guarantees it.
  if (amt <= 0) return { inserted: false };
  const donated_at = String(date || '').trim() || nowStamp();
  const dedupe_key = `${referralId}|${amt}|${donated_at.slice(0, 10)}`;
  const info = insertDonationRow.run({
    user_id: userId, org_id: orgId, referral_id: referralId,
    connection_id: connectionId, amount: amt, donated_at, source, dedupe_key,
  });
  refreshDonationCache.run({ referral_id: referralId, user_id: userId, org_id: orgId });
  return { inserted: info.changes > 0 };
}
const recordGiftTx = db.transaction((args) => recordGift(args));

// ── Follow-up reminders / cadence ────────────────────────────────
// All reminder statements scope by the parent referral's (user_id, org_id) — the
// denormalized columns on follow_up_reminders — so a cross-org reminder id can
// NEVER be read or mutated (it returns no row → the route 404s).
const insertReminder = db.prepare(`
  INSERT INTO follow_up_reminders (referral_id, user_id, org_id, step_index, due_date)
  VALUES (@referral_id, @user_id, @org_id, @step_index, @due_date)
`);
// A reminder fetched WITH its parent referral fields (joined), still org-scoped.
const getReminderScoped = db.prepare(`
  SELECT fr.*, r.contact_name, r.company, r.linkedin_url, r.status AS referral_status
    FROM follow_up_reminders fr
    JOIN referrals r ON r.id = fr.referral_id
   WHERE fr.id = ? AND fr.user_id = ? AND fr.org_id = ?
`);
// Open (not-yet-done) reminders for one referral, earliest due first.
const openRemindersForReferral = db.prepare(
  'SELECT * FROM follow_up_reminders WHERE referral_id = ? AND done_at IS NULL ORDER BY due_date, step_index'
);
const countOpenRemindersForReferral = db.prepare(
  'SELECT COUNT(*) AS n FROM follow_up_reminders WHERE referral_id = ? AND done_at IS NULL'
);
// The scout's reminders QUEUE: every OPEN reminder across their pipeline (the UI
// splits due/overdue vs upcoming by comparing due_date to today). Joined to the
// referral so the client gets the contact without a second round-trip.
const listOpenReminders = db.prepare(`
  SELECT fr.*, r.contact_name, r.company, r.linkedin_url, r.status AS referral_status, r.connection_id
    FROM follow_up_reminders fr
    JOIN referrals r ON r.id = fr.referral_id
   WHERE fr.user_id = ? AND fr.org_id = ? AND fr.done_at IS NULL
   ORDER BY fr.due_date, fr.step_index
`);
const markReminderDone = db.prepare(
  "UPDATE follow_up_reminders SET done_at = CURRENT_TIMESTAMP, closed_reason = ? WHERE id = ? AND user_id = ? AND org_id = ?"
);
const setReminderDue = db.prepare(
  'UPDATE follow_up_reminders SET due_date = ? WHERE id = ? AND user_id = ? AND org_id = ?'
);
const closeOpenRemindersStmt = db.prepare(
  "UPDATE follow_up_reminders SET done_at = CURRENT_TIMESTAMP, closed_reason = ? WHERE referral_id = ? AND done_at IS NULL"
);

// Keep the legacy referrals.follow_up_date column in sync with the NEXT open
// reminder's due date (or NULL when none remain). This preserves the old single-
// date field — existing UI bits that read follow_up_date keep working, now backed
// by the cadence — without a hard cutover.
function syncReferralFollowUp(referralId, userId, orgId) {
  const next = openRemindersForReferral.get(referralId)?.due_date || null;
  setReferralFollowUp.run(next, referralId, userId, orgId);
  return next;
}

// Seed the cadence for a referral that has just been "asked". Idempotent: only the
// FIRST step is created, and only when the referral has no open reminders yet
// (re-marking "asked" won't stack duplicates). startDate seeds step 0 (defaults to
// today + cadence[0]); used by the migration to honor a pre-existing follow_up_date.
function seedCadence(referral, orgId, startDate) {
  if (countOpenRemindersForReferral.get(referral.id).n > 0) return;
  const cadence = resolveCadence(orgId);
  const due = startDate || addDays(todayYmd(), cadence[0]);
  insertReminder.run({
    referral_id: referral.id,
    user_id: referral.user_id,
    org_id: orgId,
    step_index: 0,
    due_date: due,
  });
  syncReferralFollowUp(referral.id, referral.user_id, orgId);
}

// Close every open reminder on a referral (called when the ask is resolved —
// donated/declined — so the queue doesn't keep nagging about a closed prospect).
function closeReferralReminders(referralId, userId, orgId, reason) {
  closeOpenRemindersStmt.run(reason, referralId);
  setReferralFollowUp.run(null, referralId, userId, orgId);
}

app.post('/api/referrals', requireAuth, (req, res) => {
  const connectionId = Number(req.body?.connectionId);
  if (!connectionId) return res.status(400).json({ error: 'connectionId is required.' });
  const orgId = orgScope(req);

  const conn = getConnection.get(connectionId, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });

  const existing = findReferralForConnection.get(req.user.id, orgId, connectionId);
  if (existing) return res.status(409).json({ error: 'Already in your pipeline.', referral: existing });

  const status = PIPELINE_STAGES.includes(req.body?.status) ? req.body.status : 'asked';
  const info = insertReferral.run({
    user_id: req.user.id,
    org_id: orgId,
    connection_id: connectionId,
    contact_name: conn.contact_name,
    contact_email: conn.contact_email,
    company: conn.company,
    linkedin_url: conn.linkedin_url,
    status,
  });
  // Reaching out (status "asked") seeds the follow-up CADENCE (a sequence of
  // reminders; the first is scheduled now, the rest as each step is completed).
  if (status === 'asked') {
    seedCadence(getReferral.get(info.lastInsertRowid, req.user.id, orgId), orgId);
  } else if (CLOSING_STAGES.has(status)) {
    // Imported straight as donated/declined (e.g. reconcile): nothing open to close,
    // but keep the legacy date clear for consistency.
    setReferralFollowUp.run(null, info.lastInsertRowid, req.user.id, orgId);
  }
  recomputeImpact(req.user.id);
  res.status(201).json({ referral: getReferral.get(info.lastInsertRowid, req.user.id, orgId) });
});

app.get('/api/referrals', requireAuth, (req, res) => {
  res.json({ referrals: listReferrals.all(req.user.id, orgScope(req)) });
});

// Remove someone from the pipeline (the connection stays a prospect). Its cadence
// reminders go with it (scoped delete first so no orphan reminders linger).
const deleteRemindersForReferral = db.prepare(
  'DELETE FROM follow_up_reminders WHERE referral_id = ? AND user_id = ? AND org_id = ?'
);
app.delete('/api/referrals/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  deleteRemindersForReferral.run(id, req.user.id, orgId);
  deleteDonationsForReferral.run(id, req.user.id, orgId); // no orphan ledger rows
  const info = deleteReferralById.run(id, req.user.id, orgId);
  if (!info.changes) return res.status(404).json({ error: 'Referral not found.' });
  recomputeImpact(req.user.id);
  res.json({ ok: true });
});

// Update a pipeline entry's stage, note, and/or follow-up date.
app.patch('/api/referrals/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });

  const status =
    req.body?.status !== undefined && PIPELINE_STAGES.includes(req.body.status)
      ? req.body.status
      : referral.status;
  const note =
    req.body?.note !== undefined ? String(req.body.note).trim() || null : referral.note;

  // follow_up_date is now a VIEW onto the cadence (the next open reminder's due
  // date). We persist status+note here, then reconcile reminders below; the column
  // is kept in sync by the reminder helpers — never written directly from the body.
  updateReferralFields.run(status, note, referral.follow_up_date, id, req.user.id, orgId);

  // Resolving the ask (donated/declined) closes any open reminders so the queue
  // stops nagging. Moving INTO "asked" seeds the cadence (unless one's already open).
  if (CLOSING_STAGES.has(status) && !CLOSING_STAGES.has(referral.status)) {
    closeReferralReminders(id, req.user.id, orgId, status);
  } else if (status === 'asked' && referral.status !== 'asked') {
    seedCadence({ ...referral, status }, orgId);
  }

  // Backward-compatible manual date edit: the Pipeline date input still works. A
  // supplied follow_up_date reschedules the earliest open reminder (or seeds one if
  // none is open and the ask isn't closed); an empty value closes the open reminders.
  if (req.body?.follow_up_date !== undefined && !CLOSING_STAGES.has(status)) {
    const wanted = req.body.follow_up_date || null;
    const open = openRemindersForReferral.get(id);
    if (wanted && open) {
      setReminderDue.run(wanted, open.id, req.user.id, orgId);
    } else if (wanted && !open) {
      seedCadence({ ...referral, status }, orgId, wanted);
    } else if (!wanted) {
      closeOpenRemindersStmt.run('completed', id);
    }
    syncReferralFollowUp(id, req.user.id, orgId);
  }

  recomputeImpact(req.user.id);
  res.json({ referral: getReferral.get(id, req.user.id, orgId) });
});

app.post('/api/referrals/:id/donation', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required.' });
  const orgId = orgScope(req);

  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });

  const { inserted } = recordGiftTx({
    userId: req.user.id, orgId, referralId: id,
    connectionId: referral.connection_id ?? null, amount, date: nowStamp(), source: 'manual',
  });
  // The ask is resolved — close any open follow-up reminders (only on a real new gift).
  if (inserted) closeReferralReminders(id, req.user.id, orgId, 'donated');
  const impact = recomputeImpact(req.user.id);
  res.json({ referral: getReferral.get(id, req.user.id, orgId), impact, alreadyRecorded: !inserted });
});

// GET the per-gift ledger for one referral (org-scoped). The donation_* columns on
// the referral are the cached rollup; this is the authoritative gift-by-gift history.
app.get('/api/referrals/:id/donations', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const referral = getReferral.get(id, req.user.id, orgId);
  if (!referral) return res.status(404).json({ error: 'Referral not found.' });
  const donations = listDonationsForReferral.all(id, req.user.id, orgId);
  const total = donations.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  res.json({ donations, total, count: donations.length });
});

// ── Reminders queue (the cadence the scout actually works) ───────
// GET /api/reminders → every OPEN reminder across the caller's pipeline, with a
// `due` flag (due today or overdue) computed against the server's date. The client
// uses this for the Dashboard "reminders due" widget and the Pipeline controls.
app.get('/api/reminders', requireAuth, (req, res) => {
  const today = todayYmd();
  const reminders = listOpenReminders.all(req.user.id, orgScope(req)).map((r) => ({
    ...r,
    due: r.due_date <= today, // due today OR overdue → actionable now
    overdue: r.due_date < today,
  }));
  res.json({ reminders, today });
});

// Complete a reminder: mark it done and ADVANCE the cadence — seed the next step
// (relative to THIS step's due date) if the cadence has one. Returns the referral's
// remaining open reminders so the UI can refresh in place.
app.post('/api/reminders/:id/complete', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const reminder = getReminderScoped.get(id, req.user.id, orgId);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  if (reminder.done_at) return res.status(409).json({ error: 'Reminder already completed.' });

  markReminderDone.run('completed', id, req.user.id, orgId);

  // Advance to the next cadence step, if any. Offsets are cumulative from step 0,
  // so step N's due date = step (N-1)'s due date + cadence[N]. Anchored on this
  // step's due_date (not "today") so the schedule stays even when worked late.
  const cadence = resolveCadence(orgId);
  const nextIndex = reminder.step_index + 1;
  if (nextIndex < cadence.length) {
    insertReminder.run({
      referral_id: reminder.referral_id,
      user_id: req.user.id,
      org_id: orgId,
      step_index: nextIndex,
      due_date: addDays(reminder.due_date, cadence[nextIndex]),
    });
  }
  syncReferralFollowUp(reminder.referral_id, req.user.id, orgId);
  res.json({
    ok: true,
    referralId: reminder.referral_id,
    open: openRemindersForReferral.all(reminder.referral_id),
  });
});

// Snooze a reminder: reschedule its due date. Accepts an explicit `dueDate`
// (YYYY-MM-DD) or a `days` offset from today (default +3). Does NOT advance the
// cadence — it's the same step, just later.
app.post('/api/reminders/:id/snooze', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const orgId = orgScope(req);
  const reminder = getReminderScoped.get(id, req.user.id, orgId);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  if (reminder.done_at) return res.status(409).json({ error: 'Reminder already completed.' });

  let due;
  if (typeof req.body?.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate)) {
    due = req.body.dueDate;
  } else {
    const days = Number.isInteger(req.body?.days) && req.body.days > 0 ? req.body.days : 3;
    due = addDays(todayYmd(), days);
  }
  setReminderDue.run(due, id, req.user.id, orgId);
  syncReferralFollowUp(reminder.referral_id, req.user.id, orgId);
  res.json({ ok: true, referralId: reminder.referral_id, dueDate: due });
});

// Reconcile a Zeffy donor export: match each donor to a referral (or a connection)
// by email then name, auto-record the donation, and create a pipeline entry for
// network donors who weren't formally referred yet.
app.post('/api/donations/reconcile', requireAuth, (req, res) => {
  const donors = Array.isArray(req.body?.donors) ? req.body.donors : null;
  if (!donors || donors.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty "donors" array.' });
  }
  if (donors.length > LIMITS.reconcileDonors) return res.status(413).json({ error: `Too many rows (max ${LIMITS.reconcileDonors.toLocaleString()}).` });

  const userId = req.user.id;
  const orgId = orgScope(req);
  const refByEmail = new Map();
  const refByName = new Map();
  for (const r of listReferrals.all(userId, orgId)) {
    if (r.contact_email) refByEmail.set(canonicalizeEmail(r.contact_email), r);
    if (r.contact_name) refByName.set(norm(r.contact_name), r);
  }
  const connByEmail = new Map();
  const connByName = new Map();
  const nameTokenIndex = new Map(); // name token → [connection], for fuzzy near-matches
  for (const c of connectionsForUser.all(userId, orgId)) {
    if (c.contact_email) connByEmail.set(canonicalizeEmail(c.contact_email), c);
    if (c.contact_name) connByName.set(norm(c.contact_name), c);
    for (const t of new Set(tokenize(c.contact_name))) {
      if (!nameTokenIndex.has(t)) nameTokenIndex.set(t, []);
      nameTokenIndex.get(t).push(c);
    }
  }
  // Deterministic near-match suggestions for an unmatched donor name (NO AI): the
  // connections sharing name tokens, ranked by Jaccard overlap, top 3. The match
  // Maps are already in hand, so this is near-free — it turns the dropped "unmatched"
  // rows into an actionable Reconcile Review queue.
  function candidatesFor(donorName) {
    const toks = new Set(tokenize(donorName));
    if (!toks.size) return [];
    const acc = new Map();
    for (const t of toks) {
      for (const c of nameTokenIndex.get(t) || []) {
        const e = acc.get(c.id) || { c, shared: 0 };
        e.shared += 1;
        acc.set(c.id, e);
      }
    }
    return [...acc.values()]
      .map(({ c, shared }) => {
        const union = new Set([...toks, ...tokenize(c.contact_name)]).size || 1;
        return { connectionId: c.id, name: c.contact_name, company: c.company || null, confidence: Math.round((shared / union) * 100) };
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  let recorded = 0;
  let amountRecorded = 0;
  let createdFromConnections = 0;
  let alreadyRecorded = 0;
  let unmatched = 0;
  const unmatchedList = []; // bare names (back-compat)
  const unmatchedReview = []; // structured rows + near-match candidates (Reconcile Review)

  const tx = db.transaction(() => {
    for (const d of donors) {
      const name = (d.name || '').trim();
      const email = canonicalizeEmail(d.email);
      const amount = Number(String(d.amount ?? '').replace(/[^0-9.]/g, '')) || 0;
      const date = (d.date || '').trim() || new Date().toISOString().slice(0, 19).replace('T', ' ');
      // A row with no positive amount is not a gift — skip it (never fabricate a gift).
      if (amount <= 0) continue;

      // 1) existing referral? Append to the ledger; the dedupe index (referral+amount+
      // day) makes a re-imported gift a no-op (alreadyRecorded), while a genuinely new
      // gift on the same person is now correctly recorded as a second ledger row.
      const ref = (email && refByEmail.get(email)) || (name && refByName.get(norm(name))) || null;
      if (ref) {
        const { inserted } = recordGift({ userId, orgId, referralId: ref.id, connectionId: ref.connection_id ?? null, amount, date, source: 'reconcile' });
        if (inserted) {
          closeReferralReminders(ref.id, userId, orgId, 'donated');
          ref.donation_received = 1;
          recorded++;
          amountRecorded += amount;
        } else {
          alreadyRecorded++;
        }
        continue;
      }

      // 2) a connection (in your network) who isn't referred yet → create + record
      const conn = (email && connByEmail.get(email)) || (name && connByName.get(norm(name))) || null;
      if (conn) {
        const existing = findReferralForConnection.get(userId, orgId, conn.id);
        let refId;
        if (existing) {
          refId = existing.id;
        } else {
          const info = insertReferral.run({
            user_id: userId,
            org_id: orgId,
            connection_id: conn.id,
            contact_name: conn.contact_name,
            contact_email: conn.contact_email,
            company: conn.company,
            linkedin_url: conn.linkedin_url,
            status: 'donated',
          });
          refId = info.lastInsertRowid;
          createdFromConnections++;
        }
        const { inserted } = recordGift({ userId, orgId, referralId: refId, connectionId: conn.id, amount, date, source: 'reconcile' });
        if (inserted) {
          closeReferralReminders(refId, userId, orgId, 'donated');
          const stub = { id: refId, donation_received: 1 };
          if (conn.contact_email) refByEmail.set(canonicalizeEmail(conn.contact_email), stub);
          if (conn.contact_name) refByName.set(norm(conn.contact_name), stub);
          recorded++;
          amountRecorded += amount;
        } else {
          alreadyRecorded++;
        }
        continue;
      }

      // 3) donor not in your network at all → queue for human review with
      // deterministic near-match suggestions (the Reconcile Review surface).
      unmatched++;
      if (name || email) {
        if (unmatchedList.length < 50) unmatchedList.push(name || email);
        if (unmatchedReview.length < 50) unmatchedReview.push({ name, email, amount, date, candidates: candidatesFor(name) });
      }
    }
  });
  tx();
  recomputeImpact(userId);

  res.json({
    totalDonors: donors.length,
    recorded,
    createdFromConnections,
    alreadyRecorded,
    unmatched,
    amountRecorded,
    unmatchedList,
    unmatchedReview,
  });
});

// Resolve ONE unmatched donation from the Reconcile Review queue: LINK it to an
// existing connection (record the gift on that person) or CREATE a standalone record
// (donor not in the network). Human-confirmed, per row — never an auto-send.
app.post('/api/donations/record', requireAuth, (req, res) => {
  const userId = req.user.id;
  const orgId = orgScope(req);
  const d = req.body?.donor || {};
  const name = String(d.name || '').trim();
  const email = canonicalizeEmail(d.email);
  const amount = Number(String(d.amount ?? '').replace(/[^0-9.]/g, '')) || 0;
  const date = String(d.date || '').trim() || new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!name && !email) return res.status(400).json({ error: 'Donor name or email is required.' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required.' });

  const connectionId = req.body?.connectionId != null ? Number(req.body.connectionId) : null;
  let referralId;
  let linkedConnectionId = null;
  if (connectionId) {
    const conn = getConnection.get(connectionId, userId, orgId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    linkedConnectionId = conn.id;
    const existing = findReferralForConnection.get(userId, orgId, conn.id);
    referralId = existing
      ? existing.id
      : insertReferral.run({
          user_id: userId, org_id: orgId, connection_id: conn.id,
          contact_name: conn.contact_name, contact_email: conn.contact_email,
          company: conn.company, linkedin_url: conn.linkedin_url, status: 'donated',
        }).lastInsertRowid;
  } else {
    // Standalone record — donor isn't in the network; a referral with no linked
    // connection still counts the gift toward impact.
    referralId = insertReferral.run({
      user_id: userId, org_id: orgId, connection_id: null,
      contact_name: name || null, contact_email: email || null,
      company: String(d.company || '').trim() || null, linkedin_url: null, status: 'donated',
    }).lastInsertRowid;
  }
  // Single funnel: append + cache refresh. inserted=false → this exact gift is already
  // on file (dedupe), so report alreadyRecorded instead of a misleading success.
  const { inserted } = recordGiftTx({ userId, orgId, referralId, connectionId: linkedConnectionId, amount, date, source: 'manual' });
  if (inserted) closeReferralReminders(referralId, userId, orgId, 'donated');
  recomputeImpact(userId);
  res.json({ ok: true, referralId, alreadyRecorded: !inserted });
});

// ── Tonight's 15 Minutes: one ranked daily action queue ─────────────────────
// Pure assembly over existing data — due/overdue follow-ups, donors awaiting a
// thank-you, the top un-asked prospects (snooze-aware), and donors at employer
// matching-gift companies. NO AI, NO send: every card action is a local DB write
// or a copy/mailto the human confirms. Org-scoped via orgScope(req).
const snoozeConnectionStmt = db.prepare(
  'UPDATE connections SET snooze_until = ? WHERE id = ? AND user_id = ? AND org_id = ?'
);

// Per-org custom matching-gift companies — extend the built-in ~315. Org-scoped;
// owner/admin add them (manually or via CSV), everyone benefits on the Today queue.
db.exec(`CREATE TABLE IF NOT EXISTS org_match_companies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL,
  name       TEXT NOT NULL,
  keyword    TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const listOrgMatchCompanies = db.prepare('SELECT * FROM org_match_companies WHERE org_id = ? ORDER BY name COLLATE NOCASE');
const insertOrgMatchCompany = db.prepare('INSERT INTO org_match_companies (org_id, name, keyword) VALUES (?, ?, ?)');
const deleteOrgMatchCompany = db.prepare('DELETE FROM org_match_companies WHERE id = ? AND org_id = ?');
const orgMatchByName = db.prepare('SELECT 1 FROM org_match_companies WHERE org_id = ? AND name = ? COLLATE NOCASE');

// ── Grants workspace: per-org document library ───────────────────────────────
// Reference material the org uploads (mission, programs, impact, financials, prior
// reports, grant applications). Stored as EXTRACTED TEXT ONLY: the original file
// never reaches the server (the client extracts text from PDF/DOCX/TXT and sends the
// text). Org-scoped. This text is the grounding source for the grant report and the
// application-answer drafts, so the model only ever uses real, org-supplied material.
db.exec(`CREATE TABLE IF NOT EXISTS documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT DEFAULT 'reference',
  content    TEXT NOT NULL,
  char_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(org_id)');
// Newsletter send history (one row per send). Recipients are resolved server-side at
// send time; this just logs what went out (and how many were demo-redirected).
db.exec(`CREATE TABLE IF NOT EXISTS newsletters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  subject     TEXT,
  segment     TEXT,
  recipients  INTEGER DEFAULT 0,
  sent        INTEGER DEFAULT 0,
  redirected  INTEGER DEFAULT 0,
  blocked     INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
)`);
ensureColumn('newsletters', 'blocked', 'INTEGER DEFAULT 0'); // for DBs created before the column existed
ensureColumn('newsletters', 'suppressed', 'INTEGER DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_newsletters_org ON newsletters(org_id, created_at)');
// Per-org email opt-out list. A suppressed (org_id, email) is never emailed for any
// donor-facing kind. email_lc is the canonical lowercased address; the unique index makes
// re-unsubscribing idempotent.
db.exec(`CREATE TABLE IF NOT EXISTS email_suppressions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL,
  email_lc   TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_org_email ON email_suppressions(org_id, email_lc)');
const insertSuppressionStmt = db.prepare(
  'INSERT OR IGNORE INTO email_suppressions (org_id, email_lc, reason) VALUES (@org_id, @email_lc, @reason)'
);
const isSuppressedStmt = db.prepare('SELECT 1 FROM email_suppressions WHERE org_id = ? AND email_lc = ?');
// Signing secret for unsubscribe tokens (same material as lib/secrets; falls back to a dev
// key when unset). UNSUB_BASE is where the one-click link points (the app's public origin).
const UNSUB_SECRET = process.env.SECRETS_KEY || '';
// The route lives on the API origin (like every other /api URL), NOT the SPA origin, so a
// split-origin deploy's link still reaches the server.
const unsubUrlFor = (orgId, email) => `${API_PUBLIC_URL}/api/unsubscribe/${signUnsubToken(orgId, email, UNSUB_SECRET)}`;
const DOC_KINDS = ['mission', 'program', 'impact', 'financial', 'prior_report', 'application', 'reference'];
const DOC_MAX_CHARS = 400000; // generous per-document storage cap (~100k tokens)
const listDocsStmt = db.prepare('SELECT id, name, kind, char_count, created_at FROM documents WHERE org_id = ? ORDER BY created_at DESC');
const getDocStmt = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?');
const insertDocStmt = db.prepare('INSERT INTO documents (org_id, user_id, name, kind, content, char_count) VALUES (@org_id, @user_id, @name, @kind, @content, @char_count)');
const deleteDocStmt = db.prepare('DELETE FROM documents WHERE id = ? AND org_id = ?');
const docsForOrg = db.prepare('SELECT id, name, kind, content FROM documents WHERE org_id = ? ORDER BY created_at DESC'); // full text, for AI grounding (M2/M3)

app.get('/api/documents', requireAuth, (req, res) => {
  res.json({ documents: listDocsStmt.all(orgScope(req)), kinds: DOC_KINDS });
});

app.get('/api/documents/:id', requireAuth, (req, res) => {
  const doc = getDocStmt.get(Number(req.params.id), orgScope(req));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json({ document: doc });
});

app.post('/api/documents', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const name = String(req.body?.name || '').trim().slice(0, 200);
  const content = String(req.body?.content || '').trim();
  const kind = DOC_KINDS.includes(req.body?.kind) ? req.body.kind : 'reference';
  if (!name) return res.status(400).json({ error: 'A document name is required.' });
  if (!content) return res.status(400).json({ error: 'No readable text was found. Try a different file or paste the text directly.' });
  if (content.length > DOC_MAX_CHARS) {
    return res.status(413).json({ error: `That document is too long (over ${Math.round(DOC_MAX_CHARS / 1000)}k characters). Split it into smaller files.` });
  }
  const info = insertDocStmt.run({ org_id: orgId, user_id: req.user.id, name, kind, content, char_count: content.length });
  res.status(201).json({ document: getDocStmt.get(info.lastInsertRowid, orgId) });
});

app.delete('/api/documents/:id', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  deleteDocStmt.run(Number(req.params.id), orgId);
  res.json({ documents: listDocsStmt.all(orgId) });
});

// ── Grants: donation/impact summary (the real-data half of a report) ─────────
// Aggregate, org-scoped figures only (no individual donor names) so a report can cite
// true numbers without exposing the donor list. Built from the per-gift ledger.
const donationStatsStmt = db.prepare(`
  SELECT COUNT(*) AS gifts, COALESCE(SUM(amount), 0) AS total,
         COUNT(DISTINCT referral_id) AS donors, COALESCE(MAX(amount), 0) AS largest,
         MIN(donated_at) AS firstAt, MAX(donated_at) AS lastAt
    FROM donations WHERE org_id = ?
`);
const recurringDonorsStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM (SELECT referral_id FROM donations WHERE org_id = ? GROUP BY referral_id HAVING COUNT(*) > 1)'
);
const topDonorEmployersStmt = db.prepare(`
  SELECT r.company AS company, COUNT(*) AS n
    FROM donations d JOIN referrals r ON r.id = d.referral_id
   WHERE d.org_id = ? AND r.company IS NOT NULL AND TRIM(r.company) != ''
   GROUP BY r.company COLLATE NOCASE ORDER BY n DESC, company LIMIT 5
`);

function buildDonationSummary(orgId) {
  const s = donationStatsStmt.get(orgId);
  if (!s || !s.gifts) return 'No donations have been recorded in Donor Scout yet.';
  const cfg = getOrgConfig(orgId);
  const programCost = cfg.impact?.programCost || COST_PER_BOOTCAMP;
  const dayCost = cfg.impact?.dayCost || COST_PER_DAY;
  const unit = cfg.copy?.programUnit || cfg.programUnit || 'program';
  const recurring = recurringDonorsStmt.get(orgId).n;
  // Privacy: aggregate figures only. To stop a tiny or concentrated org's report from
  // re-identifying a donor, the most granular figures are gated on cohort size and the
  // employer breakdown is k-anonymized: only employers with >= 2 gifts, and only when
  // there are enough donors that a company can't pinpoint one person.
  const employers = s.donors >= 5 ? topDonorEmployersStmt.all(orgId).filter((e) => e.n >= 2) : [];
  const lines = [
    `Total raised: $${Math.round(s.total).toLocaleString()}`,
    `Number of gifts: ${s.gifts}`,
    `Number of donors: ${s.donors}`,
    `Recurring donors (more than one gift): ${recurring}`,
    `Average gift: $${(s.total / s.gifts).toFixed(2)}`,
    s.donors >= 3 ? `Largest single gift: $${Math.round(s.largest).toLocaleString()}` : null,
    s.firstAt && s.lastAt ? `Gifts span ${String(s.firstAt).slice(0, 10)} to ${String(s.lastAt).slice(0, 10)}` : null,
    programCost ? `Approximate ${unit}s funded (at $${programCost} each): ${Math.floor(s.total / programCost)}` : null,
    dayCost ? `Approximate program days funded (at $${dayCost}/day): ${Math.floor(s.total / dayCost)}` : null,
    employers.length ? `Top donor employers by gift count: ${employers.map((e) => `${e.company} (${e.n})`).join(', ')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// Generate a grant/donor report from the org's documents + its real donation data.
// Grounded + no-fabrication (see lib/grants.js). One strategy-model call, budgeted.
app.post('/api/grants/report', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  if (!aiEnabled()) return res.status(503).json({ error: 'AI is off. Add an ANTHROPIC_API_KEY to generate reports.', aiDisabled: true });
  const reportType = REPORT_TYPES[req.body?.reportType] ? req.body.reportType : 'general';
  const instructions = String(req.body?.instructions || '').slice(0, 1500);
  const ids = Array.isArray(req.body?.documentIds) ? req.body.documentIds.map(Number).filter(Boolean) : null;
  let docs = docsForOrg.all(orgId);
  if (ids && ids.length) docs = docs.filter((d) => ids.includes(d.id));
  if (!docs.length) return res.status(400).json({ error: 'Add at least one document to your library first.' });
  try {
    const { report, truncated } = await generateGrantReport({
      reportType, documents: docs, donationSummary: buildDonationSummary(orgId),
      instructions, cause: getOrgConfig(orgId), orgId,
    });
    res.json({ report, truncated });
  } catch (e) {
    handleAiError(res, e);
  }
});

// Draft answers to grant application questions, grounded in the org's documents + data.
app.post('/api/grants/answer', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  if (!aiEnabled()) return res.status(503).json({ error: 'AI is off. Add an ANTHROPIC_API_KEY to draft answers.', aiDisabled: true });
  const questions = Array.isArray(req.body?.questions)
    ? req.body.questions.map((q) => String(q || '').trim().slice(0, 2000)).filter(Boolean).slice(0, 30)
    : [];
  if (!questions.length) return res.status(400).json({ error: 'Add at least one application question.' });
  const ids = Array.isArray(req.body?.documentIds) ? req.body.documentIds.map(Number).filter(Boolean) : null;
  let docs = docsForOrg.all(orgId);
  if (ids && ids.length) docs = docs.filter((d) => ids.includes(d.id));
  if (!docs.length) return res.status(400).json({ error: 'Add at least one document to your library first so answers are grounded.' });
  try {
    const { answers } = await answerGrantQuestions({
      questions, documents: docs, donationSummary: buildDonationSummary(orgId),
      cause: getOrgConfig(orgId), orgId,
    });
    res.json({ answers });
  } catch (e) {
    handleAiError(res, e);
  }
});

// ── Newsletter: draft + audience + send ──────────────────────────────────────
// A donor newsletter is three things: AI-drafted impact content (grounded in the org's
// documents + donation data, lib/newsletter), an AUDIENCE resolved from the donor ledger,
// and a fan-out send through the SAME outbound chokepoint (sendOutbound) — so in demo every
// copy is redirected to the operator inbox and nothing reaches a real donor by accident.

// Donors (gifted referrals) WITH a usable email, plus per-referral gift count + last gift,
// for audience segmentation. Org-scoped like every owned read.
const newsletterAudienceStmt = db.prepare(`
  SELECT r.id, r.contact_name, r.contact_email, r.donation_amount, r.donation_date,
         (SELECT COUNT(*) FROM donations d WHERE d.referral_id = r.id) AS gift_count
    FROM referrals r
   WHERE r.user_id = ? AND r.org_id = ? AND r.donation_received = 1
     AND r.contact_email IS NOT NULL AND TRIM(r.contact_email) != ''
   ORDER BY r.donation_date DESC
`);
// Total donors (gifted referrals), reachable or not — so "no email" = total minus the
// reachable audience, which accounts for null, blank, AND malformed addresses.
const giftedDonorCountStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM referrals WHERE user_id = ? AND org_id = ? AND donation_received = 1'
);
const NEWSLETTER_SEGMENTS = ['all', 'recent', 'lapsed', 'recurring'];
const hasEmail = (e) => /\S+@\S+\.\S+/.test(String(e || ''));

// Resolve the audience for a segment (server-side; the client never supplies a recipient
// list). recent = gift within 90d, lapsed = newest gift older than 365d, recurring = >1 gift.
function resolveNewsletterAudience(userId, orgId, segment) {
  // Reachable = has a usable email AND has not opted out (suppression filtered here, and
  // re-checked in sendOutbound, so an unsubscribe is honored even on a stale audience).
  const rows = newsletterAudienceStmt
    .all(userId, orgId)
    .filter((r) => hasEmail(r.contact_email) && !isSuppressedStmt.get(orgId, String(r.contact_email).trim().toLowerCase()));
  const now = Date.now();
  const ageDays = (d) => (now - Date.parse(`${String(d || '').slice(0, 10)}T00:00:00`)) / 86400000;
  switch (segment) {
    case 'recent': return rows.filter((r) => ageDays(r.donation_date) <= 90);
    case 'lapsed': return rows.filter((r) => ageDays(r.donation_date) >= 365);
    case 'recurring': return rows.filter((r) => r.gift_count > 1);
    default: return rows; // 'all'
  }
}

function audienceCounts(userId, orgId) {
  const out = {};
  for (const seg of NEWSLETTER_SEGMENTS) out[seg] = resolveNewsletterAudience(userId, orgId, seg).length;
  return out;
}

// Static fallback newsletter when AI is off — grounded only in the aggregate donation
// summary + org name, so the operator always has an editable starting point. Returns the
// same { subject, preheader, body } shape as the AI draft (body is light markdown; a
// Donate button is added at render time, so no raw link here).
function staticNewsletter(cfg, donationSummary) {
  const org = cfg.orgName || 'our cause';
  const snapshot = String(donationSummary || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
  return {
    subject: `An update from ${org}`,
    preheader: 'A quick thank-you and a snapshot of your impact.',
    body:
      `Hi {{first_name}},\n\n` +
      `Thank you for supporting ${org}. Because of donors like you, the work continues. Here is a quick snapshot of what your support has made possible:\n\n` +
      `${snapshot}\n\n` +
      `We are grateful for you, and we will keep sharing the impact of your generosity.\n\n` +
      `With thanks,\n${org}`,
  };
}

// AI-draft a donor newsletter from the org's documents + donation data. 503 + editable
// static fallback when AI is off.
app.post('/api/newsletter/draft', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  const cfg = getOrgConfig(orgId);
  const summary = buildDonationSummary(orgId);
  const fallback = staticNewsletter(cfg, summary);
  if (!aiEnabled()) {
    return res.status(503).json({ error: 'AI is off. Add an ANTHROPIC_API_KEY to draft a newsletter.', aiDisabled: true, fallback });
  }
  const instructions = String(req.body?.instructions || '').slice(0, 1000);
  try {
    const { subject, preheader, body } = await generateNewsletter({
      documents: docsForOrg.all(orgId), donationSummary: summary, instructions, cause: cfg, orgId,
    });
    res.json({ subject, preheader, body });
  } catch (e) {
    if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message, budgetExhausted: true, fallback });
    if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message, aiDisabled: true, fallback });
    console.error('Newsletter draft failed:', e.message);
    res.status(502).json({ error: 'Could not draft the newsletter. Using a basic template.', fallback });
  }
});

// Audience sizes per segment (so the UI shows reach before sending), plus a tiny sample of
// names for reassurance. No bulk PII leaves here.
app.get('/api/newsletter/audience', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const userId = req.user.id;
  const segments = audienceCounts(userId, orgId);
  const noEmail = Math.max(0, giftedDonorCountStmt.get(userId, orgId).n - segments.all);
  res.json({
    segments,
    noEmail,
    sample: resolveNewsletterAudience(userId, orgId, 'all').slice(0, 5).map((r) => r.contact_name),
  });
});

// Render a live preview of the newsletter as donors will see it (HTML email), using a
// real donor's first name as the sample personalization. No send.
app.post('/api/newsletter/preview', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const cfg = getOrgConfig(orgId);
  const sampleName =
    resolveNewsletterAudience(req.user.id, orgId, 'all')[0]?.contact_name || req.user.name || 'Alex Donor';
  const built = buildNewsletterEmail({
    subject: String(req.body?.subject || '').slice(0, 200),
    preheader: String(req.body?.preheader || '').slice(0, 200),
    body: String(req.body?.body || '').slice(0, 20000),
    headerImageUrl: String(req.body?.headerImageUrl || '').slice(0, 500),
    donateUrl: donateUrlForOrg(orgId),
    orgName: cfg.orgName,
    recipientName: sampleName,
  });
  res.json({ html: built.html, text: built.text, sampleName });
});

// SEND the newsletter to a segment. The audience is resolved SERVER-SIDE (never trust a
// client-supplied list); each recipient goes through sendOutbound, so the demo allowlist
// clamps every copy to the operator inbox. Returns a tally and logs one newsletters row.
const insertNewsletterStmt = db.prepare(`
  INSERT INTO newsletters (org_id, user_id, subject, segment, recipients, sent, redirected, blocked, suppressed, failed)
  VALUES (@org_id, @user_id, @subject, @segment, @recipients, @sent, @redirected, @blocked, @suppressed, @failed)
`);
const MAX_NEWSLETTER_RECIPIENTS = 2000; // bound the synchronous fan-out per send

app.post('/api/newsletter/send', requireAuth, async (req, res) => {
  const orgId = orgScope(req);
  const userId = req.user.id;
  const subject = String(req.body?.subject || '').trim().slice(0, 200);
  const body = String(req.body?.body || '').trim().slice(0, 20000);
  const preheader = String(req.body?.preheader || '').trim().slice(0, 200);
  const headerImageUrl = String(req.body?.headerImageUrl || '').trim().slice(0, 500);
  const segment = NEWSLETTER_SEGMENTS.includes(req.body?.segment) ? req.body.segment : 'all';
  if (!subject || !body) return res.status(400).json({ error: 'A subject and body are required.' });
  const cfg = getOrgConfig(orgId);
  const donateUrl = donateUrlForOrg(orgId);
  // Build a personalized email for one recipient, with their own one-click unsubscribe URL.
  const render = (recipientName, recipientEmail) =>
    buildNewsletterEmail({
      subject, preheader, body, headerImageUrl, donateUrl, orgName: cfg.orgName, recipientName,
      unsubscribeUrl: recipientEmail ? unsubUrlFor(orgId, recipientEmail) : '',
    });

  // "Send a test to me" — one copy to the operator inbox with a sample personalization,
  // regardless of audience. Useful to preview deliverability before a real send.
  if (req.body?.test) {
    const me = parseAllowlist()[0] || req.user.email;
    if (!me) return res.status(400).json({ error: 'No test address is configured.' });
    const built = render(req.user.name || 'there', me);
    const r = await sendOutbound({ to: me, subject: `[TEST] ${subject}`, text: built.text, html: built.html, kind: 'newsletter_test', orgId, userId });
    return res.json({ ok: r.delivered, test: true, to: me, suppressed: !!r.suppressed });
  }

  const audience = resolveNewsletterAudience(userId, orgId, segment);
  if (!audience.length) return res.status(400).json({ error: 'No donors with an email address in that segment.' });
  if (audience.length > MAX_NEWSLETTER_RECIPIENTS) {
    return res.status(413).json({ error: `That segment has ${audience.length} recipients, over the ${MAX_NEWSLETTER_RECIPIENTS} per-send limit.` });
  }

  let sent = 0, redirected = 0, blocked = 0, suppressed = 0, failed = 0;
  await mapWithConcurrency(audience, 5, async (r) => {
    try {
      const built = render(r.contact_name, r.contact_email); // personalize + per-recipient unsubscribe
      const unsubscribeUrl = unsubUrlFor(orgId, r.contact_email);
      const result = await sendOutbound({
        to: r.contact_email, subject, text: built.text, html: built.html, kind: 'newsletter', orgId, userId,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      if (result.delivered) { sent++; if (result.redirected) redirected++; }
      else if (result.suppressed) suppressed++;
      else if (result.blocked) blocked++;
      else failed++;
    } catch {
      failed++;
    }
  });
  insertNewsletterStmt.run({ org_id: orgId, user_id: userId, subject, segment, recipients: audience.length, sent, redirected, blocked, suppressed, failed });
  res.json({ ok: true, recipients: audience.length, sent, redirected, blocked, suppressed, failed, segment });
});

// Past newsletter sends (org-scoped), newest first.
const listNewslettersStmt = db.prepare(
  'SELECT id, subject, segment, recipients, sent, redirected, blocked, suppressed, failed, created_at FROM newsletters WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT 50'
);
app.get('/api/newsletter/history', requireAuth, (req, res) => {
  res.json({ newsletters: listNewslettersStmt.all(orgScope(req)) });
});

// ── Public one-click unsubscribe ─────────────────────────────────────────────
// No auth/session: the signed token IS the authorization and tells us which (org,email)
// to suppress. Idempotent, rate-limited, and never reveals whether an address existed
// (always shows success), so it can't be used to enumerate donors. GET shows a friendly
// confirmation page; POST is the RFC 8058 one-click endpoint named by List-Unsubscribe-Post.
const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(200).type('html').send(unsubscribePage()),
});
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function unsubscribePage({ confirmToken } = {}) {
  const shell = (h1, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;margin:0;padding:48px 16px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:28px 30px">
<h1 style="font-size:20px;margin:0 0 10px;color:#111">${h1}</h1>${body}</div></body></html>`;
  if (confirmToken) {
    return shell(
      'Unsubscribe',
      `<p style="color:#444;line-height:1.6;margin:0 0 16px">Click below to stop receiving these emails.</p>
<form method="post" action="/api/unsubscribe/${escAttr(confirmToken)}">
<button type="submit" style="background:#0b5cad;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:15px;font-weight:700;cursor:pointer">Confirm unsubscribe</button>
</form>`
    );
  }
  return shell('You have been unsubscribed', '<p style="color:#444;line-height:1.6;margin:0">You will no longer receive these emails. If this was a mistake, just reply to a past message and we will add you back.</p>');
}
function recordUnsubscribe(token, reason) {
  const claim = verifyUnsubToken(token, UNSUB_SECRET);
  if (claim) insertSuppressionStmt.run({ org_id: claim.orgId, email_lc: String(claim.email).trim().toLowerCase(), reason });
  return !!claim;
}
// GET is NON-mutating (a mail-security link prefetcher must never auto-suppress a donor): it
// shows a confirm page whose form POSTs to the same URL. POST is the RFC 8058 one-click
// endpoint AND the form target; it records the suppression. Both always 200 (no existence leak).
app.get('/api/unsubscribe/:token', unsubscribeLimiter, (req, res) => {
  res.type('html').send(unsubscribePage({ confirmToken: req.params.token }));
});
app.post('/api/unsubscribe/:token', unsubscribeLimiter, (req, res) => {
  recordUnsubscribe(req.params.token, 'unsubscribe');
  res.type('html').send(unsubscribePage()); // 200 done page; mail clients ignore the body
});

// Pure assembly of the daily queue (shared by /api/today and /api/today/brief).
// Org-scoped; NO AI, NO send.
function assembleToday(userId, orgId) {
  const today = todayYmd();
  const reminders = listOpenReminders
    .all(userId, orgId)
    .filter((r) => r.due_date <= today)
    .map((r) => ({ ...r, overdue: r.due_date < today }))
    .slice(0, 25);
  const unthanked = listAwaitingThanks.all(userId, orgId).slice(0, 25);
  // One referrals read, reused for both the referred-set filter and the match-gift
  // worklist (was scanning the whole table twice per request).
  const allReferrals = listReferrals.all(userId, orgId);
  const referredIds = new Set(allReferrals.map((r) => r.connection_id).filter(Boolean));
  const prospects = listProspects
    .all(userId, orgId, 1)
    .filter((c) => !referredIds.has(c.id))
    .filter((c) => !c.snooze_until || c.snooze_until <= today)
    .slice(0, 10)
    .map(withReasons);
  // Donors at employer matching-gift companies (built-in list PLUS this org's custom
  // additions) → a "double their gift" worklist.
  const customMatchers = compileCustom(listOrgMatchCompanies.all(orgId));
  const matchGifts = allReferrals
    .filter((r) => r.donation_received && r.company)
    .map((r) => ({
      id: r.id, contact_name: r.contact_name, company: r.company,
      donation_amount: r.donation_amount, program: matchProgramWith(r.company, customMatchers),
    }))
    .filter((r) => r.program)
    .slice(0, 25);
  // Retention: previously-thanked, single-gift donors now in the re-ask window.
  const secondGifts = secondGiftLane(userId, orgId, allReferrals);
  return { today, reminders, unthanked, prospects, matchGifts, secondGifts };
}

app.get('/api/today', requireAuth, (req, res) => {
  res.json(assembleToday(req.user.id, orgScope(req)));
});

// L1 daily triage: the deterministic Today queue, run through ONE strategy-model
// pass that SUPPRESSES relationship-damaging items and flags genuine FORKS. It only
// hides/surfaces — never writes, never sends. Degrades to the raw queue when AI is
// off, the org's autoApplyTriage is off, the budget is spent, or the call errors —
// the brief must never 500.
app.get('/api/today/brief', requireAuth, aiLimiter, async (req, res) => {
  const userId = req.user.id;
  const orgId = orgScope(req);
  const base = assembleToday(userId, orgId);
  const autonomy = getAutonomy(orgId);
  if (!aiEnabled() || !autonomy.autoApplyTriage) {
    return res.json({ ...base, triage: { enabled: false, summary: '', suppressed: [], forks: [] } });
  }
  // Bounded candidate list with stable ref tokens the model echoes back.
  const items = [
    ...base.reminders.map((r) => ({ ref: `reminder:${r.id}`, kind: 'reminder', label: `Follow up with ${r.contact_name || 'a contact'}${r.company ? ` (${r.company})` : ''}`, context: r.referral_status || '' })),
    ...base.unthanked.map((r) => ({ ref: `unthanked:${r.id}`, kind: 'unthanked', label: `Thank ${r.contact_name || 'a donor'} for $${r.donation_amount || 0}`, context: '' })),
    ...base.prospects.map((p) => ({ ref: `prospect:${p.id}`, kind: 'prospect', label: `Ask ${p.contact_name || 'a prospect'}${p.company ? ` (${p.company})` : ''}`, context: (p.reasons || []).slice(0, 3).join(', ') })),
    ...base.matchGifts.map((m) => ({ ref: `match:${m.id}`, kind: 'match', label: `Ask ${m.contact_name || 'a donor'} to submit an employer match (${m.program})`, context: '' })),
    ...base.secondGifts.map((r) => ({ ref: `second:${r.id}`, kind: 'second', label: `Re-ask ${r.contact_name || 'a past donor'} for a second gift (gave $${r.donation_amount || 0}${r.daysAgo != null ? `, ${r.daysAgo}d ago` : ''})`, context: '' })),
  ];
  try {
    const t = await triageToday({ items, policy: autonomy.policy, cause: getOrgConfig(orgId), orgId });
    const suppressed = new Set(t.suppress.map((s) => s.ref));
    const keep = (kind, id) => !suppressed.has(`${kind}:${id}`);
    res.json({
      today: base.today,
      reminders: base.reminders.filter((r) => keep('reminder', r.id)),
      unthanked: base.unthanked.filter((r) => keep('unthanked', r.id)),
      prospects: base.prospects.filter((p) => keep('prospect', p.id)),
      matchGifts: base.matchGifts.filter((m) => keep('match', m.id)),
      secondGifts: base.secondGifts.filter((r) => keep('second', r.id)),
      triage: { enabled: true, summary: t.summary, suppressed: t.suppress, forks: t.forks },
    });
  } catch (e) {
    // Any AI/budget error → degrade to the raw queue (never 500 the daily brief).
    res.json({ ...base, triage: { enabled: false, summary: '', suppressed: [], forks: [], error: true } });
  }
});

// Snooze a prospect off the Today queue for N days (default 7).
app.post('/api/today/snooze', requireAuth, (req, res) => {
  const userId = req.user.id;
  const orgId = orgScope(req);
  const id = Number(req.body?.connectionId);
  const conn = getConnection.get(id, userId, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });
  const days = Number.isInteger(req.body?.days) && req.body.days > 0 ? req.body.days : 7;
  const until = addDays(todayYmd(), days);
  snoozeConnectionStmt.run(until, id, userId, orgId);
  res.json({ ok: true, connectionId: id, snoozeUntil: until });
});

// ── Custom matching-gift companies (manual add / CSV upload) ─────────────────
// List is visible to the whole org (it drives everyone's Today worklist); only
// owner/admin can add or remove. org_id is always the session org, never request input.
app.get('/api/match-companies', requireAuth, (req, res) => {
  res.json({ companies: listOrgMatchCompanies.all(orgScope(req)), builtInCount: MATCH_PROGRAM_COUNT });
});

app.post('/api/match-companies', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Company name is required.' });
  if (!orgMatchByName.get(orgId, name)) insertOrgMatchCompany.run(orgId, name, null);
  res.status(201).json({ companies: listOrgMatchCompanies.all(orgId) });
});

// Bulk add from a CSV upload (the client parses the file → a names array). Deduped,
// capped, and org-scoped; new rows only — never touches another tenant.
app.post('/api/match-companies/bulk', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  let added = 0;
  const tx = db.transaction(() => {
    for (const raw of names.slice(0, LIMITS.bulkMatchCompanies)) {
      const name = String(raw || '').trim().slice(0, 120);
      if (!name) continue;
      if (!orgMatchByName.get(orgId, name)) {
        insertOrgMatchCompany.run(orgId, name, null);
        added += 1;
      }
    }
  });
  tx();
  res.json({ added, companies: listOrgMatchCompanies.all(orgId) });
});

app.delete('/api/match-companies/:id', requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
  const orgId = orgScope(req);
  deleteOrgMatchCompany.run(Number(req.params.id), orgId);
  res.json({ companies: listOrgMatchCompanies.all(orgId) });
});

// ── Impact & dashboard stats ────────────────────────────────────
const getImpact = db.prepare('SELECT * FROM code_x_impact WHERE user_id = ? AND org_id = ?');
const countReferrals = db.prepare(
  'SELECT COUNT(*) AS n FROM referrals WHERE user_id = ? AND org_id = ?'
);

function buildImpact(userId) {
  recomputeImpact(userId);
  const orgId = _userOrgStmt.get(userId)?.org_id || DEFAULT_ORG_ID;
  const cfg = getOrgConfig(orgId);
  const impact = getImpact.get(userId, orgId) || {};
  const totalReferrals = countReferrals.get(userId, orgId).n;
  const converted = impact.num_referrals_converted || 0;
  return {
    totalRaised: impact.total_referred_donations || 0,
    studentsFunded: impact.num_students_supported || 0,
    daysFunded: impact.num_days_funded || 0,
    referralsConverted: converted,
    totalReferrals,
    conversionRate: totalReferrals ? converted / totalReferrals : 0,
    costPerBootcamp: cfg.impact?.programCost || COST_PER_BOOTCAMP,
    costPerDay: cfg.impact?.dayCost || COST_PER_DAY,
    bootcampDays: cfg.impact?.programDays || BOOTCAMP_DAYS,
    lastUpdatedAt: impact.last_updated_at || null,
  };
}

app.get('/api/impact', requireAuth, (req, res) => {
  res.json(buildImpact(req.user.id));
});

app.get('/api/stats', requireAuth, (req, res) => {
  const impact = buildImpact(req.user.id);
  res.json({
    totalReferrals: impact.totalReferrals,
    donationsReceived: impact.referralsConverted,
    totalRaised: impact.totalRaised,
    studentsSupported: impact.studentsFunded,
    daysFunded: impact.daysFunded,
  });
});

// ── Campaign Agent (Phase 2, reconciled onto the multi-tenant trunk) ─────────
// Cost is bounded by design: planning is ONE strategy-model call over the top-N
// candidates (not a per-prospect fan-out); per-message drafts are lazy, one Haiku
// call each, only when the user wants to send. Everything routes through lib/ai.js
// (per-org budget + economy tier + graceful no-key degradation). NOTHING here
// sends: approving an action queues a pipeline referral as 'to_ask' (NOT asked),
// and the human still sends each message by hand. EVERY statement is org-scoped
// via orgScope(req) — org_id is derived from the session, never request input.

// Server-sourced donation link (never from the client). enforceDonationLink uses
// its host as the ONLY allowed link in agent drafts/replies — so a per-org override
// is validated on READ here (https only, or http on localhost) and falls back to the
// trusted default otherwise, so even a future config-write path can't inject a
// javascript:/data:/cleartext host.
const ZEFFY_FORM_ID = process.env.ZEFFY_FORM_ID || 'fe71a2d0-1133-40ac-9032-897b66b0a7b1';
const DONATE_URL = process.env.DONATE_URL || `https://www.zeffy.com/en-US/donation-form/${ZEFFY_FORM_ID}`;
function donateUrlForOrg(orgId) {
  return cleanDonateUrl(getOrgConfig(orgId)?.donateUrl, DONATE_URL);
}

// Map AI-layer errors to clean HTTP responses (mirrors the inline pattern the
// dossier/draft/thank-you routes already use). Carries the flags CampaignPage reads.
function handleAiError(res, e) {
  if (e instanceof AIBudgetError) return res.status(429).json({ error: e.message, budgetExhausted: true });
  if (e instanceof AIDisabledError) return res.status(503).json({ error: e.message, aiDisabled: true });
  console.error('Campaign AI call failed:', e?.message);
  return res.status(502).json({ error: 'AI request failed. Please try again shortly.' });
}

// Distil a contact's aggregate history row (org-scoped) into the shape the prompt
// builders (historyBlock) expect; null when nothing was imported for this contact.
function loadHistory(userId, orgId, connectionId) {
  const h = historyForConnection.get(userId, orgId, connectionId);
  if (!h) return null;
  let snippets = [];
  try {
    snippets = h.snippets ? JSON.parse(h.snippets) : [];
  } catch {
    snippets = [];
  }
  return { ...h, snippets };
}

// The Campaign Agent's prompt builders (candidateBlock/prospectBlock) expect
// score_reasons as plain strings; this branch stores them as {label,...} objects,
// so normalise before handing a prospect/candidate to lib/campaign or lib/brief
// (otherwise the prompt would render "[object Object]").
function withReasonStrings(c) {
  const r = withReasons(c);
  const reasons = (Array.isArray(r.score_reasons) ? r.score_reasons : [])
    .map((x) => (x && x.label) || x)
    .filter(Boolean);
  return { ...r, score_reasons: reasons };
}

// Strip ALL URLs from model-authored, display-only planning notes (hook/rationale).
// They are shown in the planning UI but never sent, so they must carry NO links — an
// untrusted candidate snippet must not be able to surface a phishing URL the volunteer
// could click. (Outbound drafts/replies get enforceDonationLink instead.)
function stripUrls(s) {
  return String(s || '')
    .replace(/\bhttps?:\/\/[^\s<>()]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const PLAN_CANDIDATE_LIMIT = 12;
const listCampaignCandidates = db.prepare(`
  SELECT c.*,
         (SELECT 1 FROM contact_history h
           WHERE h.user_id = c.user_id AND h.org_id = c.org_id AND h.connection_id = c.id LIMIT 1) AS has_history
    FROM connections c
   WHERE c.user_id = @user_id
     AND c.org_id = @org_id
     AND c.donor_likelihood_score >= 1
     AND c.id NOT IN (
       SELECT connection_id FROM agent_actions
        WHERE campaign_id = @campaign_id AND user_id = @user_id AND org_id = @org_id
          AND connection_id IS NOT NULL AND status IN ('proposed','approved')
     )
     AND c.id NOT IN (
       -- Anyone already in the pipeline (any status) is being worked or is done;
       -- the planner proposes only NEW asks, never someone already contacted.
       SELECT connection_id FROM referrals
        WHERE user_id = @user_id AND org_id = @org_id AND connection_id IS NOT NULL
     )
   ORDER BY c.donor_likelihood_score DESC, c.capacity_score DESC, c.github_followers DESC
   LIMIT @limit
`);

const insertCampaign = db.prepare(`
  INSERT INTO campaigns (user_id, org_id, name, goal_amount, deadline, constraints)
  VALUES (@user_id, @org_id, @name, @goal_amount, @deadline, @constraints)
`);
const listCampaignsStmt = db.prepare('SELECT * FROM campaigns WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC');
const getCampaignStmt = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ? AND org_id = ?');
const updateCampaignStmt = db.prepare(`
  UPDATE campaigns SET name=@name, goal_amount=@goal_amount, deadline=@deadline,
    constraints=@constraints, status=@status, updated_at=CURRENT_TIMESTAMP
  WHERE id=@id AND user_id=@user_id AND org_id=@org_id
`);
const deleteCampaignStmt = db.prepare('DELETE FROM campaigns WHERE id = ? AND user_id = ? AND org_id = ?');
const deleteActionsForCampaign = db.prepare('DELETE FROM agent_actions WHERE campaign_id = ? AND user_id = ? AND org_id = ?');
const deleteRunsForCampaign = db.prepare('DELETE FROM agent_runs WHERE campaign_id = ? AND user_id = ? AND org_id = ?');
const deleteNightlyRunsForCampaign = db.prepare('DELETE FROM nightly_runs WHERE campaign_id = ? AND org_id = ?');

const insertActionStmt = db.prepare(`
  INSERT INTO agent_actions
    (campaign_id, user_id, org_id, connection_id, contact_name, kind, channel,
     suggested_ask, p_yes, expected_value, rationale, hook, scheduled_date, status)
  VALUES
    (@campaign_id, @user_id, @org_id, @connection_id, @contact_name, @kind, @channel,
     @suggested_ask, @p_yes, @expected_value, @rationale, @hook, @scheduled_date, 'proposed')
`);
const listActionsStmt = db.prepare(`
  SELECT * FROM agent_actions WHERE campaign_id = ? AND user_id = ? AND org_id = ?
   ORDER BY (status='proposed') DESC, expected_value DESC, created_at ASC
`);
const getActionStmt = db.prepare('SELECT * FROM agent_actions WHERE id = ? AND user_id = ? AND org_id = ?');
const updateActionStmt = db.prepare(`
  UPDATE agent_actions SET suggested_ask=@suggested_ask, scheduled_date=@scheduled_date,
    status=@status, draft=@draft, expected_value=@expected_value, updated_at=CURRENT_TIMESTAMP
  WHERE id=@id AND user_id=@user_id AND org_id=@org_id
`);
const setActionApproved = db.prepare(
  "UPDATE agent_actions SET status='approved', referral_id=@referral_id, updated_at=CURRENT_TIMESTAMP WHERE id=@id AND user_id=@user_id AND org_id=@org_id"
);
const setActionDraft = db.prepare(
  'UPDATE agent_actions SET draft=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND org_id=?'
);
const insertRunStmt = db.prepare(`
  INSERT INTO agent_runs (campaign_id, user_id, org_id, model, num_candidates, num_actions, strategy)
  VALUES (@campaign_id, @user_id, @org_id, @model, @num_candidates, @num_actions, @strategy)
`);

function campaignForClient(c) {
  if (!c) return c;
  return {
    id: c.id,
    name: c.name,
    goalAmount: c.goal_amount,
    deadline: c.deadline,
    constraints: c.constraints,
    status: c.status,
    createdAt: c.created_at,
  };
}
function actionForClient(a) {
  if (!a) return a;
  return {
    id: a.id,
    campaignId: a.campaign_id,
    connectionId: a.connection_id,
    contactName: a.contact_name,
    kind: a.kind,
    channel: a.channel,
    suggestedAsk: a.suggested_ask,
    pYes: a.p_yes,
    expectedValue: a.expected_value,
    rationale: a.rationale,
    hook: a.hook,
    draft: a.draft || '',
    scheduledDate: a.scheduled_date,
    status: a.status,
    referralId: a.referral_id,
  };
}
function campaignProgress(campaignId, userId, orgId) {
  const actions = listActionsStmt.all(campaignId, userId, orgId);
  const counts = { proposed: 0, approved: 0, skipped: 0 };
  const refIds = [];
  for (const a of actions) {
    counts[a.status] = (counts[a.status] || 0) + 1;
    if (a.referral_id) refIds.push(a.referral_id);
  }
  // Which linked referrals actually converted? (Both the amount AND the set, so a
  // converted approval isn't double-counted in the projection below.)
  let raised = 0;
  const donatedRefs = new Set();
  if (refIds.length) {
    const rows = db
      .prepare(
        `SELECT id, donation_amount FROM referrals
          WHERE user_id = ? AND org_id = ? AND donation_received = 1 AND id IN (${refIds.map(() => '?').join(',')})`
      )
      .all(userId, orgId, ...refIds);
    for (const r of rows) {
      donatedRefs.add(r.id);
      raised += r.donation_amount || 0;
    }
  }
  let projected = 0;
  const countedRefs = new Set();
  for (const a of actions) {
    if (a.status === 'proposed') {
      projected += a.expected_value || 0;
    } else if (a.status === 'approved' && !donatedRefs.has(a.referral_id)) {
      // Dedupe by referral_id so two approved actions linked to the SAME queued
      // referral can't project the one outstanding ask twice (latent-invariant guard).
      if (a.referral_id && countedRefs.has(a.referral_id)) continue;
      if (a.referral_id) countedRefs.add(a.referral_id);
      projected += a.expected_value || 0;
    }
  }
  return { counts, total: actions.length, projectedValue: Math.round(projected), raised };
}

app.post('/api/campaigns', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const name = String(req.body?.name || '').trim().slice(0, 120) || 'Untitled campaign';
  const goal = Math.max(0, Math.min(100_000_000, Number(req.body?.goalAmount) || 0));
  const deadline = req.body?.deadline ? String(req.body.deadline).slice(0, 40) : null;
  const constraints = req.body?.constraints ? String(req.body.constraints).trim().slice(0, 2000) : null;
  const info = insertCampaign.run({
    user_id: req.user.id,
    org_id: orgId,
    name,
    goal_amount: goal,
    deadline,
    constraints,
  });
  res.status(201).json({ campaign: campaignForClient(getCampaignStmt.get(info.lastInsertRowid, req.user.id, orgId)) });
});

app.get('/api/campaigns', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const campaigns = listCampaignsStmt.all(req.user.id, orgId).map((c) => ({
    ...campaignForClient(c),
    progress: campaignProgress(c.id, req.user.id, orgId),
  }));
  res.json({ campaigns });
});

app.get('/api/campaigns/:id', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const c = getCampaignStmt.get(id, req.user.id, orgId);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({
    campaign: campaignForClient(c),
    actions: listActionsStmt.all(id, req.user.id, orgId).map(actionForClient),
    progress: campaignProgress(id, req.user.id, orgId),
  });
});

app.patch('/api/campaigns/:id', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const c = getCampaignStmt.get(id, req.user.id, orgId);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const name =
    req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) || c.name : c.name;
  const goal =
    req.body?.goalAmount !== undefined
      ? Math.max(0, Math.min(100_000_000, Number(req.body.goalAmount) || 0))
      : c.goal_amount;
  const deadline =
    req.body?.deadline !== undefined ? (req.body.deadline ? String(req.body.deadline).slice(0, 40) : null) : c.deadline;
  const constraints =
    req.body?.constraints !== undefined
      ? req.body.constraints
        ? String(req.body.constraints).trim().slice(0, 2000)
        : null
      : c.constraints;
  const status = ['active', 'archived'].includes(req.body?.status) ? req.body.status : c.status;
  updateCampaignStmt.run({ id, user_id: req.user.id, org_id: orgId, name, goal_amount: goal, deadline, constraints, status });
  res.json({ campaign: campaignForClient(getCampaignStmt.get(id, req.user.id, orgId)) });
});

app.delete('/api/campaigns/:id', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  if (!getCampaignStmt.get(id, req.user.id, orgId)) return res.status(404).json({ error: 'Campaign not found.' });
  deleteActionsForCampaign.run(id, req.user.id, orgId);
  deleteRunsForCampaign.run(id, req.user.id, orgId);
  deleteNightlyRunsForCampaign.run(id, orgId); // no orphan idempotency rows
  deleteCampaignStmt.run(id, req.user.id, orgId);
  res.json({ ok: true });
});

// The planner: ONE strategy-model call over the top-N candidates → proposed actions.
// ── L2: the nightly Standing Planner ─────────────────────────────────────────
// agent_actions double as "Moves". The nightly tick re-plans each active campaign
// once/day (idempotent via nightly_runs), stages the moves, and — when the org's
// autonomy.autoApproveMoves is on — auto-approves them. CRITICAL: auto-approve only
// QUEUES a 'to_ask' referral (the existing no-send approval path); it NEVER sends and
// NEVER records a gift. The tenant boundary is re-derived from the campaign row
// (campaign.user_id / org_id), never a session.
const insertNightlyMove = db.prepare(`
  INSERT INTO agent_actions
    (campaign_id, user_id, org_id, connection_id, contact_name, kind, channel,
     suggested_ask, p_yes, expected_value, rationale, hook, scheduled_date, status,
     source, approval_tier, brief_date)
  VALUES
    (@campaign_id, @user_id, @org_id, @connection_id, @contact_name, @kind, @channel,
     @suggested_ask, @p_yes, @expected_value, @rationale, @hook, @scheduled_date, 'proposed',
     'nightly', @approval_tier, @brief_date)
`);
const listActiveCampaignsForOrg = db.prepare("SELECT * FROM campaigns WHERE org_id = ? AND status = 'active' ORDER BY id");
const allOrgIdsStmt = db.prepare('SELECT id FROM organizations ORDER BY id');
// INSERT OR IGNORE is the atomic claim — its `.changes` tells the caller whether it
// won the slot (1) or someone already holds it today (0). update/delete maintain it.
const insertNightlyRun = db.prepare('INSERT OR IGNORE INTO nightly_runs (org_id, campaign_id, run_date, num_moves) VALUES (?, ?, ?, ?)');
const updateNightlyRunCount = db.prepare('UPDATE nightly_runs SET num_moves = ? WHERE campaign_id = ? AND run_date = ?');
const deleteNightlyRun = db.prepare('DELETE FROM nightly_runs WHERE campaign_id = ? AND run_date = ?');
const listBriefMoves = db.prepare(`
  SELECT * FROM agent_actions
   WHERE user_id = ? AND org_id = ? AND source = 'nightly' AND brief_date = ?
   ORDER BY (approval_tier='ask') DESC, expected_value DESC, id ASC
`);

// Approve a Move → queue a 'to_ask' pipeline referral. NO send: the human sends by
// hand. The SINGLE no-send approval path, shared by the manual approve route AND the
// nightly auto-approve. Scoped to (userId, orgId); returns the referral id (or null).
function approveActionToReferral(action, userId, orgId) {
  if (action.status === 'approved' && action.referral_id) return action.referral_id;
  let referralId = null;
  if (action.connection_id) {
    const conn = getConnection.get(action.connection_id, userId, orgId);
    if (conn) {
      const existing = findReferralForConnection.get(userId, orgId, action.connection_id);
      referralId = existing
        ? existing.id
        : insertReferral.run({
            user_id: userId, org_id: orgId, connection_id: conn.id,
            contact_name: conn.contact_name, contact_email: conn.contact_email,
            company: conn.company, linkedin_url: conn.linkedin_url,
            status: 'to_ask', // QUEUED, not asked — preserves the no-send guarantee
          }).lastInsertRowid;
    }
  }
  setActionApproved.run({ id: action.id, user_id: userId, org_id: orgId, referral_id: referralId });
  return referralId;
}

// Display grouping for the Morning Brief: net-new asks surface first; follow-ups and
// thank-yous are routine. Exported for offline unit tests.
export function moveTierFor(kind) {
  return kind === 'ask' ? 'ask' : 'routine';
}

// Persist a generated plan as nightly Moves for ONE campaign; auto-approve when the
// org's dial is on. Validates plan ids against the candidate set (drops hallucinated
// ids). Auto-approve only queues 'to_ask' — never sends, never records a gift.
function persistNightlyMoves({ campaign, plan, candidates, autonomy, userId, orgId, today }) {
  const allowed = new Map(candidates.map((c) => [c.id, c]));
  let staged = 0;
  let approved = 0;
  const tx = db.transaction(() => {
    for (const a of Array.isArray(plan.actions) ? plan.actions : []) {
      const cand = allowed.get(Number(a.connectionId));
      if (!cand) continue; // drop hallucinated / out-of-set ids
      const kind = ['ask', 'followup', 'thanks', 'second_ask'].includes(a.kind) ? a.kind : 'ask';
      const ask = Math.max(0, Math.min(1_000_000, parseInt(a.suggestedAsk, 10) || 0));
      const pYes = Math.max(0, Math.min(100, parseInt(a.pYes, 10) || 0));
      const offset = Math.max(0, Math.min(120, parseInt(a.scheduleOffsetDays, 10) || 0));
      const info = insertNightlyMove.run({
        campaign_id: campaign.id, user_id: userId, org_id: orgId,
        connection_id: cand.id, contact_name: cand.contact_name, kind,
        channel: ['linkedin', 'email', 'text', 'in_person'].includes(a.channel) ? a.channel : 'linkedin',
        suggested_ask: ask, p_yes: pYes, expected_value: Math.round((pYes / 100) * ask),
        rationale: stripUrls(a.rationale).slice(0, 500), hook: stripUrls(a.hook).slice(0, 400),
        scheduled_date: addDays(today, offset), approval_tier: moveTierFor(kind), brief_date: today,
      });
      staged++;
      if (autonomy.autoApproveMoves) {
        approveActionToReferral(getActionStmt.get(info.lastInsertRowid, userId, orgId), userId, orgId);
        approved++;
      }
    }
  });
  tx();
  return { staged, approved };
}

// Plan + stage ONE campaign for the day (idempotent via nightly_runs). One strategy
// call. AI/budget errors are swallowed so one campaign can't crash the whole tick.
async function runNightlyForCampaign(campaign, today) {
  const orgId = campaign.org_id || DEFAULT_ORG_ID;
  const userId = campaign.user_id;
  // CLAIM today's slot ATOMICALLY before any spend or staging. INSERT OR IGNORE +
  // changes===0 means the cron OR an on-demand /api/brief/run already claimed this
  // campaign today → abort. better-sqlite3 is synchronous, so the read+write is one
  // step with no await between them: two concurrent callers can't both win the claim.
  // This is the single idempotency gate (replaces the old check-then-act across the
  // await, which let two callers both plan + stage duplicates).
  if (insertNightlyRun.run(orgId, campaign.id, today, 0).changes === 0) return { skipped: true };
  const autonomy = getAutonomy(orgId);
  const candidates = listCampaignCandidates
    .all({ user_id: userId, org_id: orgId, campaign_id: campaign.id, limit: PLAN_CANDIDATE_LIMIT })
    .map((c) => ({ ...withReasonStrings(c), has_history: !!c.has_history }));
  if (!candidates.length) return { staged: 0, approved: 0 }; // slot claimed (0 moves) → won't re-plan today
  let r;
  try {
    const plan = await generatePlan({ campaign, candidates, cause: getOrgConfig(orgId), orgId });
    // persistNightlyMoves stages all moves in ONE transaction (atomic all-or-nothing).
    r = persistNightlyMoves({ campaign, plan, candidates, autonomy, userId, orgId, today });
    r.strategy = String(plan.strategy || '').slice(0, 2000);
  } catch (e) {
    // generatePlan threw, or persistNightlyMoves rolled back → NOTHING was durably
    // staged. Release the claim so a later tick can retry (no duplicates possible).
    deleteNightlyRun.run(campaign.id, today);
    return { error: e.name || 'error' };
  }
  // Moves are committed. The move-count update + audit-run ledger are non-critical
  // metadata: a failure here must NOT release the claim (moves are real) or surface.
  try {
    updateNightlyRunCount.run(r.staged, campaign.id, today);
    insertRunStmt.run({
      campaign_id: campaign.id, user_id: userId, org_id: orgId, model: MODELS.strategy,
      num_candidates: candidates.length, num_actions: r.staged, strategy: r.strategy,
    });
  } catch {
    /* best-effort metadata */
  }
  return r;
}

// Run the nightly planner for ONE org's active campaigns. org_id from the caller, not
// a session for the cron path. No-op when AI is unavailable.
async function runNightlyForOrg(orgId, today) {
  if (!aiEnabled()) return { enabled: false, campaigns: 0, staged: 0, approved: 0 };
  let staged = 0;
  let approved = 0;
  let planned = 0;
  for (const c of listActiveCampaignsForOrg.all(orgId)) {
    const r = await runNightlyForCampaign(c, today);
    if (r.staged !== undefined) {
      staged += r.staged;
      approved += r.approved || 0;
      planned++;
    }
  }
  return { enabled: true, campaigns: planned, staged, approved };
}

// Run the nightly planner across EVERY org. The tenant boundary is re-established from
// each campaign row — there is no session here, so a single mis-scoped statement would
// leak across tenants (guarded by the cron-isolation test). Exported for that test +
// on-demand triggering.
export async function runNightlyPlanning(today = todayYmd()) {
  if (!aiEnabled()) return { enabled: false };
  const totals = { enabled: true, orgs: 0, staged: 0, approved: 0 };
  for (const { id } of allOrgIdsStmt.all()) {
    const r = await runNightlyForOrg(id, today);
    if (r.enabled) {
      totals.orgs++;
      totals.staged += r.staged;
      totals.approved += r.approved;
    }
  }
  return totals;
}

// Morning Brief — today's nightly-staged Moves for the caller, grouped by tier so the
// human's eye goes to net-new asks first. Read-only; org-scoped.
app.get('/api/brief', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const today = todayYmd();
  const moves = listBriefMoves.all(req.user.id, orgId, today).map((m) => ({ ...actionForClient(m), tier: m.approval_tier }));
  res.json({
    date: today,
    autoApproved: moves.filter((m) => m.status === 'approved'),
    needsReview: moves.filter((m) => m.status === 'proposed'),
    total: moves.length,
    autonomy: getAutonomy(orgId),
  });
});

// On-demand: run the nightly planner for the caller's org NOW (owner/admin), so an
// admin can populate the Morning Brief without waiting for the cron. Idempotent/day.
app.post('/api/brief/run', requireAuth, requireOrgRole('owner', 'admin'), async (req, res) => {
  const orgId = orgScope(req);
  if (!aiEnabled()) return res.json({ enabled: false, message: 'AI is off. Nightly planning is unavailable.' });
  try {
    res.json(await runNightlyForOrg(orgId, todayYmd()));
  } catch (e) {
    handleAiError(res, e);
  }
});

app.post('/api/campaigns/:id/plan', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const campaign = getCampaignStmt.get(id, req.user.id, orgId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const candidates = listCampaignCandidates
    .all({ user_id: req.user.id, org_id: orgId, campaign_id: id, limit: PLAN_CANDIDATE_LIMIT })
    .map((c) => ({ ...withReasonStrings(c), has_history: !!c.has_history }));
  if (!candidates.length) {
    return res.json({
      strategy: '',
      actions: [],
      progress: campaignProgress(id, req.user.id, orgId),
      message:
        'No new prospects to plan. Your strongest contacts are already queued, declined, or have given. Import more connections, or skip or clear some actions, then re-plan.',
    });
  }

  try {
    const plan = await generatePlan({
      campaign,
      candidates,
      cause: getOrgConfig(orgId),
      orgId,
    });
    const allowed = new Map(candidates.map((c) => [c.id, c]));
    const created = [];
    const insertMany = db.transaction((actions) => {
      for (const a of actions) {
        const cand = allowed.get(Number(a.connectionId));
        if (!cand) continue; // drop hallucinated / out-of-set ids
        const ask = Math.max(0, Math.min(1_000_000, parseInt(a.suggestedAsk, 10) || 0));
        const pYes = Math.max(0, Math.min(100, parseInt(a.pYes, 10) || 0));
        const offset = Math.max(0, Math.min(120, parseInt(a.scheduleOffsetDays, 10) || 0));
        const d = new Date();
        d.setDate(d.getDate() + offset);
        const info = insertActionStmt.run({
          campaign_id: id,
          user_id: req.user.id,
          org_id: orgId,
          connection_id: cand.id,
          contact_name: cand.contact_name,
          kind: ['ask', 'followup', 'thanks'].includes(a.kind) ? a.kind : 'ask',
          channel: ['linkedin', 'email', 'text', 'in_person'].includes(a.channel) ? a.channel : 'linkedin',
          suggested_ask: ask,
          p_yes: pYes,
          expected_value: Math.round((pYes / 100) * ask),
          rationale: stripUrls(a.rationale).slice(0, 500),
          hook: stripUrls(a.hook).slice(0, 400),
          scheduled_date: d.toISOString().slice(0, 10),
        });
        created.push(getActionStmt.get(info.lastInsertRowid, req.user.id, orgId));
      }
    });
    insertMany(Array.isArray(plan.actions) ? plan.actions : []);
    insertRunStmt.run({
      campaign_id: id,
      user_id: req.user.id,
      org_id: orgId,
      model: MODELS.strategy,
      num_candidates: candidates.length,
      num_actions: created.length,
      strategy: String(plan.strategy || '').slice(0, 2000),
    });
    res.json({
      strategy: String(plan.strategy || ''),
      actions: created.map(actionForClient),
      progress: campaignProgress(id, req.user.id, orgId),
    });
  } catch (e) {
    handleAiError(res, e);
  }
});

// Approve a proposed action → adds it to the pipeline as a referral. Status is
// 'to_ask' (QUEUED, not asked): approving never sends; the human sends by hand.
app.post('/api/actions/:id/approve', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const action = getActionStmt.get(id, req.user.id, orgId);
  if (!action) return res.status(404).json({ error: 'Action not found.' });
  const alreadyApproved = action.status === 'approved' && !!action.referral_id;
  const referralId = approveActionToReferral(action, req.user.id, orgId); // the single no-send approval path
  recomputeImpact(req.user.id);
  res.json({ action: actionForClient(getActionStmt.get(id, req.user.id, orgId)), referralId, alreadyApproved });
});

// Edit an action's ask size / schedule / draft, or skip it.
app.patch('/api/actions/:id', requireAuth, (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const a = getActionStmt.get(id, req.user.id, orgId);
  if (!a) return res.status(404).json({ error: 'Action not found.' });
  const ask =
    req.body?.suggestedAsk !== undefined
      ? Math.max(0, Math.min(1_000_000, parseInt(req.body.suggestedAsk, 10) || 0))
      : a.suggested_ask;
  const scheduled =
    req.body?.scheduledDate !== undefined
      ? req.body.scheduledDate
        ? String(req.body.scheduledDate).slice(0, 10)
        : null
      : a.scheduled_date;
  // Approvals MUST go through POST /api/actions/:id/approve (which queues the
  // 'to_ask' pipeline referral) — so this generic PATCH only routes proposed↔skipped,
  // never 'approved'. Keeps a single, no-send-guaranteed approval path.
  const status = ['proposed', 'skipped'].includes(req.body?.status) ? req.body.status : a.status;
  const draft = req.body?.draft !== undefined ? String(req.body.draft).slice(0, 4000) : a.draft;
  updateActionStmt.run({
    id,
    user_id: req.user.id,
    org_id: orgId,
    suggested_ask: ask,
    scheduled_date: scheduled,
    status,
    draft,
    expected_value: Math.round(((a.p_yes || 0) / 100) * ask),
  });
  res.json({ action: actionForClient(getActionStmt.get(id, req.user.id, orgId)) });
});

// Lazily draft the message for one action (in the user's voice). Returns text;
// never sends. One Haiku call (MODELS.draft) through lib/ai.js.
app.post('/api/actions/:id/draft', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  const id = Number(req.params.id);
  const action = getActionStmt.get(id, req.user.id, orgId);
  if (!action) return res.status(404).json({ error: 'Action not found.' });
  if (!action.connection_id) return res.status(400).json({ error: 'This action has no linked connection to draft for.' });
  const conn = getConnection.get(action.connection_id, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });
  try {
    const draft = await generateDraft({
      prospect: withReasonStrings(conn),
      history: loadHistory(req.user.id, orgId, action.connection_id),
      voiceSample: voiceSampleForUser.get(req.user.id, orgId)?.sample || '',
      cause: getOrgConfig(orgId),
      kind: action.kind || 'ask',
      amount: undefined,
      donateUrl: donateUrlForOrg(orgId), // server-sourced; never from the client
      scoutFirstName: (req.user.name || '').trim().split(/\s+/)[0] || '',
      orgId,
    });
    setActionDraft.run(String(draft).slice(0, 4000), id, req.user.id, orgId);
    res.json({ action: actionForClient(getActionStmt.get(id, req.user.id, orgId)) });
  } catch (e) {
    handleAiError(res, e);
  }
});

// ── L1: the conversation drives the pipeline ─────────────────────────────────
// Map a classified reply intent → a REVERSIBLE pipeline move. NEVER records a gift
// (already_gave is a human fork) and NEVER sends. Exported for offline unit tests.
export function stateChangeForIntent(intent) {
  switch (intent) {
    case 'interested': return { kind: 'advance', followDays: 3 };
    case 'hesitant': return { kind: 'advance', followDays: 5 };
    case 'not_now': return { kind: 'snooze', followDays: 30 };
    case 'declined': return { kind: 'decline' };
    case 'already_gave': return { kind: 'record_gift_fork' };
    default: return { kind: 'none' };
  }
}

// Apply the reversible portion of a reply-derived state change to an EXISTING
// referral. Returns a summary of what changed, or null if nothing was applied. All
// writes scoped to (referral.id, userId, orgId); never sends, never records a gift.
function applyReplyStateChange({ intent, userId, orgId, referral }) {
  if (!referral) return null;
  const sc = stateChangeForIntent(intent);
  const today = todayYmd();
  if (sc.kind === 'advance') {
    const followUp = addDays(today, sc.followDays);
    updateReferralFields.run('following_up', referral.note ?? null, followUp, referral.id, userId, orgId);
    return { kind: 'advance', status: 'following_up', followUp };
  }
  if (sc.kind === 'snooze') {
    const followUp = addDays(today, sc.followDays);
    setReferralFollowUp.run(followUp, referral.id, userId, orgId);
    return { kind: 'snooze', followUp };
  }
  if (sc.kind === 'decline') {
    updateReferralFields.run('declined', referral.note ?? null, null, referral.id, userId, orgId);
    closeReferralReminders(referral.id, userId, orgId, 'declined');
    return { kind: 'decline', status: 'declined' };
  }
  return null; // record_gift_fork / none → no auto mutation (human fork)
}

// Conversation-native: paste a reply, get a drafted response in your voice + the
// classified intent, and (with auto-accept on) the reversible pipeline move applied.
// Returns text + intent only — NEVER sends, NEVER records a gift. One Haiku JSON call.
app.post('/api/ai/reply', requireAuth, aiLimiter, async (req, res) => {
  const orgId = orgScope(req);
  const connectionId = Number(req.body?.connectionId);
  const theirMessage = String(req.body?.theirMessage || '').trim();
  if (!theirMessage) return res.status(400).json({ error: 'Paste the message you received first.' });
  const conn = getConnection.get(connectionId, req.user.id, orgId);
  if (!conn) return res.status(404).json({ error: 'Prospect not found.' });
  try {
    const { intent, confidence, draft } = await classifyReply({
      prospect: withReasonStrings(conn),
      history: loadHistory(req.user.id, orgId, connectionId),
      voiceSample: voiceSampleForUser.get(req.user.id, orgId)?.sample || '',
      cause: getOrgConfig(orgId),
      theirMessage,
      donateUrl: donateUrlForOrg(orgId), // server-sourced; never from the client
      scoutFirstName: (req.user.name || '').trim().split(/\s+/)[0] || '',
      orgId,
    });
    const autonomy = getAutonomy(orgId);
    const referral = findReferralForConnection.get(req.user.id, orgId, connectionId);
    let applied = null;
    let fork = null;
    if (intent === 'already_gave') {
      // A claimed gift is ALWAYS a human fork — we never record an amount from a
      // parsed message (no-send / no-fabricate); the human enters the gift.
      fork = { kind: 'record_gift', connectionId, referralId: referral?.id ?? null, contactName: conn.contact_name || null };
    } else if (autonomy.autoAcceptReplies) {
      applied = applyReplyStateChange({ intent, userId: req.user.id, orgId, referral });
    }
    res.json({ draft, intent, confidence, applied, fork, autoAccept: autonomy.autoAcceptReplies });
  } catch (e) {
    handleAiError(res, e);
  }
});

// ── Serve built client in production ────────────────────────────
const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ── Error handler ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Log with request context (id + org) so a 500 is traceable, but never leak the
  // error detail to the client. If the response already started, defer to Express.
  const ctx = { id: req.id, org: req.user?.org_id, method: req.method, path: req.path };
  console.error('Unhandled error:', err?.stack || err?.message || err, JSON.stringify(ctx));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

// Process-level crash guards: a stray rejection or throw in async code (a bad mailer
// call, an unexpected DB error) must not silently wedge the single shared process for
// every tenant. Log structured, and on an uncaughtException exit so the supervisor
// restarts a clean process rather than serving undefined state. Registered only for the
// real server (the node:test runner manages the process itself).
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason?.stack || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err?.stack || err);
    process.exit(1);
  });
}

// Start the HTTP listener unless we're being imported by a test harness
// (SKIP_LISTEN), which drives the Express `app` directly with supertest-style
// requests against an isolated DATA_DIR database.
if (process.env.SKIP_LISTEN !== '1') {
  installCrashGuards();
  app.listen(PORT, () => {
    console.log(`\n  Code for Ukraine — Donor Scout API`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  LinkedIn OIDC: ${LINKEDIN_CONFIGURED ? 'enabled' : 'NOT configured (demo login only)'}`);
    console.log(`  GitHub enrichment: ${HAS_GH_TOKEN ? 'authenticated (30/min)' : 'unauthenticated (10/min, capped)'}`);
    // AI preflight: confirm the key works at boot and say so loudly, instead of silently
    // serving fallbacks if the key is bad. One ~1-token call; never blocks the listener.
    if (!aiEnabled()) {
      console.log('  AI: OFF (no ANTHROPIC_API_KEY) — features use static fallbacks\n');
    } else {
      aiPreflight().then((p) => {
        if (p.ok) console.log(`  AI: ON (tier=${p.tier}, strategy=${p.models.strategy}, draft=${p.models.draft})\n`);
        else console.warn(`  AI: KEY PRESENT BUT FAILING (${p.status || ''} ${p.error}) — features will fall back. Check ANTHROPIC_API_KEY.\n`);
      });
    }
  });

  // L2 nightly Standing Planner. Runs hourly from NIGHTLY_HOUR onward; the per-campaign
  // nightly_runs guard makes it idempotent (each campaign plans at most once/day). Only
  // armed when AI is configured (no point otherwise); never runs under the test harness
  // (SKIP_LISTEN gates this whole block).
  if (aiEnabled()) {
    const NIGHTLY_HOUR = Number(process.env.NIGHTLY_HOUR || 4);
    const tick = () => {
      try {
        if (new Date().getHours() >= NIGHTLY_HOUR) {
          runNightlyPlanning().catch((e) => console.error('nightly planning:', e.message));
        }
      } catch (e) {
        console.error('nightly tick:', e.message);
      }
    };
    const timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref?.(); // don't keep the process alive for the timer alone
    console.log(`  Nightly planner: armed (runs hourly from ${NIGHTLY_HOUR}:00)\n`);
  }
}

// Exported for the node:test suites (multi-tenancy isolation, roles, onboarding).
// These give tests a real Express app + the same DB connection without binding a
// port. NOT part of the public HTTP surface.
export { app, db, DEFAULT_ORG_ID };
