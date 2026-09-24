# ADR 0002 — Embedding Provider Choice

**Date:** 2026-09-23  
**Status:** Accepted  
**Deciders:** Platform Engineering  

---

## Context

Phase 4 (Chunking & Embedding Engine) requires an `EmbeddingProvider` abstraction (FR-3.4) with one concrete implementation. The `document_chunks.embedding` column is currently defined as `VECTOR(1536)` in the schema, which must match the chosen model's output dimensionality.

The SRS specifies: "Before wiring it up, write a short ADR confirming the chosen provider/model and its **current** output dimensionality from that provider's own docs, and set the `document_chunks.embedding` column width to match — don't assume the number in the SRS is still current."

---

## Decision

**Provider:** OpenAI  
**Model:** `text-embedding-3-small`  
**Output dimensionality:** **1536** dimensions (confirmed from OpenAI API docs as of 2026-09)

`text-embedding-3-small` was verified to produce 1536-dimensional vectors by default (it supports a custom `dimensions` parameter to reduce to smaller sizes, but the default and our chosen output is 1536).

> The existing `VECTOR(1536)` column width in the schema **matches exactly** — no migration is needed.

---

## Rationale

| Factor | `text-embedding-3-small` | `text-embedding-3-large` | `text-embedding-ada-002` |
|---|---|---|---|
| Output dims | 1536 | 3072 | 1536 |
| Perf (MTEB) | 62.3% | 64.6% | 61.0% |
| Cost (per 1M tokens) | \$0.02 | \$0.13 | \$0.10 |
| Schema change needed | None | Yes (3072) | None |
| Suitable for PoC/MVP | ✅ | ⚠️ (6.5× more expensive) | ❌ (worse than small) |

`text-embedding-3-small` provides the best cost/performance ratio for an MVP deployment. It outperforms the older `ada-002` model at 1/5th the cost, while the large model's quality gain (~2%) doesn't justify a 6.5× cost increase or the schema migration to `VECTOR(3072)`.

### Rate-limit note (FR-2.9 interaction)

OpenAI's default rate limits for `text-embedding-3-small`:
- **Tier 1:** 1,000,000 TPM / 3,000 RPM
- **Tier 2:** 2,000,000 TPM / 5,000 RPM

The `workspace_rate_limits.embedding_calls_per_min` default (500 calls/min per workspace) stays well within these limits for a multi-tenant deployment. If a workspace hits its per-workspace limit, the admission gate (AdmissionGate, already implemented in Phase 3) will hold the job as `queued` without calling OpenAI — no provider-side backoff is needed beyond the standard token bucket.

If the platform later exceeds Tier 1 limits across all workspaces combined, upgrade the OpenAI organization tier or add a global rate limiter in the `OpenAIEmbeddingProvider` class (retry with `Retry-After` header). This is flagged but not needed for MVP.

---

## Consequences

1. The `VECTOR(1536)` column dimension is confirmed correct — no schema migration needed for Phase 4.
2. The `EmbeddingProvider` interface abstracts the model; swapping to `text-embedding-3-large` or a self-hosted model (e.g., `nomic-embed-text`) requires only implementing a new provider class and updating the `EMBEDDING_MODEL` env var.
3. Dimensionality is fixed per deployment. If a different model with different dimensions is chosen in future, a full re-embedding of all chunks is required (delete all rows in `document_chunks`, re-run ingestion). This is the same constraint called out in FR-3.4.
4. The `OPENAI_API_KEY` env var must be set in `.env.example` and the worker's environment.
