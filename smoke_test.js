'use strict';

/**
 * smoke_test.js
 *
 * End-to-end smoke test for the G3 Deep Research Agent.
 *
 * Usage: node smoke_test.js
 *
 * What it does:
 *   1. Sends one hardcoded business research query through the full pipeline.
 *   2. Asserts output_log.json has one new entry after the run.
 *   3. Asserts the new entry has non-empty final_answer, sub_questions, sources_used.
 *   4. Asserts no sub-question context exceeded 2,000 tokens.
 *   5. Prints PASS or FAIL with a reason for each assertion.
 *
 * Requirements:
 *   - GROQ_API_KEY must be set in the environment (or .env).
 *   - TAVILY_API_KEY must be set in the environment (or .env).
 *   - No test framework required — plain assertions only.
 *
 * Exit code: 0 if all assertions pass, 1 if any fail.
 */

// Load .env if present (manual dotenv-lite — no external dependency)
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

const { runPipeline } = require('./src/pipeline');
const OUTPUT_LOG_PATH = path.resolve(process.env.OUTPUT_LOG_PATH || './output_log.json');

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, name, reason) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passCount++;
  } else {
    console.log(`  FAIL  ${name} — ${reason}`);
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load output_log.json safely
// ─────────────────────────────────────────────────────────────────────────────

function loadOutputLog() {
  if (!fs.existsSync(OUTPUT_LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(OUTPUT_LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test runner
// ─────────────────────────────────────────────────────────────────────────────

async function runSmokeTest() {
  console.log('=== G3 Deep Research Agent — Smoke Test ===\n');

  const TEST_QUERY = 'What are the main factors driving growth in enterprise AI adoption, and which industries are leading this trend?';

  console.log(`Test query: "${TEST_QUERY}"\n`);

  // Record pre-run log length
  const logBefore = loadOutputLog();
  const logLengthBefore = logBefore.length;
  console.log(`Output log entries before run: ${logLengthBefore}`);

  // Run the pipeline
  let result;
  let pipelineError = null;
  try {
    console.log('\nRunning pipeline (this may take a minute)...\n');
    result = await runPipeline(TEST_QUERY);
    console.log(`Pipeline returned run_id: ${result.run_id}\n`);
  } catch (err) {
    pipelineError = err;
    console.error(`Pipeline threw an error: ${err.message}\n`);
  }

  console.log('--- Assertions ---\n');

  // Assertion 1: Pipeline did not throw a fatal error
  assert(
    pipelineError === null,
    'Pipeline completed without fatal error',
    pipelineError ? pipelineError.message : ''
  );

  // If pipeline failed fatally, remaining assertions cannot be checked
  if (pipelineError) {
    console.log('\n--- Results ---\n');
    console.log(`PASSED: ${passCount}  FAILED: ${failCount}`);
    process.exit(1);
  }

  // Assertion 2: output_log.json has exactly one new entry
  const logAfter = loadOutputLog();
  assert(
    logAfter.length === logLengthBefore + 1,
    'output_log.json has exactly one new entry after the run',
    `log length before=${logLengthBefore}, after=${logAfter.length}`
  );

  // Get the new log entry
  const newEntry = logAfter[logAfter.length - 1];

  // Assertion 3: new entry matches the returned run_id
  assert(
    newEntry && newEntry.run_id === result.run_id,
    'New log entry has the correct run_id',
    `expected run_id=${result.run_id}, got=${newEntry ? newEntry.run_id : 'undefined'}`
  );

  // Assertion 4: final_answer is non-empty
  assert(
    newEntry && typeof newEntry.final_answer === 'string' && newEntry.final_answer.trim().length > 0,
    'Log entry has non-empty final_answer',
    `final_answer="${newEntry ? String(newEntry.final_answer).substring(0, 50) : 'undefined'}"`
  );

  // Assertion 5: sub_questions is a non-empty array
  assert(
    newEntry && Array.isArray(newEntry.sub_questions) && newEntry.sub_questions.length > 0,
    'Log entry has non-empty sub_questions array',
    `sub_questions=${JSON.stringify(newEntry ? newEntry.sub_questions : undefined)}`
  );

  // Assertion 6: sources_used is an array (may be empty if no web/doc results, but must exist)
  assert(
    newEntry && Array.isArray(newEntry.sources_used),
    'Log entry has sources_used array',
    `sources_used=${JSON.stringify(newEntry ? newEntry.sources_used : undefined)}`
  );

  // Assertion 7: no sub-question context exceeded 2,000 tokens
  const tokenViolations = (newEntry && Array.isArray(newEntry.token_usage))
    ? newEntry.token_usage.filter(tu => tu.tokens_used > 2000)
    : [];

  assert(
    tokenViolations.length === 0,
    'No sub-question context exceeded 2,000 tokens',
    `Violations: ${JSON.stringify(tokenViolations)}`
  );

  // Assertion 8: sub_questions has at most 3 entries
  assert(
    newEntry && Array.isArray(newEntry.sub_questions) && newEntry.sub_questions.length <= 3,
    'Sub-questions count is at most 3',
    `Got ${newEntry ? newEntry.sub_questions.length : 'undefined'} sub-questions`
  );

  // Print final answer for human review
  console.log('\n--- Final Answer (for manual review) ---\n');
  console.log(result.final_answer || '(empty)');

  console.log('\n--- Results ---\n');
  console.log(`PASSED: ${passCount}  FAILED: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('\nAll assertions passed.');
    process.exit(0);
  }
}

runSmokeTest().catch(err => {
  console.error('Smoke test runner error:', err.message);
  process.exit(1);
});
