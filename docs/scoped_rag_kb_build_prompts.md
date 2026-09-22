# Build Prompt Kit — Scoped-RAG Knowledge Base Platform

Companion to `scoped_rag_kb_srs.md` (v1.1). This is the set of prompts to feed an AI code editor to actually build the thing, broken into vertical, reviewable slices instead of one "build the whole SRS" mega-prompt — that pattern reliably produces plausible-looking code that silently drifts from the spec, especially on the security-critical pieces (§6.2 pooled RLS, §6.6 rate limits).

**Stack assumption:** your last two builds (the crypto trading app, the OCR document editor) both landed on Fastify + Next.js 14 App Router + PostgreSQL, and the trading app specifically locked in Turborepo/pnpm, Drizzle ORM, and BullMQ/ioredis. I've kept that stack here rather than introducing a new one — swap anything below if this project should diverge from it.

---



## 0. How to Use This Kit

1. **Check the SRS into the repo first**, at `docs/srs.md`. Every prompt below references it by section instead of re-pasting schemas — that's deliberate: if you paste the DDL inline into ten different prompts and then edit the SRS, the prompts silently go stale. Point the agent at the file instead.
2. **One prompt = one PR-sized slice.** Don't chain phases in a single message even if your editor's context window could technically hold it — you want a reviewable diff and a passing test suite at each step, not a 4,000-line first commit.
3. **Put the rules file in place before Phase 0.** It saves you from re-explaining the same constraints in every subsequent prompt, and — more importantly — gives the agent something to check itself against instead of "helpfully" improvising around a gap.
4. **Every phase prompt ends with an explicit stop condition.** Agentic coding tools default to filling ambiguity with a plausible guess and moving on; for the security- and cost-sensitive pieces (tenant isolation, rate limits, grounding thresholds) a plausible guess is exactly what you don't want. Keep that line in even when you're tempted to cut it for brevity.
5. **Review the diff yourself before merging**, especially Phase 1 and Phase 8. Vibe-coding speeds up the typing, not the reviewing.

---



## 1. Rules File (place before Phase 0)

Cursor uses `.cursor/rules/*.mdc`; Claude Code uses `CLAUDE.md` at the repo root; Windsurf uses `.windsurfrules`. Content is identical — only the filename/frontmatter changes. Cursor version shown; drop the frontmatter for the others.

```
---
description: Locked stack and non-negotiable constraints — Scoped-RAG KB platform
globs: ["**/*"]
alwaysApply: true
---

# Source of truth
`docs/srs.md` is the spec. If an instruction here or in a prompt conflicts with it,
docs/srs.md wins — flag the conflict instead of silently picking one.

# Locked stack — do not substitute without asking
- Monorepo: Turborepo + pnpm workspaces
- Backend API: Fastify 4 (TypeScript)
- Frontend: Next.js 14, App Router
- ORM: Drizzle, schema mirrors docs/srs.md §4.1 exactly (table/column names, enums, indexes)
- DB: PostgreSQL 16 + pgvector extension
- Queue: BullMQ + ioredis
- Auth: jose (JWT) + argon2 (password hashing)
- Object storage: S3-compatible (MinIO locally, S3 in prod)

# Non-negotiable security invariants
- Tenant isolation MUST use `SET LOCAL app.current_workspace` inside an explicit
  transaction (BEGIN...COMMIT) per every request — never a session-level SET.
  This is a merge-blocking rule; see docs/srs.md §6.2. Any DB access helper that
  doesn't go through the transaction-scoped context is a bug, not a shortcut.
- Web URL ingestion MUST block RFC 1918 / link-local / loopback targets at the
  network layer before fetching (docs/srs.md FR-2.4). Do not implement this as an
  application-level string check on the URL alone — that's bypassable via
  redirects and DNS rebinding; block at the egress/fetch layer.
- Folder and Scope authorization checks happen in the query itself (join/filter),
  never as a post-fetch filter on an unrestricted result set.
- Every resource-consuming call (OCR dequeue, embedding call, LLM generation)
  checks the workspace's rate limit BEFORE the external call is made, not after.

# Repo boundaries
- apps/web — Next.js UI only, no direct DB access, calls apps/api
- apps/api — Fastify REST + SSE/WS, owns all DB writes
- apps/worker — BullMQ consumers (OCR, chunking, embedding, scope resolution)
- packages/db — Drizzle schema + migrations, shared by api and worker
- packages/shared-types — types shared across apps (request/response DTOs)

# Testing conventions
- Every new Fastify route ships with at least one integration test.
- Any change touching tenant isolation, folder permissions, or Scope resolution
  ships with a test that asserts a *negative* case (workspace A cannot see
  workspace B's data), not just the happy path.
- Chunking/OCR acceptance criteria in docs/srs.md (FR-2.2, FR-3.1) are numeric —
  test against those numbers, not "looks reasonable."

# When you hit a gap
If the SRS doesn't specify something you need to build, stop and ask rather than
inventing a convention — especially for schema shape, auth, or rate-limit numbers.
```

---



## 2. Phase Prompts



### Phase 0 — Monorepo & Environment Scaffold

> Set up a Turborepo + pnpm workspace monorepo per the rules file at the repo root. Create `apps/web` (Next.js 14, App Router, TypeScript, Tailwind), `apps/api` (Fastify 4, TypeScript), `apps/worker` (standalone BullMQ consumer process, TypeScript), `packages/db` (Drizzle ORM setup, empty schema for now), `packages/shared-types`. Add a `docker-compose.yml` with Postgres 16 (`pgvector/pgvector:pg16` image), Redis, and MinIO for local dev, plus a root `.env.example` covering DB URL, Redis URL, S3/MinIO credentials, and placeholders for an LLM provider key and an embedding provider key (leave both as TODO — provider choice is Phase 4). Add root `package.json` scripts for `dev`, `build`, `test`, `db:migrate`. Confirm `docker-compose up` gets Postgres, Redis, and MinIO healthy, and that `pnpm dev` boots all three apps without errors.
>
> **Stop and ask if:** the Node version needs to diverge from what an `.nvmrc` at the repo root would otherwise pick — check for compatibility with the rest of your toolchain before locking it in.

**Done when:** `docker-compose up` + `pnpm dev` both succeed cold, and a hello-world route on `apps/api` is reachable from `apps/web`.

---



### Phase 1 — Data Layer, Auth & Pool-Safe Tenant Isolation

*This is the phase to review most carefully — everything downstream depends on this being right.*

> In `packages/db`, write the full Drizzle schema mirroring `docs/srs.md §4.1` exactly: `workspaces`, `users`, `workspace_members`, `folders` (with `ltree` path), `folder_permissions`, `documents`, `batch_jobs`, `document_chunks` (with `pgvector` column and HNSW index), `scopes`, `scope_documents`, `scope_folders`, `scope_shares`, `scope_resolved_documents`, `workspace_rate_limits`, `workspace_usage_events`, `chat_sessions`, `chat_messages`, `chat_message_citations`. Generate the initial migration and confirm it applies cleanly to the docker-compose Postgres instance.
>
> In `apps/api`, implement JWT auth (`jose`) with `argon2` password hashing: signup, login, and a Fastify auth-decorator that resolves the current user and their `workspace_members.role` for the request's workspace.
>
> Implement the tenant-isolation pattern from `docs/srs.md §6.2` as a Fastify plugin: every authenticated request runs inside an explicit `BEGIN`, issues `SET LOCAL app.current_workspace = $workspaceId`, executes the handler against that transaction, and commits — with RLS policies on every tenant-scoped table enforcing `workspace_id = current_setting('app.current_workspace')::uuid`. Do **not** implement this as a session-level `SET` under any circumstances, even for a "just to get it working" first pass.
>
> Write an integration test that runs against Postgres through **PgBouncer in transaction-pooling mode** (add PgBouncer to the docker-compose file), creates two workspaces, and asserts that a request authenticated for workspace A can never read a row belonging to workspace B — including immediately after another request for workspace B has run on what may be the same pooled physical connection. This test is the actual acceptance criterion for this phase, not "the happy path works."
>
> **Stop and ask if:** achieving pool-safety requires a connection-handling library choice (e.g., how Drizzle is wired to the pool) that isn't already implied by the stack — don't silently pick one without flagging the trade-off.

**Done when:** the cross-tenant pooled-connection test passes, and it fails (red) if you temporarily revert the `SET LOCAL`-in-transaction pattern to a bare session-level `SET` — i.e., confirm the test actually catches the bug it's meant to catch before moving on.

---



### Phase 2 — Drive UI: Workspaces, Folders, Documents

> Implement folder CRUD (`docs/srs.md` Module 1 / FR-1.1–1.2, FR-1.7, FR-1.9–1.10) in `apps/api`: nested folders via the `ltree path` column, breadcrumb resolution, trash (`deleted_at`) with a scheduled purge job in `apps/worker` respecting `purge_at`. Implement `folder_permissions` nearest-ancestor resolution exactly as specified in FR-1.3 — the search/list query must join against the authorized path set, not filter results after fetching.
>
> Implement document metadata CRUD: upload endpoint that stores the file to the S3/MinIO bucket and inserts a `documents` row with `processing_status = 'queued'` (no parsing pipeline yet — that's Phase 3). Implement the Base Document Registry distinction (`is_base_document`, `base_doc_category`, `supersedes_doc_id` versioning per FR-1.6), including the DB trigger that rejects `UPDATE`/`DELETE` on a published Base Document.
>
> In `apps/web`, build the Drive UI: folder tree, breadcrumbs, drag-and-drop move, file cards showing `processing_status` (static for now — wire to live updates in Phase 3), and a toggle to mark an upload as a Base Document.
>
> **Stop and ask if:** the folder depth limit (default 15 in the SRS) or the trash retention window (default 30 days) should differ from the SRS defaults for your use case.

**Done when:** you can create nested folders, upload a file into one, see it listed with correct breadcrumbs, move it, trash it, and confirm a user without `folder_permissions` access to that subtree gets a 403/empty result rather than seeing the file.

---



### Phase 3 — Ingestion Pipeline & Real-Time Status

> In `apps/worker`, implement the BullMQ ingestion queue per `docs/srs.md` Module 2, partitioned per-workspace with weighted fair-share scheduling (FR-2.9) so one workspace's large batch can't starve another's single upload. Implement parsers for native-text PDF, scanned PDF/image (OCR), Excel/CSV (preserving formula string + computed value per FR-2.3), DOCX, and web URL. For OCR, pick one engine (Tesseract, AWS Textract, or Azure Document Intelligence — note the choice and why in a short ADR under `docs/adr/`, since it affects the ≥98% CRA acceptance bar in FR-2.2) and produce bounding boxes per FR-2.2.
>
> For web URL ingestion, implement the SSRF guard from FR-2.4 at the network/fetch layer (block RFC 1918, link-local, loopback, and re-validate on every redirect hop — not just the initial URL), a 15-second render timeout, a 10 MB DOM cap, and `<main>`/`<article>` extraction with script/style stripping.
>
> Implement the `processing_status` state machine transitions and the SSE endpoint (`GET /api/v1/documents/{id}/events`) plus the workspace-wide WebSocket channel from `docs/srs.md §5.3`. Wire the ingestion admission check (FR-2.9) to `workspace_rate_limits`/`workspace_usage_events` before a job is dequeued for processing — over-limit jobs stay `queued`, they are not rejected. Implement retry-with-backoff (3 attempts) and a dead-letter path.
>
> In `apps/web`, replace the static status in the Drive UI with the live SSE/WebSocket stream so file cards update without a refresh.
>
> **Stop and ask if:** the OCR engine you're evaluating can't realistically hit 98% CRA in your testing — that's a spec parameter to renegotiate, not silently lower.

**Done when:** uploading a scanned PDF shows live status transitions in the UI through to `indexed` (chunking/embedding stubbed as instant pass-through until Phase 4), a malicious web-URL ingestion attempt against `http://169.254.169.254` or `http://localhost` is provably blocked by a test, and a synthetic burst of uploads to one workspace doesn't visibly delay a single upload to another workspace in a load test.

---



### Phase 4 — Chunking & Embedding Engine

> Implement structure-aware chunking per `docs/srs.md` FR-3.1: paragraph-break/regex-terminal-punctuation splitting targeting 512±64 tokens, parent-child linking per FR-3.2 (child chunks ~400–600 tokens, parent ~1500–2000, 10–15% sibling overlap), spreadsheet row-group chunking with header-row context. Write boundary-integrity tests against the numeric targets — not visual inspection.
>
> Implement the `EmbeddingProvider` abstraction from FR-3.4 behind a single interface (`embed(text: string): Promise<number[]>`), with one concrete implementation to start. Before wiring it up, write a short `docs/adr/embedding-provider.md` confirming the chosen provider/model and its **current** output dimensionality from that provider's own docs, and set the `document_chunks.embedding` column width (currently `VECTOR(1536)` in the schema, matching a 1536-dim model) to match — don't assume the number in the SRS is still current without checking, embedding model lineups change.
>
> Wire embedding generation into the ingestion pipeline (`embedding` stage → `indexed`), storing the full metadata payload from `docs/srs.md §4.2` on every chunk. Implement re-chunk-on-supersede (FR-3.6): re-uploading or versioning a document deletes and re-inserts its chunk set transactionally.
>
> **Stop and ask if:** the embedding provider's rate limits are tight enough that FR-2.9's admission control needs a provider-side backoff strategy beyond the basic token bucket — that's a real constraint worth surfacing, not absorbing silently into retries.

**Done when:** a document reaches `indexed` with a full chunk set in `document_chunks`, `EXPLAIN ANALYZE` on a vector similarity query shows the HNSW index being used (not a sequential scan), and boundary tests pass on a fixture set covering PDFs, spreadsheets, and OCR output.

---



### Phase 5 — Dynamic Scoping Engine

> Implement Scope CRUD per `docs/srs.md` Module 4. The core deliverable is `scope_resolved_documents` materialization (FR-4.6, detailed in §4.3): synchronous recompute on scope edit for scopes resolving under 1,000 documents, an async BullMQ job for larger ones, and an incremental updater triggered off document lifecycle events (upload/move/delete) that matches against `scope_folders` via `path <@`/`path @>` LTREE checks and upserts/deletes the affected `(scope_id, document_id)` rows rather than recomputing the whole scope.
>
> Implement the retrieval-side query change from FR-4.4: joins go through `scope_resolved_documents` keyed on the (small) bound Scope ID array, never a large per-query document-ID array. Write a test with a synthetic 20,000-document Scope and confirm via `EXPLAIN` that the query plan stays index-backed rather than degrading to a sequential/bitmap scan.
>
> Measure and log the propagation delay from "document uploaded into a scoped folder" to "row appears in `scope_resolved_documents`" — the target is a median under 5 seconds (§4.3); alert if it drifts materially above that in testing.
>
> **Stop and ask if:** the 1,000-document synchronous/async cutover threshold turns out wrong for your actual scope sizes in practice — treat it as a starting tuning parameter, not a fixed constant.

**Done when:** creating a Scope over a large folder tree resolves without blocking the request past a reasonable UI timeout, uploading a new file into a scoped folder makes it queryable within the target propagation window, and the 20,000-document query-plan test passes.

---



### Phase 6 — Hybrid Retrieval & Scoped Chat

> Implement hybrid search per `docs/srs.md` Module 5: dense (pgvector cosine) + sparse (`tsvector`) candidate retrieval over the Scope-filtered set, fused via Reciprocal Rank Fusion, then cross-encoder re-ranking down to the top-K passed to the LLM.
>
> Implement the grounding gate from FR-5.3 as a hard check, not a prompt instruction alone: if the top re-ranked candidate's score is below the configured threshold (default 0.65 — calibrate against a held-out labeled query set per the SRS's implementation note before trusting this number in production), short-circuit to `{"no_grounding_found": true}` without calling the LLM. When generation does proceed, implement the post-hoc citation-span faithfulness check and gate the response on a ≥0.90 score, with one retry on failure before falling back to the refusal path.
>
> Implement `POST /api/v1/chat/completions` per `docs/srs.md §5.5` including SSE streaming, and wire the LLM rate-limit check from FR-5.6 before dispatch — an over-limit request returns `429` with `Retry-After` immediately, it does not queue silently.
>
> Persist `chat_sessions` (with the `scope_ids` snapshot per FR-4.5), `chat_messages` (with `retrieval_debug`), and `chat_message_citations`.
>
> **Stop and ask if:** you don't have a labeled query set to calibrate the 0.65/0.90 thresholds against yet — ship with the SRS defaults but flag them as uncalibrated rather than presenting them as tuned.

**Done when:** a query bound to a Scope returns a streamed, cited answer; a query with no relevant content in-Scope returns the refusal path without ever hitting the LLM; and a burst of requests past the workspace's token budget gets `429`s instead of degrading latency for everyone.

---



### Phase 7 — Citation Split-Pane Viewer

> In `apps/web`, build the split-pane viewer from FR-5.4: left pane keeps the chat thread, right pane renders the cited source (PDF page, spreadsheet range, or web screenshot) with the bounding box or row range highlighted and auto-scrolled into view on citation click. Support both the OCR bounding-box case and the spreadsheet row/column case explicitly — they're different rendering paths, not one generic "highlight" component.
>
> **Stop and ask if:** rendering the specific source type (e.g., a very large spreadsheet, or a low-quality scan) needs a fallback UX the SRS doesn't specify.

**Done when:** clicking any citation in a chat response opens the correct source file at the correct location with a visible highlight, for at least one PDF/OCR example and one spreadsheet example.

---



### Phase 8 — Batch Operations, Rate-Limit Hardening & Release Gate

> Implement `POST /api/v1/documents/batch` and `GET /api/v1/batch-jobs/{id}` per FR-1.8 and `docs/srs.md §5.6`: inline execution under the 50-touched-item / 1,500 ms budget, falling back to an async `batch_jobs` row + BullMQ job above either threshold.
>
> Do a full pass wiring `workspace_rate_limits` and `workspace_usage_events` (§6.6) across every admission point identified so far (OCR dequeue, embedding calls, LLM dispatch) if any were stubbed earlier, plus the admin-notification alert at >90% sustained usage.
>
> Treat this phase as the pre-launch gate: re-run the Phase 1 cross-tenant pooled-connection test, the Phase 3 SSRF test, and the Phase 5 large-Scope query-plan test together in CI as a required check before this branch can merge to main, not just individually when they were first written.
>
> **Stop and ask if:** any of those three gate tests is flaky rather than reliably red/green — a flaky security test is worse than no test, because it trains people to ignore the failure.

**Done when:** all three gate tests pass reliably in CI back-to-back, batch operations respect the size/latency thresholds, and rate-limit enforcement is verifiably active on every resource-consuming call path (spot-check by temporarily setting a workspace's limit to 0 and confirming every relevant call path returns the expected backpressure).

---



## 3. Beyond MVP

Phases 0–8 cover `docs/srs.md §7` Phase 1 (MVP) plus the hardening items pulled forward into it. Phase 2 (live thumbnails are already covered above since SSE was built in Phase 3; bounding-box viewer in Phase 7) and Phase 3 (enterprise collaboration, multi-Scope comparison, automated compliance reports, Qdrant migration) aren't broken into prompts yet — worth doing once MVP is actually in front of users, since those priorities may shift based on what real usage shows.