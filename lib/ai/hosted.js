/**
 * Second tier: any OpenAI-compatible chat endpoint.
 *
 * Groq, OpenRouter, Cerebras and friends all speak the same shape, so one
 * module covers them and the only thing that changes is the base URL and model
 * name in .env. It exists because a second hosted model keeps answers fast and
 * good when Gemini is throttled, which a CPU-bound local model cannot do.
 */
const { config } = require('./config');
const { AiError } = require('./gemini');

const TIER = 'hosted';

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function readContent(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const content = choice && choice.message && choice.message.content;

  if (typeof content === 'string') return content.trim();

  // Some gateways return content as an array of parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  return '';
}

function readErrorDetail(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    const message =
      (parsed && parsed.error && (parsed.error.message || parsed.error.code)) || '';
    if (message) return String(message).slice(0, 180);
  } catch {
    // Not JSON, fall through.
  }

  return text.slice(0, 180);
}

function configured() {
  return config().hosted.configured;
}

function modelName() {
  return config().hosted.model;
}

async function generateJson({ prompt, system, task = 'ai', temperature = 0.2, maxOutputTokens = 2048, budgetMs = null }) {
  const cfg = config().hosted;

  if (!cfg.configured) {
    throw new AiError(`backup model is not configured (${task})`, {
      code: 'not_configured',
      retryable: false
    });
  }

  const timeoutMs = Math.min(cfg.timeoutMs, budgetMs || cfg.timeoutMs);
  const endpoint = cfg.baseUrl.endsWith('/chat/completions')
    ? cfg.baseUrl
    : `${cfg.baseUrl}/chat/completions`;

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    temperature,
    max_tokens: maxOutputTokens
  };

  // Not every gateway accepts a JSON response format; the switch exists so a
  // provider that rejects it can be used anyway.
  if (cfg.jsonMode) body.response_format = { type: 'json_object' };

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');

    throw new AiError(
      timedOut
        ? `Backup model did not answer within ${timeoutMs} ms (${task})`
        : `Backup model request failed (${task}): ${err && err.message}`,
      { code: timedOut ? 'timeout' : 'unavailable' }
    );
  }

  if (!response.ok) {
    const detail = readErrorDetail(await response.text().catch(() => ''));
    const rateLimited = response.status === 429 || response.status === 403;

    throw new AiError(
      `Backup model returned ${response.status} (${task})${detail ? `: ${detail}` : ''}`,
      {
        code: rateLimited ? 'rate_limited' : 'unavailable',
        status: response.status
      }
    );
  }

  const payload = await response.json().catch(() => null);
  const text = readContent(payload);

  if (!text) {
    throw new AiError(`Backup model returned an empty response (${task})`, {
      code: 'bad_response'
    });
  }

  try {
    return JSON.parse(stripFences(text));
  } catch {
    throw new AiError(`Backup model returned text that is not valid JSON (${task})`, {
      code: 'bad_response'
    });
  }
}

module.exports = { generateJson, configured, modelName, tier: TIER };
