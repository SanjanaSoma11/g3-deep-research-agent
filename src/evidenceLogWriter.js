'use strict';

/**
 * evidenceLogWriter.js
 *
 * Appends a structured run record to output_log.json after each pipeline run.
 *
 * Input: A complete run record object (see schema below).
 * Output: Appends to output_log.json (append-only — never deletes existing entries).
 *
 * Record schema (CLAUDE.md Step 13):
 * {
 *   run_id:         string  (UUID)
 *   timestamp:      string  (ISO 8601)
 *   model_used:     string
 *   original_query: string
 *   sub_questions:  string[]
 *   final_answer:   string
 *   sources_used:   Array<{ type: "web"|"doc"|"memory", label: string }>
 *   token_usage:    Array<{ sub_question: string, tokens_used: number, tokens_dropped: number }>
 *   context_kept:   Array<{ source: string, tokens: number }>
 *   context_dropped: Array<{ source: string, tokens: number, reason: string }>
 * }
 *
 * Security (SECURITY.md):
 *   - Only writes to OUTPUT_LOG_PATH (default: ./output_log.json).
 *   - No path traversal.
 *   - Append-only: reads existing array, pushes new entry, writes back.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const OUTPUT_LOG_PATH = path.resolve(process.env.OUTPUT_LOG_PATH || './output_log.json');

/**
 * Load the existing log array from disk.
 * Returns [] if the file doesn't exist or is malformed.
 * @returns {Array}
 */
function loadLog() {
  if (!fs.existsSync(OUTPUT_LOG_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(OUTPUT_LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[evidenceLogWriter] Failed to read output_log.json: ${err.message}. Starting fresh.`);
    return [];
  }
}

/**
 * Append a run record to output_log.json.
 * @param {{
 *   model_used: string,
 *   original_query: string,
 *   sub_questions: string[],
 *   final_answer: string,
 *   sources_used: Array<{type: string, label: string}>,
 *   token_usage: Array<{sub_question: string, tokens_used: number, tokens_dropped: number}>,
 *   context_kept: Array<{source: string, tokens: number}>,
 *   context_dropped: Array<{source: string, tokens: number, reason: string}>,
 *   status?: string,
 *   error?: string
 * }} runData
 * @returns {string} The run_id assigned to this record.
 */
function writeEvidenceLog(runData) {
  const runId = randomUUID();
  const record = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    model_used: runData.model_used || '',
    original_query: runData.original_query || '',
    sub_questions: runData.sub_questions || [],
    final_answer: runData.final_answer || '',
    sources_used: runData.sources_used || [],
    token_usage: runData.token_usage || [],
    context_kept: runData.context_kept || [],
    context_dropped: runData.context_dropped || []
  };

  // Include optional status/error fields for failed runs
  if (runData.status) record.status = runData.status;
  if (runData.error) record.error = runData.error;

  const log = loadLog();
  log.push(record);

  try {
    fs.writeFileSync(OUTPUT_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
    console.log(`[evidenceLogWriter] Run ${runId} logged to output_log.json (total entries: ${log.length}).`);
  } catch (err) {
    console.error(`[evidenceLogWriter] Failed to write output_log.json: ${err.message}`);
    throw err;
  }

  return runId;
}

module.exports = { writeEvidenceLog };
