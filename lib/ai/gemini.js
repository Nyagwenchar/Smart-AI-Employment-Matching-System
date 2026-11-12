/**
 * Google Gemini client (free tier friendly).
 *
 * One job: send a prompt, get parsed JSON back, and classify the failure so the
 * caller knows whether it is worth retrying soon. Everything provider specific
 * stays in this file.
 */
const { config } = require('./config');

const TIER = 'gemini';

class AiError extends Error {
  constructor(message, { code = 'unavailable', status = 0, retryable = true } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.tier = TIER;
  }
}

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function readText(payload) {
  const parts =
    (payload &&
      payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts) ||
    [];

  return parts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/** Google wraps failures in a JSON envelope; keep just the human sentence. */
function readErrorDetail(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    const message =
      (parsed && parsed.error && (parsed.error.message || parsed.error.status)) || '';

    if (message) return String(message).slice(0, 180);
  } catch {
    // Not JSON, fall through to the raw text.
  }

  return text.slice(0, 180);
}

/**
 * One round trip to one model.
 *
 * Throws AiError and leaves runtime state alone, so the caller can decide
 * whether another model in the chain is worth trying.
 */
async function requestModel({ model, timeoutMs, prompt, system, task, temperature, maxOutputTokens }) {
  const cfg = config();
  const endpoint = `${cfg.gemini.baseUrl}/models/${model}:generateContent`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cfg.gemini.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          responseMimeType: 'application/json'
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');

    throw new AiError(
      timedOut
        ? `Gemini (${model}) did not answer within ${timeoutMs} ms (${task})`
        : `Gemini (${model}) request failed (${task}): ${err && err.message}`,
      { code: timedOut ? 'timeout' : 'unavailable' }
    );
  }

  if (!response.ok) {
    const detail = readErrorDetail(await response.text().catch(() => ''));
    const rateLimited = response.status === 429 || response.status === 403;

    throw new AiError(
      `Gemini (${model}) returned ${response.status} (${task})${detail ? `: ${detail}` : ''}`,
      {
        code: rateLimited ? 'rate_limited' : 'unavailable',
        status: response.status
      }
    );
  }

  const payload = await response.json().catch(() => null);
  const text = readText(payload);

  if (!text) {
    throw new AiError(`Gemini (${model}) returned an empty response (${task})`, {
      code: 'bad_response'
    });
  }

  try {
    return JSON.parse(stripFences(text));
  } catch {
    throw new AiError(`Gemini (${model}) returned text that is not valid JSON (${task})`, {
      code: 'bad_response'
    });
  }
}

// Codes worth handing to the next model. A malformed answer from a healthy
// model, or a missing key, will not improve by asking a different model.
const TRY_NEXT_MODEL = new Set(['timeout', 'unavailable', 'rate_limited']);

// Below this, an attempt would be cut off almost immediately by the shared
// deadline, so it is not worth the round trip.
const MIN_ATTEMPT_MS = 1000;

// The model id that produced the last successful answer. It is not always the
// primary: a retired or overloaded primary hands over to a fallback, and the UI
// and status endpoint should name the model that actually replied.
let answeredModel = null;

/**
 * Asks the model chain for JSON and returns the first usable answer.
 *
 * The primary model is tried first; retired, overloaded or silent models hand
 * over to the fallbacks listed in GEMINI_FALLBACK_MODELS. This function does not
 * touch runtime state: the dispatcher owns cooldowns and counters, because only
 * it knows whether another tier is about to be tried.
 *
 * @param {object} options
 * @param {string} options.prompt  the task instructions plus its input data
 * @param {string} options.system  role and output contract
 * @param {string} [options.task]  short label, useful in error messages
 * @param {number} [options.budgetMs] remaining time the caller can afford
 */
async function generateJson({
  prompt,
  system,
  task = 'ai',
  temperature = 0.2,
  maxOutputTokens = 2048,
  budgetMs = null
}) {
  const cfg = config();

  if (!cfg.gemini.configured) {
    throw new AiError('GEMINI_API_KEY is not configured', {
      code: 'not_configured',
      retryable: false
    });
  }

  const startedAt = Date.now();
  const allowance = Math.min(cfg.gemini.totalBudgetMs, budgetMs || cfg.gemini.totalBudgetMs);
  const deadline = startedAt + allowance;
  let lastError = null;

  for (const model of cfg.gemini.models) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) break;

    try {
      const payload = await requestModel({
        model,
        timeoutMs: Math.min(cfg.gemini.timeoutMs, remaining),
        prompt,
        system,
        task,
        temperature,
        maxOutputTokens
      });

      answeredModel = model;
      return payload;
    } catch (error) {
      error.model = model;
      lastError = error;

      if (!TRY_NEXT_MODEL.has(error.code)) break;
    }
  }

  throw lastError || new AiError('Gemini is not reachable', { code: 'unavailable' });
}

function modelName() {
  return config().gemini.model;
}

/** The model that answered last, for the dispatcher's bookkeeping. */
function lastModel() {
  return answeredModel;
}

module.exports = { generateJson, AiError, tier: TIER, modelName, lastModel };
