# FRONTEND_INSTRUCTIONS.md — Claude Code Build Instructions for Groq Swap + Frontend + Hosting

## Context

The G3 Deep Research Agent backend (Node.js pipeline) is fully built and working with Groq's hosted API (Llama 3.3 70B). Part 1 of this file is retained for historical reference — the Groq swap is already complete. Begin at Part 2 (Frontend) if the backend is confirmed working.

This file instructs Claude Code to:

1. **Replace Ollama with Groq's free hosted API** — eliminates the need for local LLM inference entirely.
2. **Add a lightweight frontend** served by the existing Node.js process.
3. **Prepare the project for deployment on Render** (free hosting).

**Read these files before writing any code:**
- `ARCHITECTURE.md` — understand the existing backend
- `SECURITY.md` — all security rules still apply (with domain additions below)
- `CLAUDE.md` — understand the existing build (note: the "Do not build a web UI" rule is **overridden** by this file for this phase only)

**n8n is NOT connected yet.** Do not configure, reference, or depend on n8n being available. The frontend talks directly to the Node.js pipeline's `POST /query` endpoint.

---

## Part 1 — Replace Ollama with Groq

### Why

Ollama runs locally and requires 8–16GB RAM, a running process, and an ngrok tunnel for remote hosting. Groq provides a free API (no credit card, instant signup) running Llama 3.3 70B — a much better model than local Mistral 7B — with sub-second inference speed. This eliminates the single biggest setup friction and makes remote deployment possible.

### What is Groq

Groq is a hosted LLM inference provider with an OpenAI-compatible REST API. Free tier: 30 requests/minute, 14,400 requests/day. No credit card required. Sign up at https://console.groq.com and generate an API key.

The API endpoint is `https://api.groq.com/openai/v1/chat/completions`. It uses the same request/response format as OpenAI's Chat Completions API.

---

### Step 1 — Rewrite `src/ollamaClient.js` → `src/llmClient.js`

**Rename** the file from `ollamaClient.js` to `llmClient.js`. This is a full rewrite, not an edit.

The new module must:

- POST to `https://api.groq.com/openai/v1/chat/completions`
- Load the API key from environment variable `GROQ_API_KEY`
- Send the `Authorization: Bearer <key>` header (this is different from Ollama which needed no auth)
- Load the model name from environment variable `LLM_MODEL` (default: `llama-3.3-70b-versatile`)
- Use the OpenAI Chat Completions request format:

```json
{
  "model": "<LLM_MODEL>",
  "messages": [
    { "role": "user", "content": "<prompt string>" }
  ],
  "max_tokens": <maxTokens>,
  "temperature": 0.3
}
```

- Parse the response and return `data.choices[0].message.content`
- Keep the existing hard 2,000-token prompt limit check — throw `TOKEN_LIMIT_EXCEEDED` if prompt exceeds 2,000 tokens before sending
- Keep logging: log model name, prompt token count, and response token count on every call
- **Never log the API key**, even partially
- Throw a typed `LLMError` (renamed from `OllamaError`) on non-200 response, including the HTTP status and error body
- On missing `GROQ_API_KEY`, throw immediately with a clear message: `"GROQ_API_KEY environment variable is not set."`
- Set `temperature: 0.3` for deterministic research outputs (lower than the default 1.0)

**Export the same function signature** so other modules need minimal changes:

```javascript
// Old: ollamaGenerate(model, prompt, maxTokens)
// New: llmGenerate(prompt, maxTokens)
// Model is now loaded from env var inside the module — callers don't pass it
```

Note: the model parameter is removed from the function signature because it's now a single env var, not something callers choose per-call. This simplifies every call site.

### Step 2 — Update all callers of `ollamaClient`

Every file that imports from `./ollamaClient` must be updated to import from `./llmClient` instead. The files that call `ollamaGenerate` are:

- `src/pipeline.js` — multiple calls (decomposer, research, summariser, synthesiser)

In each call site:
- Change `require('./ollamaClient')` → `require('./llmClient')`
- Change `ollamaGenerate(OLLAMA_MODEL, prompt, maxTokens)` → `llmGenerate(prompt, maxTokens)`
- Remove the `OLLAMA_MODEL` constant from `pipeline.js` (no longer needed — the model is internal to `llmClient.js`)
- Keep `model_used` in the evidence log — `llmClient.js` should export a `getModelName()` function that returns the current `LLM_MODEL` env var value, so `pipeline.js` can log it

### Step 3 — Update `SECURITY.md` allowed domains

Add `api.groq.com` to the allowed outbound domains table. Remove the Ollama localhost/ngrok entries since we are fully replacing Ollama with Groq. The updated table should be:

```markdown
| Domain | Purpose |
|---|---|
| `api.tavily.com` | Web search retrieval |
| `api.groq.com` | LLM inference (Groq free tier) |
```

Remove the note about ngrok tunnels for Ollama — it no longer applies.

### Step 4 — Update environment variables

**`.env.example`** — replace Ollama vars with Groq vars:

```
# LLM inference (Groq — free tier, https://console.groq.com)
GROQ_API_KEY=your_groq_api_key_here
LLM_MODEL=llama-3.3-70b-versatile

# Tavily web search API key (https://tavily.com)
TAVILY_API_KEY=your_tavily_api_key_here

# Optional path overrides (defaults shown)
# DOCS_DIR=./docs
# MEMORY_BUFFER_PATH=./memory_buffer.json
# OUTPUT_LOG_PATH=./output_log.json
```

Remove `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.

### Step 5 — Update `ARCHITECTURE.md`

Replace every reference to Ollama with Groq. Specific changes:

- Overview section: change "Ollama running locally" → "Groq API (free tier, Llama 3.3 70B)"
- LLM inference line: `Groq API (free tier — Llama 3.3 70B via OpenAI-compatible endpoint)`
- System Components section 3: rename from "Ollama (LLM)" to "Groq (LLM)". Update description to explain Groq's API endpoint and auth. Remove RAM requirements.
- Data flow diagram: change all "(Ollama)" labels to "(Groq)"
- File structure: change `ollamaClient.js` → `llmClient.js` with updated description
- Known limitations: remove "Ollama requires local tunnel for n8n cloud" row. Add: "Groq free tier has rate limits (30 req/min) — batch runs may be throttled"

### Step 6 — Update `CLAUDE.md`

- Step 5 (Ollama client): rename to "LLM client (Groq)" and update all instructions to match the new `llmClient.js` spec above
- Environment Variables table: replace `OLLAMA_BASE_URL` and `OLLAMA_MODEL` with `GROQ_API_KEY` and `LLM_MODEL`
- What NOT to Build: keep as-is (the web UI override is in this file, not CLAUDE.md)

### Step 7 — Update `evaluation.md`

- "LLM Choice" section: rewrite to explain why Groq was chosen over Ollama. Key points:
  - Eliminates local hardware requirement (no 8GB+ RAM needed)
  - Free tier with generous limits (30 req/min, 14,400 req/day) — more than enough for demo
  - Llama 3.3 70B is significantly better than Mistral 7B for query decomposition and synthesis
  - OpenAI-compatible API means minimal code change
  - Trade-off accepted: depends on external service availability; Groq could rate-limit or go down. For a demo prototype this is acceptable. A production system would add fallback providers.
- Remove the "Ollama requires a machine with sufficient RAM" trade-off — no longer relevant

### Step 8 — Update `README.md`

- Prerequisites table: remove Ollama and ngrok rows. Add `Groq API key` row (free at https://console.groq.com — no credit card).
- Step 4 (Start Ollama): **replace entirely** with:

```markdown
### Step 4 — Get a Groq API key

1. Sign up at https://console.groq.com (free, no credit card required).
2. Go to API Keys → Create API Key.
3. Copy the key and paste it as `GROQ_API_KEY` in your `.env` file.

Verify the key works:

    curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

- Remove all references to `ollama serve`, `ollama pull`, ngrok tunnels, and `OLLAMA_BASE_URL`.
- Update the Architecture Summary to say "Groq API" instead of "Ollama (local)".
- In the Environment Variables table: replace `OLLAMA_BASE_URL` and `OLLAMA_MODEL` with `GROQ_API_KEY` and `LLM_MODEL`.
- Known Limitations: remove the ngrok/Ollama bullet. Add: "Groq free tier rate limits may throttle batch runs (30 requests/minute)."

### Step 9 — Update `n8n_workflow_export.json`

In the `meta.notes` field, replace the reference to "Ollama" with "Groq". The n8n workflow itself doesn't call Ollama/Groq directly (it just POSTs to the Node.js pipeline), so no functional change is needed — only the documentation text inside the JSON.

### Step 10 — Update `smoke_test.js`

The smoke test imports `runPipeline` and calls it directly. It should not need changes unless it references Ollama-specific strings. Check for:
- Any reference to "Ollama" in log messages or assertions — update to "Groq" or make generic
- The test still requires `GROQ_API_KEY` and `TAVILY_API_KEY` to be set in the environment

### Step 11 — Delete `src/ollamaClient.js`

After creating `src/llmClient.js` and updating all imports, delete the old `src/ollamaClient.js`. Do not leave dead code in the repo.

---

## Part 2 — Add Frontend

### What You Are Building

A single-page frontend that:
1. Lets a user type a research query and submit it.
2. Shows a loading/progress state while the pipeline runs (now much faster with Groq — typically 10–30 seconds instead of 60–120).
3. Displays the final answer when the pipeline completes.
4. Optionally shows run metadata: sub-questions generated, sources used, token usage, context kept/dropped.
5. Optionally shows past runs from `output_log.json`.

The frontend must be served by the **same Node.js process** that already runs the pipeline (`src/pipeline.js`). Do not add a separate frontend server, build tool, or framework.

---

### Non-Negotiable Rules (Inherited + New)

1. All rules in `SECURITY.md` still apply — no new outbound domains beyond `api.groq.com` and `api.tavily.com`, no credential leaks, no eval of external strings.
2. **No frontend framework build step.** No React, no Vue, no Svelte, no Webpack, no Vite, no Tailwind CLI. The frontend is plain HTML + CSS + vanilla JavaScript served as static files.
3. **No new npm dependencies for the frontend.** The Node.js server uses the built-in `http` module (already in `pipeline.js`) to serve static files. Do not install Express, Koa, Fastify, or any HTTP framework.
4. **Do not break the existing `POST /query` endpoint or CLI mode.** Both must continue working exactly as before.
5. **Do not modify `runPipeline`'s return signature.** You may add new routes to the HTTP server in `pipeline.js`, but `runPipeline(query)` must still return `{ final_answer, run_id }`.
6. The frontend must work when the backend has no documents in `/docs`, no memory buffer entries, and no prior runs — empty state must be handled gracefully.

---

### Step 12 — Create the `public/` directory

Create the following file structure:

```
public/
├── index.html
├── style.css
└── app.js
```

This is a new directory at the project root (same level as `src/`).

### Step 13 — Static file serving in `pipeline.js`

Modify the HTTP server section of `src/pipeline.js` to serve static files from `public/`. Add these routes **before** the existing `POST /query` handler:

- `GET /` → serve `public/index.html`
- `GET /style.css` → serve `public/style.css`
- `GET /app.js` → serve `public/app.js`
- `GET /api/runs` → return the contents of `output_log.json` as JSON (read-only)
- `GET /api/health` → return `{ "status": "ok", "model": "<LLM_MODEL>" }` (useful for the frontend to check connectivity)

**File serving rules:**
- Use `fs.readFileSync` with the correct `Content-Type` header (`text/html`, `text/css`, `application/javascript`).
- Resolve file paths using `path.join(__dirname, '..', 'public', filename)`.
- Validate that the resolved path is inside the `public/` directory (no path traversal).
- Return 404 for any file not explicitly listed above. Do NOT build a general-purpose static file server that serves arbitrary files.

**Do not touch the existing `POST /query` route or CLI logic.** Only add new routes.

### Step 14 — `public/index.html`

Build a clean, single-page HTML file. Structure:

```
- Header: "G3 Deep Research Agent" title
- Query input section:
    - Textarea for the research query (placeholder: "Ask a complex research question...")
    - Submit button (label: "Research")
    - Character counter showing current / 1,000 max
- Status section (hidden by default):
    - Animated loading indicator (CSS only — no GIF, no external asset)
    - Status text: "Researching... this usually takes 10–30 seconds"
- Result section (hidden by default):
    - Final answer (rendered as text, not HTML — escape any HTML in the response)
    - Collapsible metadata panel:
        - Run ID
        - Sub-questions list
        - Sources used
        - Token usage per sub-question
        - Context kept / dropped
- Past runs section:
    - List of previous runs loaded from GET /api/runs
    - Each run shows: timestamp, original query (truncated), and an expand toggle to see the full answer and metadata
- Footer: "Built for Binox 2026 G3 Assessment"
```

**HTML rules:**
- No inline JavaScript. All JS goes in `app.js`.
- No inline CSS beyond linking to `style.css`.
- No external CDN links (no Google Fonts, no Font Awesome, no Bootstrap, no anything external).
- Use semantic HTML (`<main>`, `<section>`, `<article>`, `<header>`, `<footer>`).
- Include `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">`.

### Step 15 — `public/style.css`

Build a clean, professional stylesheet. Requirements:

- **Colour scheme:** Dark background (`#0f1117` or similar), light text, accent colour for interactive elements. Professional/research tool aesthetic — not playful.
- **Typography:** Use the system font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. No external fonts.
- **Layout:** Single column, max-width 800px, centred. Responsive — must look good on mobile (360px) through desktop (1440px).
- **Loading animation:** CSS-only spinner or pulsing dots. No GIFs, no external assets.
- **Textarea:** Full width, minimum 3 rows, resizable vertically only.
- **Submit button:** Clear visual state for default, hover, disabled (while loading), and active.
- **Result display:** Use `white-space: pre-wrap` for the final answer to preserve line breaks. Light border or background to visually separate from the input area.
- **Metadata panel:** Collapsed by default. Use a `<details>/<summary>` element or a simple toggle. Monospace font for token numbers and run IDs.
- **Past runs list:** Compact. Each run is a card or row. Oldest at the bottom.
- **Scrollbar styling** is optional — do not spend time on it.
- **No animations beyond the loading spinner.** Keep it fast and professional.

### Step 16 — `public/app.js`

Build the frontend logic in vanilla JavaScript. Structure:

```javascript
// 1. DOM references
// 2. State variables
// 3. Event listeners
// 4. Functions: submitQuery, showLoading, showResult, showError, loadPastRuns, renderRun
```

**Behaviour:**

- On page load: call `GET /api/health` to verify backend is reachable. If not, show a warning banner: "Backend not reachable. Make sure the server is running."
- On page load: call `GET /api/runs` to populate the past runs section.
- On submit:
    1. Validate: query is non-empty and ≤ 1,000 characters. If invalid, show inline error — do not send request.
    2. Disable the submit button and show the loading state.
    3. Send `POST /query` with `{ "query": "<user input>" }`.
    4. On success (200): hide loading, show the result section with the final answer and metadata.
    5. On error (4xx/5xx or network failure): hide loading, show an error message with the reason.
    6. After success: re-fetch `GET /api/runs` to update the past runs list.
- The textarea should submit on Ctrl+Enter (or Cmd+Enter on Mac) in addition to clicking the button.
- **Escape all LLM output before inserting into the DOM.** Use `textContent`, never `innerHTML`, for any string that came from the API. This is a security requirement (SECURITY.md: never execute external content).
- Use `fetch` for all HTTP calls. No XMLHttpRequest. No external HTTP libraries.
- Handle the case where the pipeline takes a long time (>60 seconds): keep the loading indicator visible. Do not time out on the client side. Set no explicit timeout on fetch — let the browser's default handle it.

### Step 17 — Update `README.md` for frontend

Add a new section **after** the existing "Run a query via HTTP" section (Step 8):

```markdown
### Step 8b — Open the web interface

With the server running (`node src/pipeline.js`), open your browser to:

    http://localhost:3000

The web interface lets you submit queries, view results, and browse past runs.
This is the same server that handles API requests — no additional setup needed.
```

Also update the Project Structure section to include the `public/` directory:

```
├── public/
│   ├── index.html              # Web interface
│   ├── style.css               # Styles (no external dependencies)
│   └── app.js                  # Frontend logic (vanilla JS)
```

### Step 18 — Update `.gitignore`

Ensure `public/` is **NOT** in `.gitignore`. The frontend files must be committed.

Confirm these are still in `.gitignore`:
- `.env`
- `output_log.json`
- `memory_buffer.json`
- `node_modules/`

---

## Part 3 — Hosting Preparation

The project will be hosted on **Render** (free tier — https://render.com). Render runs Node.js apps directly from a GitHub repo with zero configuration. Since Groq is a hosted API, there is no longer any need to tunnel a local Ollama instance — the entire app runs remotely with no local dependencies.

### Step 19 — Add a `render.yaml` (Blueprint spec)

Create `render.yaml` at the project root:

```yaml
services:
  - type: web
    name: g3-deep-research-agent
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: node src/pipeline.js
    envVars:
      - key: PORT
        value: 10000
      - key: GROQ_API_KEY
        sync: false
      - key: LLM_MODEL
        sync: false
      - key: TAVILY_API_KEY
        sync: false
```

**Note:** Render assigns the PORT at runtime. The pipeline reads `process.env.PORT` and defaults to 3000 locally. No --server flag is needed — zero-arg invocation starts the HTTP server.

### Step 20 — Handle Render's health check

Render's free tier pings the root URL (`GET /`) to check if the service is alive. The static file serving added in Step 13 already handles this (it serves `index.html` on `GET /`). No additional work needed — just confirm it works.

### Step 21 — Add a `README.md` section for Render deployment

Add a new section at the end of README.md:

```markdown
---

## Deployment (Render — Free Tier)

This app can be deployed to Render's free tier directly from the GitHub repo. Since the LLM runs on Groq's hosted API (not locally), no GPU or high-RAM server is needed.

### Prerequisites
- A Render account (free at https://render.com)
- A Groq API key (free at https://console.groq.com)
- A Tavily API key (free at https://tavily.com)

### Deploy steps
1. Push this repo to GitHub.
2. Log in to Render → New → Web Service → Connect your GitHub repo.
3. Render auto-detects `render.yaml` and configures the service.
4. Set environment variables in Render's dashboard:
   - `GROQ_API_KEY` — your Groq API key
   - `LLM_MODEL` — model name (default: `llama-3.3-70b-versatile`)
   - `TAVILY_API_KEY` — your Tavily API key
5. Deploy. The web interface will be available at `https://<your-service>.onrender.com`.

### Limitations on Render free tier
- Free tier services spin down after 15 minutes of inactivity. First request after spin-down takes ~30 seconds to cold-start.
- Free tier has 512MB RAM. The Node.js pipeline itself is lightweight, but keep document uploads small.
- `output_log.json` and `memory_buffer.json` are stored on Render's ephemeral filesystem — they reset on every deploy or restart. This is acceptable for a demo.
- Groq free tier rate limits (30 req/min) may throttle batch runs.
```

---

## What NOT to Do

- Do not install Express, Koa, or any HTTP framework.
- Do not install any CSS framework or UI library.
- Do not install the Groq SDK npm package — use raw `fetch` to call the REST API (same pattern as the existing Tavily client). Zero new dependencies for the LLM swap.
- Do not add any build step (no bundler, no transpiler, no minifier).
- Do not use any external CDN, font service, or analytics.
- Do not add WebSocket support — the frontend uses a simple POST and waits for the response.
- Do not add authentication or login to the frontend.
- Do not create a `.dockerignore` or `Dockerfile` — Render uses native Node.js runtime.
- Do not remove or modify the CLI mode — `node src/pipeline.js "query"` must still work.
- Do not serve any file outside the `public/` directory. The static file server must be a whitelist, not a directory listing.
- Do not keep `src/ollamaClient.js` in the repo — delete it after the migration.
- Do not leave any references to `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, or `ollamaClient` anywhere in the codebase.

---

## Verification Checklist

Before considering this phase complete, verify:

**Groq swap:**
1. `src/ollamaClient.js` has been deleted.
2. `src/llmClient.js` exists and exports `llmGenerate(prompt, maxTokens)` and `getModelName()`.
3. No file in the project imports from `./ollamaClient`.
4. No file in the project references `OLLAMA_BASE_URL` or `OLLAMA_MODEL` (search entire codebase).
5. `GROQ_API_KEY` is loaded from env and never logged.
6. The hard 2,000-token prompt limit check still works in `llmClient.js`.
7. `.env.example` has `GROQ_API_KEY` and `LLM_MODEL`, not Ollama vars.

**Frontend:**
8. `node src/pipeline.js` starts the server and `http://localhost:3000` shows the web interface.
9. `node src/pipeline.js "test query"` still works in CLI mode.
10. `POST /query` via curl still works exactly as before.
11. `GET /api/health` returns `{ "status": "ok", "model": "..." }`.
12. `GET /api/runs` returns the contents of `output_log.json`.
13. The frontend submits a query and displays the result.
14. The frontend handles errors gracefully (try with invalid `GROQ_API_KEY`).
15. The frontend works on mobile viewport (360px width).
16. No external network requests are made by the frontend (check browser DevTools Network tab).

**Hosting:**
17. `render.yaml` exists and is valid YAML with Groq env vars (not Ollama).
18. The `public/` directory is not in `.gitignore`.
19. All existing smoke test assertions still pass (`node smoke_test.js`).

**Documentation:**
20. `SECURITY.md` allowed domains table includes `api.groq.com`, does not include localhost/ngrok Ollama entries.
21. `ARCHITECTURE.md` references Groq everywhere, not Ollama.
22. `evaluation.md` explains the Groq choice and trade-offs.
23. `README.md` setup instructions reference Groq, not Ollama.
24. `CLAUDE.md` updated with Groq env vars and LLM client instructions.
