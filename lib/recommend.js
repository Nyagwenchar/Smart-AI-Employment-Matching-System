/**
 * Job-to-job similarity for the "similar roles" recommendations.
 *
 * Compared on requirement vectors rather than raw text: two listings that ask
 * for the same skills are similar even if one is titled "Backend Engineer" and
 * the other "Node.js Developer".
 */
const { normalize } = require('./taxonomy');

const SIMILARITY_FLOOR = 0.1;

function requirementVector(requirements) {
  const vector = new Map();

  for (const requirement of requirements || []) {
    const key = normalize(requirement.skill_name);
    if (!key) continue;

    const weight = Number(requirement.weight) > 0 ? Number(requirement.weight) : 1;
    vector.set(key, (vector.get(key) || 0) + weight);
  }

  return vector;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;

  let dot = 0;
  let normA = 0;

  for (const [key, value] of a) {
    normA += value * value;
    dot += value * (b.get(key) || 0);
  }

  let normB = 0;
  for (const value of b.values()) normB += value * value;

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const sameText = (a, b) => {
  const left = normalize(a || '');
  return Boolean(left) && left === normalize(b || '');
};

/**
 * 0..1 similarity. Shared sector and department nudge otherwise-close roles up,
 * so an IT job never outranks a same-sector role with a near-identical skill set.
 */
function jobSimilarity(target, candidate) {
  const base = cosine(
    requirementVector(target.requirements),
    requirementVector(candidate.requirements)
  );

  let bonus = 0;
  if (sameText(target.industry, candidate.industry)) bonus += 0.15;
  if (sameText(target.department, candidate.department)) bonus += 0.05;

  return Math.min(1, Math.round((base + bonus) * 1000) / 1000);
}

/**
 * @param {object} target      job used as the anchor
 * @param {object[]} candidates other open jobs
 */
function rankSimilarJobs(target, candidates, limit = 5) {
  return candidates
    .filter((candidate) => candidate.job_id !== target.job_id)
    .map((candidate) => ({
      ...candidate,
      similarity: jobSimilarity(target, candidate)
    }))
    .filter((candidate) => candidate.similarity >= SIMILARITY_FLOOR)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

module.exports = { requirementVector, cosine, jobSimilarity, rankSimilarJobs, SIMILARITY_FLOOR };
