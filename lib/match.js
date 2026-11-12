/**
 * Deterministic CV-to-job scoring.
 *
 * Same CV + same job always produces the same number, so any percentage shown
 * in the UI can be explained line by line. No external AI call is involved here;
 * the optional LLM layer only improves how text becomes a skill list.
 */
const { normalize, proficiencyRank, extractSkills } = require('./taxonomy');

const WEIGHTS = {
  required: 0.75,
  preferred: 0.25
};

const THRESHOLDS = {
  qualifiedScore: 70,
  minMandatoryCoverage: 0.5
};

const MAX_DERIVED_REQUIREMENTS = 12;
const MAX_DERIVED_REQUIRED = 8;

const GAP_ADVICE = {
  missing: (name) =>
    `No evidence of ${name} yet. A short course plus one portfolio project closes this gap.`,
  belowLevel: (name, have, need) =>
    `You are ${have} in ${name}; this role asks for ${need}. Add hands-on work that shows the stronger level.`
};

/**
 * Turns a job title + description into requirements when the employer did not
 * supply any. Skills named with an explicit level ("advanced React") keep that
 * level; everything else defaults to beginner so the bar stays realistic.
 */
function deriveRequirements(title, description) {
  const text = `${title || ''}\n${String(description || '').replace(/[.;]/g, '\n')}`;
  const found = extractSkills(text).slice(0, MAX_DERIVED_REQUIREMENTS);

  return found.map((skill, index) => ({
    skill_name: skill.name,
    category: skill.category,
    importance: index < MAX_DERIVED_REQUIRED ? 'required' : 'preferred',
    minimum_proficiency: skill.explicit ? skill.proficiency : 'beginner',
    weight: skill.mentions >= 3 ? 2 : 1
  }));
}

/** How well one requirement is satisfied, and whether it leaves a gap. */
function evaluate(seekerSkill, requirement) {
  const required = proficiencyRank(requirement.minimum_proficiency);

  if (!seekerSkill) {
    return { ratio: 0, gapType: 'missing', current: null, required };
  }

  const have = proficiencyRank(seekerSkill.proficiency_level || seekerSkill.proficiency);

  if (have >= required) return { ratio: 1, gapType: null, current: have, required };

  return { ratio: have / required, gapType: 'below_level', current: have, required };
}

function tidy(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {Array<{name:string, proficiency_level?:string, proficiency?:string}>} seekerSkills
 * @param {Array<{skill_name:string, importance:string, minimum_proficiency:string, weight?:number}>} requirements
 */
function scoreMatch(seekerSkills, requirements) {
  const owned = new Map();
  for (const skill of seekerSkills || []) {
    owned.set(normalize(skill.name || skill.skill_name), skill);
  }

  const required = [];
  const preferred = [];

  for (const requirement of requirements || []) {
    const seekerSkill = owned.get(normalize(requirement.skill_name)) || null;
    const weight = Number(requirement.weight) > 0 ? Number(requirement.weight) : 1;
    const result = { ...evaluate(seekerSkill, requirement), requirement, weight };

    if (requirement.importance === 'preferred') preferred.push(result);
    else required.push(result);
  }

  const covered = (rows) => {
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    if (!totalWeight) return { ratio: 0, weight: 0 };
    const earned = rows.reduce((sum, row) => sum + row.ratio * row.weight, 0);
    return { ratio: earned / totalWeight, weight: totalWeight };
  };

  const requiredScore = covered(required);
  const preferredScore = covered(preferred);

  let ratio;
  if (required.length && preferred.length) {
    ratio =
      WEIGHTS.required * requiredScore.ratio + WEIGHTS.preferred * preferredScore.ratio;
  } else if (required.length) {
    ratio = requiredScore.ratio;
  } else if (preferred.length) {
    ratio = preferredScore.ratio;
  } else {
    ratio = 0;
  }

  const matchedRequired = required.filter((row) => row.gapType === null);
  const matchedPreferred = preferred.filter((row) => row.gapType === null);
  const coverage = required.length ? matchedRequired.length / required.length : 0;
  const score = tidy(ratio * 100);

  let qualification;
  if (!required.length) {
    qualification = 'not_qualified';
  } else if (coverage < THRESHOLDS.minMandatoryCoverage) {
    qualification = 'not_qualified';
  } else if (matchedRequired.length === required.length && score >= THRESHOLDS.qualifiedScore) {
    qualification = 'qualified';
  } else {
    qualification = 'partially_qualified';
  }

  const gaps = [...required, ...preferred]
    .filter((row) => row.gapType !== null)
    .map((row) => {
      const name = row.requirement.skill_name;
      const advice =
        row.gapType === 'missing'
          ? GAP_ADVICE.missing(name)
          : GAP_ADVICE.belowLevel(name, row.current, row.required);

      return {
        skill_name: name,
        importance: row.requirement.importance,
        gap_type: row.gapType,
        current_proficiency: row.current,
        required_proficiency: row.required,
        recommendation:
          row.requirement.importance === 'preferred'
            ? `${advice} Preferred rather than mandatory, but it strengthens the application.`
            : advice
      };
    });

  return {
    score,
    qualification,
    requiredMatched: matchedRequired.length,
    requiredTotal: required.length,
    preferredMatched: matchedPreferred.length,
    preferredTotal: preferred.length,
    matchedSkills: [...matchedRequired, ...matchedPreferred].map((row) => row.requirement.skill_name),
    missingSkills: required.filter((row) => row.gapType === 'missing').map((row) => row.requirement.skill_name),
    belowLevelSkills: required
      .filter((row) => row.gapType === 'below_level')
      .map((row) => row.requirement.skill_name),
    gaps,
    reason: buildReason({
      score,
      qualification,
      matchedRequired: matchedRequired.length,
      requiredTotal: required.length,
      matchedPreferred: matchedPreferred.length,
      preferredTotal: preferred.length,
      missing: required.filter((row) => row.gapType === 'missing').map((row) => row.requirement.skill_name),
      below: required
        .filter((row) => row.gapType === 'below_level')
        .map((row) => row.requirement.skill_name)
    })
  };
}

function buildReason(row) {
  const parts = [];

  if (!row.requiredTotal && !row.preferredTotal) {
    return 'This job has no skill requirements recorded yet, so it cannot be scored.';
  }

  if (row.requiredTotal) {
    parts.push(`Matches ${row.matchedRequired}/${row.requiredTotal} required skills`);
  }

  if (row.preferredTotal) {
    parts.push(`${row.matchedPreferred}/${row.preferredTotal} preferred`);
  }

  if (row.missing.length) {
    parts.push(`No evidence of ${list(row.missing)}`);
  }

  if (row.below.length) {
    parts.push(`Below the level asked for in ${list(row.below)}`);
  }

  const verdict = {
    qualified: 'Strong fit for this role.',
    partially_qualified: 'Close, but not yet a full match.',
    not_qualified: 'Below the bar for this role right now.'
  }[row.qualification];

  return `${verdict} ${parts.join('. ')}. Final score ${row.score}%.`;
}

function list(names) {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

module.exports = {
  WEIGHTS,
  THRESHOLDS,
  deriveRequirements,
  scoreMatch
};
