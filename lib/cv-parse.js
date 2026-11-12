/**
 * CV ingestion: turn an uploaded file into text, then text into structure.
 *
 * Errors carry a `status` so the route can respond with the right code:
 * 415 = unsupported format, 422 = nothing readable inside the file.
 */
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const taxonomy = require('./taxonomy');

const MIN_USABLE_CHARS = 120;

class CvError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'CvError';
    this.status = status;
  }
}

const EXTENSIONS = ['.pdf', '.docx'];

function cleanup(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.doc') {
    throw new CvError(
      'Legacy .doc files cannot be read. Save the CV as PDF or .docx and upload again.',
      415
    );
  }

  if (!EXTENSIONS.includes(ext)) {
    throw new CvError('Only PDF and DOCX files are supported.', 415);
  }

  if (!fs.existsSync(filePath)) {
    throw new CvError('The uploaded file disappeared while being processed.', 422);
  }

  let text = '';

  if (ext === '.pdf') {
    // Node reads small files into a shared pool, so the Buffer starts at a
    // non-zero byteOffset. pdf-parse ignores that offset and throws
    // "bad XRef entry", so hand it a copy that starts at zero.
    const raw = fs.readFileSync(filePath);
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);

    const parsed = await pdfParse(bytes);
    text = parsed.text;
  } else {
    const parsed = await mammoth.extractRawText({ path: filePath });
    text = parsed.value;
  }

  const cleaned = cleanup(text);

  if (cleaned.length < MIN_USABLE_CHARS) {
    throw new CvError(
      'No readable text found in this file. Scanned or image-only documents need a text-based PDF or DOCX.',
      422
    );
  }

  return cleaned;
}

/**
 * @param {string} text raw CV text already extracted from the file
 */
function parseCv(text) {
  const skills = taxonomy.extractSkills(text);
  const titles = taxonomy.extractTitles(text);

  return {
    textLength: text.length,
    skills,
    titles,
    education_level: taxonomy.extractEducation(text),
    years_experience: taxonomy.extractYears(text),
    career_track: taxonomy.primaryCategory(skills) || titles[0]?.category || null,
    parsedAt: new Date().toISOString()
  };
}

module.exports = { extractText, parseCv, CvError, EXTENSIONS, MIN_USABLE_CHARS };
