/**
 * Runtime configuration for the AI layer.
 *
 * Read on every call rather than cached at import time, so tests and one-off
 * scripts can override process.env without reloading modules.
 */
const fs = require('fs');

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A tier switch defaults to on and only turns off when explicitly set false. */
function toggle(name) {
  return String(process.env[name] || 'true').toLowerCase() !== 'false';
}

/** Ordered, de-duplicated list of models to attempt, primary first. */
function modelChain(primary) {
  const fallbacks = String(process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return [primary, ...fallbacks.filter((name) => name !== primary)].slice(0, MAX_MODEL_ATTEMPTS);
}

// Google retires model ids without notice and individual models can be
// overloaded while their siblings are healthy, so a short chain is cheaper than
// abandoning the online path on the first error.
const MAX_MODEL_ATTEMPTS = 3;

function config() {
  const enabled = String(process.env.LLM_ENABLED || 'true').toLowerCase() !== 'false';
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const primary = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim();
  const models = modelChain(primary);

  const backupEnabled = toggle('BACKUP_LLM_ENABLED');
  const backupKey = String(process.env.BACKUP_LLM_API_KEY || '').trim();
  const backupModel = String(process.env.BACKUP_LLM_MODEL || '').trim();

  const localEnabled = toggle('LOCAL_LLM_ENABLED');
  const localPath = String(process.env.LOCAL_LLM_MODEL_PATH || '').trim();
  // A path that points at nothing cannot answer, so the tier reports itself off
  // instead of attempting (and logging) a load that must fail.
  const localFile = localPath.length > 0 && fs.existsSync(localPath);

  return {
    enabled,
    gemini: {
      apiKey,
      configured: enabled && apiKey.length > 0,
      model: primary,
      models,
      baseUrl: String(
        process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
      ).replace(/\/+$/, ''),
      // Deadline for a single attempt.
      timeoutMs: positive(process.env.GEMINI_TIMEOUT_MS, 10000),
      // Ceiling for the whole chain. Slightly above one attempt, so a failure
      // that comes back quickly (retired model, rate limit) still leaves time
      // for a fallback, while a silent model is not given a second long wait.
      totalBudgetMs: positive(process.env.GEMINI_TOTAL_BUDGET_MS, 10500)
    },
    // Second tier: any OpenAI-compatible endpoint (Groq, OpenRouter, Cerebras).
    // Same request shape as the others, so it needs no special casing downstream.
    hosted: {
      enabled: backupEnabled,
      apiKey: backupKey,
      baseUrl: String(process.env.BACKUP_LLM_BASE_URL || 'https://api.groq.com/openai/v1')
        .replace(/\/+$/, ''),
      model: backupModel,
      jsonMode: toggle('BACKUP_LLM_JSON_MODE'),
      // A hosted backup either answers in a second or two or it is not worth
      // waiting for: the local tier still needs room in the same budget.
      timeoutMs: positive(process.env.BACKUP_LLM_TIMEOUT_MS, 5000),
      configured: enabled && backupEnabled && backupKey.length > 0 && backupModel.length > 0
    },
    // Third tier: an embedded GGUF model. Slow by nature on a CPU, so it gets a
    // long deadline of its own and a much smaller job batch.
    local: {
      enabled: localEnabled,
      modelPath: localPath,
      label: String(process.env.LOCAL_LLM_MODEL || 'local model').trim(),
      contextSize: positive(process.env.LOCAL_LLM_CONTEXT, 8192),
      threads: positive(process.env.LOCAL_LLM_THREADS, 0),
      // "auto", "max" or a layer count. Auto lets node-llama-cpp use whatever
      // backend it found (here: Vulkan on the integrated GPU).
      gpuLayers: String(process.env.LOCAL_LLM_GPU_LAYERS || 'auto').trim(),
      timeoutMs: positive(process.env.LOCAL_LLM_TIMEOUT_MS, 60000),
      // Below this remaining budget an attempt would be cut off mid-generation.
      minBudgetMs: positive(process.env.LOCAL_LLM_MIN_BUDGET_MS, 12000),
      maxJobsPerCall: Math.min(Math.max(positive(process.env.LOCAL_LLM_MAX_JOBS, 3), 1), 10),
      configured: enabled && localEnabled && localFile
    },
    // Whole-call ceilings per task type. Ranking is a nicety on a page load, so
    // it gets the shorter leash, but it still has to outlast the Gemini chain:
    // cutting a healthy model short would park the tier and take scoring down
    // with it. A timeout here therefore means the provider really is silent.
    budgetMs: positive(process.env.LLM_BUDGET_MS, 32000),
    rankingBudgetMs: positive(process.env.LLM_RANKING_BUDGET_MS, 12000),
    // Recommendation ordering is cached for this long: a dashboard refresh
    // should not spend a free-tier request, and the order should not change
    // between two visits with the same data.
    cacheTtlMs: positive(process.env.LLM_CACHE_TTL_MS, 300000),
    // One request refines at most this many jobs, which keeps a large board
    // from turning a dashboard load into a long chain of model calls.
    maxJobsPerCall: Math.min(Math.max(positive(process.env.LLM_MAX_JOBS, 12), 1), 40),
    // After a rate limit or timeout the online model is skipped for this long.
    cooldownMs: positive(process.env.LLM_COOLDOWN_MS, 60000)
  };
}

module.exports = { config };
