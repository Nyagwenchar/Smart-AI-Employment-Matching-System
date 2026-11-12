/**
 * Job scoring: online model first, deterministic engine as the fallback.
 *
 * One request scores a batch of jobs, because scoring a board job by job would
 * be slow and would burn the free tier quota. Only the strongest deterministic
 * candidates are sent for refinement; the rest keep their offline score, so a
 * large board still loads in one round trip.
 *
 * Whatever the model returns is reconciled with the evidence:
 *   - percentages are clamped to 0-100 and rounded to two decimals
 *   - a score can never claim "qualified" while required skills are still
 *     missing, so the number and the verdict never contradict each other
 *   - gaps keep the deterministic advice text the UI already knows how to show
 */
const { scoreMatch, THRESHOLDS } = require('../match');
const taxonomy = require('../taxonomy');
const completion = require('./completion');
const { AiError } = require('./gemini');
const normalize = require('./normalize');
const runtime = require('./runtime');
const { config } = require('./config');

const SYSTEM = [
  'You are a technical recruiter scoring how well a candidate fits a job.',
  'Score 0-100 using evidence from the candidate skills and the job requirements.',
  'Be strict: a missing required skill must lower the score.',
  'Return JSON only, with one entry per job id you were given.'
].join(' ');

const OUTPUT_CONTRACT = `Return JSON shaped exactly like this:
{
  "results": [
    {
      "job_id": 1,
      "score": 0,
      "matched_skills": ["skill names the candidate demonstrably has"],
      "missing_skills": ["required skill names the candidate lacks"],
      "reason": "one or two sentences explaining the percentage"
    }
  ]
}`;

const MAX_DESCRIPTION_CHARS = 700;

const keyOf = (value) => taxonomy.normalize(value);

function jobForPrompt(entry) {
  return {
    job_id: entry.job.job_id,
    title: entry.job.title,
    company: entry.job.company_name,
    department: entry.job.department,
    description: String(entry.job.description || '').slice(0, MAX_DESCRIPTION_CHARS),
    requirements: (entry.requirements || []).map((requirement) => ({
      skill: requirement.skill_name,
      importance: requirement.importance,
      minimum_level: requirement.minimum_proficiency
    }))
  };
}

function buildPrompt(skills, entries) {
  const candidate = {
    skills: (skills || []).map((skill) => ({
      name: skill.name || skill.skill_name,
      level: skill.proficiency_level || skill.proficiency
    }))
  };

  return [
    'TASK: score_jobs',
    OUTPUT_CONTRACT,
    '',
    'CANDIDATE_JSON:',
    JSON.stringify(candidate),
    '',
    'JOBS_JSON:',
    JSON.stringify({ jobs: entries.map(jobForPrompt) }),
    '',
    'Score every job in JOBS_JSON. Use only skills listed for the candidate.'
  ].join('\n');
}

/**
 * Keeps the percentage honest: the model may be optimistic, but every unmet
 * mandatory requirement lowers the ceiling.
 *
 * A flat ceiling was the obvious first rule, but it pushed every imperfect
 * match to the same number, so a strong 88% candidate and a thin 60% candidate
 * both landed on 69.99 and the online mode read far worse than the offline one
 * for the same evidence. Scaling the ceiling by coverage keeps the ordering.
 */
function reconcileScore(rawScore, matchedRequired, requiredTotal) {
  let score = rawScore;

  if (requiredTotal) {
    const coverage = matchedRequired / requiredTotal;

    score = Math.min(score, 100 - 45 * (1 - coverage));

    if (coverage < THRESHOLDS.minMandatoryCoverage) {
      score = Math.min(score, 55);
    }
  }

  return normalize.asScore(score);
}

function rebuildGaps(requirements, skills, matched, baseGaps) {
  const owned = new Map(
    (skills || []).map((skill) => [keyOf(skill.name || skill.skill_name), skill])
  );
  const baseByName = new Map((baseGaps || []).map((gap) => [keyOf(gap.skill_name), gap]));
  const gaps = [];

  for (const requirement of requirements || []) {
    const key = keyOf(requirement.skill_name);
    if (matched.has(key)) continue;

    const existing = baseByName.get(key);

    if (existing) {
      gaps.push(existing);
      continue;
    }

    // The model disagreed with the deterministic pass, so record the gap here
    // instead of showing a match without its missing skill.
    const ownedSkill = owned.get(key) || null;
    const required = taxonomy.proficiencyRank(requirement.minimum_proficiency);
    const current = ownedSkill
      ? taxonomy.proficiencyRank(ownedSkill.proficiency_level || ownedSkill.proficiency)
      : null;

    gaps.push({
      skill_name: requirement.skill_name,
      importance: requirement.importance,
      gap_type: current === null ? 'missing' : 'below_level',
      current_proficiency: current,
      required_proficiency: required,
      recommendation:
        requirement.importance === 'preferred'
          ? `Preferred rather than mandatory, but ${requirement.skill_name} strengthens the application.`
          : current === null
            ? `No evidence of ${requirement.skill_name} yet. A short course plus one portfolio project closes this gap.`
            : `Your ${requirement.skill_name} level is below what this role asks for. Add hands-on work that shows the stronger level.`
    });
  }

  return gaps;
}

function composeReason(aiReason, fallback, score) {
  const text = String(aiReason || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return fallback;

  const clipped = text.length > 320 ? `${text.slice(0, 317)}...` : text;

  return /final score/i.test(clipped) ? clipped : `${clipped} Final score ${score}%.`;
}

function mergeResult(entry, ai, skills) {
  const requirements = entry.requirements || [];
  const required = requirements.filter((row) => row.importance !== 'preferred');
  const preferred = requirements.filter((row) => row.importance === 'preferred');

  // Evidence, not the model's bookkeeping. The model writes "Node" for a
  // requirement called "Node.js", so trusting its matched list marked the
  // requirement unmet and dragged every score down; the deterministic pass
  // already knows which requirements the candidate really satisfies.
  const matched = new Set((entry.result.matchedSkills || []).map(keyOf).filter(Boolean));

  const matchedRequired = required.filter((row) => matched.has(keyOf(row.skill_name))).length;
  const matchedPreferred = preferred.filter((row) => matched.has(keyOf(row.skill_name))).length;

  const score = reconcileScore(
    normalize.asScore(ai.score) ?? entry.result.score,
    matchedRequired,
    required.length
  );

  const gaps = rebuildGaps(requirements, skills, matched, entry.result.gaps);

  return {
    score,
    qualification: normalize.qualificationFor(score, matchedRequired, required.length),
    requiredMatched: matchedRequired,
    requiredTotal: required.length,
    preferredMatched: matchedPreferred,
    preferredTotal: preferred.length,
    matchedSkills: requirements
      .filter((row) => matched.has(keyOf(row.skill_name)))
      .map((row) => row.skill_name),
    missingSkills: gaps
      .filter((gap) => gap.importance === 'required' && gap.gap_type === 'missing')
      .map((gap) => gap.skill_name),
    belowLevelSkills: gaps
      .filter((gap) => gap.importance === 'required' && gap.gap_type === 'below_level')
      .map((gap) => gap.skill_name),
    gaps,
    reason: composeReason(ai.reason, entry.result.reason, score)
  };
}

/**
 * @param {Array} skills seeker skills as stored in the database
 * @param {Array<{job: object, requirements: Array}>} entries jobs with their requirements
 * @returns {Promise<{results: Map<number, object>, provider: string, error?: string}>}
 */
async function scoreJobs(skills, entries) {
  const prepared = (entries || []).map((entry) => ({
    ...entry,
    result: scoreMatch(skills, entry.requirements),
    source: 'deterministic'
  }));

  const results = new Map(prepared.map((entry) => [entry.job.job_id, entry.result]));

  if (!prepared.length || !runtime.onlineAvailable()) {
    return { results, provider: 'deterministic' };
  }

  const cfg = config();

  // A local CPU model cannot chew through a dozen jobs inside the deadline, so
  // the batch shrinks to what the tier that will actually answer can finish.
  const batchSize =
    runtime.preferredTier() === 'local' ? cfg.local.maxJobsPerCall : cfg.maxJobsPerCall;

  const shortlist = prepared
    .slice()
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, batchSize);

  try {
    const { data: payload, tier } = await completion.complete({
      task: 'score_jobs',
      system: SYSTEM,
      prompt: buildPrompt(skills, shortlist),
      temperature: 0.1,
      maxOutputTokens: 3072,
      budgetMs: cfg.budgetMs
    });

    const rows = Array.isArray(payload && payload.results) ? payload.results : null;

    if (!rows) {
      throw new AiError('The model did not return a results array', { code: 'bad_response' });
    }

    const byJobId = new Map();

    for (const row of rows) {
      if (!row) continue;
      const jobId = Number(row.job_id);
      if (Number.isInteger(jobId)) byJobId.set(jobId, row);
    }

    let merged = 0;

    for (const entry of shortlist) {
      const ai = byJobId.get(entry.job.job_id);
      if (!ai || normalize.asScore(ai.score) === null) continue;

      results.set(entry.job.job_id, mergeResult(entry, ai, skills));
      merged += 1;
    }

    if (!merged) {
      throw new AiError('The model returned no usable scores', { code: 'bad_response' });
    }

    return { results, provider: tier };
  } catch (error) {
    return { results, provider: 'deterministic', error: error.message };
  }
}

module.exports = { scoreJobs, mergeResult, reconcileScore, buildPrompt };
