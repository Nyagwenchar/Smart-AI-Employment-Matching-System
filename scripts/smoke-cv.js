/**
 * Smoke test for the CV parser. Runs without a database:
 *   node scripts/smoke-cv.js
 */
const { parseCv } = require('../lib/cv-parse');

const SAMPLE_CV = `
BRIAN OTIENO
Nairobi, Kenya | brian.otieno@example.com | +254 712 345 678

PROFESSIONAL SUMMARY
Full stack developer with 5 years of experience building web applications for
fintech and logistics companies. Strong in JavaScript and React, comfortable
owning backend services in Node.js.

TECHNICAL SKILLS
- JavaScript (advanced), TypeScript, React, Next.js
- Node.js, Express, REST API design
- PostgreSQL, MongoDB
- Git, GitHub Actions, Docker
- Basic exposure to Kubernetes
- AWS (EC2, S3)

EXPERIENCE
Software Engineer, Savanna Pay (2021 - present)
- Built payment dashboards in React serving 40k users
- Designed REST APIs in Node.js backed by PostgreSQL
- Containerised services with Docker and set up CI/CD

Junior Developer, Tembo Logistics (2019 - 2021)
- Maintained an internal Django service
- Wrote unit testing suites with Jest

EDUCATION
BSc Computer Science, University of Nairobi, 2019
KCSE, Kisumu Boys High School, 2014
`;

const parsed = parseCv(SAMPLE_CV);

console.log('education_level :', parsed.education_level);
console.log('years_experience:', parsed.years_experience);
console.log('career_track    :', parsed.career_track);
console.log('titles          :', parsed.titles.map(t => t.name).join(', '));
console.log('skills:');

for (const skill of parsed.skills) {
  console.log(
    `  ${skill.name.padEnd(18)} ${skill.proficiency.padEnd(13)} ${skill.mentions}x  [${skill.category}]`
  );
}
