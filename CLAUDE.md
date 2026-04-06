# CLAUDE.md — Build Instructions for Claude Code

## What You Are Building

You are building the G3 Deep Research Agent described in ARCHITECTURE.md. Read ARCHITECTURE.md completely before writing any code or creating any files. Read SECURITY.md completely before making any API calls, writing any file I/O code, or handling any user input.

This is a working prototype for a hiring assessment. It must run end-to-end without manual intervention after setup. It must be reproducible by a third party following only README.md.

---

## Non-Negotiable Rules

1. Do not write any code until you have read ARCHITECTURE.md, SECURITY.md, and this file in full.
2. Do not invent architecture decisions not described in ARCHITECTURE.md. If something is ambiguous, leave a clearly marked TODO comment and continue — do not guess.
3. Do not hardcode any API keys, tokens, passwords, or credentials anywhere in any file. All credentials are loaded from environment variables or n8n's credential manager.
4. Do not write code that makes destructive file operations (delete, overwrite) on any file except `memory_buffer.json`, `output_log.json`, and `chunks_index.json`. These three files are the only files the agent is allowed to modify at runtime.
5. Do not write code that makes outbound HTTP requests to any domain not listed in the Allowed Domains section of SECURITY.md.
6. Every function that calls an external API must have a try/catch with explicit error logging. Silent failures are not acceptable.
7. Every n8n Function node must include a comment block at the top explaining what it does, its inputs, and its outputs.

---

## Build Order

Follow this exact order. Do not skip steps or build out of sequence.

### Step 1 — Project scaffolding
Create the directory structure exactly as specified in ARCHITECTURE.md under File Structure. Create empty placeholder files for `memory_buffer.json` (initial value: `[]`), `output_log.json` (initial value: `[]`), and `chunks_index.json` (initial value: `[]`). Create the `/docs` directory.

### Step 2 — Document chunker
Build the document chunking utility. This runs once at startup (not on every query). It reads all `.pdf` and `.txt` files from the `/docs` directory, splits each into chunks of approximately 300 words, and writes the result to `chunks_index.json`. Each chunk object must contain: `source_filename`, `chunk_index`, `word_count`, `text`. If `/docs` is empty, write an empty array and log a warning — do not throw an error.

For PDF parsing use a lightweight library only. Do not use any library that requires native binary compilation unless it is available as a pure JavaScript or pure Python package.

### Step 3 — Token counter utility
Build a shared utility function for token counting. Use the formula: `token_count = Math.ceil(word_count * 1.33)`. This function must be importable by all other modules. It must accept a string and return an integer. Document the approximation in a comment.

### Step 4 — Keyword scorer utility
Build a shared utility function for BM25-style keyword overlap scoring. Input: a query string and a candidate text string. Output: a float score between 0 and 1. Implementation: extract non-stopword tokens from both strings, compute overlap ratio (intersection size / union size). This is used for both document chunk retrieval and episodic memory retrieval.

### Step 5 — LLM client (Groq)
Build a thin HTTP client for Groq (`src/llmClient.js`). It must:
- POST to `https://api.groq.com/openai/v1/chat/completions` using the OpenAI Chat Completions request format
- Load the API key from environment variable `GROQ_API_KEY` — throw immediately if not set
- Load the model name from environment variable `LLM_MODEL` (default: `llama-3.3-70b-versatile`)
- Accept: prompt string, max_tokens integer (model is internal — callers do not pass it)
- Return: response text string (`data.choices[0].message.content`)
- Throw a typed `LLMError` on non-200 response
- Log the model name, prompt token count, and response token count on every call
- Never log the API key, even partially
- Set `temperature: 0.3` for deterministic research outputs
- Respect the 2,000 token hard limit: if the prompt exceeds 2,000 tokens, throw an error with message "TOKEN_LIMIT_EXCEEDED" before sending — do not send the request
- Export `llmGenerate(prompt, maxTokens)` and `getModelName()` so pipeline.js can log the model name

### Step 6 — Tavily client
Build a thin HTTP client for Tavily. It must:
- POST to `https://api.tavily.com/search`
- Load the Tavily API key from environment variable `TAVILY_API_KEY`
- Accept: query string
- Request parameters: `search_depth: "basic"`, `max_results: 3`, `include_answer: false`
- Return: array of `{ title, url, content }` objects
- Throw a typed error on non-200 response
- Log each call with query and number of results returned

### Step 7 — Memory buffer module
Build the episodic memory read/write module. It must:
- Read from `memory_buffer.json`
- On read: accept a query string, score all buffer entries against the query using the keyword scorer, return the top 5 entries sorted by score descending
- On write: accept a structured summary object `{ query, sub_questions, summaries, sources_used, timestamp }` and append it to the buffer array
- Never truncate or delete existing buffer entries (append-only in v1)
- Handle the case where `memory_buffer.json` does not exist by returning an empty array

### Step 8 — Token budget gate
Build the token budget gate function. This is the most critical component. It must:
- Accept: array of web snippets, array of doc chunks, array of memory summaries, current sub-question string
- Score every item using the keyword scorer against the sub-question
- Sort all items by score descending, regardless of source type — but apply source priority tiebreaking: memory > docs > web when scores are equal
- Iterate through sorted items, adding each to the kept list until cumulative token count reaches 1,600
- All remaining items go to the dropped list
- All remaining items go to the dropped list with reason "budget exceeded" — no overflow summarisation step
- Return: `{ kept: [], dropped: [], kept_tokens: int, dropped_tokens: int }`
- Hard ceiling check: if `kept_tokens > 1600`, throw "HARD_LIMIT_EXCEEDED"
- The remaining 400 tokens are reserved for prompt overhead (system instructions, sub-question text, formatting). Total hard ceiling: 2,000 tokens per sub-question LLM call

### Step 9 — Context assembler
Build the context assembler function. It must:
- Accept the output of the token budget gate plus the current sub-question string
- Assemble a prompt string in this exact structure:

  ```
  You are a research assistant. Answer the question below using only the provided context.
  Be concise. Cite sources by filename or URL inline.

  CONTEXT:
  [kept items, each prefixed with its source label]
  [kept context items with source labels]

  QUESTION:
  [sub-question text]
  ```

- Verify final prompt token count using the token counter utility
- If count exceeds 2,000, throw "CONTEXT_ASSEMBLY_LIMIT_EXCEEDED" with the actual count in the error message
- Return the assembled prompt string and the final token count

### Step 10 — Query decomposer prompt
Write the Ollama prompt for query decomposition. The prompt must:
- Instruct the model to decompose the input query into max 3 focused sub-questions
- Instruct the model to return only a JSON array of strings, no preamble, no explanation
- Include two worked examples in the prompt (few-shot)
- Specify that sub-questions must be self-contained (answerable without reading each other)

### Step 11 — Summariser prompt
Write the Ollama prompt for the summariser. The prompt must:
- Accept a sub-question and its answer
- Instruct the model to return only a JSON object: `{ summary: string (≤150 tokens), sources_cited: string[], key_facts: string[] }`
- Instruct the model to return no preamble or explanation
- Specify that the summary must be under 150 tokens

### Step 12 — Final synthesiser prompt
Write the Ollama prompt for the final synthesiser. The prompt must:
- Accept all sub-question answers as a numbered list
- Instruct the model to write a single coherent answer of ≤ 400 tokens
- Instruct the model to reference which sub-question each part of the answer draws from
- Return plain prose, not JSON

### Step 13 — Evidence log writer
Build the evidence log writer. It must append to `output_log.json` a record containing exactly:

```json
{
  "run_id": "<uuid>",
  "timestamp": "<ISO8601>",
  "model_used": "<ollama model name>",
  "original_query": "<string>",
  "sub_questions": ["<string>"],
  "final_answer": "<string>",
  "sources_used": [{ "type": "web|doc|memory", "label": "<url or filename>" }],
  "token_usage": [{ "sub_question": "<string>", "tokens_used": int, "tokens_dropped": int }],
  "context_kept": [{ "source": "<string>", "tokens": int }],
  "context_dropped": [{ "source": "<string>", "tokens": int, "reason": "<string>" }]
}
```

### Step 14 — Main pipeline orchestration
Wire all components into the main pipeline following the data flow in ARCHITECTURE.md exactly. The entry point accepts a query string. It runs the full pipeline and returns the final answer plus the run_id so the caller can look up the evidence log entry.

### Step 15 — n8n workflow
Export the complete pipeline as an n8n workflow JSON file (`n8n_workflow_export.json`). The workflow must be importable into n8n cloud free tier without modification. All HTTP Request nodes must use n8n credential references, not hardcoded values. Include an Error Trigger node that logs failed runs to `output_log.json` with `status: "failed"` and the error message.

### Step 16 — Smoke test
Write a smoke test script (`smoke_test.js` or `smoke_test.py`) that:
- Sends one hardcoded business research query through the full pipeline
- Asserts that `output_log.json` has one new entry after the run
- Asserts that the entry contains non-empty `final_answer`, `sub_questions`, and `sources_used`
- Asserts that no sub-question context exceeded 2,000 tokens
- Prints PASS or FAIL with a reason for each assertion
- Does not require any test framework — plain assertions only

---

## Environment Variables Required

| Variable | Description | Required |
|---|---|---|
| `GROQ_API_KEY` | Groq API key (https://console.groq.com) | Yes |
| `LLM_MODEL` | Groq model name to use | No (default: llama-3.3-70b-versatile) |
| `TAVILY_API_KEY` | Tavily search API key | Yes |
| `DOCS_DIR` | Path to uploaded documents folder | No (default: ./docs) |
| `MEMORY_BUFFER_PATH` | Path to memory buffer JSON | No (default: ./memory_buffer.json) |
| `OUTPUT_LOG_PATH` | Path to output log JSON | No (default: ./output_log.json) |

---

## What NOT to Build

- Do not build a web UI or frontend of any kind (this rule is overridden by FRONTEND_INSTRUCTIONS.md for the frontend phase)
- Do not build a database — all storage is flat JSON files
- Do not build vector embeddings or a vector store — retrieval is keyword-based only
- Do not build authentication or user management
- Do not build any background scheduler — n8n handles all scheduling
- Do not install any dependency that requires a compiled native binary unless explicitly approved
- Do not build retry logic beyond a single retry on network timeout — this is a demo, not production
