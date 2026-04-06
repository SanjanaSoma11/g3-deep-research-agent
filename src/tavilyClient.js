'use strict';

/**
 * tavilyClient.js
 *
 * Thin HTTP client for Tavily web search API.
 *
 * Inputs:
 *   query {string} — The search query (sub-question text only — never document
 *                    content or memory buffer contents, per SECURITY.md).
 *
 * Outputs:
 *   Array of { title, url, content } objects (up to 3 results).
 *
 * Security constraints (SECURITY.md):
 *   - Only makes requests to https://api.tavily.com — no other domains.
 *   - API key loaded exclusively from TAVILY_API_KEY env var. Never logged.
 *   - Never sends document chunks or memory buffer contents to Tavily.
 *   - Throws a typed error on non-200 response.
 *   - Logs query and result count on every call (not the API key).
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/**
 * Custom error for Tavily API failures.
 */
class TavilyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'TavilyError';
    this.statusCode = statusCode;
  }
}

/**
 * Search Tavily for web results relevant to the given query.
 * @param {string} query - Sub-question text to search for.
 * @returns {Promise<Array<{title: string, url: string, content: string}>>}
 * @throws {TavilyError} On non-200 response or missing API key.
 */
async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error('[tavilyClient] TAVILY_API_KEY environment variable is not set.');
    throw new TavilyError('TAVILY_API_KEY environment variable is not set.', null);
  }

  console.log(`[tavilyClient] Searching Tavily for query="${query.substring(0, 80)}..."`);

  const body = JSON.stringify({
    api_key: apiKey,
    query,
    search_depth: 'basic',
    max_results: 3,
    include_answer: false
  });

  let response;
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  } catch (err) {
    console.error(`[tavilyClient] Network error calling Tavily: ${err.message}. Query="${query.substring(0, 80)}"`);
    throw new TavilyError(`Tavily network error: ${err.message}`, null);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '(no body)');
    // Log without echoing API key (it's in the request body, not the response)
    console.error(`[tavilyClient] Tavily returned HTTP ${response.status}. Query="${query.substring(0, 80)}"`);
    throw new TavilyError(`Tavily returned HTTP ${response.status}: ${errText}`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[tavilyClient] Failed to parse Tavily JSON response: ${err.message}`);
    throw new TavilyError(`Failed to parse Tavily response: ${err.message}`, response.status);
  }

  // Tavily returns results in data.results
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results = rawResults.slice(0, 3).map(r => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    content: String(r.content || '')
  }));

  console.log(`[tavilyClient] OK query="${query.substring(0, 80)}" results=${results.length}`);

  return results;
}

module.exports = { tavilySearch, TavilyError };
