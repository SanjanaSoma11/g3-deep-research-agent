# evaluation.md — Architecture Trade-offs and Design Decisions

## Overview

This document explains the key architectural decisions made in the G3 Deep Research Agent, the trade-offs considered, and the reasoning behind choices made under time and resource constraints. It is a required deliverable under the G3 task specification.

---

## Memory Strategy: Episodic Buffer over Vector RAG

### Decision
An episodic buffer stored as a flat JSON file was chosen over a vector store (Chroma, Qdrant, or Pinecone).

### Reasoning
A vector store requires either a locally running service (Chroma, Qdrant) or a paid managed service (Pinecone). Both add operational complexity that is disproportionate to the scale of this prototype — the memory buffer will contain at most a few hundred entries during the assessment period. A JSON file with keyword scoring is sufficient for this scale and requires zero additional infrastructure.

The episodic structure (full session summaries keyed by query) is more appropriate for this use case than chunk-level vector embeddings because: (1) the agent is answering business research questions where session-level context ("last time I researched this topic I found X") is more useful than sentence-level similarity, and (2) the summaries are already compressed by the summariser LLM, so they are dense and information-rich.

### Trade-off accepted
Retrieval quality degrades for queries that use different vocabulary than previously stored sessions. A vector store with semantic embeddings would handle paraphrasing and synonyms better. This is an acceptable trade-off for a demo prototype.

---

## Retrieval Strategy: Keyword Overlap over Semantic Embeddings

### Decision
BM25-style keyword overlap scoring was used for both document chunk retrieval and memory buffer retrieval, instead of generating embeddings and computing cosine similarity.

### Reasoning
Generating embeddings requires either a local embedding model (additional Ollama model download, additional RAM) or an external embedding API (additional cost, additional dependency). For business research queries, which tend to use specific domain vocabulary (company names, industry terms, metric names), keyword overlap performs adequately. The queries are not ambiguous natural language — they are focused research questions where the key terms are highly predictive of relevance.

### Trade-off accepted
Synonyms and paraphrasing will reduce retrieval recall. A query about "revenue growth" will not match a document chunk that discusses "sales increase" without the word "revenue." This is documented as a known limitation and would be the first improvement in a production version.

---

## Token Constraint: 2,000 Tokens Per Sub-question Context Window

### Decision
The 2,000-token hard ceiling is split into two fixed budgets: 1,600 tokens for retrieved context (web snippets, document chunks, memory summaries) and 400 tokens reserved for prompt overhead (system instructions, sub-question text, formatting). These two budgets are strict and non-overlapping. The final synthesis call is exempt — it only receives already-compressed sub-question answers and is not subject to the per-call limit.

There is no overflow summarisation step. When retrieved context exceeds 1,600 tokens, lower-ranked items are dropped entirely and recorded in the evidence log with reason "budget exceeded." This was a deliberate simplification: an overflow summarisation step would require an additional Ollama call per sub-question, adding latency and making token accounting harder to verify. Clean dropping with full logging is easier to audit and sufficient for a prototype.

### Reasoning
Splitting the ceiling into a fixed context budget (1,600) and a fixed overhead reservation (400) eliminates the risk of prompt overhead eating into context space unpredictably. The 400-token overhead reservation is conservative — a typical system prompt and sub-question text uses approximately 150–250 tokens — but the extra headroom prevents hard limit violations caused by long sub-question strings.

The constraint forces the agent to make explicit, logged decisions about what context to keep and drop, which is the core demonstration of the memory management requirement in the G3 spec. An unconstrained agent would simply concatenate all available context, which would not demonstrate the required memory strategy.

### Token counting approximation
Token counts are approximated using `word_count × 1.33`. This is a conservative multiplier derived from the empirical observation that English text tokenises at approximately 0.75 words per token in common BPE tokenisers. The multiplier rounds up to avoid underestimation. Actual token counts may differ by ±10% depending on the specific model and tokeniser. A production implementation would use the model's native tokeniser for exact counts.

### Trade-off accepted
The 1,600-token context budget may cause the agent to drop relevant context when many high-scoring sources are available. The priority order (memory summaries > document chunks > web snippets) mitigates this by ensuring the most trusted and already-compressed sources are kept first. Dropped items are fully logged in the evidence log, making the trade-off visible and auditable.

---

## LLM Choice: Ollama (Local Open-Source) over Hosted APIs

### Decision
Ollama running a local open-source model (Mistral or Llama 3) was chosen over hosted API providers (OpenAI, Anthropic, Google).

### Reasoning
Using a local model eliminates per-token API costs entirely, which is critical for a prototype that may run dozens of test queries during development. It also eliminates the risk of API rate limits interrupting development. The trade-off is that Ollama requires a machine with sufficient RAM (minimum 8GB for Mistral 7B) and must be running locally before the n8n workflow executes.

For the demo runs required for submission, model quality is sufficient. The architecture is model-agnostic — swapping the Ollama client for an OpenAI or Anthropic client requires changing only the client module, not any other component.

### Trade-off accepted
Local model quality is lower than frontier models (GPT-4o, Claude Sonnet). Query decomposition and summarisation may be less accurate. For a business research demo with straightforward queries this is acceptable. A production deployment would use a frontier model.

---

## Web Search: Tavily over Other Providers

### Decision
Tavily was chosen over Serper, Google Custom Search, and DuckDuckGo.

### Reasoning
Tavily is specifically designed for research agent use cases and returns clean content snippets rather than raw HTML, eliminating the need for a scraping/parsing layer. The free tier provides 1,000 queries/month, which is more than sufficient for development and demo. Serper provides more queries on the free tier (2,500/month) but returns less structured content. DuckDuckGo's instant answer API is unpredictable for business research queries.

### Trade-off accepted
Tavily's free tier content may be lower quality than a paid web search API with full page indexing. For a demo prototype this is acceptable.

---

## Storage: Flat JSON Files over a Database

### Decision
All persistent state (memory buffer, output log, document chunks index) is stored as flat JSON files rather than SQLite, PostgreSQL, or any other database.

### Reasoning
Flat JSON files require zero infrastructure beyond the filesystem. They are human-readable, directly inspectable, and trivially version-controlled (for the chunks index and initial buffer state). For the scale of this prototype (hundreds of entries maximum) there is no performance argument for a database.

### Trade-off accepted
JSON file storage has no concurrent write safety. If two workflow runs execute simultaneously they may corrupt the memory buffer or output log. This is acceptable for a single-user demo. A production system would use a database with proper transaction support.

---

## Known Limitations Summary

| Limitation | Impact | Mitigation in v1 | Production fix |
|---|---|---|---|
| Word-count token approximation (±10%) | Occasional over/undercount | Conservative 1.33 multiplier | Use model tokeniser |
| Keyword retrieval (no semantics) | Missed synonyms | Focused query vocabulary | Vector embeddings |
| No memory pruning | Buffer grows unbounded | Acceptable for demo scale | TTL-based pruning |
| Ollama requires local tunnel for n8n cloud | Setup complexity | Documented in README | Host Ollama on VPS |
| No concurrent write safety | File corruption risk | Single-user demo only | Database with transactions |
| No document sanitisation beyond type/size | Prompt injection risk | Trusted user uploads only | Content sandboxing |
