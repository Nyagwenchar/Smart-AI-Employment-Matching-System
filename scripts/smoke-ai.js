/**
 * Proves the hybrid AI layer without spending a single Gemini token.
 *
 * A local server imitates the Gemini REST API, so this script can drive every
 * branch: online success, rate limit, timeout, malformed JSON and no key at all.
 *
 *   node scripts/smoke-ai.js
 */
require('dotenv').config({ quiet: true });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const mock = { mode: 'ok', hostedMode: null, requests: 0, models: [], hits: [] };

/* ------------------------------------------------------------------ */
/* Mock Gemini                                                         */
/* ------------------------------------------------------------------ */

function jsonAfter(prompt, marker) {
  const lines = String(prompt || '').split('\n');
  const index = lines.findIndex((line) => line.startsWith(marker));

  if (index === -1 || !lines[index + 1]) return null;

  try {
    return JSON.parse(lines[index + 1]);
  } catch {
    return null;
  }
}

function buildReply(prompt) {
  if (prompt.includes('TASK: cv_parse')) {
    return {
      // Deliberately messy: a lower-case canonical skill, plus one the
      // taxonomy has never heard of.
      skills: [
        { name: 'nodejs', proficiency: 'advanced' },
        { name: 'TypeScript', proficiency: 'intermediate' },
        { name: 'PostgreSQL', proficiency: 'intermediate' },
        { name: 'Underwater Basket Weaving', category: 'Hobbies', proficiency: 'beginner' }
      ],
      education_level: 'bachelors',
      years_experience: 4.5,
      career_track: 'Software & IT',
      titles: ['Backend Engineer']
    };
  }

  if (prompt.includes('TASK: score_jobs')) {
    const payload = jsonAfter(prompt, 'JOBS_JSON:') || { jobs: [] };

    return {
      results: payload.jobs.map((job, index) => ({
        job_id: job.job_id,
        // A high, optimistic number: the merge step must clamp it when the
        // candidate is still missing required skills.
        score: 96 - index * 8,
        matched_skills: job.requirements.slice(0, 2).map((row) => row.skill),
        missing_skills: job.requirements.slice(2).map((row) => row.skill),
        reason: `Mocked assessment for ${job.title}.`
      }))
    };
  }

  if (prompt.includes('TASK: recommend')) {
    const payload = jsonAfter(prompt, 'CANDIDATES_JSON:') || { jobs: [] };
    const ids = payload.jobs.map((job) => job.job_id);

    return { order: ids.slice().reverse(), note: 'Mock reversed order.' };
  }

  return {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Which endpoint a request hit, so a test can assert the tier order. */
function endpointOf(url) {
  return String(url || '').startsWith('/openai/') ? 'hosted' : 'gemini';
}

function geminiPrompt(request) {
  return (
    (request.contents &&
      request.contents[0] &&
      request.contents[0].parts &&
      request.contents[0].parts.map((part) => part.text || '').join('\n')) ||
    ''
  );
}

/** OpenAI shape: the prompt is the user message, the system prompt is separate. */
function openAiPrompt(request) {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  return messages
    .filter((message) => message && message.role !== 'system')
    .map((message) => String(message.content || ''))
    .join('\n');
}

function sendAnswer(res, endpoint, prompt) {
  const text = JSON.stringify(buildReply(prompt));

  if (endpoint === 'hosted') {
    return sendJson(res, 200, { choices: [{ message: { role: 'assistant', content: text } }] });
  }

  return sendJson(res, 200, { candidates: [{ content: { parts: [{ text }] } }] });
}

const server = http.createServer((req, res) => {
  let body = '';

  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', () => {
    mock.requests += 1;

    const endpoint = endpointOf(req.url);
    mock.hits.push(endpoint);

    const model = (req.url.match(/\/models\/([^:]+):/) || [])[1] || '';
    if (endpoint === 'gemini') mock.models.push(model);

    const request = (() => {
      try {
        return JSON.parse(body || '{}');
      } catch {
        return {};
      }
    })();

    const prompt = endpoint === 'hosted' ? openAiPrompt(request) : geminiPrompt(request);

    // A scenario can fail one tier while leaving the next one healthy.
    const mode = (endpoint === 'hosted' && mock.hostedMode) || mock.mode;

    // A retired or overloaded model: the chain must ask the next one.
    if (mode === 'primary_down' && model === 'primary-model') {
      return sendJson(res, 503, { error: { code: 503, message: 'Model overloaded' } });
    }

    if (mode === 'rate_limited') {
      return sendJson(res, 429, { error: { code: 429, message: 'Resource exhausted' } });
    }

    if (mode === 'server_error') {
      return sendJson(res, 503, { error: { code: 503, message: 'Unavailable' } });
    }

    if (mode === 'slow') {
      setTimeout(() => {
        // The client has already given up; writing would raise on a dead socket.
        if (res.writableEnded || res.destroyed) return;
        sendAnswer(res, endpoint, prompt);
      }, 900);

      return;
    }

    if (mode === 'bad_json') {
      const text = 'not json at all';
      const payload =
        endpoint === 'hosted'
          ? { choices: [{ message: { role: 'assistant', content: text } }] }
          : { candidates: [{ content: { parts: [{ text }] } }] };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    sendAnswer(res, endpoint, prompt);
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const skills = [
  { name: 'Node.js', proficiency_level: 'advanced' },
  { name: 'React', proficiency_level: 'advanced' },
  { name: 'AWS', proficiency_level: 'intermediate' }
];

const requirements = [
  { skill_name: 'Node.js', importance: 'required', minimum_proficiency: 'beginner', weight: 1 },
  { skill_name: 'React', importance: 'required', minimum_proficiency: 'beginner', weight: 1 },
  { skill_name: 'Redis', importance: 'required', minimum_proficiency: 'beginner', weight: 1 },
  { skill_name: 'AWS', importance: 'preferred', minimum_proficiency: 'beginner', weight: 1 }
];

const job = {
  job_id: 101,
  title: 'Backend Engineer',
  company_name: 'Mock Ltd',
  department: 'Engineering',
  industry: 'Technology',
  description: 'Build services with Node.js, React and Redis.'
};

const secondJob = {
  job_id: 102,
  title: 'Frontend Engineer',
  company_name: 'Mock Ltd',
  department: 'Engineering',
  industry: 'Technology',
  description: 'Ship interfaces with React.'
};

const entries = [
  { job, requirements },
  { job: secondJob, requirements: requirements.slice(0, 2) }
];

const cvText = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.txt'), 'utf8');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function check(label, condition, detail) {
  if (condition) {
    results.push({ label, ok: true });
    console.log(`ok    ${label}`);
    return;
  }

  results.push({ label, ok: false, detail });
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}/v1beta`;
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  // One model per section: a chain from the developer's .env would double every
  // request and blur which tier answered. Section 6 sets its own chain.
  process.env.GEMINI_FALLBACK_MODELS = '';
  // The suite must never reach a real provider: no backup key, no model file.
  delete process.env.BACKUP_LLM_API_KEY;
  delete process.env.BACKUP_LLM_MODEL;
  process.env.LOCAL_LLM_MODEL_PATH = '';
  process.env.LLM_ENABLED = 'true';
  process.env.LLM_COOLDOWN_MS = '4000';

  // Loaded after dotenv so the modules see the overrides on their first call.
  const ai = require('../lib/ai');
  const { scoreMatch } = require('../lib/match');

  console.log('\n=== 1. no API key: everything runs offline ===');
  delete process.env.GEMINI_API_KEY;
  ai.runtime.reset();

  let status = ai.status();
  check('mode is offline', status.mode === 'offline', status.mode);
  check('reason mentions the missing key', /GEMINI_API_KEY/.test(status.reason || ''), status.reason);

  let parsed = await ai.parseCvWithAi(cvText);
  check('CV falls back to the dictionary parser', parsed.source === 'dictionary', parsed.source);
  check('CV still yields skills', parsed.skills.length > 5, parsed.skills.length);

  let scored = await ai.scoreJobs(skills, entries);
  check('scoring falls back to deterministic', scored.provider === 'deterministic', scored.provider);
  check(
    'offline score equals the pure maths',
    scored.results.get(101).score === scoreMatch(skills, requirements).score
  );

  console.log('\n=== 2. key present, mock Gemini answers ===');
  process.env.GEMINI_API_KEY = 'test-key';
  mock.mode = 'ok';
  ai.runtime.reset();

  check('mode is gemini', ai.status().mode === 'gemini', ai.status().mode);

  parsed = await ai.parseCvWithAi(cvText);
  check('CV parsed by gemini', parsed.source === 'gemini', parsed.source);
  check('lower-case skill mapped to canonical label', parsed.skills[0].name === 'Node.js', parsed.skills[0].name);
  check('proficiency preserved', parsed.skills[0].proficiency === 'advanced', parsed.skills[0].proficiency);
  check(
    'unknown skill kept with its own category',
    parsed.skills.some((skill) => skill.category === 'Hobbies'),
    JSON.stringify(parsed.skills.map((skill) => skill.category))
  );
  check('education parsed', parsed.education_level === 'bachelors', parsed.education_level);
  check('years parsed', parsed.years_experience === 4.5, parsed.years_experience);

  const spellings = require('../lib/ai/normalize').normalizeSkills([
    { name: 'React.js' },
    { name: 'React' },
    { name: 'Node' },
    { name: 'Node.js' }
  ]);

  check(
    'two spellings of one skill collapse to one row',
    spellings.length === 2 && spellings.every((skill) => skill.name === 'React' || skill.name === 'Node.js'),
    spellings.map((skill) => skill.name).join(',')
  );

  scored = await ai.scoreJobs(skills, entries);
  const merged = scored.results.get(101);
  const offline = scoreMatch(skills, requirements);

  check('scoring reported gemini', scored.provider === 'gemini', scored.provider);
  check(
    'result shape identical to the offline engine',
    JSON.stringify(Object.keys(merged).sort()) === JSON.stringify(Object.keys(offline).sort()),
    JSON.stringify(Object.keys(merged).sort())
  );
  check('percentage capped by the missing requirement', merged.score === 85, merged.score);
  check('verdict recomputed from evidence', merged.qualification === 'partially_qualified', merged.qualification);
  check('missing required skill kept as a gap', merged.gaps.some((gap) => gap.skill_name === 'Redis'));
  check('reason keeps the score suffix', /Final score 85%\.$/.test(merged.reason), merged.reason);
  check(
    'second job also scored by the model',
    scored.results.get(102).reason.includes('Mocked assessment'),
    scored.results.get(102).reason
  );

  const candidates = [
    { job_id: 201, title: 'Platform Engineer', similarity: 0.7, match: { score: 60 } },
    { job_id: 202, title: 'Data Engineer', similarity: 0.6, match: { score: 55 } },
    { job_id: 203, title: 'QA Engineer', similarity: 0.5, match: { score: 50 } }
  ];

  const ranking = await ai.rankRecommendations({ skills, anchorJob: job, candidates });

  check('recommendations ordered by gemini', ranking.provider === 'gemini', ranking.provider);
  check('order applied exactly', ranking.order.join(',') === '203,202,201', ranking.order.join(','));
  check(
    'no candidate lost',
    ai.applyOrder([{ job_id: 201 }, { job_id: 202 }, { job_id: 203 }], ranking.order).length === 3
  );

  const requestsBeforeCache = mock.requests;
  const again = await ai.rankRecommendations({ skills, anchorJob: job, candidates });

  check('second dashboard load is served from cache', again.cached === true, JSON.stringify(again.cached));
  check('cache saves a free-tier request', mock.requests === requestsBeforeCache, `${mock.requests} vs ${requestsBeforeCache}`);
  check('cached order matches the first', again.order.join(',') === '203,202,201', again.order.join(','));

  const changed = await ai.rankRecommendations({
    skills,
    anchorJob: job,
    candidates: candidates.slice(0, 2)
  });

  check('different inputs bypass the cache', changed.cached !== true);

  console.log('\n=== 3. rate limited: cooldown then automatic recovery ===');
  process.env.LLM_COOLDOWN_MS = '120';
  mock.mode = 'rate_limited';
  ai.runtime.reset();

  scored = await ai.scoreJobs(skills, entries);
  status = ai.status();

  check('falls back to deterministic', scored.provider === 'deterministic', scored.provider);
  check('failure is recorded', /429/.test((status.last_error && status.last_error.message) || ''), JSON.stringify(status.last_error));
  check('mode reports offline', status.mode === 'offline', status.mode);
  check('cooldown is active', status.online.cooling_down === true, JSON.stringify(status.online));

  const beforeRecovery = mock.requests;
  await ai.scoreJobs(skills, entries);
  check('no request while cooling down', mock.requests === beforeRecovery, `${mock.requests} vs ${beforeRecovery}`);

  await sleep(180);
  check('mode recovers after the cooldown', ai.status().mode === 'gemini', ai.status().mode);

  console.log('\n=== 4. timeout: fallback inside the deadline ===');
  process.env.LLM_COOLDOWN_MS = '4000';
  process.env.GEMINI_TIMEOUT_MS = '200';
  mock.mode = 'slow';
  ai.runtime.reset();

  const started = Date.now();
  scored = await ai.scoreJobs(skills, entries);
  const elapsed = Date.now() - started;

  check('falls back on timeout', scored.provider === 'deterministic', scored.provider);
  check('timeout is reported', /did not answer within 200 ms/.test(scored.error || ''), scored.error);
  check('the user is not kept waiting', elapsed < 800, `${elapsed} ms`);
  check(
    'scene still produces the offline number',
    scored.results.get(101).score === offline.score,
    `${scored.results.get(101).score} vs ${offline.score}`
  );

  console.log('\n=== 5. server error and malformed JSON ===');
  process.env.GEMINI_TIMEOUT_MS = '4000';
  mock.mode = 'server_error';
  ai.runtime.reset();

  parsed = await ai.parseCvWithAi(cvText);
  check('CV falls back on 503', parsed.source === 'dictionary', parsed.source);
  check('fallback reason kept for the UI', /503/.test(parsed.ai_skipped || ''), parsed.ai_skipped);

  mock.mode = 'bad_json';
  ai.runtime.reset();

  scored = await ai.scoreJobs(skills, entries);
  check('scoring falls back on malformed JSON', scored.provider === 'deterministic', scored.provider);
  check('malformed JSON is reported', /not valid JSON/.test(scored.error || ''), scored.error);

  console.log('\n=== 6. retired primary model hands over to the fallback ===');
  process.env.GEMINI_MODEL = 'primary-model';
  process.env.GEMINI_FALLBACK_MODELS = 'fallback-model';
  process.env.GEMINI_TIMEOUT_MS = '4000';
  mock.mode = 'primary_down';
  mock.models.length = 0;
  ai.runtime.reset();

  parsed = await ai.parseCvWithAi(cvText);
  check('fallback model answers the CV', parsed.source === 'gemini', parsed.source || parsed.ai_skipped);
  check(
    'both models were tried, in order',
    mock.models.join(',') === 'primary-model,fallback-model',
    mock.models.join(',')
  );
  check('last call names the model that answered', ai.status().last_call.model === 'fallback-model', ai.status().last_call.model);
  check('online mode survives a dead primary', ai.status().mode === 'gemini', ai.status().mode);
  check('no error is left on the status', ai.status().last_error === null, JSON.stringify(ai.status().last_error));

  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  delete process.env.GEMINI_FALLBACK_MODELS;
  process.env.GEMINI_TIMEOUT_MS = '4000';

  console.log('\n=== 7. Gemini throttled: the backup tier answers instead ===');
  process.env.BACKUP_LLM_API_KEY = 'test-backup-key';
  process.env.BACKUP_LLM_MODEL = 'backup-model';
  process.env.BACKUP_LLM_BASE_URL = `http://127.0.0.1:${port}/openai`;
  process.env.BACKUP_LLM_TIMEOUT_MS = '4000';
  mock.mode = 'ok';
  mock.hostedMode = null;
  mock.hits.length = 0;
  ai.runtime.reset();

  status = ai.status();

  check(
    'the backup tier is configured',
    (status.tiers.find((tier) => tier.tier === 'hosted') || {}).configured === true,
    JSON.stringify(status.tiers)
  );
  check('Gemini is still preferred while healthy', status.active_tier === 'gemini', status.active_tier);

  parsed = await ai.parseCvWithAi(cvText);
  check('Gemini answers while it is healthy', parsed.source === 'gemini', parsed.source);
  check('nothing fell through to the backup', mock.hits.join(',') === 'gemini', mock.hits.join(','));

  // Gemini now fails while the backup stays healthy.
  mock.mode = 'server_error';
  mock.hostedMode = 'ok';
  mock.hits.length = 0;
  ai.runtime.reset();

  parsed = await ai.parseCvWithAi(cvText);
  check('the backup tier answers when Gemini fails', parsed.source === 'hosted', parsed.source);
  check('tiers were tried in order', mock.hits.join(',') === 'gemini,hosted', mock.hits.join(','));
  check(
    'the status names the tier that answered',
    ai.status().last_call.tier === 'hosted',
    JSON.stringify(ai.status().last_call)
  );

  mock.hits.length = 0;
  parsed = await ai.parseCvWithAi(cvText);
  check('a throttled Gemini is not retried', mock.hits.join(',') === 'hosted', mock.hits.join(','));
  check('the active tier moves to the backup', ai.status().active_tier === 'hosted', ai.status().active_tier);
  check('mode follows the active tier', ai.status().mode === 'hosted', ai.status().mode);

  console.log('\n=== 8. both hosted tiers down: local, then the offline engine ===');
  process.env.LOCAL_LLM_MODEL_PATH = path.join(__dirname, 'fixtures', 'sample-cv.txt');
  process.env.LOCAL_LLM_TIMEOUT_MS = '2000';
  process.env.LOCAL_LLM_MIN_BUDGET_MS = '1000';

  const realLocal = ai.completion.providers.local;
  let localCalls = 0;

  // The real tier loads a multi-gigabyte GGUF, which a test run must not
  // download. This stub sits below the dispatcher, so ordering, cooldowns,
  // validation and merging are all still the production path.
  const stubLocal = {
    generateJson: async ({ prompt }) => {
      localCalls += 1;
      return buildReply(prompt);
    },
    modelName: () => 'stub-local',
    describe: () => ({ tier: 'local', configured: true, reason: null, loaded: true })
  };

  ai.completion.providers.local = stubLocal;
  mock.hostedMode = 'server_error';
  mock.hits.length = 0;
  ai.runtime.reset();

  check(
    'the chain is Gemini, backup, local',
    ai.status().tiers.map((tier) => tier.tier).join(',') === 'gemini,hosted,local',
    ai.status().tiers.map((tier) => tier.tier).join(',')
  );

  parsed = await ai.parseCvWithAi(cvText);
  check(
    'the local tier answers when both hosted tiers fail',
    parsed.source === 'local',
    parsed.source || parsed.ai_skipped
  );
  check('the local tier was reached in order', localCalls === 1, String(localCalls));
  check('the hosted tiers were tried first', mock.hits.join(',') === 'gemini,hosted', mock.hits.join(','));

  stubLocal.generateJson = async () => {
    throw new Error('stub local failure');
  };
  ai.runtime.reset();

  parsed = await ai.parseCvWithAi(cvText);
  check('the offline engine is the last resort', parsed.source === 'dictionary', parsed.source);
  check(
    'the local failure is reported to the caller',
    /stub local failure/.test(parsed.ai_skipped || ''),
    parsed.ai_skipped
  );
  check('every tier is parked after failing', ai.status().mode === 'offline', ai.status().mode);

  ai.completion.providers.local = realLocal;
  mock.hostedMode = null;
  mock.mode = 'ok';
  delete process.env.BACKUP_LLM_API_KEY;
  delete process.env.BACKUP_LLM_MODEL;
  process.env.LOCAL_LLM_MODEL_PATH = '';

  console.log('\n=== 9. LLM_ENABLED=false wins over valid credentials ===');
  process.env.LLM_ENABLED = 'false';
  ai.runtime.reset();
  status = ai.status();

  check('disabled mode is offline', status.mode === 'offline', status.mode);
  check('reason names the switch', /LLM_ENABLED/.test(status.reason || ''), status.reason);
  process.env.LLM_ENABLED = 'true';

  server.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length) process.exit(1);
})().catch((error) => {
  console.error('smoke-ai crashed:', error);
  server.close();
  process.exit(1);
});
