/**
 * Career-aware ordering for the "you might also fit" list.
 *
 * The similarity maths already guarantees the candidates are related. The model
 * only decides the order, which is where judgement matters: a React role and a
 * Node role can be equally similar on paper while one is the better next step
 * for this particular candidate.
 */
const { config } = require('./config');
const { complete } = require('./completion');
const { AiError } = require('./gemini');
const runtime = require('./runtime');

// The prompt is a pure function of the inputs, so it doubles as the cache key:
// new skills or new candidate scores produce a new prompt and a fresh call.
const cache = new Map();
const MAX_CACHE_ENTRIES = 300;

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;

  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return hit.value;
}

// Only successful model answers are cached. An offline ordering is cheap to
// recompute and must not outlive the outage.
function writeCache(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, { value, expiresAt: Date.now() + config().cacheTtlMs });
}

const SYSTEM = [
  'You are a career coach ordering job recommendations for one candidate.',
  'Prefer roles that build on the skills the candidate already has.',
  'Use only the job ids given to you, each at most once.',
  'Return JSON only.'
].join(' ');

const OUTPUT_CONTRACT = `Return JSON shaped exactly like this:
{ "order": [1, 2, 3], "note": "one sentence on why this order" }`;

function candidateSummary(row) {
  return {
    job_id: row.job_id,
    title: row.title,
    company: row.company_name,
    department: row.department,
    industry: row.industry,
    match_score: row.match ? row.match.score : null,
    similarity: row.similarity
  };
}

function buildPrompt({ skills, anchorJob, candidates }) {
  const candidate = {
    skills: (skills || []).map((skill) => ({
      name: skill.name || skill.skill_name,
      level: skill.proficiency_level || skill.proficiency
    }))
  };

  const anchor = anchorJob
    ? {
        title: anchorJob.title,
        department: anchorJob.department,
        industry: anchorJob.industry
      }
    : null;

  return [
    'TASK: recommend',
    OUTPUT_CONTRACT,
    '',
    'CANDIDATE_JSON:',
    JSON.stringify(candidate),
    '',
    'ANCHOR_JOB_JSON:',
    JSON.stringify(anchor),
    '',
    'CANDIDATES_JSON:',
    JSON.stringify({ jobs: (candidates || []).map(candidateSummary) }),
    '',
    'Order the candidate job ids for this person, best next move first.'
  ].join('\n');
}

/**
 * @returns {Promise<{order: number[], provider: string, note?: string}>}
 *          `order` always contains every candidate id exactly once.
 */
async function rankRecommendations({ skills, anchorJob, candidates }) {
  const fallbackOrder = (candidates || []).map((row) => row.job_id);
  const fallback = { order: fallbackOrder, provider: 'deterministic' };

  // The ranking call gets a short budget that only a hosted tier can meet, so a
  // local-only setup keeps the similarity order instead of queueing a slow job
  // behind a page load.
  const hostedReady = runtime.availableTiers().some((tier) => tier !== 'local');

  if (!fallbackOrder.length || !hostedReady) return fallback;

  const prompt = buildPrompt({ skills, anchorJob, candidates });
  const cached = readCache(prompt);
  if (cached) return { ...cached, cached: true };

  try {
    const { data: payload, tier } = await complete({
      task: 'recommend',
      system: SYSTEM,
      prompt,
      temperature: 0.2,
      maxOutputTokens: 512,
      // Ordering is a nicety on a page load: never make the dashboard wait for a
      // slow tier when the similarity order is already serviceable.
      budgetMs: config().rankingBudgetMs
    });

    const returned = Array.isArray(payload && payload.order) ? payload.order : null;

    if (!returned) {
      throw new AiError('The model did not return an order array', { code: 'bad_response' });
    }

    const known = new Set(fallbackOrder);
    const seen = new Set();
    const order = [];

    for (const value of returned) {
      const jobId = Number(value);
      if (!Number.isInteger(jobId) || !known.has(jobId) || seen.has(jobId)) continue;

      seen.add(jobId);
      order.push(jobId);
    }

    // Anything the model skipped keeps its similarity position at the end.
    for (const jobId of fallbackOrder) {
      if (!seen.has(jobId)) order.push(jobId);
    }

    const value = {
      order,
      provider: tier,
      note: typeof (payload && payload.note) === 'string' ? payload.note.slice(0, 200) : undefined
    };

    writeCache(prompt, value);

    return value;
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function applyOrder(rows, order) {
  const byId = new Map((rows || []).map((row) => [row.job_id, row]));
  const ordered = [];

  for (const jobId of order || []) {
    const row = byId.get(jobId);
    if (!row) continue;

    ordered.push(row);
    byId.delete(jobId);
  }

  // Rows the order did not mention keep their original relative position.
  for (const row of rows || []) {
    if (byId.has(row.job_id)) ordered.push(row);
  }

  return ordered;
}

module.exports = { rankRecommendations, applyOrder, buildPrompt };
