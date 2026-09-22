"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { canMarkBaseDocument } from "../../lib/api";
import type { UserRole } from "@rag/shared-types";

interface UploadPanelProps {
  role: UserRole;
  onUpload: (files: File[], options: { isBaseDocument: boolean; baseDocCategory: string }) => Promise<void>;
  disabled?: boolean;
  hidden?: boolean;
}

export const UploadPanel = forwardRef<HTMLInputElement, UploadPanelProps>(function UploadPanel(
  { role, onUpload, disabled, hidden },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);

  const [isBaseDocument, setIsBaseDocument] = useState(false);
  const [baseDocCategory, setBaseDocCategory] = useState("");
  const [uploading, setUploading] = useState(false);

  const canBase = canMarkBaseDocument(role);

  async function handleFiles(files: FileList | null) {
    if (!files?.length || disabled || uploading) return;
    setUploading(true);
    try {
      await onUpload(Array.from(files), {
        isBaseDocument: canBase && isBaseDocument,
        baseDocCategory,
      });
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setUploading(false);
    }
  }

  if (hidden) {
    return (
      <>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {canBase && (
          <div className="sr-only">
            <label>
              <input
                type="checkbox"
                checked={isBaseDocument}
                onChange={(e) => setIsBaseDocument(e.target.checked)}
              />
              Base Document
            </label>
            <input
              type="text"
              value={baseDocCategory}
              onChange={(e) => setBaseDocCategory(e.target.value)}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="rounded-xl border-2 border-dashed border-drive-border bg-drive-bg p-6 transition-colors">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
          className="drive-btn-primary disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload files"}
        </button>
        <span className="text-sm text-drive-text-secondary">or drag and drop anywhere</span>

        {canBase && (
          <label className="ml-auto flex items-center gap-2 text-sm text-drive-text">
            <input
              type="checkbox"
              checked={isBaseDocument}
              onChange={(e) => setIsBaseDocument(e.target.checked)}
              className="rounded border-drive-border"
            />
            Mark as Base Document
          </label>
        )}

        {canBase && isBaseDocument && (
          <input
            type="text"
            placeholder="Category (ISA, Statute…)"
            value={baseDocCategory}
            onChange={(e) => setBaseDocCategory(e.target.value)}
            className="rounded-lg border border-drive-border px-3 py-1.5 text-sm"
          />
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
    </div>
  );
});
