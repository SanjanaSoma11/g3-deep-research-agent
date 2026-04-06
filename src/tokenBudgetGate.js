'use strict';

/**
 * tokenBudgetGate.js
 *
 * Token budget gate — the critical context selection component.
 *
 * Inputs:
 *   webSnippets    {Array}  — results from Tavily: [{ title, url, content }]
 *   docChunks      {Array}  — from chunks_index.json: [{ source_filename, chunk_index, word_count, text }]
 *   memorySummaries {Array} — from memory buffer: [{ query, sub_questions, summaries, sources_used, timestamp }]
 *   subQuestion    {string} — the current sub-question being researched
 *
 * Outputs:
 *   {
 *     kept:         Array of kept items (with source, text, tokens, type fields)
 *     dropped:      Array of dropped items (with source, text, tokens, type, reason fields)
 *     kept_tokens:  number — cumulative token count of kept items
 *     dropped_tokens: number — cumulative token count of dropped items
 *   }
 *
 * Algorithm (ARCHITECTURE.md Token Budget Rule):
 *   1. Score every item using keyword overlap against the sub-question.
 *   2. Sort descending by score. Tiebreak: memory > docs > web.
 *   3. Add items to kept list until cumulative tokens reach CONTEXT_BUDGET (1,600).
 *   4. Remaining items → dropped list with reason "budget exceeded".
 *   5. Hard ceiling: if kept_tokens > 1,600, throw "HARD_LIMIT_EXCEEDED".
 *
 * No overflow summarisation step — dropped items are dropped cleanly.
 */

const { scoreKeywordOverlap } = require('./keywordScorer');
const { countTokens } = require('./tokenCounter');

const CONTEXT_BUDGET = 1600; // tokens reserved for retrieved context

// Source priority for tiebreaking (higher = higher priority)
const SOURCE_PRIORITY = { memory: 3, doc: 2, web: 1 };

/**
 * Normalise raw items from all three sources into a unified format.
 * @param {Array} webSnippets
 * @param {Array} docChunks
 * @param {Array} memorySummaries
 * @returns {Array<{type, source, text, tokens}>}
 */
function normaliseItems(webSnippets, docChunks, memorySummaries) {
  const items = [];

  // Web snippets
  for (const snippet of (webSnippets || [])) {
    const text = [snippet.title || '', snippet.content || ''].filter(Boolean).join(' — ');
    items.push({
      type: 'web',
      source: snippet.url || snippet.title || 'web',
      text,
      tokens: countTokens(text)
    });
  }

  // Document chunks
  for (const chunk of (docChunks || [])) {
    const text = chunk.text || '';
    items.push({
      type: 'doc',
      source: chunk.source_filename || 'doc',
      text,
      tokens: countTokens(text)
    });
  }

  // Memory summaries — serialise to a readable text representation
  for (const mem of (memorySummaries || [])) {
    const summaryTexts = Array.isArray(mem.summaries)
      ? mem.summaries.map(s => (typeof s === 'string' ? s : (s.summary || '')))
      : [];
    const text = [
      mem.query ? `Prior query: ${mem.query}` : '',
      ...summaryTexts
    ].filter(Boolean).join(' ');

    items.push({
      type: 'memory',
      source: `memory:${mem.timestamp || 'unknown'}`,
      text,
      tokens: countTokens(text)
    });
  }

  return items;
}

/**
 * Run the token budget gate.
 * @param {Array} webSnippets
 * @param {Array} docChunks
 * @param {Array} memorySummaries
 * @param {string} subQuestion
 * @returns {{ kept: Array, dropped: Array, kept_tokens: number, dropped_tokens: number }}
 */
function runTokenBudgetGate(webSnippets, docChunks, memorySummaries, subQuestion) {
  const items = normaliseItems(webSnippets, docChunks, memorySummaries);

  // Score each item against the sub-question
  const scored = items.map(item => ({
    ...item,
    score: scoreKeywordOverlap(subQuestion, item.text)
  }));

  // Sort descending by score; tiebreak by source priority (memory > docs > web)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (SOURCE_PRIORITY[b.type] || 0) - (SOURCE_PRIORITY[a.type] || 0);
  });

  const kept = [];
  const dropped = [];
  let keptTokens = 0;
  let droppedTokens = 0;

  for (const item of scored) {
    if (keptTokens + item.tokens <= CONTEXT_BUDGET) {
      keptTokens += item.tokens;
      kept.push(item);
    } else {
      droppedTokens += item.tokens;
      dropped.push({ ...item, reason: 'budget exceeded' });
    }
  }

  // Hard ceiling safety check
  if (keptTokens > CONTEXT_BUDGET) {
    console.error(`[tokenBudgetGate] HARD_LIMIT_EXCEEDED: kept_tokens=${keptTokens} exceeds CONTEXT_BUDGET=${CONTEXT_BUDGET}`);
    throw new Error('HARD_LIMIT_EXCEEDED');
  }

  console.log(`[tokenBudgetGate] kept=${kept.length} items (${keptTokens} tokens), dropped=${dropped.length} items (${droppedTokens} tokens)`);

  return {
    kept,
    dropped,
    kept_tokens: keptTokens,
    dropped_tokens: droppedTokens
  };
}

module.exports = { runTokenBudgetGate };
