'use strict';

/**
 * tokenCounter.js
 *
 * Shared utility for approximating token count from a string.
 *
 * Formula: token_count = Math.ceil(word_count * 1.33)
 *
 * This is an approximation. The average English word tokenises to roughly
 * 1.33 sub-word tokens in BPE-based tokenisers (e.g., SentencePiece used by
 * Mistral/Llama). Accuracy is ±10% for typical English prose. A more precise
 * count would require the model's actual tokeniser, which is not available
 * without native binaries. This approximation is intentional and documented
 * in evaluation.md.
 *
 * @module tokenCounter
 */

/**
 * Estimate the token count for a string.
 * @param {string} text - Input string.
 * @returns {number} Estimated token count (non-negative integer).
 */
function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 1.33);
}

module.exports = { countTokens };
