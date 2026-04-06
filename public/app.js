'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. DOM references
// ─────────────────────────────────────────────────────────────────────────────

const backendWarning   = document.getElementById('backend-warning');
const queryInput       = document.getElementById('query-input');
const charCounter      = document.getElementById('char-counter');
const queryError       = document.getElementById('query-error');
const submitBtn        = document.getElementById('submit-btn');
const statusSection    = document.getElementById('status-section');
const errorSection     = document.getElementById('error-section');
const errorMessage     = document.getElementById('error-message');
const resultSection    = document.getElementById('result-section');
const finalAnswer      = document.getElementById('final-answer');
const metaRunId        = document.getElementById('meta-run-id');
const metaSubQuestions = document.getElementById('meta-sub-questions');
const metaSources      = document.getElementById('meta-sources');
const metaTokens       = document.getElementById('meta-tokens');
const metaKept         = document.getElementById('meta-kept');
const metaDropped      = document.getElementById('meta-dropped');
const pastRunsEmpty    = document.getElementById('past-runs-empty');
const pastRunsList     = document.getElementById('past-runs-list');

// ─────────────────────────────────────────────────────────────────────────────
// 2. State variables
// ─────────────────────────────────────────────────────────────────────────────

let isLoading = false;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Event listeners
// ─────────────────────────────────────────────────────────────────────────────

queryInput.addEventListener('input', () => {
  const len = queryInput.value.length;
  charCounter.textContent = `${len} / 1,000`;
  charCounter.classList.toggle('near-limit', len >= 800 && len < 1000);
  charCounter.classList.toggle('at-limit', len >= 1000);

  // Clear inline error while user is typing
  if (len > 0) hideQueryError();
});

submitBtn.addEventListener('click', submitQuery);

queryInput.addEventListener('keydown', (e) => {
  // Ctrl+Enter or Cmd+Enter submits
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submitQuery();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and submit the research query.
 */
async function submitQuery() {
  if (isLoading) return;

  const raw = queryInput.value;
  const query = raw.trim();

  // Validate: non-empty
  if (query.length === 0) {
    showQueryError('Please enter a research query.');
    return;
  }

  // Validate: max 1,000 characters
  if (query.length > 1000) {
    showQueryError(`Query is too long (${query.length} characters). Maximum is 1,000.`);
    return;
  }

  hideQueryError();
  showLoading();

  try {
    const response = await fetch('/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Never send untrusted content as anything other than a JSON string
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      let reason = `Server error (HTTP ${response.status})`;
      try {
        const errData = await response.json();
        if (errData && typeof errData.error === 'string') {
          reason = errData.error;
        }
      } catch (_) { /* ignore parse failure */ }
      hideLoading();
      showError(reason);
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      hideLoading();
      showError('Could not parse server response. Check server logs.');
      return;
    }

    hideLoading();
    showResult(data);

    // Refresh past runs list after a successful run
    await loadPastRuns();

  } catch (err) {
    hideLoading();
    showError(`Network error: ${err.message}. Check that the server is running.`);
  }
}

/**
 * Show the loading indicator and disable the submit button.
 */
function showLoading() {
  isLoading = true;
  submitBtn.disabled = true;
  statusSection.hidden = false;
  errorSection.hidden = true;
  resultSection.hidden = true;
}

/**
 * Hide the loading indicator and re-enable the submit button.
 */
function hideLoading() {
  isLoading = false;
  submitBtn.disabled = false;
  statusSection.hidden = true;
}

/**
 * Display the pipeline result.
 * Uses textContent exclusively for all LLM-derived strings — no innerHTML.
 * @param {object} data - { final_answer, run_id }
 */
function showResult(data) {
  errorSection.hidden = true;
  resultSection.hidden = false;

  // final_answer: use textContent — never innerHTML (SECURITY.md: never exec external content)
  finalAnswer.textContent = typeof data.final_answer === 'string' ? data.final_answer : '(no answer)';

  // Populate metadata from the full run entry if available,
  // otherwise use what came back from POST /query
  populateMetadata(data);
}

/**
 * Populate the metadata panel from a run data object.
 * Accepts either the POST /query response or a full output_log entry.
 * @param {object} data
 */
function populateMetadata(data) {
  // Run ID
  metaRunId.textContent = safeString(data.run_id || data.run_id);

  // Sub-questions
  clearList(metaSubQuestions);
  const subQs = Array.isArray(data.sub_questions) ? data.sub_questions : [];
  if (subQs.length === 0) {
    appendListItem(metaSubQuestions, '—');
  } else {
    subQs.forEach(q => appendListItem(metaSubQuestions, safeString(q)));
  }

  // Sources used
  clearList(metaSources);
  const sources = Array.isArray(data.sources_used) ? data.sources_used : [];
  if (sources.length === 0) {
    appendListItem(metaSources, '—');
  } else {
    sources.forEach(s => {
      const label = `[${safeString(s.type || '?')}] ${safeString(s.label || '?')}`;
      appendListItem(metaSources, label);
    });
  }

  // Token usage
  clearList(metaTokens);
  const tokenUsage = Array.isArray(data.token_usage) ? data.token_usage : [];
  if (tokenUsage.length === 0) {
    appendListItem(metaTokens, '—');
  } else {
    tokenUsage.forEach(tu => {
      const text = `used=${tu.tokens_used ?? '?'} dropped=${tu.tokens_dropped ?? '?'}  —  ${safeString(tu.sub_question || '')}`;
      appendListItem(metaTokens, text);
    });
  }

  // Context kept
  clearList(metaKept);
  const kept = Array.isArray(data.context_kept) ? data.context_kept : [];
  if (kept.length === 0) {
    appendListItem(metaKept, '—');
  } else {
    kept.forEach(k => appendListItem(metaKept, `${k.tokens ?? '?'} tokens — ${safeString(k.source || '?')}`));
  }

  // Context dropped
  clearList(metaDropped);
  const dropped = Array.isArray(data.context_dropped) ? data.context_dropped : [];
  if (dropped.length === 0) {
    appendListItem(metaDropped, '—');
  } else {
    dropped.forEach(d => appendListItem(metaDropped, `${d.tokens ?? '?'} tokens — ${safeString(d.source || '?')} (${safeString(d.reason || '?')})`));
  }
}

/**
 * Show an error message below the query form.
 * @param {string} message
 */
function showError(message) {
  errorSection.hidden = false;
  errorMessage.textContent = safeString(message);
}

/**
 * Show an inline validation error on the query field.
 */
function showQueryError(message) {
  queryError.hidden = false;
  queryError.textContent = message;
}

/**
 * Hide the inline validation error.
 */
function hideQueryError() {
  queryError.hidden = true;
  queryError.textContent = '';
}

/**
 * Load past runs from GET /api/runs and render them.
 */
async function loadPastRuns() {
  try {
    const response = await fetch('/api/runs');
    if (!response.ok) return; // silently fail — not critical

    let runs;
    try {
      runs = await response.json();
    } catch (_) { return; }

    if (!Array.isArray(runs) || runs.length === 0) {
      pastRunsEmpty.hidden = false;
      pastRunsList.hidden = true;
      return;
    }

    pastRunsEmpty.hidden = true;
    pastRunsList.hidden = false;
    clearList(pastRunsList);

    // Render oldest at bottom — reverse order so newest is at top
    const sorted = runs.slice().reverse();
    sorted.forEach(run => {
      const li = renderRun(run);
      pastRunsList.appendChild(li);
    });

  } catch (_) {
    // Network error loading past runs — non-fatal, ignore
  }
}

/**
 * Render a single past run as a <li> card.
 * All LLM content set via textContent — never innerHTML.
 * @param {object} run - Output log entry
 * @returns {HTMLElement}
 */
function renderRun(run) {
  const li = document.createElement('li');
  li.className = 'run-card';

  const header = document.createElement('div');
  header.className = 'run-card-header';
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');

  const timestamp = document.createElement('span');
  timestamp.className = 'run-timestamp';
  // Safely format the timestamp
  let ts = '—';
  if (run.timestamp) {
    try {
      ts = new Date(run.timestamp).toLocaleString();
    } catch (_) {
      ts = safeString(run.timestamp);
    }
  }
  timestamp.textContent = ts;

  const queryPreview = document.createElement('span');
  queryPreview.className = 'run-query-preview';
  const queryText = safeString(run.original_query || '(no query)');
  queryPreview.textContent = queryText.length > 100 ? queryText.slice(0, 100) + '…' : queryText;

  const toggle = document.createElement('span');
  toggle.className = 'run-toggle';
  toggle.textContent = 'expand';

  header.appendChild(timestamp);
  header.appendChild(queryPreview);
  header.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'run-card-body';
  body.hidden = true;

  const answerEl = document.createElement('pre');
  answerEl.className = 'run-answer';
  answerEl.textContent = safeString(run.final_answer || '(no answer)');

  const metaEl = document.createElement('div');
  metaEl.className = 'run-meta-row';
  const subQCount = Array.isArray(run.sub_questions) ? run.sub_questions.length : 0;
  const srcCount  = Array.isArray(run.sources_used) ? run.sources_used.length : 0;
  metaEl.textContent = `run_id: ${safeString(run.run_id || '?')} · ${subQCount} sub-questions · ${srcCount} sources · model: ${safeString(run.model_used || '?')}`;

  body.appendChild(answerEl);
  body.appendChild(metaEl);

  li.appendChild(header);
  li.appendChild(body);

  // Toggle expand/collapse
  function toggleExpand() {
    const expanded = !body.hidden;
    body.hidden = expanded;
    toggle.textContent = expanded ? 'expand' : 'collapse';
  }

  header.addEventListener('click', toggleExpand);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return li;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely coerce a value to a string.
 * Guards against prototype pollution — only accepts string/number/boolean/null/undefined.
 * @param {*} val
 * @returns {string}
 */
function safeString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return ''; // Objects/arrays not coerced — prevents unexpected serialisation
}

/** Clear all children of a list element. */
function clearList(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Append a text item to a list. Uses textContent — no innerHTML. */
function appendListItem(listEl, text) {
  const item = document.createElement('li');
  item.textContent = text;
  listEl.appendChild(item);
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  // Check backend health
  try {
    const healthRes = await fetch('/api/health');
    if (!healthRes.ok) {
      backendWarning.hidden = false;
    }
  } catch (_) {
    backendWarning.hidden = false;
  }

  // Load past runs
  await loadPastRuns();
}

init();
