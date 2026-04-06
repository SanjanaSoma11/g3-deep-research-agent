'use strict';

/**
 * chunker.js
 *
 * Document chunking utility. Run once at startup (or manually via `npm run chunk`).
 *
 * Inputs:
 *   Reads all .pdf and .txt files from the /docs directory (configurable via DOCS_DIR).
 *
 * Outputs:
 *   Writes an array of chunk objects to chunks_index.json. Each chunk:
 *   { source_filename, chunk_index, word_count, text }
 *
 * Behaviour:
 *   - If /docs is empty, writes [] and logs a warning (does not throw).
 *   - Skips files that cannot be parsed (logs a warning, continues).
 *   - Skips files larger than 10MB (SECURITY.md limit).
 *   - Only accepts .pdf and .txt extensions (SECURITY.md limit).
 *   - Target chunk size: ~300 words.
 *   - Never executes or evaluates document content (SECURITY.md: data only).
 *
 * Security notes (SECURITY.md):
 *   - No path traversal: validates all filenames do not contain '..'.
 *   - File content is treated as plain text only, never executed.
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.resolve(process.env.DOCS_DIR || './docs');
const CHUNKS_INDEX_PATH = path.resolve('./chunks_index.json');
const TARGET_CHUNK_WORDS = 300;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Split text into chunks of approximately TARGET_CHUNK_WORDS words.
 * @param {string} text
 * @param {string} sourceFilename
 * @returns {Array<{source_filename, chunk_index, word_count, text}>}
 */
function chunkText(text, sourceFilename) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks = [];
  let chunkIndex = 0;

  for (let i = 0; i < words.length; i += TARGET_CHUNK_WORDS) {
    const chunkWords = words.slice(i, i + TARGET_CHUNK_WORDS);
    const chunkText = chunkWords.join(' ');
    chunks.push({
      source_filename: sourceFilename,
      chunk_index: chunkIndex,
      word_count: chunkWords.length,
      text: chunkText
    });
    chunkIndex++;
  }

  return chunks;
}

/**
 * Extract text from a .txt file.
 * @param {string} filePath
 * @returns {string}
 */
function extractTextFromTxt(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Extract text from a .pdf file using pdf-parse (pure JS, no native binaries).
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromPdf(filePath) {
  // pdf-parse is a pure JavaScript PDF text extractor
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (err) {
    console.error('[chunker] pdf-parse not installed. Run: npm install');
    throw new Error('pdf-parse module not found. Run: npm install');
  }

  const dataBuffer = fs.readFileSync(filePath);
  try {
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (err) {
    console.error(`[chunker] Failed to parse PDF "${filePath}": ${err.message}`);
    throw err;
  }
}

/**
 * Main chunker function. Reads /docs, chunks all .pdf and .txt files,
 * writes result to chunks_index.json.
 * @returns {Promise<Array>} Array of all chunk objects written.
 */
async function runChunker() {
  console.log(`[chunker] Starting document chunker. DOCS_DIR=${DOCS_DIR}`);

  // Ensure docs directory exists
  if (!fs.existsSync(DOCS_DIR)) {
    console.warn(`[chunker] WARNING: DOCS_DIR "${DOCS_DIR}" does not exist. Writing empty chunks_index.json.`);
    fs.writeFileSync(CHUNKS_INDEX_PATH, JSON.stringify([], null, 2), 'utf8');
    return [];
  }

  let files;
  try {
    files = fs.readdirSync(DOCS_DIR);
  } catch (err) {
    console.error(`[chunker] Failed to read DOCS_DIR: ${err.message}`);
    fs.writeFileSync(CHUNKS_INDEX_PATH, JSON.stringify([], null, 2), 'utf8');
    return [];
  }

  // Filter to .pdf and .txt only; skip .gitkeep and other hidden files
  const supportedFiles = files.filter(filename => {
    // Security: reject any filename containing path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      console.warn(`[chunker] Skipping suspicious filename: "${filename}"`);
      return false;
    }
    const ext = path.extname(filename).toLowerCase();
    return ext === '.pdf' || ext === '.txt';
  });

  if (supportedFiles.length === 0) {
    console.warn('[chunker] WARNING: No .pdf or .txt files found in /docs. Writing empty chunks_index.json.');
    fs.writeFileSync(CHUNKS_INDEX_PATH, JSON.stringify([], null, 2), 'utf8');
    return [];
  }

  const allChunks = [];

  for (const filename of supportedFiles) {
    const filePath = path.join(DOCS_DIR, filename);

    // Security: enforce no path traversal in resolved path
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(DOCS_DIR)) {
      console.warn(`[chunker] Skipping file outside DOCS_DIR: "${filename}"`);
      continue;
    }

    // Check file size
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      console.warn(`[chunker] Cannot stat file "${filename}": ${err.message}. Skipping.`);
      continue;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      console.warn(`[chunker] Skipping "${filename}": file size ${stat.size} bytes exceeds 10MB limit.`);
      continue;
    }

    const ext = path.extname(filename).toLowerCase();
    let text = '';

    try {
      if (ext === '.txt') {
        text = extractTextFromTxt(filePath);
      } else if (ext === '.pdf') {
        text = await extractTextFromPdf(filePath);
      }
    } catch (err) {
      console.warn(`[chunker] Failed to parse "${filename}": ${err.message}. Skipping.`);
      continue;
    }

    if (!text || text.trim().length === 0) {
      console.warn(`[chunker] "${filename}" produced no text content. Skipping.`);
      continue;
    }

    const chunks = chunkText(text.trim(), filename);
    console.log(`[chunker] "${filename}" => ${chunks.length} chunk(s).`);
    allChunks.push(...chunks);
  }

  try {
    fs.writeFileSync(CHUNKS_INDEX_PATH, JSON.stringify(allChunks, null, 2), 'utf8');
    console.log(`[chunker] Done. ${allChunks.length} total chunks written to chunks_index.json.`);
  } catch (err) {
    console.error(`[chunker] Failed to write chunks_index.json: ${err.message}`);
    throw err;
  }

  return allChunks;
}

module.exports = { runChunker };

// Allow direct invocation: node src/chunker.js
if (require.main === module) {
  runChunker().catch(err => {
    console.error('[chunker] Fatal error:', err.message);
    process.exit(1);
  });
}
