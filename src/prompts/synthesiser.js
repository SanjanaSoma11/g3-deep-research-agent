'use strict';

/**
 * synthesiser.js
 *
 * Prompt builder for the final synthesis step.
 *
 * Input:
 *   subQuestionAnswers {Array<{subQuestion: string, answer: string}>}
 *     — array of up to 3 sub-question/answer pairs
 *
 * Output: {string} — complete prompt to send to Ollama
 *
 * The prompt instructs the model to:
 *   - Write a single coherent answer of ≤ 400 tokens.
 *   - Reference which sub-question each part of the answer draws from (e.g., "[Q1]").
 *   - Return plain prose, not JSON.
 *   - Do not introduce information not present in the sub-question answers.
 */

/**
 * Build the final synthesiser prompt.
 * @param {Array<{subQuestion: string, answer: string}>} subQuestionAnswers
 * @returns {string} Complete prompt string ready to send to Ollama.
 */
function buildSynthesiserPrompt(subQuestionAnswers) {
  const numberedAnswers = subQuestionAnswers.map((qa, idx) =>
    `[Q${idx + 1}] Sub-question: ${qa.subQuestion}\nAnswer: ${qa.answer}`
  ).join('\n\n');

  return `You are a research synthesiser. Combine the answers to the following sub-questions into a single, coherent response.

Rules:
- Write plain prose (no JSON, no bullet points unless natural to the content).
- Maximum 400 tokens (~300 words).
- For each claim or section, cite which sub-question it draws from using inline references like [Q1], [Q2], [Q3].
- Do not introduce any information not present in the sub-question answers below.
- Write in a clear, professional tone suitable for a business research context.

Sub-question answers:

${numberedAnswers}

Synthesised answer (plain prose, ≤ 400 tokens, with [Q1]/[Q2]/[Q3] citations):`;
}

module.exports = { buildSynthesiserPrompt };
