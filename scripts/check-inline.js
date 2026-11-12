/**
 * Syntax-checks every inline <script> block in the static pages, because a
 * typo there fails silently in the browser instead of at build time.
 *
 *   node scripts/check-inline.js public/job-seeker-dashboard.html
 */
const fs = require('fs');
const path = require('path');

const targets = process.argv.slice(2);

if (!targets.length) {
  console.error('usage: node scripts/check-inline.js <file.html> [more.html]');
  process.exit(1);
}

let failures = 0;

for (const target of targets) {
  const file = path.resolve(target);
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

  blocks.forEach((block, index) => {
    const source = block[1];

    if (!source.trim()) return;

    try {
      // Compiling catches syntax errors without executing page code.
      new Function(source);
      console.log(`ok    ${path.basename(file)} block ${index + 1}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${path.basename(file)} block ${index + 1}: ${err.message}`);
    }
  });
}

process.exit(failures ? 1 : 0);
