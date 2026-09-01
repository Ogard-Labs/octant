import type { CodeFileId, CodeFileMetadata, CodeRelativePath } from "@octant/contracts/code";
import { ChevronRight, File, Folder, FolderOpen, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const search = useRef<HTMLInputElement>(null);
  const directoryPaths = useMemo(
    () =>
      new Set(
        props.entries.flatMap((entry) => (entry.kind === "directory" ? [String(entry.path)] : [])),
      ),
    [props.entries],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(selectedAncestors(props.selectedPath, directoryPaths)),
  );
  useEffect(() => {
    const ancestors = selectedAncestors(props.selectedPath, directoryPaths);
    if (ancestors.length === 0) return;
    setExpanded((current) => new Set([...current, ...ancestors]));
  }, [directoryPaths, props.selectedPath]);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return props.entries.filter((entry) =>
      normalized.length === 0
        ? ancestorsExpanded(entry.path, directoryPaths, expanded)
        : entry.path.toLocaleLowerCase().includes(normalized),
    );
  }, [directoryPaths, expanded, props.entries, query]);
  const basenameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.entries) {
      if (entry.kind !== "file") continue;
      const name = pathBasename(entry.path);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [props.entries]);
  const visible = matches.slice(0, MAX_CODE_FILE_EXPLORER_ENTRIES);
  const incomplete = matches.length > MAX_CODE_FILE_EXPLORER_ENTRIES;

  return (
    <section aria-label="Code file explorer" className="code-file-explorer">
      <label className="code-file-explorer__search">
        <span className="sr-only">Search files</span>
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          aria-label="Search files"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter relative paths"
          ref={search}
          type="search"
          value={query}
        />
        {query === "" ? null : (
          <OctantButton
            aria-label="Clear file search"
            className="code-file-explorer__search-clear"
            onClick={() => {
              setQuery("");
              search.current?.focus();
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} strokeWidth={1.8} />
          </OctantButton>
        )}
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
              const open = expanded.has(label);
              return (
                <OctantButton
                  aria-expanded={open}
                  aria-label={label}
                  aria-level={level}
                  className="code-file-explorer__entry code-file-explorer__entry--directory"
                  key={`directory:${entry.path}`}
                  onClick={() => setExpanded((current) => toggleExpandedDirectory(current, label))}
                  role="treeitem"
                  style={{ paddingInlineStart: `${8 + (level - 1) * 14}px` }}
                  type="button"
                  variant="ghost"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="code-file-explorer__chevron"
                    size={16}
                    strokeWidth={1.8}
                  />
                  {open ? (
                    <FolderOpen aria-hidden="true" size={14} strokeWidth={1.7} />
                  ) : (
                    <Folder aria-hidden="true" size={14} strokeWidth={1.7} />
                  )}
                  <span>{pathBasename(entry.path)}</span>
                </OctantButton>
              );
            }
            const unavailable = entry.availability.status === "unavailable";
            const availability = availabilityLabel(entry.availability);
            const parent = pathParent(entry.path);
            const showParent =
              query.trim() !== "" || (basenameCounts.get(pathBasename(entry.path)) ?? 0) > 1;
            return (
              <OctantButton
                aria-label={`${label}${availability === undefined ? "" : ` ${availability}`}`}
                aria-level={level}
                aria-selected={props.selectedPath === entry.path}
                className="code-file-explorer__entry code-file-explorer__entry--file"
                disabled={unavailable}
                key={`file:${entry.fileId}:${entry.path}`}
                onClick={() => props.onOpenFile(entry)}
                role="treeitem"
                style={{ paddingInlineStart: `${26 + (level - 1) * 14}px` }}
                type="button"
                variant="ghost"
              >
                <File aria-hidden="true" size={14} strokeWidth={1.7} />
                <span>{pathBasename(entry.path)}</span>
                {showParent && parent !== "" ? <small>{parent}</small> : null}
                {availability === undefined ? null : <small>{availability}</small>}
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
): string | undefined {
  if (availability.status === "available") return undefined;
  if (availability.status === "unavailable") return "Unavailable";
  return availability.reason === "binary" ? "Binary · read-only" : "Oversized · read-only";
}

function pathBasename(path: CodeRelativePath): string {
  return String(path).split("/").at(-1) ?? String(path);
}

function pathParent(path: CodeRelativePath): string {
  const segments = String(path).split("/");
  return segments.slice(0, -1).join("/");
}

function selectedAncestors(
  selectedPath: CodeRelativePath | undefined,
  directories: ReadonlySet<string>,
): ReadonlyArray<string> {
  if (selectedPath === undefined) return [];
  const segments = String(selectedPath).split("/");
  return segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"))
    .filter((path) => directories.has(path));
}

function ancestorsExpanded(
  path: CodeRelativePath,
  directories: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): boolean {
  const segments = String(path).split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (directories.has(ancestor) && !expanded.has(ancestor)) return false;
  }
  return true;
}

function toggleExpandedDirectory(current: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
