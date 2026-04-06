# Architecture — G3 Deep Research Agent

## Architectural Style

This project is **Node-first**. The entire research pipeline is implemented as a Node.js application. n8n cloud is used exclusively as a scheduler and manual trigger — it sends a single HTTP POST to the Node.js pipeline's webhook endpoint and nothing else. All orchestration logic, API calls, memory management, token budgeting, and file I/O happen inside Node.js.

This means:
- The pipeline can be run directly from the command line without n8n
- n8n is not required for development or testing — only for scheduled production runs
- All logic is in version-controlled Node.js code, not inside n8n's visual workflow nodes

---

## Overview

A deep research agent that answers complex, multi-part business research questions by:
1. Decomposing the query into at most 3 sub-questions
2. Retrieving context for each sub-question from two sources: Tavily web search and user-uploaded documents
3. Ranking and compressing retrieved context to fit within a strict 2,000-token hard limit
4. Answering each sub-question with the Groq API (Llama 3.3 70B)
5. Writing structured summaries back to an episodic memory buffer
6. Synthesising a final evidence-tracked answer

**Orchestration**: Node.js (core pipeline) + n8n cloud free tier (trigger/scheduler only)
**LLM inference**: Groq API (free tier — Llama 3.3 70B via OpenAI-compatible endpoint)
**Web search**: Tavily API (free tier, research-optimised)
**Document retrieval**: User-uploaded PDFs and text files, chunked and keyword-scored at startup
**Memory backend**: Episodic buffer in flat JSON (`memory_buffer.json`)
**Token constraint**: 1,600 tokens of retrieved context + 400 tokens of prompt overhead = 2,000 token hard ceiling per sub-question LLM call

---

## System Components

### 1. Node.js Pipeline (Core)
The pipeline is the application. It exposes a simple HTTP endpoint (`POST /query`) that accepts a query string and runs the full research pipeline synchronously, returning the final answer and run ID. It can also be invoked directly from the command line: `node src/pipeline.js "your query here"`.

### 2. n8n Cloud (Trigger Only)
One n8n workflow contains a single HTTP Request node that POSTs the query to the Node.js pipeline endpoint. n8n handles scheduling (Cron node) and provides a UI for manual triggering. No logic lives in n8n — it is a thin caller. The n8n workflow export (`n8n_workflow_export.json`) is provided for reproducibility but is optional for running the agent.

### 3. Groq (LLM)
Groq is a hosted LLM inference provider with an OpenAI-compatible REST API (`https://api.groq.com/openai/v1/chat/completions`). Authentication is via `Authorization: Bearer` header using the key from `GROQ_API_KEY`. Three prompt roles use Groq: query decomposer, per-sub-question research call, and final synthesiser. The summariser also uses Groq to compress answers before writing to the memory buffer. Default model: `llama-3.3-70b-versatile` (set via `LLM_MODEL` env var). No local RAM requirements — inference runs entirely on Groq's infrastructure.

### 4. Tavily API (Web Search)
Called once per sub-question. Returns top 3 results (title, URL, content snippet). Only the content snippet is used in context assembly. API key stored in environment variable `TAVILY_API_KEY` — never in source code.

### 5. Document Store (User Uploads)
Users place `.pdf` or `.txt` files in the `/docs` directory before running the agent. At startup, the chunker script reads all files, splits them into ~300-word chunks, and writes `chunks_index.json`. Each chunk stores: `source_filename`, `chunk_index`, `word_count`, `text`. Retrieval is keyword-based (overlap scoring) — no vector embeddings required.

### 6. Episodic Memory Buffer
`memory_buffer.json` stores structured summaries of previous research sessions. Each entry contains all sub-question summaries for a single run: `{ query, sub_questions, summaries, sources_used, timestamp, run_id }`. On each sub-question, the top 5 most keyword-relevant prior entries are retrieved and included in context ranking. A single memory entry is written after the final synthesiser completes — one entry per successful run, not one per sub-question. Only successful runs with at least one non-memory source are written; failed or low-evidence runs do not pollute future retrieval.

### 7. Output and Evidence Log
`output_log.json` is append-only. Every run adds one record containing: `run_id`, `timestamp`, `model_used`, `original_query`, `sub_questions` (max 3), `final_answer`, `sources_used`, `context_kept`, `context_dropped`, `token_usage` (with `low_confidence` per sub-question), `status` (`"success"`, `"failed"`, or `"partial"`), `error_message`, and `retrieval_quality`.

---

## Token Budget Rule

This rule applies to every sub-question research LLM call. It is the single authoritative definition used throughout the codebase.

```
Retrieved context budget:    1,600 tokens  (web snippets + doc chunks + memory summaries)
Prompt overhead budget:        400 tokens  (system prompt + sub-question text + formatting)
─────────────────────────────────────────
Hard ceiling per LLM call:   2,000 tokens  (never exceeded under any circumstance)
```

**How the 1,600-token context budget is spent:**

1. All retrieved items (web snippets, doc chunks, memory summaries) are scored by keyword overlap against the sub-question.
2. Items are deduplicated by source label before the keep/drop loop. Web snippets dedup by URL; doc chunks dedup by `source_filename:chunk_index`; memory entries dedup by timestamp. Within each duplicate group, the highest-scoring item is kept.
3. Items are sorted by score descending. Tiebreak priority: memory summaries > doc chunks > web snippets.
4. Items are added to the kept list one by one until cumulative token count reaches 1,600.
5. Any remaining items are dropped. Dropped items are recorded in the evidence log with reason "budget exceeded."
6. No overflow summarisation step — dropped items are dropped cleanly. This keeps budget accounting simple and eliminates the risk of an overflow note pushing the total past the ceiling.

**The 400-token prompt overhead is reserved and never used for retrieved content.** If the assembled prompt including overhead exceeds 2,000 tokens, the pipeline throws `HARD_LIMIT_EXCEEDED` and the run fails with a logged error.

**Token counting method**: `Math.ceil(wordCount * 1.33)`. This is an approximation. Documented as such in `evaluation.md`.

---

## Data Flow

```
POST /query  (or: node src/pipeline.js "query")
  │
  ▼
Query decomposer (Groq)
  → returns JSON array of 2–3 sub-questions (hard max: 3)
  │
  ▼
FOR EACH sub-question (max 3 iterations):
  │
  ├─► Tavily API call
  │     query = sub-question text
  │     returns top 3 results: { title, url, content }
  │
  ├─► Document chunk retrieval
  │     keyword-score all chunks_index.json entries against sub-question
  │     return top 3 chunks by score
  │
  ├─► Episodic memory read
  │     keyword-score all memory_buffer.json entries against sub-question
  │     return top 5 entries by score
  │
  ▼
Token budget gate
  combine all retrieved items into one list
  score each item (keyword overlap with sub-question)
  sort descending (tiebreak: memory > docs > web)
  keep items until cumulative tokens reach 1,600
  drop remainder — log dropped items with reason "budget exceeded"
  verify: kept_tokens ≤ 1,600
  │
  ▼
Context assembler
  build prompt:
    system prompt + formatting    (≤ 400 tokens, reserved overhead)
    kept context items            (≤ 1,600 tokens)
    sub-question text
  verify: total prompt tokens ≤ 2,000
  throw HARD_LIMIT_EXCEEDED if over ceiling
  │
  ▼
Research LLM call (Groq)
  returns answer to sub-question grounded in context
  │
  ▼
Summariser (Groq)
  compress answer to ≤ 150 tokens
  output: { summary, sources_cited[], key_facts[] }
  (summary collected — memory write deferred to after synthesis)
  │
  ▼
END LOOP — collect all sub-question answers (max 3)
  │
  ▼
Final synthesiser (Groq)
  input: all sub-question answers (max 3) as numbered list
  output: single coherent answer ≤ 400 tokens
  │
  ▼
Session-level memory write (quality gate)
  if run is successful AND at least one sub-question has fresh evidence:
    write ONE memory entry containing all sub-question summaries
  else: skip write (failed/partial/low-evidence runs do not write to memory)
  append to memory_buffer.json
  │
  ▼
Evidence log writer
  append full run record to output_log.json
  includes: status, error_message, retrieval_quality, low_confidence per sub-question
  │
  ▼
Return: { final_answer, run_id }
```

---

## File Structure

```
/
├── src/
│   ├── pipeline.js             # Entry point — HTTP server + CLI handler
│   ├── chunker.js              # Run once at setup to index /docs
│   ├── tokenCounter.js         # Shared token count approximation
│   ├── keywordScorer.js        # BM25-style keyword overlap scorer
│   ├── llmClient.js            # Groq HTTP client (OpenAI-compatible)
│   ├── tavilyClient.js         # Tavily HTTP client
│   ├── memoryBuffer.js         # Episodic memory read/write
│   ├── tokenBudgetGate.js      # Rank and trim context to 1,600 tokens
│   ├── contextAssembler.js     # Build final prompt, verify ≤ 2,000 tokens
│   ├── evidenceLogWriter.js    # Append to output_log.json
│   └── prompts/
│       ├── decomposer.js       # Query decomposition prompt (max 3 sub-questions)
│       ├── summariser.js       # Sub-answer compression prompt
│       └── synthesiser.js      # Final synthesis prompt
├── docs/                       # Place uploaded PDFs and text files here
├── memory_buffer.json          # Episodic memory (auto-created, append-only)
├── output_log.json             # Evidence log (auto-created, append-only)
├── chunks_index.json           # Document chunks (auto-created by chunker.js)
├── n8n_workflow_export.json    # Optional: import into n8n cloud for scheduling
├── tests/
│   └── unit.js                 # Unit tests for non-LLM deterministic logic
├── smoke_test.js               # End-to-end smoke test
├── .env.example                # Environment variable template
├── .gitignore
├── ARCHITECTURE.md
├── CLAUDE.md
├── SECURITY.md
├── evaluation.md
└── README.md
```

---

## Known Limitations

- Groq free tier has rate limits (30 req/min) — batch runs may be throttled.
- Token counting uses word × 1.33 approximation (±10% accuracy).
- Document retrieval is keyword-based only. Synonym and paraphrase mismatches reduce recall.
- Memory buffer grows without pruning (append-only in v1).
- No concurrent run safety — single-user prototype only.
- Uploaded documents are not sanitised beyond file type and size checks. Only upload trusted documents.
- No semantic deduplication — exact-label dedup only. Two web snippets from the same domain with different URLs are not deduplicated.

Full trade-off discussion in `evaluation.md`.
