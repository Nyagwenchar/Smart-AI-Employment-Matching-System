/**
 * Seeds a small, realistic board so the matching engine has something to chew on.
 * Idempotent: re-running will not duplicate users, profiles or jobs.
 *
 *   node scripts/seed-demo.js
 *
 * Demo logins share one password. Override it before seeding anything you will
 * expose publicly:
 *
 *   $env:SEED_PASSWORD = 'a-long-random-password'; npm run seed
 */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db');

const PASSWORD = process.env.SEED_PASSWORD || 'Password123';

const EMPLOYERS = [
  {
    email: 'talent@savannatech.co.ke',
    name: 'Grace Wanjiru',
    phone: '+254711000001',
    company: 'Savanna Tech Ltd',
    industry: 'Information Technology',
    size: '51-200',
    description: 'Product engineering studio building payments and logistics software.'
  },
  {
    email: 'hr@equitygroup.co.ke',
    name: 'Peter Mwangi',
    phone: '+254711000002',
    company: 'Equity Bank Group',
    industry: 'Banking & Finance',
    size: '1000+',
    description: 'Regional bank serving retail and SME customers.'
  },
  {
    email: 'jobs@agakhanhospital.co.ke',
    name: 'Fatuma Ali',
    phone: '+254711000003',
    company: 'Aga Khan Hospital',
    industry: 'Healthcare',
    size: '500-1000',
    description: 'Private referral hospital in Nairobi.'
  }
];

const JOBS = [
  {
    company: 'Savanna Tech Ltd',
    title: 'Senior Frontend Engineer',
    location: 'Nairobi',
    workplace_type: 'hybrid',
    employment_type: 'full_time',
    department: 'Engineering',
    description:
      'We are looking for a senior frontend engineer with advanced React and TypeScript.\n' +
      'You will own our design system, build accessible interfaces with HTML and CSS,\n' +
      'and keep quality high through unit testing with Jest. Experience with Next.js\n' +
      'and Git based workflows is expected.'
  },
  {
    company: 'Savanna Tech Ltd',
    title: 'Backend Engineer (Node.js)',
    location: 'Nairobi',
    workplace_type: 'remote',
    employment_type: 'full_time',
    department: 'Engineering',
    description:
      'Build and operate REST APIs in Node.js backed by PostgreSQL. You will containerise\n' +
      'services with Docker, deploy on AWS, and own CI/CD pipelines. Exposure to Kubernetes\n' +
      'and Redis caching is a plus.'
  },
  {
    company: 'Savanna Tech Ltd',
    title: 'Data Analyst',
    location: 'Nairobi',
    workplace_type: 'on_site',
    employment_type: 'contract',
    department: 'Data',
    description:
      'Turn product data into decisions. Advanced Excel and SQL are essential, alongside\n' +
      'Power BI dashboards and statistical analysis. You will present findings to\n' +
      'non-technical stakeholders.'
  },
  {
    company: 'Savanna Tech Ltd',
    title: 'Digital Marketing Officer',
    location: 'Nairobi',
    workplace_type: 'hybrid',
    employment_type: 'full_time',
    department: 'Marketing',
    description:
      'Own our digital marketing funnel. You will run SEO, social media marketing and\n' +
      'Google Analytics reporting, write copywriting for campaigns, and manage the CRM.\n' +
      'Experience with Google Ads is required.'
  },
  {
    company: 'Equity Bank Group',
    title: 'Financial Risk Analyst',
    location: 'Nairobi',
    workplace_type: 'on_site',
    employment_type: 'full_time',
    department: 'Risk',
    description:
      'Prepare risk reports using advanced Excel. You will run statistical analysis,\n' +
      'build financial models, ensure IFRS compliance and present to the credit committee.\n' +
      'Knowledge of credit analysis is essential.'
  },
  {
    company: 'Aga Khan Hospital',
    title: 'Registered Nurse',
    location: 'Nairobi',
    workplace_type: 'on_site',
    employment_type: 'full_time',
    department: 'Clinical',
    description:
      'Deliver patient care in a busy medical ward. Registered nurse with BLS certification\n' +
      'and triage experience required. You will work with clinical officers and maintain\n' +
      'patient records.'
  }
];

async function upsertEmployer(employer) {
  const existing = await pool.query('SELECT user_id FROM users WHERE email = $1', [
    employer.email
  ]);

  let userId = existing.rows[0] && existing.rows[0].user_id;

  if (!userId) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone_number, password_hash, role, account_type)
       VALUES ($1, $2, $3, $4, 'employer', 'employer')
       RETURNING user_id`,
      [employer.name, employer.email, employer.phone, hash]
    );

    userId = rows[0].user_id;
  }

  const profile = await pool.query(
    'SELECT employer_id FROM employer_profiles WHERE user_id = $1',
    [userId]
  );

  if (!profile.rowCount) {
    await pool.query(
      `INSERT INTO employer_profiles
         (user_id, company_name, industry, company_description, location, company_size)
       VALUES ($1, $2, $3, $4, 'Nairobi', $5)`,
      [userId, employer.company, employer.industry, employer.description, employer.size]
    );
  }

  return userId;
}

async function upsertJob(job) {
  const owner = await pool.query(
    `SELECT e.employer_id
     FROM employer_profiles e
     WHERE e.company_name = $1`,
    [job.company]
  );

  if (!owner.rowCount) return null;

  const employerId = owner.rows[0].employer_id;

  const existing = await pool.query(
    'SELECT job_id FROM jobs WHERE employer_id = $1 AND title = $2',
    [employerId, job.title]
  );

  if (existing.rowCount) return existing.rows[0].job_id;

  const { rows } = await pool.query(
    `INSERT INTO jobs
       (employer_id, title, description, department, workplace_type, employment_type,
        location, status, published_at)
     VALUES ($1, $2, $3, $4, $5::workplace_type_enum, $6::employment_type_enum,
             $7, 'open', NOW())
     RETURNING job_id`,
    [
      employerId,
      job.title,
      job.description,
      job.department,
      job.workplace_type,
      job.employment_type,
      job.location
    ]
  );

  return rows[0].job_id;
}

(async () => {
  for (const employer of EMPLOYERS) {
    await upsertEmployer(employer);
  }

  for (const job of JOBS) {
    const id = await upsertJob(job);
    console.log(`job ${id}: ${job.title} (${job.company})`);
  }

  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(*)::int FROM jobs WHERE status::text = 'open') AS open_jobs,
       (SELECT COUNT(*)::int FROM employer_profiles) AS employers`
  );

  console.log('seeded:', counts.rows[0]);
  console.log(`\nEmployer login: talent@savannatech.co.ke / ${PASSWORD}`);

  if (!process.env.SEED_PASSWORD) {
    console.warn(
      'Warning: demo accounts use the default password. Set SEED_PASSWORD and re-run before exposing this data.'
    );
  }

  await pool.end();
})().catch(async (err) => {
  console.error('seed failed:', err.message);
  await pool.end();
  process.exit(1);
});
