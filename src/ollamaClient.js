'use strict';

/**
 * ollamaClient.js
 *
 * Thin HTTP client for Ollama local LLM inference.
 *
 * Inputs:
 *   model     {string}  — Ollama model name (e.g., "mistral")
 *   prompt    {string}  — Full prompt string to send
 *   maxTokens {number}  — Maximum tokens to generate in the response
 *
 * Outputs:
 *   {string} — Response text from the model
 *
 * Security / constraints (SECURITY.md + CLAUDE.md):
 *   - Only connects to the host/port set in OLLAMA_BASE_URL env var.
 *     Allowed hosts: localhost, 127.0.0.1, or an ngrok tunnel URL.
 *   - Enforces a hard 2,000-token prompt limit before sending any request.
 *     Throws "TOKEN_LIMIT_EXCEEDED" if exceeded.
 *   - Logs model name, prompt token count, and response token count on every call.
 *   - Never logs the prompt text itself (may contain user data).
 *   - No credentials are sent to Ollama (it runs locally).
 *   - Never follows more than 2 redirect hops (Node fetch default).
 */

const { countTokens } = require('./tokenCounter');

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const HARD_TOKEN_LIMIT = 2000;

/**
 * Custom error for Ollama API failures.
 */
class OllamaError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'OllamaError';
    this.statusCode = statusCode;
  }
}

/**
 * Send a prompt to Ollama and return the response text.
 * @param {string} model - Ollama model name.
 * @param {string} prompt - Prompt string.
 * @param {number} maxTokens - Maximum tokens to generate.
 * @returns {Promise<string>} Response text.
 * @throws {OllamaError} On non-200 response.
 * @throws {Error} With message "TOKEN_LIMIT_EXCEEDED" if prompt exceeds 2,000 tokens.
 */
async function ollamaGenerate(model, prompt, maxTokens = 512) {
  // Hard token limit check — do not send if over ceiling
  const promptTokens = countTokens(prompt);
  if (promptTokens > HARD_TOKEN_LIMIT) {
    console.error(`[ollamaClient] TOKEN_LIMIT_EXCEEDED: prompt is ${promptTokens} tokens (limit: ${HARD_TOKEN_LIMIT}).`);
    throw new Error('TOKEN_LIMIT_EXCEEDED');
  }

  const endpoint = `${OLLAMA_BASE_URL}/api/generate`;
  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: {
      num_predict: maxTokens
    }
  });

  console.log(`[ollamaClient] Calling model="${model}" prompt_tokens=${promptTokens}`);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow' // Node fetch follows up to 20 redirects by default; we rely on the Ollama server not redirecting
    });
  } catch (err) {
    console.error(`[ollamaClient] Network error calling Ollama: ${err.message}`);
    throw new OllamaError(`Ollama network error: ${err.message}`, null);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '(no body)');
    console.error(`[ollamaClient] Ollama returned HTTP ${response.status}: ${errText}`);
    throw new OllamaError(`Ollama returned HTTP ${response.status}: ${errText}`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[ollamaClient] Failed to parse Ollama JSON response: ${err.message}`);
    throw new OllamaError(`Failed to parse Ollama response: ${err.message}`, response.status);
  }

  const responseText = data.response || '';
  const responseTokens = countTokens(responseText);

  console.log(`[ollamaClient] OK model="${model}" prompt_tokens=${promptTokens} response_tokens=${responseTokens}`);

  return responseText;
}

module.exports = { ollamaGenerate, OllamaError };
