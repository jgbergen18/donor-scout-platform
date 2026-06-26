/**
 * lib/ai.js — the single entry point for every Claude call in Donor Scout.
 * ----------------------------------------------------------------------------
 * Why one module: it keeps model choice, structured-output plumbing, prompt
 * caching, cost guards, and graceful degradation in one place so the feature
 * code (dossiers, drafting, the campaign agent) just asks for "JSON matching
 * this schema" or "text" and never touches the SDK directly.
 *
 * Graceful degradation: if ANTHROPIC_API_KEY is unset the app still runs — the
 * AI features report `enabled: false` and callers fall back to the existing
 * heuristics (mirrors how GitHub enrichment degrades without GITHUB_TOKEN).
 */
import Anthropic from '@anthropic-ai/sdk';

// Two model tiers so cost can be dialed without touching feature code.
//   economy (DEFAULT): Sonnet for judgement-heavy strategy, Haiku for the
//     high-volume drafting/extraction — the cheapest viable mix.
//   standard: Opus for strategy, Sonnet for drafting — higher quality, pricier.
// Set AI_MODEL_TIER=standard to upgrade.
const TIER = (process.env.AI_MODEL_TIER || 'economy').toLowerCase();
export const MODELS =
  TIER === 'economy'
    ? { strategy: 'claude-sonnet-4-6', draft: 'claude-haiku-4-5' }
    : { strategy: 'claude-opus-4-8', draft: 'claude-sonnet-4-6' };

// Per-model pricing, $ per 1M tokens (input / output). Cache reads bill ~0.1x
// input; cache writes ~1.25x input (5-min TTL). Used for the dollar budget.
const PRICING = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Models that support adaptive thinking (the 4.6+ family / Fable). Notably
// Haiku 4.5 — our default draft model — does NOT; sending it adaptive thinking
// 400s, so we only attach thinking when the chosen model supports it.
const ADAPTIVE_OK = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-fable-5',
]);

const apiKey = process.env.ANTHROPIC_API_KEY || '';
export const aiEnabled = () => !!apiKey;

let _client = null;
function getClient() {
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

// Boot-time health check: confirm the key actually works (catches a bad/expired key loudly
// instead of silently degrading to fallbacks). One minimal Haiku call (~1 token, trivial
// cost). Returns { enabled, ok, tier, models, status?, error? } — never throws.
export async function preflight() {
  const client = getClient();
  if (!client) return { enabled: false, ok: false };
  try {
    await client.messages.create({ model: MODELS.draft, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    return { enabled: true, ok: true, tier: TIER, models: MODELS };
  } catch (e) {
    return { enabled: true, ok: false, status: e?.status, error: e?.message || String(e), tier: TIER, models: MODELS };
  }
}

// ── Errors callers can map to HTTP responses ────────────────────────────────
export class AIDisabledError extends Error {
  constructor() {
    super('AI features are disabled (no ANTHROPIC_API_KEY configured).');
    this.name = 'AIDisabledError';
    this.status = 503;
  }
}
export class AIBudgetError extends Error {
  constructor() {
    super('Daily AI spending limit reached. AI features will resume after the 24h window resets.');
    this.name = 'AIBudgetError';
    this.status = 429;
  }
}

// ── Cost guard: rolling 24h DOLLAR budget with PRE-FLIGHT RESERVATION ────────
// Two-layer protection so spend cannot exceed AI_DAILY_BUDGET_USD:
//   1. Before every call we compute the call's WORST-CASE cost (full max_tokens
//      of output + an input estimate) and REFUSE it if realized spend + all
//      in-flight reservations + this worst case would exceed the budget. This
//      stops both the "single big call blows the cap" and the "N concurrent
//      calls all pass a stale check" overshoots.
//   2. After the call we replace the reservation with the actual measured cost.
// State is optionally persisted (configureSpendStore) so a restart / second
// instance can't reset the window. The provider-side spending limit remains the
// ultimate backstop.
const DAILY_BUDGET_USD = Number(process.env.AI_DAILY_BUDGET_USD || 5);
const WINDOW_MS = 24 * 60 * 60 * 1000;
let _usdSpent = 0; // realized spend in the current window (GLOBAL — the dollar ceiling)
let _reserved = 0; // optimistic worst-case holds for in-flight calls (GLOBAL)
let _windowStart = Date.now();
let _store = null; // optional { load(): {windowStart,usdSpent}|null, save(windowStart,usdSpent) }

// Per-tenant fairness (Phase 2.5a): in addition to the GLOBAL dollar ceiling
// above (which is the hard cost backstop, persisted across restarts), each org
// gets its own daily sub-budget so one tenant can't exhaust the shared budget
// and 429 everyone else. The sub-budget is in-memory only — a restart resetting
// it can't overspend, because the persisted global ceiling still binds.
const DAILY_BUDGET_PER_ORG_USD = Number(process.env.AI_DAILY_BUDGET_PER_ORG_USD || DAILY_BUDGET_USD);
const SENTINEL_ORG = 0; // for calls that arrive without an org id
const _orgBuckets = new Map(); // orgId → { usdSpent, reserved, windowStart }
function orgBucket(orgId) {
  const key = orgId == null ? SENTINEL_ORG : orgId;
  let b = _orgBuckets.get(key);
  if (!b) {
    b = { usdSpent: 0, reserved: 0, windowStart: Date.now() };
    _orgBuckets.set(key, b);
  }
  // Roll this bucket's own 24h window independently of the global window. Reset
  // only realized spend — NOT `reserved` — exactly mirroring the global
  // rollWindow(): in-flight holds drain via release(), so an await that straddles
  // the boundary can't have its reservation zeroed out from under it.
  if (Date.now() - b.windowStart > WINDOW_MS) {
    b.usdSpent = 0;
    b.windowStart = Date.now();
  }
  return b;
}

/** Wire a persistent spend store (e.g. the app's SQLite DB) so the budget
 *  survives restarts and is shared across instances. Safe to call once at boot. */
export function configureSpendStore(store) {
  _store = store;
  try {
    const s = store?.load?.();
    if (s && typeof s.usdSpent === 'number' && typeof s.windowStart === 'number') {
      if (Date.now() - s.windowStart <= WINDOW_MS) {
        _usdSpent = s.usdSpent;
        _windowStart = s.windowStart;
      }
    }
  } catch {
    /* ignore — fall back to in-memory */
  }
}
function persist() {
  try {
    _store?.save?.(_windowStart, _usdSpent);
  } catch {
    /* persistence is best-effort */
  }
}

function rollWindow() {
  if (Date.now() - _windowStart > WINDOW_MS) {
    _usdSpent = 0;
    _windowStart = Date.now();
    persist();
  }
}
function priceFor(model) {
  return PRICING[model] || PRICING['claude-sonnet-4-6'];
}
function costOf(model, usage) {
  const p = priceFor(model);
  return (
    ((usage.input_tokens || 0) * p.in +
      (usage.output_tokens || 0) * p.out +
      (usage.cache_read_input_tokens || 0) * p.in * 0.1 + // cache reads ~0.1x in
      (usage.cache_creation_input_tokens || 0) * p.in * 1.25) / // cache writes ~1.25x in
    1_000_000
  );
}
// Upper bound on a call's cost BEFORE it runs: full max_tokens of output at the
// model's output rate + a rough input estimate (~4 chars/token + overhead).
function worstCaseCost(model, maxTokens, charLen) {
  const p = priceFor(model);
  const inputEst = Math.ceil((charLen || 0) / 4) + 400;
  return (inputEst * p.in + (maxTokens || 0) * p.out) / 1_000_000;
}
function reserve(orgId, worst) {
  rollWindow(); // global window
  const bucket = orgBucket(orgId); // rolls its own window
  // Refuse if EITHER the global ceiling OR this org's sub-budget would be exceeded.
  if (_usdSpent + _reserved + worst > DAILY_BUDGET_USD) throw new AIBudgetError();
  if (bucket.usdSpent + bucket.reserved + worst > DAILY_BUDGET_PER_ORG_USD) throw new AIBudgetError();
  _reserved += worst;
  bucket.reserved += worst;
}
function release(orgId, worst) {
  _reserved = Math.max(0, _reserved - worst);
  const bucket = orgBucket(orgId);
  bucket.reserved = Math.max(0, bucket.reserved - worst);
}

export const costSpent = () => _usdSpent;

/** Snapshot of AI availability + spend, for the /api/ai/status endpoint. Reports
 *  the caller's ORG sub-budget (what they actually have left) plus the global. */
export function status(orgId) {
  rollWindow();
  const bucket = orgBucket(orgId);
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    enabled: aiEnabled(),
    tier: TIER,
    models: MODELS,
    // The org's own daily budget is what the UI should show as "remaining".
    budgetUsd: DAILY_BUDGET_PER_ORG_USD,
    spentUsd: round(bucket.usdSpent),
    remainingUsd: Math.max(0, round(DAILY_BUDGET_PER_ORG_USD - bucket.usdSpent)),
    // The global ceiling across all tenants (the hard cost backstop).
    globalBudgetUsd: DAILY_BUDGET_USD,
    globalSpentUsd: round(_usdSpent),
    globalRemainingUsd: Math.max(0, round(DAILY_BUDGET_USD - _usdSpent)),
  };
}

// ── Test-only seam ───────────────────────────────────────────────────────────
// Exposes the in-memory budget primitives so the OFFLINE suite can assert per-org
// isolation + reserve/release symmetry deterministically — the harness strips
// ANTHROPIC_API_KEY, so there is no real spend path to drive end-to-end. Gated on
// NODE_ENV==='test'; `undefined` in every other environment.
export const __test =
  process.env.NODE_ENV === 'test'
    ? {
        reserve,
        release,
        AIBudgetError,
        budgets: { global: DAILY_BUDGET_USD, perOrg: DAILY_BUDGET_PER_ORG_USD },
        // Inject a fake Anthropic client so the offline suite can drive the
        // realized-spend success path (cost accrual on both counters, budget
        // exhaustion → AIBudgetError) without a real key or network call. Requires
        // ANTHROPIC_API_KEY to be set (truthy) before importing this module so
        // getClient() returns the injected client instead of null.
        setClient(c) {
          _client = c;
        },
        // Drain all realized + reserved spend (global counter + every org bucket)
        // so each unit test starts from a clean budget window.
        reset() {
          _orgBuckets.clear();
          _usdSpent = 0;
          _reserved = 0;
          _windowStart = Date.now();
        },
      }
    : undefined;

function systemField(system, cache) {
  if (!system) return undefined;
  return cache
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;
}
function firstText(resp) {
  const block = (resp.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}
function guardStop(resp) {
  if (resp.stop_reason === 'refusal') throw new Error('AI declined to answer this request.');
  if (resp.stop_reason === 'max_tokens') throw new Error('AI response was truncated (raise maxTokens).');
}

// Shared call path: reservation-based budgeting + capability-aware thinking.
async function call({ system, prompt, model, maxTokens, cacheSystem, thinking, outputConfig, orgId }) {
  const c = getClient();
  if (!c) throw new AIDisabledError();

  const useThinking = !!thinking && ADAPTIVE_OK.has(model);
  // Thinking tokens count toward max_tokens — give a floor so a thinking call
  // isn't truncated mid-reasoning before it emits the answer.
  const effMax = useThinking ? Math.max(maxTokens, 4000) : maxTokens;
  const charLen = (system ? system.length : 0) + (prompt ? prompt.length : 0);
  const worst = worstCaseCost(model, effMax, charLen);

  reserve(orgId, worst); // throws AIBudgetError if this call could exceed the global OR org budget
  let resp;
  try {
    const req = { model, max_tokens: effMax, messages: [{ role: 'user', content: prompt }] };
    const sys = systemField(system, cacheSystem);
    if (sys) req.system = sys;
    if (useThinking) req.thinking = { type: 'adaptive' };
    if (outputConfig) req.output_config = outputConfig;
    resp = await c.messages.create(req);
  } catch (e) {
    release(orgId, worst); // API/network error — nothing billed
    throw e;
  }
  // Success: replace the reservation with the actual measured cost (once), on
  // both the global counter (persisted) and the org's in-memory bucket.
  release(orgId, worst);
  if (resp.usage) {
    const cost = costOf(model, resp.usage);
    _usdSpent += cost;
    orgBucket(orgId).usdSpent += cost;
    persist();
  }
  guardStop(resp);
  return resp;
}

/**
 * Get back JSON validated against `schema` (a JSON Schema object). Uses the
 * Messages API `output_config.format` so the model is constrained to emit valid
 * JSON — the first text block is guaranteed parseable.
 */
export async function generateJSON({
  system,
  prompt,
  schema,
  model = MODELS.draft,
  maxTokens = 1500,
  cacheSystem = true,
  thinking = false,
  orgId,
}) {
  const resp = await call({
    system,
    prompt,
    model,
    maxTokens,
    cacheSystem,
    thinking,
    orgId,
    outputConfig: { format: { type: 'json_schema', schema } },
  });
  return JSON.parse(firstText(resp));
}

/** Get back free-form text (e.g. an outreach draft). */
export async function generateText({
  system,
  prompt,
  model = MODELS.draft,
  maxTokens = 1200,
  cacheSystem = true,
  thinking = false,
  orgId,
}) {
  const resp = await call({ system, prompt, model, maxTokens, cacheSystem, thinking, orgId });
  return firstText(resp);
}

/**
 * Run an async mapper over items with bounded concurrency — used to batch
 * per-contact dossier generation on import without fanning out unbounded.
 * (The budget reservation above also caps total spend regardless of concurrency.)
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
