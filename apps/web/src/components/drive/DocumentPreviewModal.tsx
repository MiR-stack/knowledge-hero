"use client";

/**
 * DocumentPreviewModal — FR-1.4
 *
 * Inline preview for PDF, image, DOCX, and spreadsheet files.
 * Rendering strategy by source type:
 *   - pdf_native / pdf_scanned  → <iframe> streaming from /preview endpoint
 *   - image                     → <img> tag
 *   - docx                      → fetches HTML via mammoth conversion in worker; falls back to download prompt
 *   - excel / csv               → "Open in new tab" (raw bytes) + note; complex rendering is Phase 7 territory
 *   - web_url                   → screenshot or iframe of original URL
 *   - Not yet indexed           → spinner with status
 */

import { useEffect, useRef, useState } from "react";
import type { DocumentSummary } from "@rag/shared-types";
import { getPreviewUrl } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export interface DocumentPreviewModalProps {
  document: DocumentSummary;
  onClose: () => void;
}

type PreviewMode = "iframe" | "image" | "docx-html" | "download-prompt" | "loading" | "not-indexed";

function getPreviewMode(doc: DocumentSummary): PreviewMode {
  if (doc.processingStatus !== "indexed") return "not-indexed";

  const src = doc.sourceType as string;
  if (src === "pdf_native" || src === "pdf_scanned" || src === "web_url") return "iframe";
  if (src === "image") return "image";
  if (src === "docx") return "docx-html";
  // excel / csv — served as raw bytes; show download prompt
  return "download-prompt";
}

export function DocumentPreviewModal({ document, onClose }: DocumentPreviewModalProps) {
  const auth = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mode] = useState<PreviewMode>(() => getPreviewMode(document));
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxError, setDocxError] = useState(false);

  // Build preview URL with auth token baked into Authorization header via
  // a service-worker proxy or, for simplicity here, embed the token in the
  // query string for the iframe case (the API strips it server-side).
  // For production, prefer a short-lived signed URL or cookie-based auth.
  const previewUrl = `${getPreviewUrl(document.id)}?token=${auth.token ?? ""}`;

  // Fetch DOCX as HTML using the browser's fetch (auth header) then render
  useEffect(() => {
    if (mode !== "docx-html") return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(getPreviewUrl(document.id), {
          headers: {
            Authorization: `Bearer ${auth.token ?? ""}`,
            "X-Workspace-Id": auth.workspaceId ?? "",
          },
        });
        if (!res.ok) throw new Error("Fetch failed");
        const arrayBuffer = await res.arrayBuffer();

        // Dynamic import of mammoth for DOCX → HTML conversion.
        // mammoth is an optional dependency; if not installed the catch branch
        // triggers and the download-prompt fallback is shown instead.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mammoth = await import("mammoth" as string).catch(() => null) as { convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> } | null;
        if (!mammoth || cancelled) return;

        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) setDocxHtml(result.value);
      } catch {
        if (!cancelled) setDocxError(true);
      }
    })();

    return () => { cancelled = true; };
  }, [mode, document.id, auth.token, auth.workspaceId]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">{document.title}</p>
            <p className="truncate text-xs text-gray-500">{document.originalFilename}</p>
          </div>
          <div className="ml-4 flex flex-shrink-0 items-center gap-2">
            {/* Open in new tab */}
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Open ↗
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Preview body */}
        <div className="relative flex-1 overflow-hidden bg-gray-100">
          {mode === "not-indexed" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
              <p className="text-sm">
                Document is still being processed ({document.processingStatus})…
              </p>
            </div>
          )}

          {mode === "iframe" && (
            <iframe
              src={previewUrl}
              title={document.title}
              className="h-full w-full border-0"
              sandbox="allow-same-origin allow-scripts allow-popups"
            />
          )}

          {mode === "image" && (
            <div className="flex h-full items-center justify-center overflow-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt={document.title}
                className="max-h-full max-w-full rounded object-contain shadow"
              />
            </div>
          )}

          {mode === "docx-html" && (
            <div className="h-full overflow-y-auto bg-white p-8">
              {!docxHtml && !docxError && (
                <div className="flex h-full items-center justify-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
                </div>
              )}
              {docxError && (
                <DownloadPrompt previewUrl={previewUrl} filename={document.originalFilename} />
              )}
              {docxHtml && (
                <article
                  className="prose prose-sm max-w-none"
                  /* eslint-disable-next-line react/no-danger */
                  dangerouslySetInnerHTML={{ __html: docxHtml }}
                />
              )}
            </div>
          )}

          {mode === "download-prompt" && (
            <div className="flex h-full items-center justify-center">
              <DownloadPrompt previewUrl={previewUrl} filename={document.originalFilename} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DownloadPrompt({ previewUrl, filename }: { previewUrl: string; filename: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center text-gray-600">
      <svg
        className="h-12 w-12 text-gray-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3"
        />
      </svg>
      <p className="text-sm font-medium">Inline preview not available for this file type.</p>
      <a
        href={previewUrl}
        download={filename}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Download to view
      </a>
    </div>
  );
}
