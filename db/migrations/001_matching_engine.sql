-- 001: Reconcile code/schema drift and add the raw material the matching engine needs.
-- Every statement is idempotent so this file can be re-applied safely.

BEGIN;

-- Columns server.js already writes but the baseline dump never created.
ALTER TABLE job_seeker_profiles
  ADD COLUMN IF NOT EXISTS education_level VARCHAR(50),
  ADD COLUMN IF NOT EXISTS looking_for VARCHAR(20) DEFAULT 'both';

ALTER TABLE employer_profiles
  ADD COLUMN IF NOT EXISTS company_size VARCHAR(50);

-- Uploaded CVs: file location plus the extracted text and parsed structure.
CREATE TABLE IF NOT EXISTS cvs (
  cv_id         SERIAL PRIMARY KEY,
  user_id       INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  file_path     VARCHAR(500) NOT NULL,
  cv_text       TEXT,
  parsed_json   JSONB,
  parsed_at     TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cvs_user_fk FOREIGN KEY (user_id)
    REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cvs_user_idx ON cvs (user_id, created_at DESC);

-- Canonical skill aliases: "nodejs", "node.js" and "node" all resolve to one skill.
CREATE TABLE IF NOT EXISTS skill_aliases (
  alias    VARCHAR(120) PRIMARY KEY,
  skill_id INT NOT NULL,
  CONSTRAINT skill_aliases_skill_fk FOREIGN KEY (skill_id)
    REFERENCES skills(skill_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS skill_aliases_skill_idx ON skill_aliases (skill_id);

-- Qualification verdict stored next to the score so the UI never recomputes it.
ALTER TABLE job_matches
  ADD COLUMN IF NOT EXISTS qualification VARCHAR(20),
  ADD COLUMN IF NOT EXISTS required_skills_matched JSONB;

ALTER TABLE job_matches
  DROP CONSTRAINT IF EXISTS job_matches_qualification_check;

ALTER TABLE job_matches
  ADD CONSTRAINT job_matches_qualification_check
  CHECK (qualification IS NULL OR qualification IN ('qualified', 'partially_qualified', 'not_qualified'));

-- Dashboard reads and scoring passes both filter on these.
CREATE INDEX IF NOT EXISTS job_matches_seeker_score_idx
  ON job_matches (seeker_id, match_score DESC);

CREATE INDEX IF NOT EXISTS skill_gaps_seeker_idx ON skill_gaps (seeker_id);

CREATE INDEX IF NOT EXISTS job_skill_requirements_job_idx
  ON job_skill_requirements (job_id);

-- Records whether a job's requirements were written by the employer or derived
-- from the job description text, so derived ones can be refreshed safely.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requirements_source VARCHAR(20);

COMMIT;
