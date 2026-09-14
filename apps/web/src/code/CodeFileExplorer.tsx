import type { CodeFileId, CodeFileMetadata, CodeRelativePath } from "@octant/contracts/code";
import { ChevronRight, File, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ShellState } from "../shell/ShellState";
import { FileName, pathBasename, pathParent } from "../lib/fileName";

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
  readonly loading?: boolean;
  readonly onOpenFile: (entry: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>) => void;
  readonly selectedPath?: CodeRelativePath;
  /** The host's walk stopped early; the tree below is what it managed to describe. */
  readonly truncated?: boolean;
  /** Absent on a surface that does not offer an explicit relist. */
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
}

export function CodeFileExplorer(props: CodeFileExplorerProps) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
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
  const [focusedPath, setFocusedPath] = useState<string | undefined>(() =>
    props.selectedPath === undefined ? undefined : String(props.selectedPath),
  );
  useEffect(() => {
    const ancestors = selectedAncestors(props.selectedPath, directoryPaths);
    if (ancestors.length === 0) return;
    setExpanded((current) => new Set([...current, ...ancestors]));
  }, [directoryPaths, props.selectedPath]);
  const normalized = query.trim();
  const matches = useMemo(() => {
    const needle = normalized.toLocaleLowerCase();
    return props.entries.filter((entry) =>
      needle.length === 0
        ? ancestorsExpanded(entry.path, directoryPaths, expanded)
        : entry.path.toLocaleLowerCase().includes(needle),
    );
  }, [directoryPaths, expanded, normalized, props.entries]);
  const visible = useMemo(() => matches.slice(0, MAX_CODE_FILE_EXPLORER_ENTRIES), [matches]);
  const incomplete = matches.length > MAX_CODE_FILE_EXPLORER_ENTRIES;
  /**
   * A basename that appears more than once among the rows on screen: two
   * files sharing one name are otherwise the same row at 320px, and a
   * filtered list has no folder above either of them to tell them apart.
   * Counted from the visible rows so a hidden duplicate does not name a
   * folder the tree already shows.
   */
  const duplicateBasenames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of visible) {
      if (entry.kind !== "file") continue;
      const name = pathBasename(entry.path);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts)
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [visible]);
  /**
   * One tab stop for the whole tree, moved by the row that last held focus.
   * Every row otherwise stays reachable with Tab first and then the arrow
   * keys, which is what a tree is expected to do at this size. A disabled
   * row cannot hold focus, so it is never the stop.
   */
  const tabbable = useMemo(() => {
    if (focusedPath !== undefined) {
      const focused = visible.find(
        (entry) => String(entry.path) === focusedPath && canReceiveFocus(entry),
      );
      if (focused !== undefined) return focusedPath;
    }
    const first = visible.find(canReceiveFocus);
    return first === undefined ? undefined : String(first.path);
  }, [focusedPath, visible]);

  const toggle = (path: string): void => {
    setExpanded((current) => toggleExpandedDirectory(current, path));
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "treeitem") return;
    const container = tree.current;
    if (container === null) return;
    // A disabled row refuses focus, so Arrow Up/Down and Home/End step over
    // it to the next row that can actually take focus.
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
      (row) => !row.hasAttribute("disabled"),
    );
    const index = rows.indexOf(target);
    if (index === -1) return;
    const level = Number(target.getAttribute("aria-level") ?? "1");
    const next = rows[index + 1];
    const previous = rows[index - 1];
    switch (event.key) {
      case "ArrowDown":
        next?.focus();
        break;
      case "ArrowUp":
        previous?.focus();
        break;
      case "Home":
        rows[0]?.focus();
        break;
      case "End":
        rows.at(-1)?.focus();
        break;
      case "ArrowRight": {
        const path = target.dataset.path;
        if (path === undefined) return;
        if (target.getAttribute("aria-expanded") === "false") {
          toggle(path);
        } else if (
          target.getAttribute("aria-expanded") === "true" &&
          next !== undefined &&
          Number(next.getAttribute("aria-level")) > level
        ) {
          next.focus();
        }
        break;
      }
      case "ArrowLeft": {
        if (target.getAttribute("aria-expanded") === "true") {
          const path = target.dataset.path;
          if (path === undefined) return;
          toggle(path);
          break;
        }
        // A collapsed folder and a file both go back to the folder holding
        // them, which is the row above at the parent's level.
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          const row = rows[candidate];
          if (row !== undefined && Number(row.getAttribute("aria-level")) === level - 1) {
            row.focus();
            break;
          }
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <section aria-label="Code file explorer" className="code-file-explorer">
      <div className="code-file-explorer__head">
        <label className="code-file-explorer__search">
          <span className="sr-only">Filter files</span>
          <Search aria-hidden="true" size={14} strokeWidth={1.8} />
          <OctantInput
            aria-label="Filter files"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter files"
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
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={14} strokeWidth={1.8} />
            </OctantButton>
          )}
        </label>

        {props.onRefresh === undefined ? null : (
          <OctantButton
            aria-label="Refresh files"
            disabled={props.refreshing === true}
            onClick={props.onRefresh}
            size="icon-sm"
            title="Refresh files"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
          </OctantButton>
        )}
      </div>

      {props.truncated === true ? (
        <p className="code-file-explorer__status" role="status">
          Octant listed part of this repository. The file tree is incomplete.
        </p>
      ) : null}

      {incomplete ? (
        <p className="code-file-explorer__status" role="status">
          Showing the first {MAX_CODE_FILE_EXPLORER_ENTRIES.toLocaleString()} entries. The file tree
          is incomplete.
        </p>
      ) : null}

      {visible.length === 0 ? (
        props.loading === true && props.entries.length === 0 ? (
          <ShellState state="loading" title="Loading files" />
        ) : (
          <p className="code-file-explorer__empty">
            {normalized === ""
              ? "This checkout has no files to list."
              : `No files match “${normalized}”.`}
          </p>
        )
      ) : (
        <div
          aria-label="Repository files"
          className="code-file-explorer__tree"
          onFocus={(event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.dataset.path !== undefined) {
              setFocusedPath(target.dataset.path);
            }
          }}
          onKeyDown={onTreeKeyDown}
          ref={tree}
          role="tree"
        >
          {visible.map((entry) => {
            const label = String(entry.path);
            const level = String(entry.path).split("/").length;
            const selected = props.selectedPath === entry.path;
            const rowProps = {
              "aria-level": level,
              "data-path": label,
              role: "treeitem" as const,
              style: depthStyle(level - 1),
              tabIndex: label === tabbable ? 0 : -1,
              title: label,
            };
            if (entry.kind === "directory") {
              const open = expanded.has(label);
              return (
                <OctantButton
                  {...rowProps}
                  aria-expanded={open}
                  aria-label={label}
                  className="code-file-explorer__entry code-file-explorer__entry--directory"
                  key={`directory:${entry.path}`}
                  onClick={() => toggle(label)}
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
                  <FileName name={pathBasename(entry.path)} />
                </OctantButton>
              );
            }
            const unavailable = entry.availability.status === "unavailable";
            const availability = availabilityLabel(entry.availability);
            const name = pathBasename(entry.path);
            const parent = pathParent(entry.path);
            // A filtered list is flat, and two files can share one name, so
            // the folder is named when the row cannot show it itself. A row
            // that already explains why it cannot open keeps that explanation
            // instead; the whole path stays in the row's accessible name and
            // hover title either way.
            const parentHint =
              availability === undefined &&
              parent !== "" &&
              (normalized !== "" || duplicateBasenames.has(name))
                ? pathBasename(parent)
                : undefined;
            const title = `${label}${availability === undefined ? "" : ` ${availability}`}`;
            return (
              <OctantButton
                {...rowProps}
                aria-label={title}
                aria-selected={selected}
                className="code-file-explorer__entry code-file-explorer__entry--file"
                disabled={unavailable}
                key={`file:${entry.fileId}:${entry.path}`}
                onClick={() => props.onOpenFile(entry)}
                title={title}
                type="button"
                variant="ghost"
              >
                <File aria-hidden="true" size={14} strokeWidth={1.7} />
                <FileName name={name} />
                {parentHint === undefined ? null : (
                  <span className="code-file-explorer__hint">{parentHint}</span>
                )}
                {availability === undefined ? null : (
                  <small className="code-file-explorer__detail">{availability}</small>
                )}
              </OctantButton>
            );
          })}
        </div>
      )}
    </section>
  );
}

function depthStyle(depth: number): CSSProperties {
  return { "--oct-file-depth": String(depth) } as CSSProperties;
}

/**
 * Native disabled buttons cannot receive focus, so a file the host reports
 * as unavailable is never the tree's tab stop or an arrow-key destination.
 * Directories always can: the explorer never renders them disabled.
 */
function canReceiveFocus(entry: CodeFileExplorerEntry): boolean {
  return entry.kind === "directory" || entry.availability.status !== "unavailable";
}

function availabilityLabel(
  availability: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>["availability"],
): string | undefined {
  if (availability.status === "available") return undefined;
  if (availability.status === "unavailable") return "Unavailable";
  return availability.reason === "binary" ? "Binary · read-only" : "Oversized · read-only";
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
