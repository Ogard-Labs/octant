import type { CodeFileId, CodeFileMetadata, CodeRelativePath } from "@octant/contracts/code";
import { useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export const MAX_CODE_FILE_EXPLORER_ENTRIES = 1_000;

export type CodeFileExplorerEntry =
  | {
      readonly kind: "directory";
      readonly path: CodeRelativePath;
    }
  | {
      readonly kind: "file";
      readonly fileId: CodeFileId;
      readonly path: CodeRelativePath;
      /**
       * `metadata` is optional because a bounded directory listing knows a
       * file's size and openability from `stat` alone; a digest would mean
       * reading every file in the tree. The editor fetches metadata when the
       * file is actually opened.
       */
      readonly availability:
        | { readonly status: "available"; readonly metadata?: CodeFileMetadata }
        | {
            readonly status: "read-only";
            readonly metadata?: CodeFileMetadata;
            readonly reason: "binary" | "oversized";
          }
        | { readonly status: "unavailable"; readonly reason: string };
    };

export interface CodeFileExplorerProps {
  readonly entries: ReadonlyArray<CodeFileExplorerEntry>;
  readonly onOpenFile: (entry: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>) => void;
  readonly selectedPath?: CodeRelativePath;
}

export function CodeFileExplorer(props: CodeFileExplorerProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? props.entries
      : props.entries.filter((entry) => entry.path.toLocaleLowerCase().includes(normalized));
  }, [props.entries, query]);
  const visible = matches.slice(0, MAX_CODE_FILE_EXPLORER_ENTRIES);
  const incomplete = matches.length > MAX_CODE_FILE_EXPLORER_ENTRIES;

  return (
    <section aria-label="Code file explorer" className="code-file-explorer">
      <label className="code-file-explorer__search">
        <span>Search files</span>
        <OctantInput
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter relative paths"
          type="search"
          value={query}
        />
      </label>

      {incomplete ? (
        <p className="code-file-explorer__status" role="status">
          Showing the first {MAX_CODE_FILE_EXPLORER_ENTRIES.toLocaleString()} matching entries. The
          file tree is incomplete.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="code-file-explorer__empty">No matching repository files.</p>
      ) : (
        <div aria-label="Repository files" className="code-file-explorer__tree" role="tree">
          {visible.map((entry) => {
            const label = String(entry.path);
            const level = String(entry.path).split("/").length;
            if (entry.kind === "directory") {
              return (
                <div
                  aria-expanded="true"
                  aria-label={label}
                  aria-level={level}
                  className="code-file-explorer__entry code-file-explorer__entry--directory"
                  key={`directory:${entry.path}`}
                  role="treeitem"
                >
                  <span>{label}</span>
                  <small>Folder</small>
                </div>
              );
            }
            const unavailable = entry.availability.status === "unavailable";
            return (
              <OctantButton
                aria-label={`${label} ${availabilityLabel(entry.availability)}`}
                aria-level={level}
                aria-selected={props.selectedPath === entry.path}
                className="code-file-explorer__entry code-file-explorer__entry--file"
                disabled={unavailable}
                key={`file:${entry.fileId}:${entry.path}`}
                onClick={() => props.onOpenFile(entry)}
                role="treeitem"
                type="button"
                variant="ghost"
              >
                <span>{label}</span>
                <small>{availabilityLabel(entry.availability)}</small>
              </OctantButton>
            );
          })}
        </div>
      )}
    </section>
  );
}

function availabilityLabel(
  availability: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>["availability"],
): string {
  if (availability.status === "available") return "Available";
  if (availability.status === "unavailable") return "Unavailable";
  return availability.reason === "binary" ? "Binary · read-only" : "Oversized · read-only";
}
