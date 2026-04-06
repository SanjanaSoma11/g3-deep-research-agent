'use strict';

/**
 * llmClient.js
 *
 * Thin HTTP client for Groq hosted LLM inference (OpenAI-compatible API).
 *
 * Inputs:
 *   prompt    {string}  — Full prompt string to send
 *   maxTokens {number}  — Maximum tokens to generate in the response
 *
 * Outputs:
 *   {string} — Response text from the model
 *
 * Security / constraints (SECURITY.md + FRONTEND_INSTRUCTIONS.md):
 *   - Only connects to https://api.groq.com (allowed domain per SECURITY.md).
 *   - Loads GROQ_API_KEY exclusively from environment variable — never logs it.
 *   - Throws immediately on missing GROQ_API_KEY with a clear message.
 *   - Enforces a hard 2,000-token prompt limit before sending any request.
 *     Throws "TOKEN_LIMIT_EXCEEDED" if exceeded.
 *   - Logs model name, prompt token count, and response token count on every call.
 *   - Never logs the API key, even partially.
 *   - temperature: 0.3 for deterministic research outputs.
 */

const { countTokens } = require('./tokenCounter');

const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const HARD_TOKEN_LIMIT = 2000;

/**
 * Custom error for LLM API failures.
 */
class LLMError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'LLMError';
    this.statusCode = statusCode;
  }
}

/**
 * Return the current LLM model name from environment.
 * Used by pipeline.js to log model_used in the evidence log.
 * @returns {string}
 */
function getModelName() {
  return process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
}

/**
 * Send a prompt to Groq and return the response text.
 * Model is loaded from the LLM_MODEL environment variable.
 *
 * @param {string} prompt - Full prompt string.
 * @param {number} maxTokens - Maximum tokens to generate.
 * @returns {Promise<string>} Response text.
 * @throws {LLMError} On non-200 response.
 * @throws {Error} With message "TOKEN_LIMIT_EXCEEDED" if prompt exceeds 2,000 tokens.
 * @throws {Error} With message "GROQ_API_KEY environment variable is not set." if key missing.
 */
async function llmGenerate(prompt, maxTokens = 512) {
  // Fail immediately if API key is not configured
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY environment variable is not set.');
  }

  // Hard token limit check — do not send if over ceiling
  const promptTokens = countTokens(prompt);
  if (promptTokens > HARD_TOKEN_LIMIT) {
    console.error(`[llmClient] TOKEN_LIMIT_EXCEEDED: prompt is ${promptTokens} tokens (limit: ${HARD_TOKEN_LIMIT}).`);
    throw new Error('TOKEN_LIMIT_EXCEEDED');
  }

  const model = getModelName();

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'user', content: prompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  console.log(`[llmClient] Calling model="${model}" prompt_tokens=${promptTokens}`);

  let response;
  try {
    response = await fetch(GROQ_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API key loaded from env — never hardcoded, never logged
        'Authorization': `Bearer ${apiKey}`
      },
      body
    });
  } catch (err) {
    console.error(`[llmClient] Network error calling Groq: ${err.message}`);
    throw new LLMError(`Groq network error: ${err.message}`, null);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '(no body)');
    console.error(`[llmClient] Groq returned HTTP ${response.status}: ${errText}`);
    throw new LLMError(`Groq returned HTTP ${response.status}: ${errText}`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[llmClient] Failed to parse Groq JSON response: ${err.message}`);
    throw new LLMError(`Failed to parse Groq response: ${err.message}`, response.status);
  }

  const responseText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const responseTokens = countTokens(responseText);

  console.log(`[llmClient] OK model="${model}" prompt_tokens=${promptTokens} response_tokens=${responseTokens}`);

  return responseText;
}

module.exports = { llmGenerate, getModelName, LLMError };
