-- Create ENUM type first
CREATE TYPE account_type_enum AS ENUM ('job_seeker', 'employer', 'admin');

-- Create users table
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone_number VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(30) NOT NULL,
	account_type account_type_enum NOT NULL DEFAULT 'job_seeker',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_signed_in TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

--Trigger Function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

--Create job seeker profiles
CREATE TABLE job_seeker_profiles (
    seeker_id SERIAL PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    location VARCHAR(255),
    bio TEXT,
	website_url VARCHAR(255),
	portfolio_url VARCHAR(255),
    career_level VARCHAR(50),
    availability VARCHAR(50),
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_signed_in TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE
);

CREATE TABLE employer_profiles (
    employer_id SERIAL PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    industry VARCHAR(100),
    company_description TEXT,
    location VARCHAR(100),
    website_url VARCHAR(200),
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_signed_in TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE
);

CREATE TABLE skills (
    skill_id SERIAL PRIMARY KEY,
    skill_name VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(255),
	description TEXT,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TYPE proficiency_level_enum AS ENUM (
    'beginner',
    'intermediate',
    'advanced',
    'expert'
);

CREATE TABLE job_seeker_skills (
    seeker_id INT NOT NULL,
    skill_id INT NOT NULL,
    proficiency_level proficiency_level_enum NOT NULL DEFAULT 'beginner',
	years_experience DECIMAL(4,1),
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

	
    PRIMARY KEY (seeker_id, skill_id),

    FOREIGN KEY (seeker_id)
        REFERENCES job_seeker_profiles(seeker_id)
        ON DELETE CASCADE,

    FOREIGN KEY (skill_id)
        REFERENCES skills(skill_id)
        ON DELETE CASCADE
);

CREATE TYPE workplace_type_enum AS ENUM (
    'remote',
    'hybrid',
    'on_site'
);

CREATE TYPE employment_type_enum AS ENUM (
    'full_time',
    'part_time',
    'contract',
    'internship',
    'freelance'
);

CREATE TYPE job_status_enum AS ENUM (
    'draft',
    'open',
    'paused',
    'closed'
);

CREATE TABLE jobs (
    job_id SERIAL PRIMARY KEY,
    employer_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
	department VARCHAR(255),
    workplace_type workplace_type_enum NOT NULL DEFAULT 'hybrid',
    employment_type employment_type_enum NOT NULL DEFAULT 'full_time',
    location VARCHAR(255),
    salary_min DECIMAL(10,2),
    salary_max DECIMAL(10,2),
    application_deadline DATE,
    status job_status_enum NOT NULL DEFAULT 'draft',
	published_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (employer_id)
        REFERENCES employer_profiles(employer_id)
        ON DELETE CASCADE, 
		
	CONSTRAINT jobs_salary_range_check
    CHECK (
      salary_min IS NULL
      OR salary_max IS NULL
      OR salary_max >= salary_min
    )
);

CREATE TYPE skill_importance_enum AS ENUM (
    'required',
    'preferred'
);

CREATE TABLE job_skill_requirements (
	job_id INT NOT NULL,
    skill_id INT NOT NULL,
    importance skill_importance_enum NOT NULL DEFAULT 'required',
    minimum_proficiency proficiency_level_enum NOT NULL DEFAULT 'beginner',
	weight DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    required_level VARCHAR(30),
    is_mandatory BOOLEAN DEFAULT TRUE,

    PRIMARY KEY (job_id, skill_id),

    FOREIGN KEY (job_id)
        REFERENCES jobs(job_id)
        ON DELETE CASCADE,

    FOREIGN KEY (skill_id)
        REFERENCES skills(skill_id)
        ON DELETE CASCADE
);

CREATE TABLE job_matches (
    match_id SERIAL PRIMARY KEY,
    seeker_id INT NOT NULL,
    job_id INT NOT NULL,
    match_score DECIMAL(5,2),
	matched_required_skills_count INT NOT NULL DEFAULT 0,
    required_skills_count INT NOT NULL DEFAULT 0,
    matched_preferred_skills_count INT NOT NULL DEFAULT 0,
    preferred_skills_count INT NOT NULL DEFAULT 0,
	matching_reason TEXT,
    calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (seeker_id)
        REFERENCES job_seeker_profiles(seeker_id)
        ON DELETE CASCADE,

    FOREIGN KEY (job_id)
        REFERENCES jobs(job_id)
        ON DELETE CASCADE,

	CONSTRAINT matches_seeker_job_unique
    UNIQUE (seeker_id, job_id),
    CONSTRAINT matches_score_check
    CHECK (match_score >= 0 AND match_score <= 100)
);

CREATE TYPE skill_gap_type_enum AS ENUM (
    'missing',
    'below_level'
);

CREATE TABLE skill_gaps (
	gap_id SERIAL PRIMARY KEY,
	match_id INT NOT NULL,
    seeker_id INT NOT NULL,
    job_id INT NOT NULL,
    skill_id INT NOT NULL,
    importance skill_importance_enum NOT NULL DEFAULT 'required',
    recommendation TEXT,
	gap_type skill_gap_type_enum NOT NULL,
    current_proficiency proficiency_level_enum,
    required_proficiency proficiency_level_enum NOT NULL,

    FOREIGN KEY (seeker_id)
        REFERENCES job_seeker_profiles(seeker_id)
        ON DELETE CASCADE,

    FOREIGN KEY (job_id)
        REFERENCES jobs(job_id)
        ON DELETE CASCADE,

    FOREIGN KEY (skill_id)
        REFERENCES skills(skill_id)
        ON DELETE CASCADE,

	CONSTRAINT skill_gaps_match_fk
    FOREIGN KEY (match_id) 
	REFERENCES job_matches(match_id)
    ON DELETE CASCADE,
	
    CONSTRAINT skill_gaps_match_skill_unique
    UNIQUE (match_id, skill_id)
);

CREATE TYPE application_status_enum AS ENUM (
    'submitted',
    'under_review',
    'shortlisted',
    'interview',
    'offer',
    'rejected',
    'withdrawn'
);

CREATE TABLE applications (
    application_id SERIAL PRIMARY KEY,
    seeker_id INT NOT NULL,
    job_id INT NOT NULL,
	cover_letter TEXT,
    application_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status application_status_enum NOT NULL DEFAULT 'submitted',
	submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	
    FOREIGN KEY (seeker_id)
        REFERENCES job_seeker_profiles(seeker_id)
        ON DELETE CASCADE,

    FOREIGN KEY (job_id)
        REFERENCES jobs(job_id)
        ON DELETE CASCADE,

    UNIQUE (seeker_id, job_id)
);

CREATE TABLE saved_jobs (
    seeker_id INT NOT NULL,
    job_id INT NOT NULL,
    saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (seeker_id, job_id),

    FOREIGN KEY (seeker_id)
        REFERENCES job_seeker_profiles(seeker_id)
        ON DELETE CASCADE,

    FOREIGN KEY (job_id)
        REFERENCES jobs(job_id)
        ON DELETE CASCADE
);