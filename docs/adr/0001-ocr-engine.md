# ADR 0001 — OCR Engine Selection

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-22 |
| Deciders | Engineering team |
| Technical area | Ingestion Pipeline (SRS Module 2, FR-2.2) |

## Context

FR-2.2 requires processing scanned PDFs and images through a layout-aware OCR engine that:
- Produces per-line/per-block bounding boxes (`{x, y, width, height, page}` as fractions of page dimensions)
- Meets a **≥ 98% Character Recognition Accuracy (CRA)** bar on 300 DPI standard text, measured against a held-out labeled test set in CI
- Preserves row/column adjacency in financial tables; routes low-confidence table regions to manual-review flagging rather than emitting misaligned text

Three engines were evaluated:

| Engine | CRA (300 DPI typeset) | Bounding boxes | Cost | Data egress | Binary dep |
|---|---|---|---|---|---|
| **Tesseract v5 LSTM** | ≥ 98% on clean typeset | hOCR per-word/block | Free | None | WASM via tesseract.js |
| AWS Textract | ≥ 99% incl. handwriting | Native block-level | ~$0.0015/page | All docs sent to AWS | None (API) |
| Azure Document Intelligence | ≥ 99% incl. forms | Native paragraph/table | ~$0.001/page | All docs sent to Azure | None (API) |

## Decision

**Tesseract v5 (LSTM engine, `--oem 1`) via `tesseract.js` (WASM, no system binary required)**

### Rationale

1. **Cost**: Zero per-page cost. At ≥ 40 pages/minute throughput target (SRS §6.1) across a multi-tenant SaaS, cloud OCR costs accumulate rapidly at scale.
2. **Data isolation**: Documents never leave the deployment boundary — critical for audit firms handling confidential client files.
3. **CRA compliance**: On 300 DPI clean typeset documents (the defined acceptance bar), Tesseract v5 LSTM consistently exceeds 98% CRA. The target corpus — bank confirmations, ISA standards, firm manuals, statutory text — is predominantly clean typeset.
4. **Provider abstraction**: The parser interface (`OcrProvider.recognize(imageBuffer) → OcrResult`) is kept behind an internal abstraction, making engine substitution a one-file change.

### Accepted limitations

- CRA drops below 98% on: handwritten text, poor-quality photocopies (< 200 DPI effective), heavily distorted scans, and non-Latin scripts not covered by the loaded language pack.
- Table structure detection is heuristic (hOCR whitespace/grid analysis) rather than native — complex multi-column financial tables may require manual review flagging more often than cloud engines would.
- WASM cold-start adds ~2–4 seconds on first job in a worker instance (negligible for async ingestion).

### Stop condition (preserved from SRS Phase 3 prompt)

> If Tesseract cannot hit 98% CRA on the specific document corpus in production testing, this is a spec parameter to renegotiate — not to silently lower. Switch trigger: corpus-level CRA measurement in CI (against a held-out labeled test set) falls below 98% for two consecutive weekly runs.

## Upgrade path

If the stop condition is triggered:
1. Swap `src/parsers/pdf-ocr.ts` implementation to call AWS Textract (`@aws-sdk/client-textract`) or Azure DI (`@azure/ai-form-recognizer`) — the `OcrResult` shape is the same.
2. Add `TEXTRACT_REGION` / `AZURE_DI_ENDPOINT` to `.env.example` and worker config.
3. Update `workspace_rate_limits.ocr_pages_per_min` semantics to account for cloud API rate limits (external, not internal throughput).
4. Re-run CI accuracy gate against the labeled test set to confirm ≥ 98% before deploying.

## Consequences

- CI must include an accuracy gate test running Tesseract against a small labeled fixture set (target: representative 5–10 page fixture at 300 DPI covering printed text and a financial table).
- Worker Dockerfile must install `tesseract` language data files for `eng` (and any additional languages required by customers) at image build time rather than downloading at runtime, to avoid cold-start delays and network dependencies.
- `tesseract.js` WASM worker is initialized once per Node.js process and reused across jobs (not spawned per job).
