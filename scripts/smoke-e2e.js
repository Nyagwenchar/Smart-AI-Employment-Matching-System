/**
 * End-to-end check against a running server.
 *
 *   node server.js            (terminal 1)
 *   node scripts/smoke-e2e.js (terminal 2)
 *
 * Registers a seeker, uploads a real PDF, then prints the dashboard,
 * job board scores, recommendations and an application.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = `e2e.${Date.now()}@example.com`;
const PHONE = '0712' + String(Date.now()).slice(-6);

async function call(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(BASE + pathname, { method, headers, body: payload });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
}

function line(label) {
  console.log(`\n=== ${label} ===`);
}

(async () => {
  line('1. register seeker');
  const register = await call('/api/register', {
    method: 'POST',
    body: {
      full_name: 'Brian Otieno',
      email: EMAIL,
      phone: PHONE,
      password: 'Password123',
      role: 'job_seeker',
      county: 'Nairobi',
      profile: { education: 'bachelors', skills: ['Communication'], looking: 'job' }
    }
  });

  if (register.status !== 201) {
    console.error('register failed', register.status, register.data);
    process.exit(1);
  }

  const token = register.data.token;
  console.log(`registered ${EMAIL} (role ${register.data.role})`);

  line('2. upload CV as PDF');
  const pdfPath = path.join(__dirname, 'fixtures', 'sample-cv.pdf');
  const pdf = fs.readFileSync(pdfPath);
  const form = new FormData();
  form.append('cv', new Blob([pdf], { type: 'application/pdf' }), 'brian-otieno-cv.pdf');

  const upload = await call('/api/cv', { method: 'POST', token, form });
  console.log(`status ${upload.status}`);

  if (upload.status !== 201) {
    console.error('upload failed', upload.data);
    process.exit(1);
  }

  console.log(`parsed ${upload.data.skills.length} skills, education=${upload.data.education_level}, years=${upload.data.years_experience}`);
  console.log(`track=${upload.data.career_track}, jobs_scored=${upload.data.jobs_scored}`);
  console.log('top skills:', upload.data.skills.slice(0, 8).map((s) => `${s.name}(${s.proficiency})`).join(', '));

  line('3. dashboard');
  const dash = await call('/api/job-seeker/dashboard', { token });
  console.log('stats:', dash.data.stats);

  for (const match of dash.data.matches) {
    console.log(
      `  ${String(match.match_score).padStart(6)}%  ${match.qualification.padEnd(19)}  ${match.title} @ ${match.company_name}`
    );
  }

  line('4. skill gaps');
  for (const gap of dash.data.skillGaps.slice(0, 5)) {
    console.log(`  [${gap.importance}/${gap.gap_type}] ${gap.skill_name} — ${gap.job_title}`);
  }

  line('5. recommendations');
  for (const rec of dash.data.recommendations) {
    console.log(
      `  ${String(rec.match_score).padStart(6)}%  ${rec.title} @ ${rec.company_name} (similarity ${rec.similarity}%, because of ${rec.because_of})`
    );
  }

  line('6. job board with scores');
  const board = await call('/api/jobs?match=1', { token });
  for (const job of board.data) {
    const score = job.match_score === null ? '  n/a' : `${String(job.match_score).padStart(6)}%`;
    const skills = (job.skills || []).slice(0, 3).join(', ');
    console.log(`  ${score}  ${job.title} @ ${job.company_name} [${skills}]`);
  }

  line('7. qualify check on one job');
  const target = board.data.find((job) => job.title.includes('Frontend'));
  const single = await call(`/api/jobs/${target.job_id}/match`, { token });
  console.log(`${single.data.job.title}: ${single.data.match_score}% (${single.data.qualification})`);
  console.log(single.data.matching_reason);

  line('8. apply');
  const apply = await call('/api/applications', {
    method: 'POST',
    token,
    body: { job_id: target.job_id }
  });
  console.log('status', apply.status, apply.data);

  const duplicate = await call('/api/applications', {
    method: 'POST',
    token,
    body: { job_id: target.job_id }
  });
  console.log('duplicate apply ->', duplicate.status, duplicate.data.error);

  line('9. applications tracker');
  const apps = await call('/api/applications', { token });
  for (const application of apps.data) {
    console.log(
      `  ${application.title} @ ${application.company_name} — ${application.status}, ${application.match_score}% match`
    );
  }

  line('10. dashboard after applying');
  const after = await call('/api/job-seeker/dashboard', { token });
  console.log('stats:', after.data.stats);

  line('seeker login for the UI');
  console.log(`${EMAIL} / Password123`);
})().catch((err) => {
  console.error('e2e failed:', err.message);
  process.exit(1);
});
