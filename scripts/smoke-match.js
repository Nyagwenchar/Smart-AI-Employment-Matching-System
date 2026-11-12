/**
 * Smoke test for the scoring engine. Runs without a database:
 *   node scripts/smoke-match.js
 */
const fs = require('fs');
const path = require('path');
const { parseCv } = require('../lib/cv-parse');
const { deriveRequirements, scoreMatch } = require('../lib/match');

const cvText = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'sample-cv.txt'),
  'utf8'
);

const cv = parseCv(cvText);
const seekerSkills = cv.skills.map((skill) => ({
  name: skill.name,
  proficiency_level: skill.proficiency
}));

const JOBS = [
  {
    title: 'Senior Frontend Engineer',
    description:
      'We need a senior frontend engineer with advanced React and TypeScript.\n' +
      'You will build design systems, work with CSS and HTML, write unit testing\n' +
      'with Jest, and ship through Git based CI pipelines.'
  },
  {
    title: 'Backend Engineer',
    description:
      'Build REST APIs in Node.js backed by PostgreSQL. Experience with Docker,\n' +
      'AWS and CI/CD required. Kubernetes is a plus.'
  },
  {
    title: 'Financial Risk Analyst',
    description:
      'Prepare risk reports using advanced Excel. You will run statistical analysis,\n' +
      'build financial models, ensure IFRS compliance and present to the credit committee.'
  },
  {
    title: 'Registered Nurse',
    description:
      'Deliver patient care in a busy ward. Registered nurse with BLS certification\n' +
      'and experience in triage required.'
  }
];

console.log(`Career track detected: ${cv.career_track}`);
console.log(`Seeker skills: ${seekerSkills.length}\n`);

for (const job of JOBS) {
  const requirements = deriveRequirements(job.title, job.description);
  const result = scoreMatch(seekerSkills, requirements);

  console.log(`${job.title.padEnd(28)} ${String(result.score).padStart(6)}%  ${result.qualification}`);
  console.log(`  requirements: ${requirements.map((r) => r.skill_name).join(', ')}`);
  console.log(`  ${result.reason}`);

  if (result.gaps.length) {
    console.log(`  gaps: ${result.gaps.map((g) => `${g.skill_name} (${g.gap_type})`).join(', ')}`);
  }

  console.log('');
}
