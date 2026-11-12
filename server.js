
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const engine = require('./lib/engine');
const ai = require('./lib/ai');
const { extractText, CvError } = require('./lib/cv-parse');

const app = express();

const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Multer writes here; without the directory the first upload fails with ENOENT.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;

// Refuse to boot on a half-configured environment. Without this a missing
// JWT_SECRET only surfaces as a 500 on the first login attempt.
const REQUIRED_ENV = ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingEnv = REQUIRED_ENV.filter((key) => !String(process.env[key] || '').trim());

if (missingEnv.length) {
  console.error('Missing required environment variables: ' + missingEnv.join(', '));
  console.error('Copy .env.example to .env, fill in the values, then start again.');
  process.exit(1);
}

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check. Deliberately does not reveal the database name or credentials.
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');

    res.json({
      success: true,
      message: 'PostgreSQL connected successfully!',
      serverTime: result.rows[0].server_time
    });
  } catch (err) {
    console.error('Database connection failed:', err.message);
    res.status(500).json({
      success: false,
      message: 'Database connection failed'
    });
  }
});

// Which engine answers the next request: Gemini online or the offline engine?
// Public on purpose: the UI shows it as a badge and it exposes no secrets.
app.get('/api/ai/status', (req, res) => {
  res.json(ai.status());
});

// Authentication middleware
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in' });
  }
}

// Helpers
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^(?:\+254|254|0)[17]\d{8}$/;

const normalizePhone = (p) =>
  '+254' + String(p).replace(/[\s-]/g, '').replace(/^(?:\+254|254|0)/, '');

// Throttle credential endpoints so one client cannot brute force accounts.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 25;
const authAttempts = new Map();

function authLimiter(req, res, next) {
  const now = Date.now();
  const key =
    (req.ip || 'local') +
    '|' +
    String((req.body && (req.body.email || req.body.identifier)) || '').toLowerCase();

  if (authAttempts.size > 2000) {
    for (const [entryKey, entry] of authAttempts) {
      if (now - entry.startedAt > AUTH_WINDOW_MS) authAttempts.delete(entryKey);
    }
  }

  const entry = authAttempts.get(key);

  if (!entry || now - entry.startedAt > AUTH_WINDOW_MS) {
    authAttempts.set(key, { count: 1, startedAt: now });
    return next();
  }

  entry.count += 1;

  if (entry.count > AUTH_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: 'Too many attempts from this device. Try again in a few minutes.'
    });
  }

  next();
}

// Register
app.post('/api/register', authLimiter, async (req, res) => {
  const {
    full_name,
    email,
    phone,
    password,
    role,
    county,
    profile = {}
  } = req.body || {};

  const name = String(full_name || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  const phoneRaw = String(phone || '').replace(/[\s-]/g, '');

  if (name.length < 2) {
    return res.status(400).json({ error: 'Enter your full name.' });
  }

  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (!PHONE_RE.test(phoneRaw)) {
    return res.status(400).json({
      error: 'Enter a Kenyan mobile number, like 0712 345 678.'
    });
  }

  if (
    !password ||
    password.length < 8 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    return res.status(400).json({
      error: 'Password needs at least 8 characters, with letters and numbers.'
    });
  }

  if (!['job_seeker', 'employer'].includes(role)) {
    return res.status(400).json({
      error: 'Choose whether you want to find work or hire talent.'
    });
  }

  if (!county) {
    return res.status(400).json({ error: 'Select your county.' });
  }

  let skills = [];

  if (role === 'job_seeker') {
    skills = (Array.isArray(profile.skills) ? profile.skills : [])
      .map(s => String(s).trim().replace(/\s+/g, ' ').slice(0, 30))
      .filter(Boolean)
      .slice(0, 10);

    if (!profile.education) {
      return res.status(400).json({
        error: 'Select your highest education level.'
      });
    }

    if (skills.length === 0) {
      return res.status(400).json({
        error: 'Add at least one skill so we can match you.'
      });
    }
  } else {
    if (String(profile.company || '').trim().length < 2) {
      return res.status(400).json({
        error: 'Enter your company name.'
      });
    }

    if (!profile.sector || !profile.size) {
      return res.status(400).json({
        error: 'Select your sector and company size.'
      });
    }
  }

  const phoneStored = normalizePhone(phoneRaw);
  const client = await pool.connect();

  try {
    const dup = await client.query(
      'SELECT 1 FROM users WHERE phone_number = $1',
      [phoneStored]
    );

    if (dup.rowCount) {
      return res.status(409).json({
        error: 'Email or phone already registered'
      });
    }

    await client.query('BEGIN');

    const hash = await bcrypt.hash(password, 10);

    const u = await client.query(
      `INSERT INTO users
        (full_name, email, phone_number, password_hash, role, account_type)
       VALUES ($1, $2, $3, $4, $5, $6::account_type_enum)
       RETURNING user_id, role, full_name`,
      [name, mail, phoneStored, hash, role, role]
    );

    const user = u.rows[0];

    if (role === 'job_seeker') {
      const sp = await client.query(
        `INSERT INTO job_seeker_profiles
          (user_id, location, education_level, looking_for)
         VALUES ($1, $2, $3, $4)
         RETURNING seeker_id`,
        [user.user_id, county, profile.education, profile.looking || 'both']
      );

      const seekerId = sp.rows[0].seeker_id;

      for (const skillName of skills) {
        let found = await client.query(
          'SELECT skill_id FROM skills WHERE LOWER(skill_name) = LOWER($1)',
          [skillName]
        );

        if (!found.rowCount) {
          found = await client.query(
            'INSERT INTO skills (skill_name) VALUES ($1) RETURNING skill_id',
            [skillName]
          );
        }

        await client.query(
          `INSERT INTO job_seeker_skills (seeker_id, skill_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [seekerId, found.rows[0].skill_id]
        );
      }
    } else {
      await client.query(
        `INSERT INTO employer_profiles
          (user_id, company_name, industry, location, company_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          user.user_id,
          String(profile.company).trim(),
          profile.sector,
          county,
          profile.size
        ]
      );
    }

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.status(201).json({
      token,
      role: user.role,
      name: user.full_name
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Email or phone already registered'
      });
    }

    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Login using email or phone
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    const id = String(identifier || '').trim().toLowerCase();
    const stripped = id.replace(/[\s-]/g, '');
    const phoneStored = PHONE_RE.test(stripped)
      ? normalizePhone(stripped)
      : null;

    const { rows } = await pool.query(
      `SELECT user_id, full_name, role, password_hash
       FROM users
       WHERE email = $1 OR phone_number = $2
       LIMIT 1`,
      [id, phoneStored]
    );

    const user = rows[0];

    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({
        error: 'Wrong email/phone or password'
      });
    }

    await pool.query(
      'UPDATE users SET last_signed_in = NOW() WHERE user_id = $1',
      [user.user_id]
    );

    const token = jwt.sign(
      { id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      token,
      role: user.role,
      name: user.full_name
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List open jobs. Add ?match=1 as a job seeker to annotate each one with
// the seeker's score for it.
app.get('/api/jobs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.*, e.company_name, e.industry
       FROM jobs j
       JOIN employer_profiles e ON e.employer_id = j.employer_id
       WHERE j.status = 'open'
       ORDER BY j.created_at DESC`
    );

    // Skill chips for the cards, so the board shows what each role asks for.
    const tags = new Map();

    if (rows.length) {
      const tagResult = await pool.query(
        `SELECT jsr.job_id, s.skill_name
         FROM job_skill_requirements jsr
         JOIN skills s ON s.skill_id = jsr.skill_id
         WHERE jsr.importance::text = 'required'
           AND jsr.job_id = ANY($1::int[])
         ORDER BY jsr.weight DESC, s.skill_name`,
        [rows.map((job) => job.job_id)]
      );

      for (const row of tagResult.rows) {
        if (!tags.has(row.job_id)) tags.set(row.job_id, []);
        tags.get(row.job_id).push(row.skill_name);
      }
    }

    // Scoring is best effort: a missing or expired token still lists the jobs.
    let scores = new Map();

    if (req.query.match === '1') {
      try {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const user = jwt.verify(token, process.env.JWT_SECRET);

        if (user.role === 'job_seeker') {
          const seeker = await engine.getSeeker(user.id);

          if (seeker) {
            await engine.ensureFreshMatches(seeker.seeker_id);

            const matches = await engine.getMatches(seeker.seeker_id, 200);
            scores = new Map(matches.map((match) => [match.job_id, match]));
          }
        }
      } catch {
        scores = new Map();
      }
    }

    res.json(
      rows.map((job) => {
        const match = scores.get(job.job_id);

        return {
          ...job,
          skills: (tags.get(job.job_id) || []).slice(0, 5),
          match_score: match ? match.match_score : null,
          qualification: match ? match.qualification : null
        };
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Employers post jobs
app.post('/api/jobs', auth, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }

  const {
    title,
    location,
    description,
    department,
    workplace_type,
    employment_type,
    skills
  } = req.body || {};

  if (!title || !description) {
    return res.status(400).json({
      error: 'Title and description required'
    });
  }

  const WORKPLACE = ['remote', 'hybrid', 'on_site'];
  const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'internship', 'freelance'];
  const LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];

  const workplace = WORKPLACE.includes(workplace_type) ? workplace_type : 'hybrid';
  const employment = EMPLOYMENT.includes(employment_type) ? employment_type : 'full_time';

  try {
    const emp = await pool.query(
      'SELECT employer_id FROM employer_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (!emp.rowCount) {
      return res.status(400).json({
        error: 'Employer profile not found'
      });
    }

    const inserted = await pool.query(
      `INSERT INTO jobs
        (employer_id, title, description, department, workplace_type,
         employment_type, location, status, published_at)
       VALUES ($1, $2, $3, $4, $5::workplace_type_enum,
               $6::employment_type_enum, $7, 'open', NOW())
       RETURNING job_id`,
      [
        emp.rows[0].employer_id,
        title,
        description,
        department || null,
        workplace,
        employment,
        location || null
      ]
    );

    const jobId = inserted.rows[0].job_id;

    // Optional skill tags. When omitted, requirements are derived from the
    // description the first time a seeker is scored against this job.
    const tags = Array.isArray(skills) ? skills.slice(0, 20) : [];

    for (const tag of tags) {
      const name = String(tag.name || tag.skill_name || '').trim();
      if (!name) continue;

      const importance = tag.importance === 'preferred' ? 'preferred' : 'required';
      const level = LEVELS.includes(tag.minimum_proficiency)
        ? tag.minimum_proficiency
        : 'beginner';
      const weight = Number(tag.weight) > 0 ? Number(tag.weight) : 1;

      const skill = await pool.query(
        `INSERT INTO skills (skill_name)
         VALUES ($1)
         ON CONFLICT (skill_name) DO UPDATE SET skill_name = EXCLUDED.skill_name
         RETURNING skill_id`,
        [name]
      );

      await pool.query(
        `INSERT INTO job_skill_requirements
           (job_id, skill_id, importance, minimum_proficiency, weight, is_mandatory)
         VALUES ($1, $2, $3::skill_importance_enum, $4::proficiency_level_enum, $5, $6)
         ON CONFLICT (job_id, skill_id) DO NOTHING`,
        [jobId, skill.rows[0].skill_id, importance, level, weight, importance === 'required']
      );
    }

    if (tags.length) {
      await pool.query(
        "UPDATE jobs SET requirements_source = 'employer' WHERE job_id = $1",
        [jobId]
      );
    }

    res.status(201).json({ message: 'Job posted', job_id: jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Does the logged-in seeker qualify for one specific job?
app.get('/api/jobs/:id/match', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const jobId = Number(req.params.id);

    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({ error: 'Job seeker profile not found' });
    }

    const scored = await engine.scoreSingleJob(seeker.seeker_id, jobId);

    if (!scored) {
      return res.status(404).json({ error: 'Job not found or no longer open' });
    }

    if (!scored.result) {
      return res.status(409).json({ error: scored.reason });
    }

    res.json({
      job: {
        job_id: scored.job.job_id,
        title: scored.job.title,
        company_name: scored.job.company_name,
        location: scored.job.location
      },
      match_score: scored.result.score,
      qualification: scored.result.qualification,
      matching_reason: scored.result.reason,
      matched_skills: scored.result.matchedSkills,
      gaps: scored.result.gaps
    });
  } catch (err) {
    console.error('Job match error:', err);
    res.status(500).json({ error: 'Could not score this job' });
  }
});

// Roles similar to the seeker's best match, or to a specific job
async function sendRecommendations(req, res, jobId) {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({ error: 'Job seeker profile not found' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);

    await engine.ensureFreshMatches(seeker.seeker_id);

    const recommendations = await engine.getRecommendations(seeker.seeker_id, {
      jobId: Number.isInteger(jobId) && jobId > 0 ? jobId : null,
      limit
    });

    res.json(recommendations);
  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({ error: 'Could not load recommendations' });
  }
}

app.get('/api/job-seeker/recommendations', auth, (req, res) =>
  sendRecommendations(req, res, req.query.job_id ? Number(req.query.job_id) : null)
);

app.get('/api/jobs/:id/recommendations', auth, (req, res) =>
  sendRecommendations(req, res, Number(req.params.id))
);

// Apply to a job; the score at apply time is stored with the match row
app.post('/api/applications', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const jobId = Number(req.body && req.body.job_id);

    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({ error: 'Job seeker profile not found' });
    }

    const jobResult = await pool.query(
      `SELECT job_id, status::text AS status FROM jobs WHERE job_id = $1`,
      [jobId]
    );

    if (!jobResult.rowCount || jobResult.rows[0].status !== 'open') {
      return res.status(404).json({ error: 'Job not found or no longer open' });
    }

    const { rows } = await pool.query(
      `INSERT INTO applications (seeker_id, job_id, cover_letter)
       VALUES ($1, $2, $3)
       RETURNING application_id, status::text AS status, submitted_at`,
      [seeker.seeker_id, jobId, (req.body && req.body.cover_letter) || null]
    );

    // The application is already stored, so a scoring failure must not turn a
    // successful submission into a 500 the client would retry.
    let scored = null;

    try {
      scored = await engine.scoreSingleJob(seeker.seeker_id, jobId);
    } catch (scoreErr) {
      console.error('Post-application scoring failed:', scoreErr.message);
    }

    res.status(201).json({
      ...rows[0],
      match_score: scored && scored.result ? scored.result.score : null
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'You have already applied to this job'
      });
    }

    console.error('Application error:', err);
    res.status(500).json({ error: 'Could not submit application' });
  }
});

// Applications tracker
app.get('/api/applications', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({ error: 'Job seeker profile not found' });
    }

    const { rows } = await pool.query(
      `SELECT a.application_id, a.status::text AS status, a.submitted_at,
              j.job_id, j.title, e.company_name,
              jm.match_score
       FROM applications a
       JOIN jobs j ON j.job_id = a.job_id
       JOIN employer_profiles e ON e.employer_id = j.employer_id
       LEFT JOIN job_matches jm
         ON jm.seeker_id = a.seeker_id AND jm.job_id = a.job_id
       WHERE a.seeker_id = $1
       ORDER BY a.submitted_at DESC`,
      [seeker.seeker_id]
    );

    res.json(rows);
  } catch (err) {
    console.error('Application list error:', err);
    res.status(500).json({ error: 'Could not load applications' });
  }
});

// Manual skill edits, alongside whatever the CV parser found
app.patch('/api/job-seeker/skills', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({ error: 'Job seeker profile not found' });
    }

    const LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];
    const incoming = Array.isArray(req.body && req.body.skills) ? req.body.skills : [];

    const skills = incoming
      .map((item) => {
        if (typeof item === 'string') {
          return { name: item.trim(), proficiency: 'intermediate' };
        }

        const name = String((item && (item.name || item.skill_name)) || '').trim();
        const requested = item && (item.proficiency_level || item.proficiency);
        const proficiency = LEVELS.includes(requested) ? requested : 'intermediate';

        return { name, proficiency };
      })
      .filter((skill) => skill.name.length > 0)
      .slice(0, 50);

    if (!skills.length) {
      return res.status(400).json({ error: 'Send at least one skill' });
    }

    const saved = await engine.saveSeekerSkills(seeker.seeker_id, skills);
    const refresh = await engine.refreshMatchesForSeeker(seeker.seeker_id);

    res.json({ skills_saved: saved, jobs_scored: refresh.scored });
  } catch (err) {
    console.error('Skill update error:', err);
    res.status(500).json({ error: 'Could not update skills' });
  }
});

// CV upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) =>
      cb(
        null,
        Date.now() + '-' +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname)
      )
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.docx'].includes(
      path.extname(file.originalname).toLowerCase()
    );

    cb(ok ? null : new Error('Only PDF or DOCX files are supported'), ok);
  }
});

// Multer writes before any handler runs, so every rejection path below has to
// remove the file it already stored or uploads/ fills with orphans.
function discardUpload(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

app.post('/api/cv', auth, (req, res) => {
  upload.single('cv')(req, res, async (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file received' });
    }

    if (req.user.role !== 'job_seeker') {
      discardUpload(req.file.path);

      return res.status(403).json({
        error: 'Only job seekers upload a CV'
      });
    }

    let text;

    try {
      text = await extractText(req.file.path);
    } catch (parseErr) {
      const status = parseErr instanceof CvError ? parseErr.status : 500;
      console.error('CV extraction error:', parseErr.message);
      discardUpload(req.file.path);

      return res.status(status).json({
        error:
          status === 500
            ? 'Could not read this CV. Try exporting it again as PDF.'
            : parseErr.message
      });
    }

    try {
      const parsed = await ai.parseCvWithAi(text);
      const seeker = await engine.getSeeker(req.user.id);

      if (!seeker) {
        discardUpload(req.file.path);

        return res.status(400).json({
          error: 'Job seeker profile not found'
        });
      }

      const saved = await pool.query(
        `INSERT INTO cvs
           (user_id, original_name, file_path, cv_text, parsed_json, parsed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         RETURNING cv_id, created_at`,
        [
          req.user.id,
          req.file.originalname,
          req.file.path,
          text,
          JSON.stringify(parsed)
        ]
      );

      const skillsSaved = await engine.saveSeekerSkills(
        seeker.seeker_id,
        parsed.skills
      );

      const refresh = await engine.refreshMatchesForSeeker(seeker.seeker_id);

      res.status(201).json({
        message: 'CV analysed',
        cv_id: saved.rows[0].cv_id,
        ai_source: parsed.source || 'dictionary',
        skills: parsed.skills,
        education_level: parsed.education_level,
        years_experience: parsed.years_experience,
        career_track: parsed.career_track,
        titles: parsed.titles,
        skills_saved: skillsSaved,
        jobs_scored: refresh.scored
      });
    } catch (dbErr) {
      console.error('CV processing error:', dbErr);
      res.status(500).json({ error: 'Could not process this CV' });
    }
  });
});

// The most recently parsed CV, for showing what the engine read
app.get('/api/cv', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({ error: 'Job seekers only' });
    }

    const { rows } = await pool.query(
      `SELECT cv_id, original_name, parsed_json, parsed_at, created_at
       FROM cvs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error('CV lookup error:', err);
    res.status(500).json({ error: 'Could not load CV' });
  }
});

// Get logged-in user's details
app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id AS id, full_name, email, role, created_at
       FROM users
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* EMPLOYER DASHBOARD API */
app.get('/api/employer/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({
        error: 'This dashboard is for employers only'
      });
    }

    const profileResult = await pool.query(
      `SELECT
         u.user_id,
         u.full_name,
         u.email,
         u.phone_number,
         u.role,
         e.employer_id,
         e.company_name,
         e.industry,
         e.location,
         e.company_size
       FROM users u
       LEFT JOIN employer_profiles e ON e.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.user.id]
    );

    if (!profileResult.rowCount) {
      return res.status(404).json({
        error: 'Employer account not found'
      });
    }

    const row = profileResult.rows[0];

    if (!row.employer_id) {
      return res.status(404).json({
        error: 'Company profile not found for this employer'
      });
    }

    const jobsResult = await pool.query(
      `SELECT
         j.job_id,
         j.title,
         j.location,
         j.status,
         COUNT(a.application_id)::int AS applications_count
       FROM jobs j
       LEFT JOIN applications a ON a.job_id = j.job_id
       WHERE j.employer_id = $1
       GROUP BY j.job_id, j.title, j.location, j.status, j.created_at
       ORDER BY j.created_at DESC`,
      [row.employer_id]
    );

    const jobs = jobsResult.rows;

    const stats = {
      total_jobs: jobs.length,
      active_jobs: jobs.filter(job => job.status === 'open').length,
      draft_jobs: jobs.filter(job => job.status === 'draft').length,
      applications_received: jobs.reduce(
        (total, job) => total + Number(job.applications_count || 0),
        0
      )
    };

    const shortlistedResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM applications a
       JOIN jobs j ON j.job_id = a.job_id
       WHERE j.employer_id = $1
         AND a.status = 'shortlisted'`,
      [row.employer_id]
    );

    stats.shortlisted_candidates = shortlistedResult.rows[0].total;

    res.json({
      user: {
        id: row.user_id,
        fullName: row.full_name,
        full_name: row.full_name,
        email: row.email,
        phone: row.phone_number,
        role: row.role
      },
      profile: {
        employer_id: row.employer_id,
        company_name: row.company_name,
        industry: row.industry,
        location: row.location,
        company_size: row.company_size
      },
      stats,
      jobs
    });
  } catch (err) {
    console.error('Employer dashboard error:', err);
    res.status(500).json({
      error: 'Could not load employer dashboard',
      details: process.env.NODE_ENV === 'development'
        ? err.message
        : undefined
    });
  }
});

/* EMPLOYER CANDIDATE PIPELINE */
app.get('/api/employer/applications', auth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({ error: 'This view is for employers only' });
    }

    const { rows } = await pool.query(
      `SELECT a.application_id,
              a.status::text AS status,
              a.submitted_at,
              j.job_id,
              j.title AS job_title,
              u.full_name,
              u.email,
              u.phone_number,
              p.location,
              p.education_level,
              jm.match_score,
              jm.qualification
       FROM applications a
       JOIN jobs j ON j.job_id = a.job_id
       JOIN employer_profiles e ON e.employer_id = j.employer_id
       JOIN job_seeker_profiles p ON p.seeker_id = a.seeker_id
       JOIN users u ON u.user_id = p.user_id
       LEFT JOIN job_matches jm
         ON jm.seeker_id = a.seeker_id AND jm.job_id = a.job_id
       WHERE e.user_id = $1
       ORDER BY a.submitted_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error('Employer applications error:', err);
    res.status(500).json({ error: 'Could not load candidate applications' });
  }
});

// Move a candidate through the hiring pipeline
app.patch('/api/employer/applications/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({ error: 'This action is for employers only' });
    }

    const applicationId = Number(req.params.id);
    const STATUSES = [
      'submitted',
      'under_review',
      'shortlisted',
      'interview',
      'offer',
      'rejected'
    ];
    const status = String((req.body && req.body.status) || '');

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return res.status(400).json({ error: 'Invalid application id' });
    }

    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'Status must be one of: ' + STATUSES.join(', ')
      });
    }

    const { rows } = await pool.query(
      `UPDATE applications a
       SET status = $1::application_status_enum
       FROM jobs j, employer_profiles e
       WHERE a.application_id = $2
         AND j.job_id = a.job_id
         AND e.employer_id = j.employer_id
         AND e.user_id = $3
       RETURNING a.application_id, a.status::text AS status`,
      [status, applicationId, req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Application status error:', err);
    res.status(500).json({ error: 'Could not update this application' });
  }
});

/* JOB-SEEKER DASHBOARD API */
app.get('/api/job-seeker/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({
        error: 'This dashboard is for job seekers only'
      });
    }

    const seeker = await engine.getSeeker(req.user.id);

    if (!seeker) {
      return res.status(404).json({
        error: 'Job seeker profile not found'
      });
    }

    // Re-scores only when stored results are missing or stale.
    await engine.ensureFreshMatches(seeker.seeker_id);

    const statsResult = await pool.query(
      `SELECT
        (
          SELECT COUNT(*)::int
          FROM job_matches jm
          JOIN jobs j ON j.job_id = jm.job_id
          WHERE jm.seeker_id = $1
            AND j.status::text = 'open'
        ) AS ai_matches,
        (
          SELECT COUNT(*)::int
          FROM job_matches jm
          JOIN jobs j ON j.job_id = jm.job_id
          WHERE jm.seeker_id = $1
            AND j.status::text = 'open'
            AND jm.qualification = 'qualified'
        ) AS qualified_matches,
        (
          SELECT COUNT(*)::int
          FROM applications a
          WHERE a.seeker_id = $1
        ) AS applications,
        (
          SELECT COUNT(*)::int
          FROM saved_jobs sj
          WHERE sj.seeker_id = $1
        ) AS saved_jobs,
        (
          SELECT COUNT(*)::int
          FROM job_seeker_skills jss
          WHERE jss.seeker_id = $1
        ) AS skills,
        (
          SELECT COUNT(*)::int
          FROM skill_gaps sg
          WHERE sg.seeker_id = $1
        ) AS skill_gaps`,
      [seeker.seeker_id]
    );

    const [matches, skillGaps, recommendations] = await Promise.all([
      engine.getMatches(seeker.seeker_id, 10),
      engine.getSkillGaps(seeker.seeker_id, 12),
      engine.getRecommendations(seeker.seeker_id, { limit: 4 })
    ]);

    const cvResult = await pool.query(
      `SELECT cv_id, original_name, parsed_json, parsed_at
       FROM cvs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    res.json({
      user: {
        id: req.user.id,
        fullName: seeker.full_name,
        email: seeker.email,
        role: req.user.role
      },
      profile: {
        seeker_id: seeker.seeker_id,
        location: seeker.location,
        education_level: seeker.education_level,
        career_level: seeker.career_level
      },
      stats: statsResult.rows[0],
      ai: ai.status(),
      matches,
      skillGaps,
      recommendations,
      cv: cvResult.rows[0] || null
    });
  } catch (err) {
    console.error('Job-seeker dashboard error:', err);
    res.status(500).json({
      error: 'Could not load dashboard data'
    });
  }
});

/* GET THE LOGGED-IN JOB SEEKER'S PROFILE */
app.get('/api/job-seeker/profile', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({
        error: 'This profile is for job seekers only'
      });
    }

    const result = await pool.query(
      `SELECT
         u.user_id,
         u.full_name,
         u.email,
         u.phone_number,
         u.role,
         p.seeker_id,
         p.location,
         p.bio,
         p.website_url,
         p.portfolio_url,
         p.education_level,
         p.career_level,
         p.availability,
         p.looking_for
       FROM users u
       LEFT JOIN job_seeker_profiles p ON p.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    const profile = result.rows[0];

    const skillsResult = await pool.query(
      `SELECT
         s.skill_id,
         s.skill_name,
         jss.proficiency_level,
         jss.years_experience
       FROM job_seeker_skills jss
       JOIN skills s ON s.skill_id = jss.skill_id
       WHERE jss.seeker_id = $1
       ORDER BY s.skill_name`,
      [profile.seeker_id]
    );

    res.json({
      ...profile,
      skills: skillsResult.rows
    });
  } catch (err) {
    console.error('Profile loading error:', err);
    res.status(500).json({
      error: 'Could not load profile'
    });
  }
});


/* ADMIN DASHBOARD API (read only, administrators only) */
app.get('/api/admin/dashboard', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'This area is for administrators only'
    });
  }

  try {
    const totalsResult = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS total_users,
         (SELECT COUNT(*)::int FROM users WHERE role = 'job_seeker') AS job_seekers,
         (SELECT COUNT(*)::int FROM users WHERE role = 'employer') AS employers,
         (SELECT COUNT(*)::int FROM jobs) AS total_jobs,
         (SELECT COUNT(*)::int FROM jobs WHERE status::text = 'open') AS open_jobs,
         (SELECT COUNT(*)::int FROM applications) AS total_applications,
         (SELECT COUNT(*)::int FROM applications
           WHERE status::text IN ('shortlisted', 'interview', 'offer')) AS placements,
         (SELECT COUNT(*)::int FROM job_matches) AS total_matches,
         (SELECT COUNT(*)::int FROM job_matches
           WHERE qualification = 'qualified') AS qualified_matches`
    );

    const totals = totalsResult.rows[0];
    const placementRate = totals.total_applications
      ? Math.round((totals.placements / totals.total_applications) * 1000) / 10
      : 0;

    const countiesResult = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(location), ''), 'Not stated') AS county,
              COUNT(*)::int AS seekers
       FROM job_seeker_profiles
       GROUP BY 1
       ORDER BY seekers DESC
       LIMIT 6`
    );

    const monthlyResult = await pool.query(
      `SELECT to_char(date_trunc('month', submitted_at), 'Mon') AS label,
              date_trunc('month', submitted_at) AS bucket,
              COUNT(*)::int AS total
       FROM applications
       WHERE submitted_at >= date_trunc('month', NOW()) - INTERVAL '7 months'
       GROUP BY 1, 2
       ORDER BY 2`
    );

    const directoryResult = await pool.query(
      `SELECT u.user_id,
              u.full_name,
              u.email,
              u.role::text AS role,
              u.created_at,
              COALESCE(e.company_name, p.location) AS detail
       FROM users u
       LEFT JOIN employer_profiles e ON e.user_id = u.user_id
       LEFT JOIN job_seeker_profiles p ON p.user_id = u.user_id
       ORDER BY u.created_at DESC
       LIMIT 25`
    );

    const activityResult = await pool.query(
      `(SELECT 'application' AS kind, a.submitted_at AS at,
               j.title AS label, u.full_name AS detail
        FROM applications a
        JOIN jobs j ON j.job_id = a.job_id
        JOIN job_seeker_profiles p ON p.seeker_id = a.seeker_id
        JOIN users u ON u.user_id = p.user_id
        ORDER BY a.submitted_at DESC
        LIMIT 5)
       UNION ALL
       (SELECT 'job' AS kind, j.created_at AS at,
               j.title AS label, e.company_name AS detail
        FROM jobs j
        JOIN employer_profiles e ON e.employer_id = j.employer_id
        ORDER BY j.created_at DESC
        LIMIT 5)
       UNION ALL
       (SELECT 'signup' AS kind, u.created_at AS at,
               u.full_name AS label, u.role::text AS detail
        FROM users u
        ORDER BY u.created_at DESC
        LIMIT 5)
       ORDER BY at DESC
       LIMIT 8`
    );

    res.json({
      stats: {
        total_users: totals.total_users,
        job_seekers: totals.job_seekers,
        employers: totals.employers,
        total_jobs: totals.total_jobs,
        open_jobs: totals.open_jobs,
        total_applications: totals.total_applications,
        total_matches: totals.total_matches,
        qualified_matches: totals.qualified_matches,
        placement_rate: placementRate
      },
      counties: countiesResult.rows,
      monthly: monthlyResult.rows,
      directory: directoryResult.rows,
      activity: activityResult.rows
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Could not load admin dashboard' });
  }
});

// Unknown API routes must answer with JSON, not the static-file HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Last resort: malformed bodies and unexpected throws get a JSON response.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log('SkillMatch AI Running on http://localhost:' + PORT);
});
