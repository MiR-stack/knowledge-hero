"use client";

import { useEffect } from "react";
import { isInputFocused } from "../lib/drive-selection";

interface DriveKeyboardOptions {
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onRename: () => void;
  hasSelection: boolean;
  canCut: boolean;
  canPaste: boolean;
}

export function useDriveKeyboard({
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onRename,
  hasSelection,
  canCut,
  canPaste,
}: DriveKeyboardOptions) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "c" && hasSelection) {
        e.preventDefault();
        onCopy();
        return;
      }

      if (mod && e.key.toLowerCase() === "x" && canCut) {
        e.preventDefault();
        onCut();
        return;
      }

      if (mod && e.key.toLowerCase() === "v" && canPaste) {
        e.preventDefault();
        onPaste();
        return;
      }

      if (e.key === "Delete" && canCut) {
        e.preventDefault();
        onDelete();
        return;
      }

      if (e.key === "F2" && canCut) {
        e.preventDefault();
        onRename();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCopy, onCut, onPaste, onDelete, onRename, hasSelection, canCut, canPaste]);
}
