'use strict';

/**
 * memoryBuffer.js
 *
 * Episodic memory read/write module for the research agent.
 *
 * Storage: flat JSON file at MEMORY_BUFFER_PATH (default: ./memory_buffer.json).
 *
 * Read:
 *   Input:  query {string}
 *   Output: top 5 memory entries scored by keyword overlap, sorted descending.
 *   If the file does not exist, returns [].
 *
 * Write:
 *   Input:  summary object { query, sub_questions, summaries, sources_used, timestamp }
 *   Appends the object to the buffer array (append-only in v1 — no truncation or deletion).
 *
 * Security (SECURITY.md):
 *   - Only reads/writes the permitted path (MEMORY_BUFFER_PATH).
 *   - No path traversal: path is resolved at startup and never changes.
 *   - Memory buffer contents are never sent to Tavily.
 */

const fs = require('fs');
const path = require('path');
const { scoreKeywordOverlap } = require('./keywordScorer');

const MEMORY_BUFFER_PATH = path.resolve(process.env.MEMORY_BUFFER_PATH || './memory_buffer.json');

/**
 * Load the entire memory buffer array from disk.
 * Returns [] if the file does not exist or is unreadable.
 * @returns {Array}
 */
function loadBuffer() {
  if (!fs.existsSync(MEMORY_BUFFER_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(MEMORY_BUFFER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[memoryBuffer] memory_buffer.json is not an array. Returning empty buffer.');
      return [];
    }
    return parsed;
  } catch (err) {
    console.error(`[memoryBuffer] Failed to read memory buffer: ${err.message}`);
    return [];
  }
}

/**
 * Read the top 5 most relevant memory entries for a given query.
 * Scores each entry's query field + summaries against the input query.
 * @param {string} query - The current sub-question or query string.
 * @returns {Array} Top 5 entries sorted by relevance score descending.
 */
function readMemory(query) {
  const buffer = loadBuffer();
  if (buffer.length === 0) return [];

  const scored = buffer.map(entry => {
    // Build a searchable text from the entry's query and summaries
    const entryText = [
      entry.query || '',
      ...(Array.isArray(entry.sub_questions) ? entry.sub_questions : []),
      ...(Array.isArray(entry.summaries) ? entry.summaries.map(s =>
        typeof s === 'string' ? s : (s.summary || '')
      ) : [])
    ].join(' ');

    return {
      entry,
      score: scoreKeywordOverlap(query, entryText)
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map(s => s.entry);
}

/**
 * Append a new summary entry to the memory buffer (append-only).
 * @param {{ query: string, sub_questions: string[], summaries: Array, sources_used: Array, timestamp: string }} summaryObj
 */
function writeMemory(summaryObj) {
  const buffer = loadBuffer();
  buffer.push(summaryObj);

  try {
    fs.writeFileSync(MEMORY_BUFFER_PATH, JSON.stringify(buffer, null, 2), 'utf8');
    console.log(`[memoryBuffer] Appended entry. Buffer size: ${buffer.length}.`);
  } catch (err) {
    console.error(`[memoryBuffer] Failed to write memory buffer: ${err.message}`);
    throw err;
  }
}

module.exports = { readMemory, writeMemory };
