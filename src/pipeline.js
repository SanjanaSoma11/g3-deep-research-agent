'use strict';

/**
 * pipeline.js
 *
 * Entry point for the G3 Deep Research Agent.
 *
 * Modes:
 *   1. HTTP server: listens on PORT (default 3000) for POST /query { query: string }
 *   2. CLI:         node src/pipeline.js "your query here"
 *
 * Full pipeline (ARCHITECTURE.md data flow):
 *   1. Validate input query (SECURITY.md input validation).
 *   2. Run document chunker at startup (once per process lifetime).
 *   3. Decompose query → up to 3 sub-questions (Ollama).
 *   4. For each sub-question:
 *      a. Tavily web search (top 3 results).
 *      b. Document chunk retrieval (top 3 by keyword score).
 *      c. Episodic memory read (top 5 by keyword score).
 *      d. Token budget gate (1,600 token context limit).
 *      e. Context assembler (builds final prompt, verifies ≤ 2,000 tokens).
 *      f. Research LLM call (Ollama).
 *      g. Summariser LLM call (Ollama) → compress answer.
 *      h. Write summary to memory buffer.
 *   5. Final synthesiser (Ollama) → single coherent answer.
 *   6. Evidence log writer → append to output_log.json.
 *   7. Return { final_answer, run_id }.
 *
 * Security (SECURITY.md):
 *   - Query validated: max 1,000 chars, non-empty, stripped, no control chars.
 *   - Only allowed outbound domains: api.tavily.com, OLLAMA_BASE_URL host.
 *   - Never exec/eval any external string.
 *   - All external calls in try/catch with explicit error logging.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scoreKeywordOverlap } = require('./keywordScorer');
const { runChunker } = require('./chunker');
const { ollamaGenerate } = require('./ollamaClient');
const { tavilySearch } = require('./tavilyClient');
const { readMemory, writeMemory } = require('./memoryBuffer');
const { runTokenBudgetGate } = require('./tokenBudgetGate');
const { assembleContext } = require('./contextAssembler');
const { writeEvidenceLog } = require('./evidenceLogWriter');
const { buildDecomposerPrompt } = require('./prompts/decomposer');
const { buildSummariserPrompt } = require('./prompts/summariser');
const { buildSynthesiserPrompt } = require('./prompts/synthesiser');

const PORT = parseInt(process.env.PORT || '3000', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const CHUNKS_INDEX_PATH = path.resolve('./chunks_index.json');

// ─────────────────────────────────────────────────────────────────────────────
// Startup: run chunker once per process lifetime
// ─────────────────────────────────────────────────────────────────────────────

let chunksIndexCache = null;

async function ensureChunksLoaded() {
  if (chunksIndexCache !== null) return chunksIndexCache;

  try {
    await runChunker();
  } catch (err) {
    console.error(`[pipeline] Chunker failed at startup: ${err.message}. Continuing with empty doc index.`);
  }

  try {
    if (fs.existsSync(CHUNKS_INDEX_PATH)) {
      const raw = fs.readFileSync(CHUNKS_INDEX_PATH, 'utf8');
      chunksIndexCache = JSON.parse(raw);
      if (!Array.isArray(chunksIndexCache)) chunksIndexCache = [];
    } else {
      chunksIndexCache = [];
    }
  } catch (err) {
    console.error(`[pipeline] Failed to load chunks_index.json: ${err.message}`);
    chunksIndexCache = [];
  }

  console.log(`[pipeline] Loaded ${chunksIndexCache.length} document chunks.`);
  return chunksIndexCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation (SECURITY.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and sanitise a query string.
 * @param {string} raw
 * @returns {string} Sanitised query.
 * @throws {Error} If validation fails.
 */
function validateQuery(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('INVALID_QUERY: query must be a non-empty string.');
  }

  // Strip leading/trailing whitespace
  let query = raw.trim();

  if (query.length === 0) {
    throw new Error('INVALID_QUERY: query must not be empty after stripping whitespace.');
  }

  if (query.length > 1000) {
    throw new Error(`INVALID_QUERY: query exceeds 1,000 characters (got ${query.length}).`);
  }

  // Remove null bytes and control characters (except tab, newline, carriage return)
  // eslint-disable-next-line no-control-regex
  query = query.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  if (query.length === 0) {
    throw new Error('INVALID_QUERY: query is empty after removing control characters.');
  }

  return query;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON parse helper for LLM outputs (SECURITY.md: parse in try/catch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to parse JSON from an LLM response string.
 * The LLM may wrap output in markdown code fences — strip them first.
 * @param {string} raw
 * @returns {any} Parsed value.
 * @throws {Error} If parsing fails.
 */
function parseLLMJson(raw) {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-3 document chunk retrieval by keyword score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve top 3 document chunks relevant to the sub-question.
 * @param {string} subQuestion
 * @param {Array} chunksIndex
 * @returns {Array}
 */
function retrieveDocChunks(subQuestion, chunksIndex) {
  if (!chunksIndex || chunksIndex.length === 0) return [];

  const scored = chunksIndex.map(chunk => ({
    chunk,
    score: scoreKeywordOverlap(subQuestion, chunk.text || '')
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.chunk);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main research pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full research pipeline for a given query.
 * @param {string} rawQuery - The user's research query.
 * @returns {Promise<{ final_answer: string, run_id: string }>}
 */
async function runPipeline(rawQuery) {
  // Step 1: Validate input
  let query;
  try {
    query = validateQuery(rawQuery);
  } catch (err) {
    console.error(`[pipeline] Input validation failed: ${err.message}`);
    throw err;
  }

  // Step 2: Ensure chunks loaded (runs chunker once)
  const chunksIndex = await ensureChunksLoaded();

  console.log(`[pipeline] Starting pipeline for query="${query.substring(0, 80)}"`);

  // Step 3: Query decomposition
  let subQuestions = [];
  try {
    const decomposerPrompt = buildDecomposerPrompt(query);
    const decomposerRaw = await ollamaGenerate(OLLAMA_MODEL, decomposerPrompt, 256);

    try {
      const parsed = parseLLMJson(decomposerRaw);
      if (!Array.isArray(parsed)) throw new Error('Decomposer did not return a JSON array.');
      subQuestions = parsed
        .filter(q => typeof q === 'string' && q.trim().length > 0)
        .map(q => q.trim())
        .slice(0, 3); // Hard max 3 (SECURITY.md rate limiting)

      if (subQuestions.length === 0) throw new Error('Decomposer returned empty array.');
      console.log(`[pipeline] Decomposed into ${subQuestions.length} sub-question(s).`);
    } catch (parseErr) {
      console.error(`[pipeline] Failed to parse decomposer output: ${parseErr.message}. Raw: ${decomposerRaw.substring(0, 200)}`);
      // Fallback: use the original query as a single sub-question
      subQuestions = [query];
      console.warn('[pipeline] Falling back to original query as single sub-question.');
    }
  } catch (err) {
    console.error(`[pipeline] Decomposer LLM call failed: ${err.message}`);
    // Fallback: use the original query as a single sub-question
    subQuestions = [query];
    console.warn('[pipeline] Falling back to original query as single sub-question.');
  }

  // Per-sub-question results for aggregation
  const subQuestionAnswers = [];
  const allSourcesUsed = [];
  const allTokenUsage = [];
  const allContextKept = [];
  const allContextDropped = [];

  // Step 4: Per-sub-question loop
  for (const subQuestion of subQuestions) {
    console.log(`[pipeline] Processing sub-question: "${subQuestion.substring(0, 80)}"`);

    let webSnippets = [];
    let docChunks = [];
    let memorySummaries = [];

    // 4a. Tavily web search
    try {
      webSnippets = await tavilySearch(subQuestion);
    } catch (err) {
      console.error(`[pipeline] Tavily search failed for sub-question "${subQuestion.substring(0, 60)}": ${err.message}`);
      // Continue without web results
    }

    // 4b. Document chunk retrieval
    try {
      docChunks = retrieveDocChunks(subQuestion, chunksIndex);
    } catch (err) {
      console.error(`[pipeline] Doc chunk retrieval failed: ${err.message}`);
      // Continue without doc results
    }

    // 4c. Episodic memory read
    try {
      memorySummaries = readMemory(subQuestion);
    } catch (err) {
      console.error(`[pipeline] Memory read failed: ${err.message}`);
      // Continue without memory
    }

    // 4d. Token budget gate
    let budgetGateOutput;
    try {
      budgetGateOutput = runTokenBudgetGate(webSnippets, docChunks, memorySummaries, subQuestion);
    } catch (err) {
      console.error(`[pipeline] Token budget gate failed: ${err.message}`);
      // Record failure and skip this sub-question
      subQuestionAnswers.push({ subQuestion, answer: `[Error: context assembly failed — ${err.message}]` });
      allTokenUsage.push({ sub_question: subQuestion, tokens_used: 0, tokens_dropped: 0 });
      continue;
    }

    // Track context for evidence log
    for (const item of budgetGateOutput.kept) {
      allContextKept.push({ source: item.source, tokens: item.tokens });
      allSourcesUsed.push({ type: item.type, label: item.source });
    }
    for (const item of budgetGateOutput.dropped) {
      allContextDropped.push({ source: item.source, tokens: item.tokens, reason: item.reason });
    }

    // 4e. Context assembler
    let assembledPrompt;
    try {
      const assembled = assembleContext(budgetGateOutput, subQuestion);
      assembledPrompt = assembled.prompt;
    } catch (err) {
      console.error(`[pipeline] Context assembly failed: ${err.message}`);
      subQuestionAnswers.push({ subQuestion, answer: `[Error: context assembly failed — ${err.message}]` });
      allTokenUsage.push({ sub_question: subQuestion, tokens_used: 0, tokens_dropped: 0 });
      continue;
    }

    // 4f. Research LLM call
    let answer = '';
    try {
      answer = await ollamaGenerate(OLLAMA_MODEL, assembledPrompt, 512);
    } catch (err) {
      console.error(`[pipeline] Research LLM call failed: ${err.message}`);
      answer = `[Error: LLM call failed — ${err.message}]`;
    }

    subQuestionAnswers.push({ subQuestion, answer });
    allTokenUsage.push({
      sub_question: subQuestion,
      tokens_used: budgetGateOutput.kept_tokens,
      tokens_dropped: budgetGateOutput.dropped_tokens
    });

    // 4g. Summariser LLM call (compress answer for memory)
    let summaryObj = null;
    try {
      const summariserPrompt = buildSummariserPrompt(subQuestion, answer);
      const summariserRaw = await ollamaGenerate(OLLAMA_MODEL, summariserPrompt, 256);
      try {
        summaryObj = parseLLMJson(summariserRaw);
        if (typeof summaryObj !== 'object' || summaryObj === null) throw new Error('Not an object.');
      } catch (parseErr) {
        console.error(`[pipeline] Failed to parse summariser output: ${parseErr.message}. Raw: ${summariserRaw.substring(0, 200)}`);
        // Fallback summary
        summaryObj = {
          summary: answer.substring(0, 300),
          sources_cited: [],
          key_facts: []
        };
      }
    } catch (err) {
      console.error(`[pipeline] Summariser LLM call failed: ${err.message}`);
      summaryObj = {
        summary: answer.substring(0, 300),
        sources_cited: [],
        key_facts: []
      };
    }

    // 4h. Write to memory buffer
    try {
      const memoryEntry = {
        query,
        sub_questions: [subQuestion],
        summaries: [summaryObj],
        sources_used: budgetGateOutput.kept.map(item => ({ type: item.type, label: item.source })),
        timestamp: new Date().toISOString()
      };
      writeMemory(memoryEntry);
    } catch (err) {
      console.error(`[pipeline] Memory write failed: ${err.message}`);
      // Non-fatal — continue
    }
  } // end sub-question loop

  // Step 5: Final synthesis
  let finalAnswer = '';
  if (subQuestionAnswers.length === 0) {
    finalAnswer = '[Error: all sub-questions failed — no answer generated.]';
  } else if (subQuestionAnswers.length === 1) {
    // Single sub-question: use answer directly to avoid redundant synthesis call
    finalAnswer = subQuestionAnswers[0].answer;
  } else {
    try {
      const synthesiserPrompt = buildSynthesiserPrompt(subQuestionAnswers);
      finalAnswer = await ollamaGenerate(OLLAMA_MODEL, synthesiserPrompt, 512);
    } catch (err) {
      console.error(`[pipeline] Synthesiser LLM call failed: ${err.message}`);
      // Fallback: concatenate sub-answers
      finalAnswer = subQuestionAnswers
        .map((qa, i) => `[Q${i + 1}] ${qa.subQuestion}\n${qa.answer}`)
        .join('\n\n');
    }
  }

  // Step 6: Evidence log
  let runId;
  try {
    runId = writeEvidenceLog({
      model_used: OLLAMA_MODEL,
      original_query: query,
      sub_questions: subQuestions,
      final_answer: finalAnswer,
      sources_used: allSourcesUsed,
      token_usage: allTokenUsage,
      context_kept: allContextKept,
      context_dropped: allContextDropped
    });
  } catch (err) {
    console.error(`[pipeline] Evidence log write failed: ${err.message}`);
    runId = 'unknown';
  }

  console.log(`[pipeline] Pipeline complete. run_id=${runId}`);

  return { final_answer: finalAnswer, run_id: runId };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (POST /query)
// ─────────────────────────────────────────────────────────────────────────────

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // Only handle POST /query
    if (req.method !== 'POST' || req.url !== '/query') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use POST /query.' }));
      return;
    }

    // Collect request body
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      let queryInput;
      try {
        const parsed = JSON.parse(body);
        queryInput = parsed.query;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body. Expected: { "query": "..." }' }));
        return;
      }

      try {
        const result = await runPipeline(queryInput);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[pipeline] HTTP handler error: ${err.message}`);
        // Log failed run to output_log.json
        try {
          writeEvidenceLog({
            model_used: OLLAMA_MODEL,
            original_query: typeof queryInput === 'string' ? queryInput : '',
            sub_questions: [],
            final_answer: '',
            sources_used: [],
            token_usage: [],
            context_kept: [],
            context_dropped: [],
            status: 'failed',
            error: err.message
          });
        } catch (logErr) {
          console.error(`[pipeline] Failed to log error run: ${logErr.message}`);
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`[pipeline] HTTP server listening on http://localhost:${PORT}`);
    console.log('[pipeline] Ready to accept POST /query requests.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // CLI mode: node src/pipeline.js "query here"
    const cliQuery = args.join(' ');
    console.log(`[pipeline] CLI mode. Query: "${cliQuery}"`);

    try {
      const result = await runPipeline(cliQuery);
      console.log('\n=== FINAL ANSWER ===');
      console.log(result.final_answer);
      console.log(`\n=== RUN ID: ${result.run_id} ===`);
    } catch (err) {
      console.error(`[pipeline] Fatal error: ${err.message}`);
      // Log failed run
      try {
        writeEvidenceLog({
          model_used: OLLAMA_MODEL,
          original_query: cliQuery,
          sub_questions: [],
          final_answer: '',
          sources_used: [],
          token_usage: [],
          context_kept: [],
          context_dropped: [],
          status: 'failed',
          error: err.message
        });
      } catch (logErr) {
        console.error(`[pipeline] Failed to log error run: ${logErr.message}`);
      }
      process.exit(1);
    }
  } else {
    // Server mode
    await ensureChunksLoaded();
    startHttpServer();
  }
}

// Run main on direct invocation
if (require.main === module) {
  main().catch(err => {
    console.error('[pipeline] Unhandled error in main:', err.message);
    process.exit(1);
  });
}

module.exports = { runPipeline, validateQuery };
