# Software Requirements Specification
## Drive-Style Knowledge Base & Dynamic Scoped-RAG System

| Field | Value |
|---|---|
| Document Version | 1.1 |
| Date | 2026-08-31 |
| Status | Draft — architecture review findings incorporated |
| Standard Basis | IEEE 830-1998, structured per ISO/IEC/IEEE 29148:2018 |
| Classification | Multi-tenant B2B SaaS |

> **Note on scope**: Throughout this document the system is referred to as **"the Platform."** Where the source prompt offered a choice between implementation technologies (e.g. pgvector vs. Qdrant, BullMQ vs. Celery), this SRS commits to one default (stated explicitly) for the sake of concrete schemas and contracts, and flags the alternative as a swappable NFR-driven decision rather than leaving it abstract.

### Revision Notes (v1.0 → v1.1)

An architecture review of v1.0 identified seven concrete flaws — under-specified authorization modeling, unbounded batch/resource operations, unverifiable ingestion/grounding criteria, an SSRF gap, a query-plan scaling failure in the Scoping Engine, and a session-pooling data-leakage risk in the RLS design — plus one systemic gap (no tenant-level cost/rate controls). Every item is fixed in this revision, not just discussed:

| # | Risk | Fixed In |
|---|---|---|
| 1 | No tenant-level rate limits (embedding/OCR/LLM) → noisy-neighbor + uncapped cost | FR-2.9, FR-5.6, §6.6 (new) |
| 2 | RLS via bare `current_setting`, unsafe under pooled connections | §6.2 (rewritten) |
| 3 | `document_id = ANY($1)` degrades at scope sizes in the thousands | FR-4.4 (rewritten), §4.3 (new), `scope_resolved_documents` table |
| 4 | FR-1.3 folder search has no modeled authorization | FR-1.3 (rewritten), `folder_permissions` table |
| 5 | FR-1.8 batch ops have no transaction/size bound | FR-1.8 (rewritten), `batch_jobs` table, §5.6 (new) |
| 6 | FR-2.2 / FR-3.1 use unverifiable adjectives | FR-2.2, FR-3.1 (rewritten with numeric acceptance criteria) |
| 7 | FR-2.4 web ingestion has no SSRF/sanitization spec | FR-2.4 (rewritten) |
| 8 | FR-5.3 grounding has no quantitative threshold | FR-5.3 (rewritten) |

---

## 1. Executive Summary & System Overview

### 1.1 Product Purpose, Value Proposition, and Target Audience

**Purpose.** The Platform lets a team build a governed, queryable knowledge base that cleanly separates two kinds of truth: (a) documents that define the rules — standards, statutes, internal manuals — and (b) documents that describe a specific case, client, or engagement. A user then builds a **Scope**: a named, reusable selection of folders, individual files, and rule-documents that a query is allowed to draw from. Every answer the Platform gives is grounded in retrieved chunks and every claim carries a citation a reviewer can click to see, highlighted, in the original file.

**Value proposition.**
- **Defensibility.** Every generated statement traces to a specific page, paragraph, cell, or bounding box in a specific file. This is the difference between "the model said so" and "here is the source, highlighted, in the original document" — essential where the output may end up in a workpaper or a legal file.
- **Context discipline.** Because retrieval is pre-filtered to a Scope's document set (not the entire tenant's corpus), a query about a 2026 bank-loan engagement cannot silently surface — or worse, blend in — unrelated content from a different client's file. This reduces hallucination surface area and cross-contamination risk, which matters more than raw model quality in regulated document work.
- **Reusable rule layer.** Base Documents (ISA standards, statutory text, firm manuals) are uploaded once, versioned, and pinned into any number of Scopes, instead of being re-uploaded or pasted per engagement.
- **Operational visibility.** Ingestion of large, OCR-heavy batches is a first-class UI experience (per-file progress, not a spinner), because document-heavy teams onboard hundreds of files per engagement.

**Target audience.** Audit and assurance firms (ISA/GAAS-based engagements), corporate legal teams (statutes/case law vs. matter files), compliance functions (regulations vs. internal policy evidence), and research teams (canonical literature vs. project-specific working files).

### 1.2 Core Workflow

```mermaid
flowchart LR
    A[File Upload<br/>Drive UI] --> B[Ingestion Queue<br/>Redis/BullMQ]
    B --> C[Background Worker<br/>Parse / OCR]
    C --> D[Structural Chunking<br/>+ Metadata Mapping]
    D --> E[Embedding Generation]
    E --> F[(Vector DB<br/>pgvector / Qdrant)]
    F --> G[Scope Definition<br/>folders + docs + base docs]
    G --> H[Hybrid Retrieval<br/>Dense + BM25 + Re-rank]
    H --> I[LLM Generation<br/>w/ enforced citations]
    I --> J[Split-Pane Viewer<br/>coordinate-highlighted source]
    C -.SSE/WebSocket status.-> A
```

The ingestion path (A→F) and the query path (G→J) are decoupled: a document becomes queryable the moment it reaches `indexed`, independent of any specific chat session. A Scope is a saved *filter definition* over F, not a copy of the data.

### 1.3 Definitions & Domain Terminology

| Term | Definition |
|---|---|
| **Base / System Document** | An immutable, workspace- or org-wide reference document (ISA standard, statute, audit manual) that can be pinned into any Scope. Edits create a new version; the prior version is superseded, not overwritten. |
| **User / Engagement Document** | A tenant-uploaded, mutable file living in the Drive-style folder tree (ledger, scanned invoice, confirmation, trial balance). |
| **Scope** | A named, saved combination of folders, individual documents, and Base Documents that constrains retrieval for any chat session bound to it. |
| **Chunk** | A retrieval-sized slice of a document (target ~512–1024 tokens) with an embedding and structured metadata, optionally linked to a parent chunk for hierarchical context. |
| **Bounding Box** | The `{x, y, width, height, page}` coordinates (as fractions of page dimensions) locating a chunk's source text on a scanned page image, produced by the OCR layout engine. |
| **Dense Retrieval** | Similarity search over embedding vectors (semantic match). |
| **Sparse Retrieval** | Keyword-based search, typically BM25 over a tokenized/tsvector index (lexical match — catches exact terms like "ISA 505" that embeddings can under-weight). |
| **Hybrid Search** | Fusion of dense + sparse candidate sets (e.g., via Reciprocal Rank Fusion) before a cross-encoder re-ranks the merged set. |
| **Cross-Encoder Re-ranker** | A model that scores (query, chunk) pairs jointly for precision, applied to the top-N hybrid candidates before final selection — too expensive to run over the full corpus, cheap enough over ~50 candidates. |
| **Metadata Pre-filtering** | Restricting the vector index scan to rows whose metadata (`document_id ∈ scope's resolved set`) matches *before* similarity ranking, rather than filtering after — necessary for both correctness and latency at scale. |
| **Processing Lifecycle** | The state machine a document moves through after upload: `queued → extracting → chunking → embedding → indexed`, or `failed` at any stage. |

---

## 2. User Personas & Role-Based Access Control (RBAC)

### 2.1 Personas

- **Workspace Admin** — Owns billing, user provisioning, and workspace-wide settings. Typically a partner/IT lead. Cares about data isolation, audit logs, and cost control.
- **Senior Reviewer / Lead Auditor** — Defines Base Documents, builds and shares Scopes across an engagement team, reviews AI-generated answers against source before they're relied on. Cares about citation accuracy and being able to lock down what a junior can query against.
- **Staff Member** — Uploads engagement documents, runs queries inside Scopes they've been given access to, cannot alter Base Documents. Cares about fast ingestion and not losing work to a bad OCR pass.
- **Read-Only Client** — External party (e.g., an audit client, or opposing counsel in a legal context) given narrow, time-boxed access to a single Scope's chat interface for status/transparency purposes, with no upload or export rights.

### 2.2 Permissions Matrix

| Action | Workspace Admin | Senior Reviewer | Staff Member | Read-Only Client |
|---|---|---|---|---|
| Manage billing / workspace settings | ✅ | ❌ | ❌ | ❌ |
| Invite / remove users, assign roles | ✅ | ➕ (Staff only) | ❌ | ❌ |
| Upload / publish Base Documents | ✅ | ✅ | ❌ | ❌ |
| Version / supersede a Base Document | ✅ | ✅ | ❌ | ❌ |
| Create folders, upload engagement docs | ✅ | ✅ | ✅ | ❌ |
| Delete / move any document in workspace | ✅ | ✅ (own team's) | Own uploads only | ❌ |
| Create a Scope | ✅ | ✅ | ✅ (private by default) | ❌ |
| Edit / delete a Scope owned by another user | ✅ | ➕ (if shared to them as editor) | ❌ | ❌ |
| Share a Scope with other users | ✅ | ✅ | ✅ (own Scopes) | ❌ |
| Query chat within a Scope granted to them | ✅ | ✅ | ✅ | ✅ (single granted Scope) |
| View citation source / split-pane viewer | ✅ | ✅ | ✅ | ✅ |
| Export chat transcript / citations | ✅ | ✅ | ✅ | ❌ |
| View workspace audit log | ✅ | ➕ (own actions + team) | ❌ | ❌ |

`➕` = conditional, scoped to what the row's role owns or has been explicitly granted. Enforcement happens at three layers: API-gateway RBAC checks against `workspace_members.role`, PostgreSQL row-level security keyed on `workspace_id` (see §6.2 for the pooled-connection-safe implementation), and, for folder-scoped visibility specifically, the `folder_permissions` nearest-ancestor grant checked in FR-1.3.

---

## 3. Detailed Functional Modules & Requirements

### Module 1 — Workspace & Drive-Style Document Management

| ID | Requirement |
|---|---|
| FR-1.1 | The system shall support nested folders to a configurable maximum depth (default 15), scoped per workspace, with drag-and-drop move between arbitrary folders. |
| FR-1.2 | The UI shall render breadcrumb navigation reflecting the current folder's full ancestor path. |
| FR-1.3 | Search shall execute as an access-filtered query, not a filter applied after an unrestricted scan. Folder visibility is resolved by finding the *nearest ancestor* (the folder itself, or the closest ancestor folder that has an explicit entry) in the `folder_permissions` table for the requesting user or their workspace role; if no entry exists anywhere in the ancestor chain, visibility defaults to workspace-membership level. The search query joins against the caller's authorized folder set using an LTREE `path <@ authorized_path` predicate, never a post-fetch filter, so unauthorized folder content is never fetched from the database in the first place. |
| FR-1.4 | The system shall render an inline preview for PDF, image, DOCX, and spreadsheet files without requiring download. |
| FR-1.5 | Users shall be able to move or copy documents and folders; copy operations create a new `document_id` with a new `document_chunks` set (re-indexed, not shared) to keep citation lineage unambiguous. |
| FR-1.6 | The system shall maintain a **Base Document Registry**: any document can be flagged `is_base_document = true` at upload or promoted later. Publishing a new version of a Base Document creates a new row linked via `supersedes_doc_id`; the prior version becomes read-only and is retained (not deleted) so historical Scopes/citations remain reproducible. |
| FR-1.7 | Deleted items enter a trash state (`deleted_at` set) recoverable for a configurable retention window (default 30 days), after which a scheduled job hard-deletes the row, its chunks, and its object storage blob. |
| FR-1.8 | Batch operations (multi-select move, tag, delete, add-to-Scope) accept up to 500 document IDs per request. If the total touched entity count — including all descendants of any selected folder — exceeds 50, the operation is executed asynchronously via a `batch_jobs` row and a BullMQ job, returning `202 Accepted` with a tracking `batch_id` immediately. Batches at or under that threshold may execute synchronously but **must** complete within 1,500 ms; a synchronous handler that would exceed that budget shall instead fall back to the same async path rather than let the request run long. |
| FR-1.9 | Documents shall support free-form tags used for both search filtering and as an optional Scope-composition input. |
| FR-1.10 | Folder-level access grants (read/write/none, per user or per role) are stored in `folder_permissions` and inherited down the folder tree until overridden by a more specific descendant grant — see FR-1.3 for the resolution rule shared by search and browse. |

### Module 2 — Ingestion Pipeline & Real-Time Status Engine

| ID | Requirement |
|---|---|
| FR-2.1 | The system shall ingest: native-text PDF, scanned PDF/images (OCR path), Excel/CSV, DOCX, and web URLs. |
| FR-2.2 | Scanned PDFs/images shall be processed through a layout-aware OCR engine producing per-line/per-block text with bounding boxes. Acceptance is quantitative, not descriptive: **≥ 98% Character Recognition Accuracy** on 300 DPI standard text (measured against a held-out labeled test set as part of CI), and detected tables shall preserve row/column adjacency such that a financial table's cell-to-cell relationships survive extraction — table detection confidence below a configured threshold routes the page to manual-review flagging rather than silently emitting misaligned text. |
| FR-2.3 | Excel/CSV ingestion shall preserve sheet name, row/column position, and — where a cell contains a formula — both the formula string and its last computed value, so a chunk can be traced to `sheet + row_range + column_range`. |
| FR-2.4 | Web URL ingestion shall run through a headless-browser fetch service with strict egress controls: requests to RFC 1918 private ranges, link-local addresses (including `169.254.169.254`), and `localhost`/loopback are blocked at the network layer before the fetch is attempted (SSRF prevention). Content extraction isolates the `<main>`/`<article>` DOM subtree, strips `<script>`/`<style>` tags, enforces a 15-second render timeout and a 10 MB rendered-DOM size cap, and stores a rendered screenshot as a fallback source-of-truth for citation display when structured extraction fails or the page is a dynamic SPA. |
| FR-2.5 | Upload shall enqueue a job and return immediately (HTTP 202); all parsing/OCR/embedding work happens in background workers (default: Redis + BullMQ, horizontally scalable by queue name) so the API is never blocked on document size. |
| FR-2.6 | Each document shall expose a `processing_status` transitioning strictly through `queued → extracting → chunking → embedding → indexed`, or into `failed` from any state, with `processing_error` populated on failure. |
| FR-2.7 | The Drive UI shall reflect status changes in real time via an SSE stream (primary) or WebSocket (workspace-wide fan-out for bulk uploads), updating the file's thumbnail/card without a page refresh. |
| FR-2.8 | Failed jobs shall be retried automatically up to 3 times with exponential backoff; after exhausting retries the job moves to a dead-letter queue and the document surfaces a "Failed — Retry" affordance for manual re-trigger. |
| FR-2.9 | Ingestion admission (OCR pages/minute, embedding calls/minute) is metered per workspace against the limits in §6.6 at the point a job is dequeued for processing, not just at upload. A workspace over its limit has new jobs held in `queued` (not rejected) and existing in-flight jobs unaffected, so one tenant's large batch upload cannot starve another tenant's worker capacity — enforced via weighted fair-share scheduling across per-workspace queue partitions. |

### Module 3 — RAG Processing, Chunking & Vectorization Engine

| ID | Requirement |
|---|---|
| FR-3.1 | Chunking shall be structure-aware and deterministic per file type. PDFs/DOCX/OCR text split strictly on paragraph breaks (`\n\n`) or, within an over-long paragraph, on terminal punctuation followed by whitespace (`[.!?]\s+`) — never inside a word — targeting **512 ± 64 tokens** per chunk. Spreadsheets chunk by logical row-groups bounded to the same token target, with the header row prepended to every chunk for column context, and a row-group boundary is never placed inside what the parser identifies as a single logical table row. These are pass/fail-testable boundaries, not stylistic guidance, so chunking output is covered by automated boundary-integrity tests in CI. |
| FR-3.2 | The system shall use a parent–child chunking pattern: small child chunks (~400–600 tokens) are embedded and retrieved for precision, but each carries `parent_chunk_id` pointing to a larger (~1500–2000 token) parent used to expand context before generation, with a 10–15% overlap between siblings to avoid boundary information loss. |
| FR-3.3 | Every chunk shall persist the metadata payload defined in §4.2 at write time — not computed on read — so filtering is a single indexed lookup. |
| FR-3.4 | The embedding provider shall be abstracted behind an internal interface (`EmbeddingProvider.embed(text) -> vector`) so the model can be swapped without a schema migration, provided dimensionality is fixed per deployment. |
| FR-3.5 | Vectors shall be stored in PostgreSQL via `pgvector` (default choice for this SRS, given the rest of the schema is already relational — see §6 trade-off note) using an **HNSW** index (`m=16, ef_construction=64` defaults) for approximate nearest-neighbor search; IVFFlat is retained as a documented fallback for workspaces with very large (>10M chunk) corpora where HNSW memory footprint becomes prohibitive. |
| FR-3.6 | Re-uploading or superseding a document triggers full re-chunking and re-embedding of that document only; existing chunks are deleted transactionally with the new set's insert (never left orphaned mid-update). |

### Module 4 — Dynamic Scoping Engine

| ID | Requirement |
|---|---|
| FR-4.1 | Users shall be able to create, rename, edit membership of, share, and archive Scopes. |
| FR-4.2 | A Scope's resolved document set is the union of: (a) explicitly added individual documents, (b) all documents under explicitly added folders (recursively, if `include_subtree = true`), and (c) explicitly added Base Documents. This set is materialized into `scope_resolved_documents` (§4.3) rather than recomputed live per query — see FR-4.6 for how it is kept current as folders and documents change, so a newly uploaded file into an included folder becomes queryable within the propagation window rather than instantly. |
| FR-4.3 | A Scope is private to its owner by default; owners may share it read-only or edit-capable with specific users or the whole workspace. |
| FR-4.4 | At query time, retrieval filters via an **indexed join against the materialized `scope_resolved_documents` table** (`JOIN scope_resolved_documents srd ON dc.document_id = srd.document_id WHERE srd.scope_id = ANY($scope_ids)`), never by injecting a large, per-query array of *document* IDs into a `WHERE document_id = ANY($1)` predicate. The array parameter passed is the small set of bound *Scope* IDs (typically 1–5), not the resolved document set (which can run into the thousands) — this keeps the query planner on a stable, indexed nested-loop/hash-join path regardless of how large a Scope's resolved membership grows. See §4.3 for how `scope_resolved_documents` is kept current. |
| FR-4.5 | Each chat session snapshots the Scope IDs bound at session start (`chat_sessions.scope_ids`) so that if a Scope's membership changes later, past sessions still display which Scope *definition* produced a given answer — full reproducibility requires also recording the resolved document ID set at query time in `chat_messages.retrieval_debug` (see §4.3). |
| FR-4.6 | `scope_resolved_documents` shall be kept current by: (a) synchronous recomputation on scope edit (add/remove folder, document, or Base Document) for scopes under 1,000 resolved documents; (b) an async recompute job for larger scopes; and (c) an incremental update triggered off document lifecycle events (upload, move, delete) that checks which scopes have a `scope_folders` entry whose path is an ancestor of the affected document's folder, upserting or deleting the corresponding row rather than recomputing the whole scope. This introduces a bounded propagation delay (target: median < 5s) between "file lands in a scoped folder" and "file is queryable in that Scope" — see §6.3 for the consistency trade-off this accepts. |

### Module 5 — Chat & Knowledge Retrieval Interface

| ID | Requirement |
|---|---|
| FR-5.1 | The chat interface shall require at least one Scope to be bound before a query can be submitted; multiple Scopes may be bound simultaneously (their resolved document sets are unioned). |
| FR-5.2 | Retrieval shall run dense (vector cosine similarity) and sparse (Postgres `tsvector`/BM25-equivalent) search in parallel over the pre-filtered candidate set, fuse results via Reciprocal Rank Fusion, then re-rank the top ~50 fused candidates with a cross-encoder down to the top-K (default 6–8) passed to the LLM. |
| FR-5.3 | Grounding is enforced against a quantitative gate, not a qualitative one. After re-ranking, if the top candidate's cross-encoder score is below an **absolute threshold (default 0.65 on the model's normalized [0,1] score range)**, generation shall not proceed against fabricated context: the API returns `{"no_grounding_found": true}` and a fixed refusal message rather than falling back to un-grounded model knowledge. When generation does proceed, a post-hoc citation-checking pass computes a **faithfulness score** (fraction of factual sentences whose claim is entailed by the span of its cited chunk, via automated citation-span validation) and the response is only released to the user if that score is **≥ 0.90**; below that, the pipeline retries generation once with a tightened prompt before falling back to the refusal path. *Implementation note:* 0.65 is a starting point, not a universal constant — cross-encoder score distributions vary by model, so the threshold must be calibrated per deployment against a held-out labeled query set before launch. |
| FR-5.4 | Clicking a citation shall open a split-pane viewer: left pane keeps the chat, right pane renders the source document at the cited page/sheet with the exact bounding box or row range highlighted, auto-scrolled into view. |
| FR-5.5 | Chat sessions and every message (with its citations) persist for audit trail and re-review; export to PDF/DOCX of a session including citations is supported for users with export rights (§2.2). |
| FR-5.6 | LLM token consumption is metered per workspace against the limits in §6.6 *before* a generation request is dispatched to the upstream provider. A request that would exceed the workspace's rolling-window budget is rejected with `429 Too Many Requests` and a `Retry-After` header rather than silently queued behind other tenants' traffic — chat is a synchronous, user-facing path, so backpressure here is surfaced immediately rather than absorbed the way ingestion backpressure is (FR-2.9). |

---

## 4. Data Models & Database Schema

### 4.1 PostgreSQL DDL

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";   -- pgvector
CREATE EXTENSION IF NOT EXISTS "ltree";    -- materialized folder paths
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================
-- Tenancy & Identity
-- ============================================================

CREATE TABLE workspaces (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    plan_tier       VARCHAR(50)  NOT NULL DEFAULT 'starter',
    settings        JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE TYPE user_role AS ENUM (
    'workspace_admin', 'senior_reviewer', 'staff_member', 'read_only_client'
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           CITEXT       NOT NULL UNIQUE,
    full_name       VARCHAR(255) NOT NULL,
    password_hash   TEXT,
    sso_subject_id  TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE TABLE workspace_members (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            user_role NOT NULL DEFAULT 'staff_member',
    invited_by      UUID REFERENCES users(id),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- ============================================================
-- Drive-Style File System
-- ============================================================

CREATE TABLE folders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES folders(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    path            LTREE NOT NULL,               -- e.g. 'root.engagements.tfl_2026'
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (workspace_id, parent_id, name)
);
CREATE INDEX idx_folders_path      ON folders USING GIST (path);
CREATE INDEX idx_folders_workspace ON folders (workspace_id) WHERE deleted_at IS NULL;

-- Nearest-ancestor folder ACL (FR-1.3, FR-1.10). A row may target a user OR a role, not both.
CREATE TABLE folder_permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    folder_id       UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    role            user_role,
    access_level    VARCHAR(10) NOT NULL DEFAULT 'read',   -- 'none' | 'read' | 'write'
    granted_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((user_id IS NOT NULL) <> (role IS NOT NULL)),   -- exactly one of user_id / role
    CHECK (access_level IN ('none', 'read', 'write'))
);
CREATE INDEX idx_folder_perms_folder ON folder_permissions (folder_id);
CREATE INDEX idx_folder_perms_user   ON folder_permissions (user_id) WHERE user_id IS NOT NULL;
-- Nearest-ancestor lookup for a given path: join folders on `path @> $requested_path`,
-- filter to rows with a folder_permissions match, order by nlevel(path) DESC, take 1.

CREATE TYPE processing_status AS ENUM (
    'queued', 'extracting', 'chunking', 'embedding', 'indexed', 'failed'
);

CREATE TYPE document_source_type AS ENUM (
    'pdf_native', 'pdf_scanned', 'image', 'excel', 'csv', 'docx', 'web_url'
);

CREATE TABLE documents (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    folder_id           UUID REFERENCES folders(id) ON DELETE SET NULL,
    is_base_document    BOOLEAN NOT NULL DEFAULT false,
    base_doc_category   VARCHAR(100),                 -- 'ISA', 'Statute', 'Firm Manual', ...
    supersedes_doc_id   UUID REFERENCES documents(id), -- Base Doc version lineage
    title               VARCHAR(500) NOT NULL,
    source_type         document_source_type NOT NULL,
    original_filename   VARCHAR(500) NOT NULL,
    storage_uri         TEXT NOT NULL,                -- S3/GCS object key
    file_size_bytes     BIGINT,
    mime_type           VARCHAR(150),
    checksum_sha256     CHAR(64),
    processing_status   processing_status NOT NULL DEFAULT 'queued',
    processing_error    TEXT,
    tags                TEXT[] NOT NULL DEFAULT '{}',
    page_count          INTEGER,
    uploaded_by         UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,                  -- trash
    purge_at            TIMESTAMPTZ                   -- hard-delete schedule
);
CREATE INDEX idx_documents_workspace_folder ON documents (workspace_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_base             ON documents (workspace_id) WHERE is_base_document = true AND deleted_at IS NULL;
CREATE INDEX idx_documents_status           ON documents (processing_status);
CREATE INDEX idx_documents_tags             ON documents USING GIN (tags);

-- Tracks async batch operations (FR-1.8) so the UI can poll/subscribe like it does for ingestion.
CREATE TYPE batch_operation_type AS ENUM ('move', 'tag', 'delete', 'add_to_scope');
CREATE TYPE batch_job_status AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE batch_jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    initiated_by    UUID NOT NULL REFERENCES users(id),
    operation_type  batch_operation_type NOT NULL,
    status          batch_job_status NOT NULL DEFAULT 'queued',
    total_items     INTEGER NOT NULL,
    processed_items INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);
CREATE INDEX idx_batch_jobs_workspace ON batch_jobs (workspace_id, status);

CREATE TABLE document_chunks (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_chunk_id   UUID REFERENCES document_chunks(id),   -- parent–child chunking (FR-3.2)
    chunk_index       INTEGER NOT NULL,
    content           TEXT NOT NULL,
    token_count       INTEGER,
    embedding         VECTOR(1536),                          -- match embedding model dims
    metadata          JSONB NOT NULL DEFAULT '{}',
    content_tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chunk_index)
);
CREATE INDEX idx_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_workspace ON document_chunks (workspace_id);
CREATE INDEX idx_chunks_metadata  ON document_chunks USING GIN (metadata jsonb_path_ops);
CREATE INDEX idx_chunks_tsv       ON document_chunks USING GIN (content_tsv);

-- ============================================================
-- Dynamic Scoping Engine
-- ============================================================

CREATE TABLE scopes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        UUID NOT NULL REFERENCES users(id),
    is_shared       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at     TIMESTAMPTZ
);

CREATE TABLE scope_documents (
    scope_id        UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, document_id)
);

CREATE TABLE scope_folders (
    scope_id         UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    folder_id        UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    include_subtree  BOOLEAN NOT NULL DEFAULT true,
    added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, folder_id)
);

CREATE TABLE scope_shares (
    scope_id        UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_edit        BOOLEAN NOT NULL DEFAULT false,
    shared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, user_id)
);

-- Materialized Scope membership (FR-4.4, FR-4.6). This is what retrieval joins against —
-- never a live folder-tree walk, and never a per-query array of document IDs.
CREATE TABLE scope_resolved_documents (
    scope_id        UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, document_id)
);
CREATE INDEX idx_scope_resolved_by_scope    ON scope_resolved_documents (scope_id);
CREATE INDEX idx_scope_resolved_by_document ON scope_resolved_documents (document_id);

-- ============================================================
-- Rate Limiting & Cost Control (§6.6)
-- ============================================================

-- Per-workspace, per-resource rolling-window usage counters, backed by Redis token
-- buckets at request time; this table is the durable/reportable side (usage history,
-- billing reconciliation), not the enforcement hot path.
CREATE TABLE workspace_rate_limits (
    workspace_id        UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    ocr_pages_per_min    INTEGER NOT NULL DEFAULT 200,
    embedding_calls_per_min INTEGER NOT NULL DEFAULT 500,
    llm_tokens_per_hour  INTEGER NOT NULL DEFAULT 200000,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_usage_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    resource        VARCHAR(20) NOT NULL,   -- 'ocr_page' | 'embedding_call' | 'llm_tokens'
    quantity        INTEGER NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_events_workspace_time ON workspace_usage_events (workspace_id, occurred_at);

-- ============================================================
-- Chat & Retrieval
-- ============================================================

CREATE TABLE chat_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    title           VARCHAR(255),
    scope_ids       UUID[] NOT NULL DEFAULT '{}',   -- snapshot at session start, FR-4.5
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

CREATE TABLE chat_messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role            message_role NOT NULL,
    content         TEXT NOT NULL,
    retrieval_debug JSONB,          -- resolved doc IDs, candidate chunk IDs, fusion/rerank scores
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_message_citations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id      UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    chunk_id        UUID NOT NULL REFERENCES document_chunks(id),
    document_id     UUID NOT NULL REFERENCES documents(id),
    citation_label  VARCHAR(10),     -- '[1]', '[2]', ...
    page_number     INTEGER,
    sheet_name      VARCHAR(255),
    row_reference    VARCHAR(50),
    bounding_box    JSONB,           -- {x, y, width, height, page}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_citations_message ON chat_message_citations (message_id);
```

**Trade-off note (pgvector vs. Qdrant):** this schema commits to `pgvector` so folder/document/chunk relational integrity and vector search share one transactional database — simpler consistency (§6.3) at the cost of scaling ceiling. A workspace whose corpus grows past the HNSW-in-Postgres comfort zone (rule of thumb: tens of millions of chunks, or a need for sharded/replicated vector-only scaling) is the trigger to introduce Qdrant as an external vector store, at which point `document_chunks.embedding` becomes a thin pointer (`qdrant_point_id`) and metadata pre-filtering (FR-4.4) moves into Qdrant's native payload filtering — the `metadata` JSONB shape in §4.2 is designed to be portable to that filter syntax unchanged.

### 4.2 Vector Chunk Metadata Payload

Stored in `document_chunks.metadata` (and mirrored into the external vector store's payload if/when Qdrant is introduced):

```json
{
  "chunk_id": "d2f1a9b0-...",
  "document_id": "9c3e21af-...",
  "workspace_id": "6b0a77e4-...",
  "is_base_document": false,
  "base_doc_category": null,
  "folder_path": "root.engagements.tfl_2026.bank_confirmations",
  "source_type": "pdf_scanned",
  "document_title": "TFL Related Party Loan Confirmation.pdf",
  "page_number": 2,
  "sheet_name": null,
  "row_range": null,
  "column_range": null,
  "bounding_box": { "x": 0.11, "y": 0.42, "width": 0.61, "height": 0.05, "page": 2 },
  "section_heading": "Confirmation of Outstanding Balance",
  "chunk_index": 3,
  "parent_chunk_id": "a77c... | null",
  "tags": ["bank-confirmation", "related-party"],
  "document_version": 1,
  "created_at": "2026-08-30T10:00:00Z"
}
```

### 4.3 Scope Resolution at Scale

The original design resolved a Scope's document membership at query time by walking `scope_folders` recursively and passing the resulting document ID array into `WHERE document_id = ANY($1)`. That degenerates badly the moment a Scope covers a large folder tree: a 20,000-document array bloats the query plan, defeats index usage, and pushes Postgres toward a sequential/bitmap scan instead of an index-backed lookup — exactly backwards for a query path with an 800ms P95 target (§6.1).

The fix is to **materialize** membership instead of recomputing it per query:

- `scope_resolved_documents` (schema in §4.1) is the flattened, indexed membership table. Retrieval always joins against it — `JOIN scope_resolved_documents srd ON dc.document_id = srd.document_id WHERE srd.scope_id = ANY($scope_ids)` — where the parameter array is the small set of *Scopes* bound to the session, not the (potentially huge) set of resolved documents.
- Membership is kept current per FR-4.6: synchronous recompute on edit for small Scopes, async recompute for large ones, and incremental upsert/delete driven by document lifecycle events (upload, move, delete) matched against `scope_folders` via LTREE ancestor checks.
- This trades strict real-time resolution for a bounded propagation delay (target median < 5s). That trade-off is deliberate and is the same shape of eventual-consistency accepted for the Qdrant migration path in §6.3 — it's called out explicitly rather than left implicit, since "a file I just uploaded doesn't show up in chat for a few seconds" is a materially different failure mode than "the query timed out" and reviewers should be able to evaluate it on its own terms.

---

## 5. API Endpoints & Event Contracts

### 5.1 Document Upload

`POST /api/v1/documents/upload` — `multipart/form-data`

Fields: `file` (binary), `folder_id` (nullable UUID), `is_base_document` (bool, default false), `base_doc_category` (string, required if base doc), `tags[]` (string array).

Response `202 Accepted`:
```json
{
  "document_id": "9c3e21af-...",
  "status": "queued",
  "created_at": "2026-08-30T10:00:00Z"
}
```

### 5.2 Processing Status (poll)

`GET /api/v1/documents/{id}/status`

Response `200 OK`:
```json
{
  "document_id": "9c3e21af-...",
  "status": "chunking",
  "progress_pct": 62,
  "stages_completed": ["queued", "extracting"],
  "current_stage": "chunking",
  "error": null,
  "updated_at": "2026-08-30T10:02:15Z"
}
```

### 5.3 Processing Status (stream)

`GET /api/v1/documents/{id}/events` — `text/event-stream`

```
event: status_update
data: {"document_id":"9c3e21af-...","status":"embedding","progress_pct":88}

event: status_update
data: {"document_id":"9c3e21af-...","status":"indexed","progress_pct":100}

event: error
data: {"document_id":"9c3e21af-...","status":"failed","error":"OCR timeout on page 34","retryable":true}
```

For bulk uploads, the Drive UI instead subscribes once to a workspace-wide WebSocket channel (`wss://api/.../ws/workspaces/{workspace_id}/documents`) carrying the same `status_update` payload shape tagged per `document_id`, so N simultaneous uploads update N thumbnails over one connection.

### 5.4 Scope Management

`POST /api/v1/scopes`
```json
{
  "name": "Bank Audit 2026 - Loans Verification",
  "description": "Loan confirmations plus ISA 505/540 guidance",
  "folder_ids": ["3f1c..."],
  "document_ids": ["9c3e21af-...", "b7e0..."],
  "base_document_ids": ["isa-505-uuid", "isa-540-uuid"],
  "is_shared": true
}
```
Response `201 Created`:
```json
{
  "scope_id": "7a90...",
  "name": "Bank Audit 2026 - Loans Verification",
  "resolved_document_count": 47,
  "created_at": "2026-08-30T10:05:00Z"
}
```

`GET /api/v1/scopes/{id}` returns the same shape plus the fully resolved document list. `PATCH /api/v1/scopes/{id}` accepts a partial body of the same fields. `DELETE /api/v1/scopes/{id}` sets `archived_at` (soft-archive; past chat sessions retain their `scope_ids` snapshot regardless).

### 5.5 Scoped RAG Query

`POST /api/v1/chat/completions`
```json
{
  "session_id": null,
  "scope_ids": ["7a90..."],
  "message": "What does ISA 505 require for loan confirmations, and do we have signed confirmations for TFL's related-party loans?",
  "stream": true,
  "retrieval_options": { "top_k": 12, "rerank_top_k": 6, "hybrid_alpha": 0.5 }
}
```

Streamed response (`text/event-stream`):
```
event: token
data: {"delta":"ISA 505 requires the auditor to..."}

event: citation
data: {"label":"[1]","document_id":"isa-505-uuid","page_number":4}

event: done
data: {
  "message_id": "f1a0...",
  "session_id": "88bd...",
  "citations": [
    {"label":"[1]","document_id":"isa-505-uuid","document_title":"ISA 505","page_number":4},
    {"label":"[2]","document_id":"9c3e21af-...","document_title":"TFL Related Party Loan Confirmation.pdf","page_number":2,"bounding_box":{"x":0.11,"y":0.42,"width":0.61,"height":0.05}}
  ],
  "no_grounding_found": false
}
```

When `stream: false`, the same `done` payload plus a fully assembled `answer` string is returned synchronously as `200 OK`. If retrieval finds nothing sufficiently relevant within the bound Scope(s), `no_grounding_found: true` is set and `answer` is a fixed refusal-to-fabricate message rather than a model-knowledge fallback (FR-5.3).

Any request rejected by the per-workspace rate limiter (§6.6) — including this endpoint — returns:
```json
// 429 Too Many Requests
// Retry-After: 12
{
  "error": "rate_limit_exceeded",
  "resource": "llm_tokens",
  "limit_per_window": 200000,
  "window": "1h",
  "retry_after_seconds": 12
}
```

### 5.6 Batch Operations

`POST /api/v1/documents/batch`
```json
{
  "operation": "move",
  "document_ids": ["9c3e21af-...", "b7e0..."],
  "folder_ids": ["3f1c..."],
  "target_folder_id": "7d2e..."
}
```
Per FR-1.8: if the total touched-entity count (documents plus recursive folder contents) is ≤ 50, the server may complete the operation inline and return `200 OK` with a result summary — but must do so within 1,500 ms or fall back to the async path below. Above that threshold, or on timeout, the response is:

`202 Accepted`
```json
{ "batch_id": "e51a...", "status": "queued", "total_items": 340 }
```

`GET /api/v1/batch-jobs/{batch_id}`
```json
{
  "batch_id": "e51a...",
  "status": "running",
  "total_items": 340,
  "processed_items": 210,
  "error": null
}
```

---

## 6. Non-Functional Requirements

### 6.1 Performance & Concurrency
- P95 hybrid-search-to-first-token latency: **< 800 ms** for corpora up to 2M chunks per workspace.
- Ingestion throughput: **≥ 40 pages/minute per worker** for OCR-path documents (native-text PDFs are materially faster); worker pool autoscales horizontally by queue depth.
- Batch upload: UI supports **≥ 200 files per batch**, each tracked independently in the status stream.
- Chat concurrency: a single workspace shall support **≥ 50 concurrent active sessions** without P95 degradation beyond the above targets.

### 6.2 Multi-Tenant Isolation & Encryption
- Every tenant-scoped table carries `workspace_id`, enforced by PostgreSQL Row-Level Security as a second line of defense behind API-level RBAC — but the naive form of this (`current_setting('app.current_workspace')` set via a session-level `SET`) is **unsafe under connection pooling**: in PgBouncer transaction-pooling mode, a physical connection is handed to a different client between transactions, and a session-level `SET` persists on that connection unless explicitly reset — which is exactly how one tenant's session variable leaks into another tenant's query.
- The fix: the workspace context is set with **`SET LOCAL app.current_workspace = :workspace_id`**, issued only inside an explicit `BEGIN ... COMMIT` transaction block that wraps the request handler. `SET LOCAL` is transaction-scoped by Postgres semantics — it cannot outlive the transaction, so there is no reset-forgetting failure mode to guard against, and it is safe under transaction-mode pooling by construction rather than by discipline.
- This is a release-blocking control, not a documentation note: automated cross-tenant integration tests run against a PgBouncer-pooled connection specifically (not a direct connection) and assert that Workspace A's session can never read a row scoped to Workspace B, before any release is considered RLS-compliant.
- Encryption at rest: AES-256 for the database and object storage (source files); encryption in transit: TLS 1.2+ everywhere, including internal worker-to-database traffic.
- Base Document immutability (FR-1.6) is enforced at the application layer (no `UPDATE` path exposed on a published Base Document row) and reinforced with a database trigger rejecting `UPDATE`/`DELETE` on rows where `is_base_document = true AND published_at IS NOT NULL`.

### 6.3 Data Consistency Between Relational State and Vector Index
- Because chunks and vectors live in the same Postgres instance (§4.1 trade-off), document deletion, folder moves, and re-indexing are single-transaction operations — no eventual-consistency window between "file no longer visible in Drive" and "file no longer retrievable in chat."
- Scope membership is the one deliberate exception to that same-transaction guarantee: `scope_resolved_documents` (§4.3) is a materialized, incrementally-refreshed table rather than something recomputed inline on every write, which trades strict immediacy for query-time scalability (FR-4.4). The accepted propagation delay (target median < 5s) is bounded and monitored, not open-ended.
- If/when an external vector store (Qdrant) is introduced, consistency shifts to a transactional-outbox pattern: writes to `documents`/`document_chunks` also insert an `outbox_events` row in the same transaction; a relay process applies it to Qdrant and a periodic reconciliation sweep diffs the two stores to catch drift.

### 6.4 Availability & Reliability
- Target **99.9%** monthly availability for the query path; ingestion path may degrade to queued-but-delayed under load without violating availability (asynchronous by design).
- Automated daily backups with **RPO ≤ 24h / RTO ≤ 4h**; point-in-time recovery enabled on the primary database.

### 6.5 Observability
- Every chat message persists `retrieval_debug` (candidate IDs, fusion scores, re-rank scores) to make retrieval quality auditable after the fact, not just the final answer.
- Structured logs for every processing-status transition, keyed by `document_id`, feeding both the real-time UI stream and a durable audit trail for compliance review.

### 6.6 Rate Limiting & Cost Control
- Every workspace has per-resource limits (`workspace_rate_limits`, §4.1) covering the three cost/contention surfaces identified in the architecture review: OCR pages/minute (default 200), embedding calls/minute (default 500), and LLM tokens/hour (default 200,000) — all configurable per `plan_tier`.
- Enforcement is a **Redis-backed token bucket** checked at the point of admission: for ingestion, when a job is dequeued for processing (FR-2.9); for chat, before a generation request is dispatched upstream (FR-5.6). Ingestion backpressure holds jobs in `queued` (the async ingestion UX already tolerates delay); chat backpressure returns `429` immediately, since a synchronous user-facing request should never be silently stalled behind another tenant's load.
- **Noisy-neighbor isolation**: the BullMQ ingestion queue is partitioned per workspace with weighted fair-share scheduling, so one tenant's 10,000-file batch upload cannot starve another tenant's single-file ingestion — both make forward progress, proportionally, rather than strict FIFO across tenants.
- `workspace_usage_events` provides the durable record for billing reconciliation and for alerting: sustained proximity to a limit (e.g., >90% of the hourly LLM token budget for 3 consecutive hours) triggers a workspace-admin notification, distinct from the hard `429`/queue-hold enforced at the limit itself.

---

## 7. Phased Implementation Roadmap

**Phase 1 — MVP**
Drive UI (folders, upload, preview) with `folder_permissions`-based authorization; native-text and scanned-PDF ingestion with basic OCR; Excel/CSV parsing; Base Document Registry with versioning; Scope Builder backed by materialized `scope_resolved_documents`; Scoped RAG chat with hybrid search, enforced citation thresholds, and per-workspace rate limiting; non-real-time (polling) processing status. The §6.2/§6.6 hardening items (pool-safe RLS, rate limits) are foundational, not deferrable — they ship with MVP rather than being retrofitted after the first tenant onboards.

**Phase 2 — Live Processing & Verification**
WebSocket/SSE-driven live thumbnails replacing polling; bounding-box-accurate split-pane viewer for OCR'd documents; batch upload/move/tag operations; retry/dead-letter handling surfaced in the UI; cross-encoder re-ranking added to the retrieval pipeline (Phase 1 may ship hybrid-only without re-ranking as a reduced-scope MVP).

**Phase 3 — Enterprise & Compliance**
Cross-workspace/enterprise collaboration controls; multi-Scope side-by-side comparison in chat (query two Scopes and diff the grounded answers); automated compliance/audit report generation that assembles a document from a set of prior chat sessions with their citation trails intact; external vector-store migration path (Qdrant) for workspaces exceeding the pgvector scaling ceiling noted in §4.1.
