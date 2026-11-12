/**
 * Matching engine service layer: everything that needs the database.
 *
 * Pure maths lives in lib/match.js and lib/recommend.js; this file only moves
 * rows in and out of Postgres.
 */
const pool = require('../db');
const ai = require('./ai');
const { deriveRequirements, scoreMatch } = require('./match');
const { rankSimilarJobs } = require('./recommend');

const PROFICIENCY_BY_RANK = ['beginner', 'intermediate', 'advanced', 'expert'];
const MAX_JOBS_PER_REFRESH = 300;
const MAX_CANDIDATE_JOBS = 200;
// A recommendation the seeker cannot actually do wastes their time, so anything
// scoring below this is dropped even if the role is textually similar.
const MIN_RECOMMENDATION_SCORE = 30;

const levelFromRank = (rank) => PROFICIENCY_BY_RANK[Math.min(Math.max(rank, 1), 4) - 1];

/* ------------------------------------------------------------------ */
/* Seeker                                                              */
/* ------------------------------------------------------------------ */

async function getSeeker(userId) {
  const { rows } = await pool.query(
    `SELECT p.seeker_id, p.location, p.bio, p.education_level, p.career_level, p.looking_for,
            u.full_name, u.email
     FROM job_seeker_profiles p
     JOIN users u ON u.user_id = p.user_id
     WHERE p.user_id = $1`,
    [userId]
  );

  return rows[0] || null;
}

async function getSeekerSkills(seekerId) {
  const { rows } = await pool.query(
    `SELECT s.skill_id, s.skill_name, s.category,
            jss.proficiency_level::text AS proficiency_level, jss.years_experience
     FROM job_seeker_skills jss
     JOIN skills s ON s.skill_id = jss.skill_id
     WHERE jss.seeker_id = $1
     ORDER BY s.skill_name`,
    [seekerId]
  );

  return rows;
}

/**
 * Adds parsed CV skills to the seeker's profile, creating vocabulary entries
 * as needed. Existing proficiency is overwritten because a newer CV is better
 * evidence than whatever was typed at signup.
 */
async function saveSeekerSkills(seekerId, skills) {
  if (!skills || !skills.length) return 0;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const skill of skills) {
      const { rows } = await client.query(
        `INSERT INTO skills (skill_name, category)
         VALUES ($1, $2)
         ON CONFLICT (skill_name) DO UPDATE
           SET category = COALESCE(NULLIF(skills.category, ''), EXCLUDED.category)
         RETURNING skill_id`,
        [skill.name, skill.category || null]
      );

      await client.query(
        `INSERT INTO job_seeker_skills (seeker_id, skill_id, proficiency_level)
         VALUES ($1, $2, $3::proficiency_level_enum)
         ON CONFLICT (seeker_id, skill_id) DO UPDATE
           SET proficiency_level = EXCLUDED.proficiency_level,
               updated_at = NOW()`,
        [seekerId, rows[0].skill_id, skill.proficiency || 'intermediate']
      );
    }

    await client.query('COMMIT');
    return skills.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                               */
/* ------------------------------------------------------------------ */

async function loadJobRequirements(jobId) {
  const { rows } = await pool.query(
    `SELECT jsr.skill_id, s.skill_name, s.category,
            jsr.importance::text AS importance,
            jsr.minimum_proficiency::text AS minimum_proficiency,
            jsr.weight
     FROM job_skill_requirements jsr
     JOIN skills s ON s.skill_id = jsr.skill_id
     WHERE jsr.job_id = $1
     ORDER BY jsr.importance, s.skill_name`,
    [jobId]
  );

  return rows;
}

/**
 * Employers do not always tag skills when posting, so derive them from the
 * description once and persist them. Derived rows are marked so they can be
 * told apart from hand-written requirements later.
 */
async function ensureJobRequirements(job) {
  const existing = await loadJobRequirements(job.job_id);
  if (existing.length) return existing;

  const derived = deriveRequirements(job.title, job.description);
  if (!derived.length) return [];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const requirement of derived) {
      const { rows } = await client.query(
        `INSERT INTO skills (skill_name, category)
         VALUES ($1, $2)
         ON CONFLICT (skill_name) DO UPDATE
           SET category = COALESCE(NULLIF(skills.category, ''), EXCLUDED.category)
         RETURNING skill_id`,
        [requirement.skill_name, requirement.category || null]
      );

      await client.query(
        `INSERT INTO job_skill_requirements
           (job_id, skill_id, importance, minimum_proficiency, weight, is_mandatory)
         VALUES ($1, $2, $3::skill_importance_enum, $4::proficiency_level_enum, $5, $6)
         ON CONFLICT (job_id, skill_id) DO NOTHING`,
        [
          job.job_id,
          rows[0].skill_id,
          requirement.importance,
          requirement.minimum_proficiency,
          requirement.weight,
          requirement.importance === 'required'
        ]
      );
    }

    await client.query(
      `UPDATE jobs SET requirements_source = 'derived'
       WHERE job_id = $1 AND requirements_source IS NULL`,
      [job.job_id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return loadJobRequirements(job.job_id);
}

async function loadOpenJobs({ jobId = null, limit = MAX_JOBS_PER_REFRESH } = {}) {
  const params = [];
  let filter = '';

  if (jobId) {
    params.push(jobId);
    filter = `AND j.job_id = $${params.length}`;
  }

  params.push(limit);

  const { rows } = await pool.query(
    `SELECT j.job_id, j.title, j.description, j.department, j.location,
            j.workplace_type::text AS workplace_type,
            j.employment_type::text AS employment_type,
            j.published_at, j.created_at,
            e.employer_id, e.company_name, e.industry
     FROM jobs j
     JOIN employer_profiles e ON e.employer_id = j.employer_id
     WHERE j.status::text = 'open' ${filter}
     ORDER BY j.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return rows;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                            */
/* ------------------------------------------------------------------ */

async function saveMatch(seekerId, jobId, requirements, result) {
  const skillIds = new Map(requirements.map((row) => [row.skill_name, row.skill_id]));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO job_matches
         (seeker_id, job_id, match_score,
          matched_required_skills_count, required_skills_count,
          matched_preferred_skills_count, preferred_skills_count,
          matching_reason, qualification, required_skills_matched,
          calculated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
       ON CONFLICT (seeker_id, job_id) DO UPDATE SET
         match_score = EXCLUDED.match_score,
         matched_required_skills_count = EXCLUDED.matched_required_skills_count,
         required_skills_count = EXCLUDED.required_skills_count,
         matched_preferred_skills_count = EXCLUDED.matched_preferred_skills_count,
         preferred_skills_count = EXCLUDED.preferred_skills_count,
         matching_reason = EXCLUDED.matching_reason,
         qualification = EXCLUDED.qualification,
         required_skills_matched = EXCLUDED.required_skills_matched,
         calculated_at = NOW(),
         updated_at = NOW()
       RETURNING match_id`,
      [
        seekerId,
        jobId,
        result.score,
        result.requiredMatched,
        result.requiredTotal,
        result.preferredMatched,
        result.preferredTotal,
        result.reason,
        result.qualification,
        JSON.stringify(result.matchedSkills)
      ]
    );

    const matchId = rows[0].match_id;

    await client.query('DELETE FROM skill_gaps WHERE seeker_id = $1 AND job_id = $2', [
      seekerId,
      jobId
    ]);

    for (const gap of result.gaps) {
      const skillId = skillIds.get(gap.skill_name);
      if (!skillId) continue;

      await client.query(
        `INSERT INTO skill_gaps
           (match_id, seeker_id, job_id, skill_id, importance, recommendation,
            gap_type, current_proficiency, required_proficiency)
         VALUES ($1, $2, $3, $4, $5::skill_importance_enum, $6,
                 $7::skill_gap_type_enum, $8::proficiency_level_enum,
                 $9::proficiency_level_enum)`,
        [
          matchId,
          seekerId,
          jobId,
          skillId,
          gap.importance,
          gap.recommendation,
          gap.gap_type,
          gap.current_proficiency ? levelFromRank(gap.current_proficiency) : null,
          levelFromRank(gap.required_proficiency)
        ]
      );
    }

    await client.query('COMMIT');
    return matchId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-scores every open job for one seeker. Cheap enough at this scale; the job
 * cap keeps a large board from turning a page load into a long transaction.
 *
 * Scoring goes through the AI layer, which batches the online model call and
 * silently falls back to the deterministic engine, so a missing key, a rate
 * limit or an outage never stops the dashboard from loading.
 */
async function refreshMatchesForSeeker(seekerId, options = {}) {
  const skills = await getSeekerSkills(seekerId);

  if (!skills.length) {
    return { scored: 0, skipped: 'seeker has no skills yet' };
  }

  const jobs = await loadOpenJobs(options);
  const entries = [];

  for (const job of jobs) {
    const requirements = await ensureJobRequirements(job);
    if (!requirements.length) continue;

    entries.push({ job, requirements });
  }

  const { results, provider } = await ai.scoreJobs(skills, entries);
  let scored = 0;

  for (const entry of entries) {
    const result = results.get(entry.job.job_id);
    if (!result) continue;

    await saveMatch(seekerId, entry.job.job_id, entry.requirements, result);
    scored += 1;
  }

  return { scored, total: jobs.length, provider };
}

/** Scores one job on demand — this is what powers "do I qualify for this?". */
async function scoreSingleJob(seekerId, jobId) {
  const jobs = await loadOpenJobs({ jobId, limit: 1 });

  if (!jobs.length) return null;

  const job = jobs[0];
  const skills = await getSeekerSkills(seekerId);

  if (!skills.length) {
    return { job, result: null, reason: 'Upload a CV so we can read your skills.' };
  }

  const requirements = await ensureJobRequirements(job);
  const { results } = await ai.scoreJobs(skills, [{ job, requirements }]);
  const result = results.get(job.job_id) || scoreMatch(skills, requirements);

  if (requirements.length) await saveMatch(seekerId, job.job_id, requirements, result);

  return { job, result, requirements };
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

const FRESH_FOR_MINUTES = 10;

/**
 * Re-scores only when what is stored looks stale (new jobs appeared, or the
 * last pass is old), so repeat dashboard loads stay cheap.
 */
async function ensureFreshMatches(seekerId, maxAgeMinutes = FRESH_FOR_MINUTES) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM jobs WHERE status::text = 'open') AS open_jobs,
       (SELECT COUNT(*)::int
          FROM job_matches jm
          JOIN jobs j ON j.job_id = jm.job_id
         WHERE jm.seeker_id = $1 AND j.status::text = 'open') AS scored_jobs,
       (SELECT MAX(jm.calculated_at)
          FROM job_matches jm
          JOIN jobs j ON j.job_id = jm.job_id
         WHERE jm.seeker_id = $1 AND j.status::text = 'open') AS last_calculated`,
    [seekerId]
  );

  const row = rows[0];
  const last = row.last_calculated ? new Date(row.last_calculated).getTime() : 0;
  const stale = Date.now() - last > maxAgeMinutes * 60 * 1000;

  if (!stale && row.scored_jobs >= row.open_jobs) {
    return { refreshed: false, scored: row.scored_jobs };
  }

  const result = await refreshMatchesForSeeker(seekerId);
  return { refreshed: true, ...result };
}

async function getMatches(seekerId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT jm.match_id, jm.job_id, jm.match_score, jm.qualification,
            jm.matching_reason,
            jm.matched_required_skills_count, jm.required_skills_count,
            jm.matched_preferred_skills_count, jm.preferred_skills_count,
            j.title, j.location, j.department,
            j.workplace_type::text AS workplace_type,
            j.employment_type::text AS employment_type,
            j.published_at,
            e.company_name, e.industry
     FROM job_matches jm
     JOIN jobs j ON j.job_id = jm.job_id
     JOIN employer_profiles e ON e.employer_id = j.employer_id
     WHERE jm.seeker_id = $1
       AND j.status::text = 'open'
     ORDER BY jm.match_score DESC NULLS LAST, j.published_at DESC NULLS LAST
     LIMIT $2`,
    [seekerId, limit]
  );

  return rows;
}

async function getSkillGaps(seekerId, limit = 12) {
  const { rows } = await pool.query(
    `SELECT sg.gap_id, s.skill_name, j.title AS job_title,
            sg.importance::text AS importance,
            sg.gap_type::text AS gap_type,
            sg.recommendation,
            sg.current_proficiency::text AS current_proficiency,
            sg.required_proficiency::text AS required_proficiency
     FROM skill_gaps sg
     JOIN skills s ON s.skill_id = sg.skill_id
     JOIN jobs j ON j.job_id = sg.job_id
     WHERE sg.seeker_id = $1
     ORDER BY CASE sg.gap_type WHEN 'missing' THEN 0 ELSE 1 END,
              CASE sg.importance WHEN 'required' THEN 0 ELSE 1 END,
              sg.gap_id DESC
     LIMIT $2`,
    [seekerId, limit]
  );

  return rows;
}

async function getAppliedJobIds(seekerId) {
  const { rows } = await pool.query(
    'SELECT job_id FROM applications WHERE seeker_id = $1',
    [seekerId]
  );

  return new Set(rows.map((row) => row.job_id));
}

/**
 * Similar open roles for a seeker.
 *
 * With `jobId` the anchor is that job ("you matched 80% here — try these").
 * Without it the anchor is the seeker's strongest match, which is the same
 * question asked from the other side.
 */
async function getRecommendations(seekerId, { jobId = null, limit = 5 } = {}) {
  const skills = await getSeekerSkills(seekerId);

  if (!skills.length) return [];

  let anchorJob = null;

  if (jobId) {
    const jobs = await loadOpenJobs({ jobId, limit: 1 });
    anchorJob = jobs[0] || null;
  } else {
    const matches = await getMatches(seekerId, 1);
    if (matches.length) {
      const jobs = await loadOpenJobs({ jobId: matches[0].job_id, limit: 1 });
      anchorJob = jobs[0] || null;
    }
  }

  if (!anchorJob) return [];

  const anchorRequirements = await ensureJobRequirements(anchorJob);
  const applied = await getAppliedJobIds(seekerId);
  const candidates = [];
  const jobs = await loadOpenJobs({ limit: MAX_CANDIDATE_JOBS });

  for (const job of jobs) {
    if (job.job_id === anchorJob.job_id || applied.has(job.job_id)) continue;

    const requirements = await ensureJobRequirements(job);
    if (!requirements.length) continue;

    const match = scoreMatch(skills, requirements);
    if (match.score < MIN_RECOMMENDATION_SCORE) continue;

    candidates.push({
      ...job,
      requirements,
      match
    });
  }

  const ranked = rankSimilarJobs(
    {
      job_id: anchorJob.job_id,
      industry: anchorJob.industry,
      department: anchorJob.department,
      requirements: anchorRequirements
    },
    candidates,
    limit
  );

  // Similarity decides who is eligible; the AI layer decides the order.
  let ordered = ranked;

  if (ranked.length) {
    const ranking = await ai.rankRecommendations({
      skills,
      anchorJob,
      candidates: ranked
    });

    ordered = ai.applyOrder(ranked, ranking.order);
  }

  return ordered.map((row) => ({
    job_id: row.job_id,
    title: row.title,
    company_name: row.company_name,
    location: row.location,
    industry: row.industry,
    workplace_type: row.workplace_type,
    similarity: Number((row.similarity * 100).toFixed(1)),
    match_score: row.match.score,
    qualification: row.match.qualification,
    matching_reason: row.match.reason,
    because_of: anchorJob.title
  }));
}

module.exports = {
  getSeeker,
  getSeekerSkills,
  saveSeekerSkills,
  loadJobRequirements,
  ensureJobRequirements,
  loadOpenJobs,
  refreshMatchesForSeeker,
  ensureFreshMatches,
  scoreSingleJob,
  getMatches,
  getSkillGaps,
  getRecommendations
};
