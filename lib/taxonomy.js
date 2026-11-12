/**
 * Skill vocabulary + text matching.
 *
 * Free text is normalised so that "Node.js", "nodejs" and "node js" all resolve
 * to the same canonical skill. Every lookup is driven by data/skill-taxonomy.json,
 * so extending the vocabulary never requires touching this file.
 */
const fs = require('fs');
const path = require('path');

const RAW = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'skill-taxonomy.json'), 'utf8')
);

const EDUCATION_ORDER = ['secondary', 'certificate', 'diploma', 'bachelors', 'masters', 'phd'];
const PROFICIENCY_ORDER = ['beginner', 'intermediate', 'advanced', 'expert'];

/**
 * Lowercase, unify typographic quotes, and turn separators between word
 * characters into spaces: "Node.js" -> "node js", "ci/cd" -> "ci cd".
 * Runs twice so chained separators ("B.Sc.") are fully flattened.
 */
function normalize(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/([a-z0-9])[./\\_-]([a-z0-9])/g, '$1 $2')
    .replace(/([a-z0-9])[./\\_-]([a-z0-9])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Surround each alias with guards so "java" never matches inside "javascript"
 * and "c++"/"c#" survive as their own tokens.
 */
function buildPattern(alias) {
  const needle = normalize(alias);
  if (!needle) return null;
  return new RegExp(`(?<![a-z0-9+#])${escapeRegex(needle)}(?![a-z0-9+#])`, 'g');
}

const SKILLS = RAW.skills.map((skill) => ({
  name: skill.name,
  category: skill.category,
  patterns: skill.aliases.map(buildPattern).filter(Boolean)
}));

const TITLES = RAW.titles.map((title) => ({
  name: title.name,
  category: title.category,
  patterns: title.aliases.map(buildPattern).filter(Boolean)
}));

const EDUCATION_PATTERNS = RAW.education_keywords.map((entry) => ({
  level: entry.level,
  patterns: entry.keywords.map(buildPattern).filter(Boolean)
}));

const LEVEL_HINTS = [
  {
    level: 'expert',
    words: ['expert', 'extensive experience', 'mastery', 'principal', 'head of', 'architect', '10+ years', 'over 10 years']
  },
  {
    level: 'advanced',
    words: ['advanced', 'senior', 'strong', 'proficient', 'deep knowledge', 'specialist', '5+ years', 'over 5 years']
  },
  {
    level: 'beginner',
    words: ['basic', 'beginner', 'familiar with', 'exposure to', 'entry level', 'intern', 'currently learning', 'some knowledge']
  }
];

const HINT_RANK = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 };

// Word-bounded so "intern" never fires on "internal" and "lead" never on "leader".
const HINT_RULES = LEVEL_HINTS.map((hint) => ({
  level: hint.level,
  patterns: hint.words.map(
    (word) => new RegExp(`(?<![a-z0-9+#])${escapeRegex(normalize(word))}(?![a-z0-9+#])`)
  )
}));

function firstIndex(text, patterns) {
  let best = -1;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function countMatches(text, patterns) {
  let total = 0;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

/** Reads a single line to guess how strong the claim is. */
function hintInLine(line) {
  for (const rule of HINT_RULES) {
    if (rule.patterns.some((re) => re.test(line))) return rule.level;
  }

  return null;
}

/**
 * Scored line by line so a hint on one bullet point ("basic exposure to X")
 * never leaks onto a skill named on the next one.
 *
 * @returns {Array<{name:string, category:string, proficiency:string, mentions:number}>}
 */
function extractSkills(text) {
  const lines = String(text || '')
    .split(/\n/)
    .map(normalize)
    .filter(Boolean);

  const found = [];

  for (const skill of SKILLS) {
    let mentions = 0;
    let strongest = null;

    for (const line of lines) {
      const hits = countMatches(line, skill.patterns);
      if (!hits) continue;

      mentions += hits;
      const lineHint = hintInLine(line);

      if (lineHint && (!strongest || HINT_RANK[lineHint] > HINT_RANK[strongest])) {
        strongest = lineHint;
      }
    }

    if (!mentions) continue;

    found.push({
      name: skill.name,
      category: skill.category,
      proficiency: strongest || 'intermediate',
      explicit: Boolean(strongest),
      mentions
    });
  }

  return found.sort((a, b) => b.mentions - a.mentions);
}

/** Highest qualification mentioned, or null. */
function extractEducation(text) {
  const normalized = normalize(text);
  let best = null;

  for (const entry of EDUCATION_PATTERNS) {
    if (firstIndex(normalized, entry.patterns) === -1) continue;
    if (!best || EDUCATION_ORDER.indexOf(entry.level) > EDUCATION_ORDER.indexOf(best)) {
      best = entry.level;
    }
  }

  return best;
}

/** Largest number of years claimed anywhere in the document. */
function extractYears(text) {
  const normalized = normalize(text);
  let years = 0;

  for (const m of normalized.matchAll(/(\d{1,2})\s*(?:\+|plus)?\s*(?:years?|yrs?)/g)) {
    const value = Number(m[1]);
    if (value > years && value < 50) years = value;
  }

  const currentYear = new Date().getFullYear();
  for (const m of normalized.matchAll(/(?:since|from)\s+(19\d{2}|20\d{2})/g)) {
    const value = currentYear - Number(m[1]);
    if (value > years && value < 50) years = value;
  }

  return years;
}

/** Job titles the candidate claims, in order of appearance. */
function extractTitles(text) {
  const normalized = normalize(text);
  const hits = [];

  for (const title of TITLES) {
    const index = firstIndex(normalized, title.patterns);
    if (index === -1) continue;
    hits.push({ name: title.name, category: title.category, index });
  }

  return hits
    .sort((a, b) => a.index - b.index)
    .map(({ name, category }) => ({ name, category }));
}

/** The career track a candidate most plausibly belongs to. */
function primaryCategory(skills) {
  const tally = new Map();

  for (const skill of skills) {
    const weight = 1 + (skill.mentions > 2 ? 1 : 0);
    tally.set(skill.category, (tally.get(skill.category) || 0) + weight);
  }

  let best = null;
  let bestScore = 0;
  for (const [category, score] of tally) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }

  return best;
}

function skillByName(name) {
  const needle = normalize(name);
  return SKILLS.find(
    (skill) =>
      normalize(skill.name) === needle ||
      skill.patterns.some((re) => {
        re.lastIndex = 0;
        const m = re.exec(needle);
        return m && m[0] === needle;
      })
  ) || null;
}

function proficiencyRank(level) {
  const index = PROFICIENCY_ORDER.indexOf(String(level || '').toLowerCase());
  return index === -1 ? 1 : index + 1;
}

module.exports = {
  taxonomy: RAW,
  skills: SKILLS,
  titles: TITLES,
  normalize,
  extractSkills,
  extractEducation,
  extractYears,
  extractTitles,
  primaryCategory,
  skillByName,
  proficiencyRank,
  EDUCATION_ORDER,
  PROFICIENCY_ORDER
};
