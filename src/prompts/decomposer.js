'use strict';

/**
 * decomposer.js
 *
 * Prompt builder for query decomposition.
 *
 * Input:  query {string} — the original research query from the user
 * Output: {string} — complete prompt to send to the Groq LLM
 *
 * The prompt instructs the model to:
 *   - Decompose the query into at most 3 focused sub-questions.
 *   - Return ONLY a JSON array of strings — no preamble, no explanation.
 *   - Produce self-contained sub-questions (each answerable independently).
 *
 * Includes two worked few-shot examples.
 */

/**
 * Build the query decomposition prompt.
 * @param {string} query - The user's original research query.
 * @returns {string} Complete prompt string ready to send to the Groq LLM.
 */
function buildDecomposerPrompt(query) {
  return `You are a research query decomposer. Your task is to break down a complex research question into at most 3 focused sub-questions.

Rules:
- Return ONLY a valid JSON array of strings. No preamble, no explanation, no markdown.
- Maximum 3 sub-questions.
- Each sub-question must be self-contained and answerable without reading the other sub-questions.
- Sub-questions should together cover the full scope of the original query.

Example 1:
Input: "What are the main competitive advantages of Tesla compared to traditional automakers, and how has this affected their market share?"
Output: ["What are Tesla's main competitive advantages over traditional automakers?", "How has Tesla's market position changed relative to traditional automakers in recent years?", "What strategies have traditional automakers adopted in response to Tesla's growth?"]

Example 2:
Input: "How does remote work affect employee productivity and company culture?"
Output: ["How does remote work impact individual employee productivity compared to office work?", "What effects does remote work have on company culture and team cohesion?", "What management practices help remote teams maintain productivity and culture?"]

Now decompose the following query:
Input: "${query.replace(/"/g, '\\"')}"
Output:`;
}

module.exports = { buildDecomposerPrompt };
