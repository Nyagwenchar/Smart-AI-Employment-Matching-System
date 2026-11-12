/**
 * Shared AI runtime state, tracked per tier.
 *
 * Every provider reports through here, so the API can say which tier will
 * answer the next request, and a failed tier parks only itself for a cooldown:
 * a throttled Gemini must not stop the local model from working, and vice versa.
 */
const { config } = require('./config');

// Ordered best-first. The dispatcher walks this list; the deterministic engine
// sits outside it as the final resort.
const TIERS = ['gemini', 'hosted', 'local'];

const state = {
  lastTier: null,
  lastModel: null,
  lastLatencyMs: null,
  lastCallAt: null,
  lastError: null,
  lastErrorAt: null,
  tiers: {}
};

function blank(name) {
  return { name, cooldownUntil: 0, calls: 0, failures: 0, lastError: null, lastErrorAt: null };
}

function tierState(name) {
  if (!state.tiers[name]) state.tiers[name] = blank(name);
  return state.tiers[name];
}

function tierConfig(name) {
  return config()[name] || null;
}

/** Configured, switched on, and not cooling down after a failure. */
function tierAvailable(name) {
  const tier = tierConfig(name);
  if (!tier || !tier.configured) return false;
  return Date.now() >= tierState(name).cooldownUntil;
}

/** Every tier that could answer right now, best first. */
function availableTiers() {
  return TIERS.filter((name) => tierAvailable(name));
}

/**
 * The tier that would answer next. Kept as the old name so existing callers
 * ("is any model reachable?") stay correct without edits.
 */
function onlineAvailable() {
  return availableTiers().length > 0;
}

function preferredTier() {
  return availableTiers()[0] || null;
}

/** Human sentence explaining why no model can be used, or null when one can. */
function reasonOnlineUnavailable() {
  const cfg = config();
  if (!cfg.enabled) return 'LLM_ENABLED is false';
  if (availableTiers().length) return null;

  const reasons = TIERS.map((name) => {
    const tier = cfg[name];
    if (!tier || !tier.configured) return null;

    const cooling = tierState(name).cooldownUntil;
    return cooling > Date.now()
      ? `${name} is in cooldown until ${new Date(cooling).toISOString()}`
      : null;
  }).filter(Boolean);

  return reasons.length
    ? reasons.join('; ')
    : 'no AI tier is configured (set GEMINI_API_KEY, BACKUP_LLM_API_KEY or LOCAL_LLM_MODEL_PATH)';
}

function recordSuccess(tier, latencyMs, model = null) {
  const entry = tierState(tier);

  entry.calls += 1;
  entry.cooldownUntil = 0;

  state.lastTier = tier;
  state.lastModel = model;
  state.lastLatencyMs = latencyMs;
  state.lastCallAt = new Date().toISOString();
}

function recordFailure(error) {
  const tier = (error && error.tier) || 'gemini';
  const entry = tierState(tier);
  const message = error && error.message ? error.message : String(error);

  entry.calls += 1;
  entry.failures += 1;
  entry.lastError = message;
  entry.lastErrorAt = new Date().toISOString();

  // Rate limits, timeouts and outages are all worth waiting out; a missing
  // key or a malformed prompt is not, so those keep retrying.
  if (error && error.retryable !== false && error.code !== 'not_configured') {
    entry.cooldownUntil = Date.now() + config().cooldownMs;
  }

  state.lastTier = 'deterministic';
  state.lastModel = (error && error.model) || null;
  state.lastError = message;
  state.lastErrorAt = entry.lastErrorAt;
  state.lastCallAt = entry.lastErrorAt;
}

/** Used by tests and by the status endpoint after a manual reset. */
function reset() {
  state.lastTier = null;
  state.lastModel = null;
  state.lastLatencyMs = null;
  state.lastCallAt = null;
  state.lastError = null;
  state.lastErrorAt = null;
  state.tiers = {};
}

function snapshot() {
  return {
    ...state,
    tiers: TIERS.reduce((acc, name) => {
      acc[name] = { ...tierState(name) };
      return acc;
    }, {})
  };
}

module.exports = {
  TIERS,
  tierAvailable,
  availableTiers,
  preferredTier,
  onlineAvailable,
  reasonOnlineUnavailable,
  recordSuccess,
  recordFailure,
  reset,
  snapshot
};
