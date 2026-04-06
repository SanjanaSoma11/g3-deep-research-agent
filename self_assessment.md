# Self-Assessment — G3 Deep Research Agent

## Assessment Criteria Checklist

### ✅ Technical Execution (40%)

| Criterion | Status | Notes |
|---|---|---|
| Clean code, working prototype | ✅ | All 16 source files follow consistent style; JSDoc comments on public functions |
| Appropriate tool selection | ✅ | Groq (free hosted LLM), Tavily (research-optimised search), flat JSON (zero-infra storage) |
| Error handling | ✅ | Every external call wrapped in try/catch; pipeline continues on per-sub-question failure |
| Token budget enforced | ✅ | Hard 2,000-token ceiling; HARD_LIMIT_EXCEEDED thrown before any over-budget LLM call |
| Memory architecture implemented | ✅ | Episodic JSON buffer with keyword retrieval and quality gate |

**Honest gaps:**
- Token counting uses a word × 1.33 approximation, not the model's native tokeniser. Worst-case error is ~10%.
- Keyword retrieval has no semantic awareness — synonym mismatches will reduce recall.
- No concurrent run safety (acceptable for a single-user demo, not for production).

---

### ✅ Documentation & Reproducibility (25%)

| Criterion | Status | Notes |
|---|---|---|
| README with setup instructions | ✅ | Step-by-step from clone to smoke test, including Render deployment |
| Architecture diagram | ✅ | Mermaid diagrams in `docs/architecture_diagram.md` (GitHub renders natively) |
| Self-assessment | ✅ | This file |
| `evaluation.md` | ✅ | Covers every major architectural decision with explicit trade-offs |
| Reproducible by a third party | ✅ | Only two external credentials required (Groq, Tavily) — both free, no credit card |

**Honest gaps:**
- `output_log.json` resets on Render free tier restarts (ephemeral filesystem). Acknowledged in README.
- n8n workflow import is provided but not tested against a live n8n cloud account during development — tested via direct HTTP only.

---

### ✅ Creativity & Constraint Handling (20%)

| Criterion | Status | Notes |
|---|---|---|
| Innovative approach within limits | ✅ | Chose episodic session-level memory over per-chunk vector embeddings — simpler, more coherent, zero infrastructure |
| Thoughtful trade-off documentation | ✅ | `evaluation.md` documents all five major decision points with explicit "trade-off accepted" sections |
| Memory constraint demonstration | ✅ | 2,000-token ceiling is enforced in code, not just documented; dropped context is logged and auditable |

**Honest gaps:**
- The keyword scorer is a simple overlap ratio, not true BM25. Production would use a proper BM25 implementation with IDF weighting.
- The quality gate thresholds (≥50-word answer, ≥1 cited source per sub-question) are heuristic rather than learned.

---

### ✅ Business Impact Reasoning (15%)

See **Business Value** section below.

---

## Business Value

### Who uses this

Intelligence, strategy, and business development teams at SMEs and agencies who need rapid, evidence-tracked answers to complex market research questions — without paying for enterprise research platforms (Crayon, Klue, AlphaSense).

The target persona is a consultant or BD analyst who currently does this manually: open 10 browser tabs, read 5 PDFs, synthesise a summary in a doc. This agent compresses that workflow to a single query, with full source attribution.

### What client problem it solves

**Problem:** A typical research session for a business question ("What pricing models are D2C brands using in 2025, and which are working?") takes 45–90 minutes of skilled analyst time. The output is often poorly cited and not reusable.

**This agent provides:**
1. Consistent, token-budget-constrained answers with cited sources in under 60 seconds
2. An episodic memory layer that accumulates institutional knowledge across sessions — the second query on a topic is informed by the first
3. A full evidence log per run: every kept and dropped source is recorded, making the answer auditable

### Why this architecture is cheaper and faster to demo

| Factor | This agent | Typical RAG + vector DB alternative |
|---|---|---|
| Infrastructure cost | $0 (Groq free + Tavily free + Render free) | $20–50/month (Pinecone, OpenAI embeddings, hosted DB) |
| Setup time for evaluator | ~5 minutes (two API keys, `npm install`) | 30+ minutes (Docker, DB setup, embedding model pull) |
| Cold-start for demo | < 30 seconds (Render free tier) | Requires warm local stack |
| LLM quality | Llama 3.3 70B (strong) | Depends on budget |

The deliberate constraint — flat JSON over a vector store, keyword scoring over embeddings — is not a shortcut. It is the right choice at this scale and makes the memory management logic fully transparent and testable without a database.

### Production upgrade path

The architecture is explicitly designed so each component can be upgraded independently:

1. **Retrieval:** Swap keyword scorer for a vector embedding model (add `chromadb` or `qdrant-client`). No other module changes.
2. **LLM:** Change `GROQ_API_KEY` + `LLM_MODEL` env vars to any OpenAI-compatible provider. `llmClient.js` is the only file that changes.
3. **Storage:** Replace flat JSON writes in `memoryBuffer.js` and `evidenceLogWriter.js` with a SQLite or Postgres client. No pipeline logic changes.
4. **Concurrency:** Add a job queue (BullMQ) in front of `runPipeline()`. The function itself is already stateless per-run.
5. **Memory pruning:** Add a TTL sweep to `memoryBuffer.js` that discards entries older than N days. The append-only format supports this without schema changes.

None of these upgrades require rewriting the pipeline orchestration, token budget gate, or prompt layer.
