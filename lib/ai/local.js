/**
 * Third tier: a GGUF model running inside this Node process via node-llama-cpp.
 *
 * It is the slowest tier by far (seconds per hundred tokens on a laptop CPU),
 * so it is only reached when both hosted providers are unavailable, and it is
 * given a much smaller job batch. Everything it returns goes through the same
 * validation and reconciliation as the hosted tiers, which is what keeps match
 * percentages and recommendations in one format.
 *
 * node-llama-cpp is ESM-only and optional: it is loaded with a dynamic import
 * on first use, and its absence degrades this tier to "not configured" rather
 * than breaking the app.
 */
const fs = require('fs');
const { config } = require('./config');
const { AiError } = require('./gemini');

const TIER = 'local';

/**
 * Output shapes, enforced by a GBNF grammar built from JSON Schema.
 *
 * This is why the local tier is usable at all: a 3-4B model on a CPU rarely
 * follows "reply in JSON" reliably, but it cannot emit anything the grammar
 * forbids, so malformed JSON stops being a failure mode.
 */
const SCHEMAS = {
  cv_parse: {
    type: 'object',
    properties: {
      skills: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category: { type: 'string' },
            proficiency: {
              type: 'string',
              enum: ['beginner', 'intermediate', 'advanced', 'expert']
            }
          },
          required: ['name', 'category', 'proficiency']
        }
      },
      education_level: { type: 'string' },
      years_experience: { type: 'number' },
      career_track: { type: 'string' },
      titles: { type: 'array', items: { type: 'string' } }
    },
    required: ['skills', 'education_level', 'years_experience', 'career_track', 'titles']
  },
  score_jobs: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            job_id: { type: 'number' },
            score: { type: 'number' },
            matched_skills: { type: 'array', items: { type: 'string' } },
            missing_skills: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' }
          },
          required: ['job_id', 'score', 'matched_skills', 'missing_skills', 'reason']
        }
      }
    },
    required: ['results']
  },
  recommend: {
    type: 'object',
    properties: {
      order: { type: 'array', items: { type: 'number' } },
      note: { type: 'string' }
    },
    required: ['order', 'note']
  }
};

const GENERIC_SCHEMA = { type: 'object' };

// Generation runs one call at a time: two contexts would double the memory and
// the CPU is the bottleneck anyway.
let queue = Promise.resolve();
let bundle = null;
let loading = null;

function enqueue(work) {
  const run = queue.then(work, work);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** Map "auto"/"max"/"12" onto what node-llama-cpp accepts. */
function gpuLayers(value) {
  if (value === 'auto' || value === 'max') return value;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 'auto';
}

async function load() {
  const cfg = config().local;

  if (!fs.existsSync(cfg.modelPath)) {
    throw new AiError(`local model file not found: ${cfg.modelPath}`, {
      code: 'not_configured',
      retryable: false
    });
  }

  if (!loading) {
    loading = (async () => {
      let lib;

      try {
        // ESM-only package: require() throws ERR_REQUIRE_ASYNC_MODULE.
        lib = await import('node-llama-cpp');
      } catch (error) {
        throw new AiError(
          `node-llama-cpp is not installed or its binaries are missing (${error.message})`,
          { code: 'not_configured', retryable: false }
        );
      }

      const llama = await lib.getLlama();
      const model = await llama.loadModel({
        modelPath: cfg.modelPath,
        gpuLayers: gpuLayers(cfg.gpuLayers)
      });

      return { lib, llama, model };
    })().catch((error) => {
      // Allow a later call to retry, e.g. after the model file is downloaded.
      loading = null;
      throw error;
    });
  }

  bundle = await loading;
  return bundle;
}

async function runModel({ prompt, system, task, temperature, maxOutputTokens, timeoutMs }) {
  const { lib, llama, model } = await load();
  const cfg = config().local;

  const context = await model.createContext({
    contextSize: cfg.contextSize,
    threads: cfg.threads || undefined
  });

  const sequence = context.getSequence();
  const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: system });

  try {
    const grammar = await llama.createGrammarForJsonSchema(SCHEMAS[task] || GENERIC_SCHEMA);

    return await session.prompt(prompt, {
      grammar,
      maxTokens: maxOutputTokens,
      temperature,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } finally {
    session.dispose();
    await context.dispose();
  }
}

function configured() {
  return config().local.configured;
}

function modelName() {
  return config().local.label;
}

/** Cheap, synchronous readiness snapshot for the status endpoint. */
function describe() {
  const cfg = config().local;
  const fileExists = Boolean(cfg.modelPath) && fs.existsSync(cfg.modelPath);

  let reason = null;
  if (!cfg.enabled) reason = 'LOCAL_LLM_ENABLED is false';
  else if (!cfg.modelPath) reason = 'LOCAL_LLM_MODEL_PATH is not set';
  else if (!fileExists) reason = `model file not found: ${cfg.modelPath}`;

  return {
    tier: TIER,
    provider: 'node-llama-cpp',
    model: cfg.label,
    model_path: cfg.modelPath || null,
    configured: cfg.configured && fileExists,
    loaded: Boolean(bundle),
    gpu_layers: cfg.gpuLayers,
    timeout_ms: cfg.timeoutMs,
    max_jobs_per_call: cfg.maxJobsPerCall,
    reason
  };
}

async function generateJson({ prompt, system, task = 'ai', temperature = 0.2, maxOutputTokens = 2048, budgetMs = null }) {
  const cfg = config().local;

  if (!cfg.configured) {
    throw new AiError('local model is not configured', {
      code: 'not_configured',
      retryable: false
    });
  }

  const timeoutMs = Math.min(cfg.timeoutMs, budgetMs || cfg.timeoutMs);

  const text = await enqueue(async () => {
    try {
      return await runModel({ prompt, system, task, temperature, maxOutputTokens, timeoutMs });
    } catch (error) {
      if (error instanceof AiError) throw error;

      const timedOut =
        error && (error.name === 'TimeoutError' || error.name === 'AbortError');

      throw new AiError(
        timedOut
          ? `Local model did not answer within ${timeoutMs} ms (${task})`
          : `Local model failed (${task}): ${error && error.message}`,
        { code: timedOut ? 'timeout' : 'unavailable' }
      );
    }
  });

  const parsed = stripFences(text);

  if (!parsed) {
    throw new AiError(`Local model returned an empty response (${task})`, {
      code: 'bad_response'
    });
  }

  try {
    return JSON.parse(parsed);
  } catch {
    throw new AiError(`Local model returned text that is not valid JSON (${task})`, {
      code: 'bad_response'
    });
  }
}

/** Releases the model and its backend. Used by tests and shutdown. */
async function unload() {
  if (!bundle) return;

  await bundle.llama.dispose().catch(() => {});
  bundle = null;
  loading = null;
}

module.exports = { generateJson, configured, modelName, describe, unload, tier: TIER, SCHEMAS };
