/**
 * Validation for anything a model returns.
 *
 * The rule is: the model proposes, this module decides. Values outside the
 * expected shape are dropped, and the match verdict is always recomputed with
 * the same thresholds the deterministic engine uses, so 72% is
 * "partially qualified" whether the number came from Gemini or from local maths.
 */
const taxonomy = require('../taxonomy');
const { THRESHOLDS } = require('../match');

const MAX_SKILLS = 40;

function cleanSkillName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function asScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.min(Math.max(number, 0), 100) * 100) / 100;
}

function asProficiency(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return taxonomy.PROFICIENCY_ORDER.includes(candidate) ? candidate : null;
}

function asEducation(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return taxonomy.EDUCATION_ORDER.includes(candidate) ? candidate : null;
}

function asYears(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number * 10) / 10, 60);
}

/**
 * The taxonomy category is preferred because the rest of the app groups skills
 * by it. A short label from the model is accepted only when the taxonomy has
 * nothing to say about any of the extracted skills.
 */
function asCareerTrack(value, skills) {
  const fromSkills = skills && skills.length ? taxonomy.primaryCategory(skills) : null;
  if (fromSkills) return fromSkills;

  const candidate = String(value || '').trim();
  return candidate && candidate.length <= 60 ? candidate : null;
}

/** Dedupes by normalised name and maps known skills onto their canonical label. */
function normalizeSkills(list, { defaultProficiency = 'intermediate' } = {}) {
  const seen = new Map();

  for (const entry of Array.isArray(list) ? list : []) {
    const name = cleanSkillName(typeof entry === 'string' ? entry : entry && entry.name);
    if (!name) continue;

    // Resolve to the canonical label before keying off it: the model writes
    // both "React" and "React.js" for one skill, and those normalise to
    // different strings while meaning the same thing.
    const known = taxonomy.skillByName(name);
    const label = known ? known.name : name;
    const key = taxonomy.normalize(label);
    if (!key || seen.has(key)) continue;

    seen.set(key, {
      name: label,
      category: (known && known.category) || cleanSkillName(entry && entry.category) || 'Other',
      proficiency: asProficiency(entry && entry.proficiency) || defaultProficiency,
      explicit: Boolean(entry && entry.explicit),
      mentions: 1
    });
  }

  return [...seen.values()].slice(0, MAX_SKILLS);
}

/** Mirrors the verdict rule in lib/match.js so both modes agree. */
function qualificationFor(score, requiredMatched, requiredTotal) {
  if (!requiredTotal) return 'not_qualified';
  if (requiredMatched / requiredTotal < THRESHOLDS.minMandatoryCoverage) return 'not_qualified';
  if (requiredMatched === requiredTotal && score >= THRESHOLDS.qualifiedScore) return 'qualified';
  return 'partially_qualified';
}

module.exports = {
  cleanSkillName,
  asScore,
  asProficiency,
  asEducation,
  asYears,
  asCareerTrack,
  normalizeSkills,
  qualificationFor
};
