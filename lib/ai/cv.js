/**
 * CV parsing with an online model and a dictionary fallback.
 *
 * The deterministic extractor always runs first: it is instant, it never fails,
 * and it guarantees the endpoint has something to store even when the online
 * model is unreachable. Gemini then replaces the skill list when it returns
 * something usable.
 */
const { parseCv } = require('../cv-parse');
const { config } = require('./config');
const { complete } = require('./completion');
const normalize = require('./normalize');
const runtime = require('./runtime');

const SYSTEM = [
  'You are a CV parser for a Kenyan job matching platform.',
  'Return a single JSON object and nothing else.',
  'Only list skills that the CV text actually supports; never invent experience.',
  'Use short canonical skill names, for example "Node.js", "Financial Modeling", "Customer Service".',
  'Proficiency must be one of beginner, intermediate, advanced, expert.'
].join(' ');

const OUTPUT_CONTRACT = `Return JSON shaped exactly like this:
{
  "skills": [{ "name": "string", "category": "string", "proficiency": "beginner|intermediate|advanced|expert" }],
  "education_level": "secondary|certificate|diploma|bachelors|masters|phd|null",
  "years_experience": 0,
  "career_track": "string|null",
  "titles": ["string"]
}`;

const MAX_CV_CHARS = 12000;

function buildPrompt(text) {
  return [
    'TASK: cv_parse',
    OUTPUT_CONTRACT,
    '',
    'CV TEXT:',
    text.slice(0, MAX_CV_CHARS)
  ].join('\n');
}

/**
 * @param {string} text extracted CV text
 * @param {object} [dictionaryResult] reuse an already computed parseCv() result
 * @returns {Promise<object>} the same shape as parseCv(), plus `source`
 */
async function parseCvWithAi(text, dictionaryResult) {
  const dictionary = dictionaryResult || parseCv(text);
  const fallback = { ...dictionary, source: 'dictionary' };

  if (!runtime.onlineAvailable()) {
    return { ...fallback, ai_skipped: runtime.reasonOnlineUnavailable() };
  }

  try {
    const { data: payload, tier } = await complete({
      task: 'cv_parse',
      system: SYSTEM,
      prompt: buildPrompt(text),
      maxOutputTokens: 2048,
      budgetMs: config().budgetMs
    });

    const skills = normalize.normalizeSkills(payload.skills);

    // A list this short usually means the model gave up on the layout, and the
    // dictionary has better recall, so keep the dictionary result instead.
    if (skills.length < 3) {
      return { ...fallback, ai_skipped: 'model returned too few skills' };
    }

    return {
      ...dictionary,
      skills,
      education_level:
        normalize.asEducation(payload.education_level) || dictionary.education_level,
      years_experience:
        normalize.asYears(payload.years_experience) ?? dictionary.years_experience,
      career_track:
        normalize.asCareerTrack(payload.career_track, skills) || dictionary.career_track,
      source: tier,
      parsedAt: new Date().toISOString()
    };
  } catch (error) {
    return { ...fallback, ai_skipped: error.message };
  }
}

module.exports = { parseCvWithAi };
