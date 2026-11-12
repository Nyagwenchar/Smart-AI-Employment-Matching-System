/**
 * Tier dispatcher.
 *
 * The order is deliberate, best first:
 *   1. gemini  - hosted, fast, strongest reasoning
 *   2. hosted  - any OpenAI-compatible backup (Groq, OpenRouter, ...)
 *   3. local   - GGUF model embedded in this process via node-llama-cpp
 *   4. offline - the deterministic engine, which lives outside this module
 *
 * A tier that fails is parked for a cooldown and *only* that tier: a throttled
 * Gemini never disables the local model. Callers get the same payload shape no
 * matter which tier answered, which is what keeps percentages and
 * recommendations identical in format across every mode.
 */
const { config } = require('./config');
const runtime = require('./runtime');
const gemini = require('./gemini');
const hosted = require('./hosted');
const local = require('./local');

const { AiError } = gemini;

const providers = { gemini, hosted, local };

// An attempt shorter than this cannot finish a single answer.
const MIN_ATTEMPT_MS = 750;

function tierModelName(tier) {
  const provider = providers[tier];
  return provider && typeof provider.modelName === 'function' ? provider.modelName() : null;
}

/** How much time this tier needs before it is worth starting at all. */
function minimumFor(tier, cfg) {
  return tier === 'local' ? Math.max(MIN_ATTEMPT_MS, cfg.local.minBudgetMs) : MIN_ATTEMPT_MS;
}

/**
 * Runs one task down the tier list.
 *
 * @returns {Promise<{data: object, tier: string, model: string|null, latencyMs: number}>}
 * @throws {AiError} when every tier is unavailable or failed
 */
async function complete(options) {
  const cfg = config();

  if (!cfg.enabled) {
    throw new AiError('LLM_ENABLED is false', { code: 'not_configured', retryable: false });
  }

  const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : cfg.budgetMs;
  const deadline = Date.now() + budgetMs;
  const attempts = [];
  let failure = null;

  for (const tier of runtime.TIERS) {
    if (!runtime.tierAvailable(tier)) {
      attempts.push({ tier, skipped: 'not configured, or cooling down after a failure' });
      continue;
    }

    const remaining = deadline - Date.now();

    if (remaining < minimumFor(tier, cfg)) {
      attempts.push({ tier, skipped: `skipped, only ${remaining} ms of the budget left` });
      continue;
    }

    const startedAt = Date.now();
    const provider = providers[tier];

    try {
      const data = await provider.generateJson({
        prompt: options.prompt,
        system: options.system,
        task: options.task,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        budgetMs: remaining
      });

      const latencyMs = Date.now() - startedAt;
      // A provider with its own model chain reports the model that answered.
      const model =
        (typeof provider.lastModel === 'function' && provider.lastModel()) || tierModelName(tier);

      runtime.recordSuccess(tier, latencyMs, model);

      return { data, tier, model, latencyMs };
    } catch (error) {
      error.tier = tier;
      runtime.recordFailure(error);

      attempts.push({ tier, error: error.message });
      failure = error;
    }
  }

  const reason = runtime.reasonOnlineUnavailable();
  const error =
    failure ||
    new AiError(reason || 'no AI tier answered', {
      code: 'not_configured',
      retryable: false
    });

  // Keep the per-tier trail for the log; callers only surface the last cause.
  error.attempts = attempts;
  error.tier = error.tier || 'none';

  throw error;
}

/** Convenience wrapper for callers that only want the payload. */
async function generateJson(options) {
  const { data } = await complete(options);
  return data;
}

/** Why this tier cannot answer, or null when it can. */
function reasonFor(tier, tierCfg, detail) {
  if (detail && detail.reason) return detail.reason;
  if (!config().enabled) return 'LLM_ENABLED is false';
  if (tierCfg.configured) return null;

  if (tier === 'gemini') {
    return tierCfg.apiKey ? 'Gemini is not configured' : 'GEMINI_API_KEY is not set';
  }

  if (tier === 'hosted') {
    if (!tierCfg.enabled) return 'BACKUP_LLM_ENABLED is false';
    if (!tierCfg.apiKey) return 'BACKUP_LLM_API_KEY is not set';
    if (!tierCfg.model) return 'BACKUP_LLM_MODEL is not set';
    return 'backup tier is not configured';
  }

  return null;
}

function tierStatus() {
  const cfg = config();
  const state = runtime.snapshot();

  return runtime.TIERS.map((tier) => {
    const tierCfg = cfg[tier] || {};
    const entry = state.tiers[tier] || {};
    const provider = providers[tier];
    const cooling = (entry.cooldownUntil || 0) > Date.now();

    const detail =
      tier === 'local' && provider && typeof provider.describe === 'function'
        ? provider.describe()
        : null;

    return {
      tier,
      provider:
        tier === 'gemini' ? 'google-gemini' : tier === 'hosted' ? 'openai-compatible' : 'node-llama-cpp',
      model: tierModelName(tier),
      configured: detail ? detail.configured : Boolean(tierCfg.configured),
      reason: reasonFor(tier, tierCfg, detail),
      cooling_down: cooling,
      cooldown_ends_at: cooling ? new Date(entry.cooldownUntil).toISOString() : null,
      calls: entry.calls || 0,
      failures: entry.failures || 0,
      last_error: entry.lastError || null,
      timeout_ms: tierCfg.timeoutMs || null
    };
  });
}

module.exports = { complete, generateJson, tierStatus, providers, MIN_ATTEMPT_MS, reasonFor };
