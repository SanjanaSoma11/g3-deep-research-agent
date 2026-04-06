# G3 Deep Research Agent

A deep research agent that answers complex, multi-part business research questions using episodic memory, web search, and document retrieval — all within a strict 2,000-token-per-query context constraint.

Built for the Binox 2026 Take-Home Assessment — Graduate Track G3.

---

## Important: Single-User Prototype

**This is a single-user prototype. It is not designed for concurrent use, shared hosting, or production deployment.**

The main setup limitation is the **ngrok + n8n Cloud combination**: Ollama runs locally on your machine, and n8n Cloud cannot reach localhost directly. You must run ngrok to expose your local Ollama port to the internet, and the free ngrok tier generates a new URL every time you restart it. This means you must update `OLLAMA_BASE_URL` in both your `.env` file and n8n each time ngrok restarts.

If you only want to run the agent from the command line without n8n, ngrok is not needed at all. See Step 5 below.

---

## Architecture Summary

This project is **Node-first**. The Node.js pipeline is the core application — it handles all API calls, memory management, token budgeting, and file I/O. n8n cloud is used only as a scheduler and manual trigger, sending a single HTTP POST to the Node.js endpoint.

- **Core pipeline**: Node.js
- **LLM inference**: Ollama (local, open-source — Mistral or Llama 3)
- **Web search**: Tavily API (free tier)
- **Document retrieval**: User-uploaded PDFs and text files, keyword-scored
- **Memory**: Episodic buffer in flat JSON, structured summaries only
- **Token constraint**: 1,600 tokens retrieved context + 400 tokens prompt overhead = 2,000 hard ceiling per sub-question call
- **Sub-questions**: Maximum 3 per query
- **Scheduler**: n8n cloud free tier (optional — pipeline runs fine without it)
- **Storage**: Flat JSON files (no database)

See `ARCHITECTURE.md` for the full data flow and component descriptions.
See `evaluation.md` for trade-off reasoning and known limitations.

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 18+ | Core runtime |
| Ollama | Latest | Must be running before pipeline executes |
| ngrok | Latest | Only needed if using n8n cloud |
| Tavily API key | — | Free tier at tavily.com — 1,000 queries/month |
| n8n cloud account | Free tier | Optional — only needed for scheduling |

---

## Setup Instructions

### Step 1 — Clone the repository

```bash
git clone <your-repo-url>
cd g3-deep-research-agent
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral
TAVILY_API_KEY=your_tavily_api_key_here
DOCS_DIR=./docs
MEMORY_BUFFER_PATH=./memory_buffer.json
OUTPUT_LOG_PATH=./output_log.json
PORT=3000
```

### Step 4 — Start Ollama and pull the model

```bash
ollama serve
ollama pull mistral
```

Verify Ollama is running:

```bash
curl http://localhost:11434/api/tags
```

### Step 5 — Add documents to the knowledge base (optional)

Place any `.pdf` or `.txt` files you want the agent to search into the `/docs` directory:

```bash
cp your-report.pdf ./docs/
```

Run the document chunker to index them:

```bash
node src/chunker.js
```

This creates `chunks_index.json`. Re-run whenever you add or remove documents. If `/docs` is empty the agent still works — it will rely on web search and memory only.

### Step 6 — Run the smoke test

Verify everything is connected before running a real query:

```bash
node smoke_test.js
```

Expected output:

```
PASS: output_log.json has new entry
PASS: final_answer is non-empty
PASS: sub_questions has 2–3 items (max 3)
PASS: sources_used is non-empty
PASS: no sub-question context exceeded 2,000 tokens
```

### Step 7 — Run a query (command line — no n8n needed)

```bash
node src/pipeline.js "What are the biggest challenges facing D2C consumer brands in 2025 and how are leading brands responding?"
```

The final answer is printed to stdout. The full evidence record is appended to `output_log.json`.

### Step 8 — Run a query via HTTP

Start the pipeline server:

```bash
node src/pipeline.js --server
```

Send a query:

```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"query": "What are the biggest challenges facing D2C consumer brands in 2025?"}'
```

### Step 9 — Connect n8n cloud (optional, for scheduling only)

This step is only needed if you want n8n to trigger the pipeline on a schedule.

**9a. Expose Ollama via ngrok**

n8n cloud cannot reach your local machine. Run ngrok to create a tunnel:

```bash
ngrok http 11434
```

Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`) and update `OLLAMA_BASE_URL` in your `.env`.

Note: free ngrok URLs change on every restart. Update `OLLAMA_BASE_URL` each time.

**9b. Also expose the Node.js pipeline**

```bash
ngrok http 3000
```

Copy this URL — you will use it as the target in n8n's HTTP Request node.

**9c. Import the n8n workflow**

1. Log in to n8n cloud at app.n8n.cloud
2. Workflows → Import → upload `n8n_workflow_export.json`
3. In the HTTP Request node, set the URL to your pipeline's ngrok URL + `/query`
4. Save and activate

---

## Demonstrating Episodic Memory

To show the memory layer working, run two related queries in sequence:

```bash
node src/pipeline.js "What are the key trends in B2B SaaS pricing models in 2025?"
node src/pipeline.js "How are B2B SaaS companies adjusting go-to-market strategy in response to pricing pressure?"
```

The second run should retrieve a summary from the first run via the episodic buffer. Check `output_log.json` — the second entry's `context_kept` array should contain an item with `type: "memory"`.

---

## Project Structure

```
/
├── src/
│   ├── pipeline.js             # Entry point — CLI + HTTP server
│   ├── chunker.js              # Document indexer (run once at setup)
│   ├── tokenCounter.js         # Token count approximation utility
│   ├── keywordScorer.js        # BM25-style keyword overlap scorer
│   ├── ollamaClient.js         # Ollama HTTP client
│   ├── tavilyClient.js         # Tavily HTTP client
│   ├── memoryBuffer.js         # Episodic memory read/write
│   ├── tokenBudgetGate.js      # Rank and trim context to 1,600 tokens
│   ├── contextAssembler.js     # Build final prompt, verify ≤ 2,000 tokens
│   ├── evidenceLogWriter.js    # Append to output_log.json
│   └── prompts/
│       ├── decomposer.js       # Decomposition prompt (max 3 sub-questions)
│       ├── summariser.js       # Sub-answer compression prompt
│       └── synthesiser.js      # Final synthesis prompt
├── docs/                       # Place uploaded PDFs and text files here
├── n8n_workflow_export.json    # Import into n8n cloud for scheduling (optional)
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

## Environment Variables

| Variable | Default | Required |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Yes |
| `OLLAMA_MODEL` | `mistral` | Yes |
| `TAVILY_API_KEY` | — | Yes |
| `DOCS_DIR` | `./docs` | No |
| `MEMORY_BUFFER_PATH` | `./memory_buffer.json` | No |
| `OUTPUT_LOG_PATH` | `./output_log.json` | No |
| `PORT` | `3000` | No |

---

## Known Limitations

- **Single-user prototype** — no concurrent run safety. Do not trigger multiple runs simultaneously.
- **ngrok + n8n Cloud** — the main setup friction. ngrok free tier URLs change on restart; n8n is entirely optional if you use the CLI.
- Token counting is approximate (±10%). See `evaluation.md`.
- Document retrieval is keyword-based only — synonym mismatches reduce recall.
- Memory buffer grows without pruning in v1. Reset by clearing `memory_buffer.json` to `[]`.

Full trade-off discussion in `evaluation.md`.

---

## Submission

Share the public GitHub repository with `oscar@binox.com.hk`. Include at least 2–3 real run entries saved as `sample_output_log.json` (excluded from `.gitignore` unlike the live `output_log.json`).
