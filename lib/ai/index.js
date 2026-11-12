/**
 * The AI layer's public surface.
 *
 * Callers never talk to a provider or a tier directly. Each function below runs
 * the tier list (Gemini, then an OpenAI-compatible backup, then an embedded
 * local model) and degrades to the deterministic engine, so the response shape
 * is identical in every mode: a percentage, a verdict, a reason, a gap list and
 * an ordered recommendation list.
 */
const { config } = require('./config');
const runtime = require('./runtime');
const completion = require('./completion');
const { parseCvWithAi } = require('./cv');
const { scoreJobs } = require('./score');
const { rankRecommendations, applyOrder } = require('./ranking');

function status() {
  const cfg = config();
  const state = runtime.snapshot();
  const tiers = completion.tierStatus();
  const activeTier = runtime.preferredTier();
  const reason = runtime.reasonOnlineUnavailable();

  const primary = tiers.find((tier) => tier.tier === 'gemini') || tiers[0];

  return {
    // The tier that will answer the next request, or 'offline' when none can.
    mode: activeTier || 'offline',
    ai_enabled: cfg.enabled,
    reason,
    active_tier: activeTier,
    tiers,
    // Kept so the existing UI badge keeps working; mirrors the primary tier.
    online: {
      provider: primary.provider,
      model: primary.model,
      model_chain: cfg.gemini.models,
      configured: primary.configured,
      timeout_ms: primary.timeout_ms,
      total_budget_ms: cfg.gemini.totalBudgetMs,
      cooling_down: primary.cooling_down,
      cooldown_ends_at: primary.cooldown_ends_at
    },
    offline: {
      provider: 'deterministic-engine',
      description: 'Skill dictionary extraction with weighted coverage scoring'
    },
    limits: {
      max_jobs_per_call: cfg.maxJobsPerCall,
      local_max_jobs_per_call: cfg.local.maxJobsPerCall,
      cooldown_ms: cfg.cooldownMs,
      budget_ms: cfg.budgetMs,
      ranking_budget_ms: cfg.rankingBudgetMs
    },
    last_call: {
      provider: state.lastTier,
      tier: state.lastTier,
      model: state.lastModel,
      latency_ms: state.lastLatencyMs,
      at: state.lastCallAt
    },
    last_error: state.lastError ? { message: state.lastError, at: state.lastErrorAt } : null,
    counters: {
      online_calls: tiers.reduce((total, tier) => total + tier.calls, 0),
      online_failures: tiers.reduce((total, tier) => total + tier.failures, 0)
    }
  };
}

module.exports = {
  parseCvWithAi,
  scoreJobs,
  rankRecommendations,
  applyOrder,
  status,
  config,
  runtime,
  completion
};
