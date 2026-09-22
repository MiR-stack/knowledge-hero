import type { BreadcrumbItem } from "@rag/shared-types";
import { ChevronRightIcon } from "./icons";

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  onNavigate: (folderId: string) => void;
  rootLabel?: string;
}

export function Breadcrumbs({ items, onNavigate, rootLabel = "My Drive" }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-0.5 text-sm">
      <button
        type="button"
        onClick={() => items.length > 0 && onNavigate(items[0].id)}
        className="rounded px-1.5 py-0.5 font-medium text-drive-text hover:bg-drive-hover"
      >
        {rootLabel}
      </button>
      {items.slice(1).map((item, index) => {
        const isLast = index === items.length - 2;
        return (
          <span key={item.id} className="flex items-center">
            <ChevronRightIcon className="text-drive-text-secondary" />
            {isLast ? (
              <span className="px-1.5 py-0.5 font-medium text-drive-text">{item.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(item.id)}
                className="rounded px-1.5 py-0.5 text-drive-text-secondary hover:bg-drive-hover hover:text-drive-text"
              >
                {item.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
