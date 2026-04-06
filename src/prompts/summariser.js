'use strict';

/**
 * summariser.js
 *
 * Prompt builder for sub-answer compression (summariser).
 *
 * Input:
 *   subQuestion {string} — the sub-question that was answered
 *   answer      {string} — the LLM's answer to that sub-question
 *
 * Output: {string} — complete prompt to send to the Groq LLM
 *
 * The prompt instructs the model to:
 *   - Return ONLY a valid JSON object: { summary, sources_cited, key_facts }
 *   - summary: string of ≤ 150 tokens
 *   - sources_cited: array of strings (URLs or filenames cited in the answer)
 *   - key_facts: array of short fact strings extracted from the answer
 *   - No preamble or explanation — JSON only.
 */

/**
 * Build the summariser prompt.
 * @param {string} subQuestion - The sub-question that was answered.
 * @param {string} answer - The answer to compress.
 * @returns {string} Complete prompt string ready to send to the Groq LLM.
 */
function buildSummariserPrompt(subQuestion, answer) {
  return `You are a research summariser. Compress the answer below into a structured JSON object.

Rules:
- Return ONLY a valid JSON object. No preamble, no explanation, no markdown.
- The JSON must have exactly these fields:
  - "summary": a concise summary string of the answer (maximum 150 tokens / ~110 words)
  - "sources_cited": an array of strings listing every URL or filename cited in the answer
  - "key_facts": an array of short strings, each stating one key fact from the answer

Sub-question: ${subQuestion}

Answer:
${answer}

Output (JSON only):`;
}

module.exports = { buildSummariserPrompt };
