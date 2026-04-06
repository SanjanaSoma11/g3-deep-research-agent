'use strict';

/**
 * keywordScorer.js
 *
 * BM25-style keyword overlap scorer.
 *
 * Inputs:
 *   query     {string} — the search query or sub-question
 *   candidate {string} — text to score against the query
 *
 * Output:
 *   {number} Jaccard similarity score in [0, 1].
 *
 * Method:
 *   1. Tokenise both strings into lowercase alphanumeric tokens.
 *   2. Remove common English stopwords.
 *   3. Compute Jaccard similarity: |intersection| / |union|.
 *
 * Used for both document chunk retrieval and episodic memory retrieval.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'can', 'could', 'not',
  'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too',
  'very', 'just', 'about', 'above', 'after', 'again', 'against',
  'all', 'also', 'as', 'before', 'between', 'during', 'how',
  'i', 'it', 'its', 'me', 'my', 'our', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'under', 'up', 'us', 'we', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'you', 'your', 'if', 'into',
  'over', 'out', 'same', 'down', 'own', 'only', 'new', 'get',
  'any', 'one', 'two', 'three', 'four', 'five', 'his', 'her',
  'him', 'she', 'he', 'was', 's', 't', 'its', 'been'
]);

/**
 * Tokenise a string into a set of lowercase non-stopword tokens.
 * Minimum token length: 2 characters (removes single-char noise).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenise(text) {
  if (!text || typeof text !== 'string') return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t))
  );
}

/**
 * Compute Jaccard overlap score between a query and a candidate text.
 * @param {string} query
 * @param {string} candidate
 * @returns {number} Score in [0, 1]
 */
function scoreKeywordOverlap(query, candidate) {
  const queryTokens = tokenise(query);
  const candidateTokens = tokenise(candidate);

  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) intersectionSize++;
  }

  const unionSize = queryTokens.size + candidateTokens.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

module.exports = { scoreKeywordOverlap, tokenise };
