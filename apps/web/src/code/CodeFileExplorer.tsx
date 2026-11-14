import type { CodeFileId, CodeFileMetadata, CodeRelativePath } from "@octant/contracts/code";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, File, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useDockBarControls, useDockBarPlacement } from "../shell/dockBarControls";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ShellState } from "../shell/ShellState";
import { FileName, pathBasename, pathParent } from "../lib/fileName";

export const MAX_CODE_FILE_EXPLORER_ENTRIES = 1_000;
const EXPLORER_VIRTUALIZATION_THRESHOLD = 40;
const EXPLORER_ROW_HEIGHT_PX = 28;
const EXPLORER_OVERSCAN = 10;

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
  /** False for a tree that is not the tool's primary one: its Refresh stays in its own row. */
  readonly barControls?: boolean;
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
  const visibleIndexByPath = useMemo(() => {
    const indexes = new Map<string, number>();
    visible.forEach((entry, index) => {
      indexes.set(String(entry.path), index);
    });
    return indexes;
  }, [visible]);
  const siblingPositions = useMemo(() => {
    const groups = new Map<string, number[]>();
    visible.forEach((entry, index) => {
      const parent = pathParent(entry.path);
      const bucket = groups.get(parent);
      if (bucket === undefined) groups.set(parent, [index]);
      else bucket.push(index);
    });
    const positions = Array.from<
      { readonly posInSet: number; readonly setSize: number } | undefined
    >({ length: visible.length });
    for (const bucket of groups.values()) {
      const setSize = bucket.length;
      bucket.forEach((index, offset) => {
        positions[index] = { posInSet: offset + 1, setSize };
      });
    }
    return positions;
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
  const virtualized = visible.length > EXPLORER_VIRTUALIZATION_THRESHOLD;
  const pendingFocusPath = useRef<string | undefined>(undefined);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: virtualized ? visible.length : 0,
    getScrollElement: () => tree.current,
    estimateSize: () => EXPLORER_ROW_HEIGHT_PX,
    measureElement: measureExplorerRowElement,
    overscan: EXPLORER_OVERSCAN,
    initialRect: { width: 320, height: 480 },
    getItemKey: (index) => {
      const entry = visible[index];
      if (entry === undefined) return String(index);
      return entry.kind === "directory"
        ? `directory:${entry.path}`
        : `file:${entry.fileId}:${entry.path}`;
    },
    rangeExtractor: (range) => {
      const extracted = defaultRangeExtractor(range);
      const pinned = new Set(extracted);
      for (const pinnedPath of [tabbable, pendingFocusPath.current]) {
        if (pinnedPath === undefined) continue;
        const index = visibleIndexByPath.get(pinnedPath);
        if (index !== undefined && index >= 0 && index < range.count) {
          pinned.add(index);
        }
      }
      if (pinned.size === extracted.length) return extracted;
      return [...pinned].sort((left, right) => left - right);
    },
    ...(!virtualized ? { enabled: false } : {}),
  });
  const virtualItems = virtualized ? virtualizer.getVirtualItems() : [];

  useLayoutEffect(() => {
    const targetPath = pendingFocusPath.current;
    if (targetPath === undefined) return;
    const row = findTreeRowElement(tree.current, targetPath);
    if (row === undefined || row.hasAttribute("disabled")) return;
    pendingFocusPath.current = undefined;
    row.focus();
  }, [virtualItems]);

  const toggle = (path: string): void => {
    setExpanded((current) => toggleExpandedDirectory(current, path));
  };

  const focusEntryAt = (targetIndex: number): void => {
    const entry = visible[targetIndex];
    if (entry === undefined || !canReceiveFocus(entry)) return;
    const targetPath = String(entry.path);
    setFocusedPath(targetPath);
    if (virtualized) virtualizer.scrollToIndex(targetIndex, { align: "auto" });
    const mounted = findTreeRowElement(tree.current, targetPath);
    if (mounted !== undefined && !mounted.hasAttribute("disabled")) {
      pendingFocusPath.current = undefined;
      mounted.focus();
      return;
    }
    pendingFocusPath.current = targetPath;
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "treeitem") return;
    const currentPath = target.dataset.path;
    if (currentPath === undefined) return;
    const index = visibleIndexByPath.get(currentPath);
    if (index === undefined) return;
    const currentEntry = visible[index];
    if (currentEntry === undefined) return;
    const level = entryLevel(currentEntry.path);
    switch (event.key) {
      case "ArrowDown": {
        const nextIndex = findFocusableIndex(visible, index + 1, 1);
        if (nextIndex !== undefined) focusEntryAt(nextIndex);
        break;
      }
      case "ArrowUp": {
        const previousIndex = findFocusableIndex(visible, index - 1, -1);
        if (previousIndex !== undefined) focusEntryAt(previousIndex);
        break;
      }
      case "Home": {
        const firstIndex = findFocusableIndex(visible, 0, 1);
        if (firstIndex !== undefined) focusEntryAt(firstIndex);
        break;
      }
      case "End": {
        const lastIndex = findFocusableIndex(visible, visible.length - 1, -1);
        if (lastIndex !== undefined) focusEntryAt(lastIndex);
        break;
      }
      case "ArrowRight": {
        if (currentEntry.kind !== "directory") break;
        if (!expanded.has(currentPath)) {
          toggle(currentPath);
          break;
        }
        const childIndex = findFocusableIndex(visible, index + 1, 1);
        const childEntry = childIndex === undefined ? undefined : visible[childIndex];
        if (
          childIndex !== undefined &&
          childEntry !== undefined &&
          entryLevel(childEntry.path) > level
        ) {
          focusEntryAt(childIndex);
        }
        break;
      }
      case "ArrowLeft": {
        if (currentEntry.kind === "directory" && expanded.has(currentPath)) {
          toggle(currentPath);
          break;
        }
        // A collapsed folder and a file both go back to the folder holding
        // them, which is the row above at the parent's level.
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          const entry = visible[candidate];
          if (
            entry !== undefined &&
            canReceiveFocus(entry) &&
            entryLevel(entry.path) === level - 1
          ) {
            focusEntryAt(candidate);
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

  // Refresh is an action, so in a tile's bar or the bottom panel's it stands in
  // the bar beside the name and the filter, which is content, keeps the one row
  // under it. Shown alone there is no bar: filter and Refresh share the one row.
  const placement = useDockBarPlacement();
  // A tool lists the checkout and each extra folder as separate trees, each with
  // its own filter, so only the primary tree (`barControls`) hands its Refresh
  // to the bar; an extra folder keeps its own beside its own filter.
  const refreshInBar =
    props.barControls !== false && (placement === "tiled" || placement === "bottom");
  useDockBarControls(
    props.onRefresh === undefined || !refreshInBar
      ? []
      : [
          {
            kind: "button",
            id: "refresh",
            label: "Refresh files",
            icon: RefreshCw,
            onSelect: props.onRefresh,
            disabled: props.refreshing === true,
          },
        ],
  );
  const hosted = placement !== undefined;

  const renderEntry = (entry: CodeFileExplorerEntry, index: number, virtualStart?: number) => {
    const label = String(entry.path);
    const level = entryLevel(entry.path);
    const selected = props.selectedPath === entry.path;
    const siblingPosition = siblingPositions[index];
    const rowProps = {
      "aria-level": level,
      ...(siblingPosition === undefined
        ? {}
        : {
            "aria-posinset": siblingPosition.posInSet,
            "aria-setsize": siblingPosition.setSize,
          }),
      "data-index": index,
      "data-path": label,
      ref: virtualized ? virtualizer.measureElement : undefined,
      role: "treeitem" as const,
      style: virtualRowStyle(level - 1, virtualStart),
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
          variant="bare"
        >
          <ChevronRight aria-hidden="true" className="code-file-explorer__chevron" size={16} />
          {open ? (
            <FolderOpen aria-hidden="true" size={14} />
          ) : (
            <Folder aria-hidden="true" size={14} />
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
        variant="bare"
      >
        <File aria-hidden="true" size={14} />
        <FileName name={name} />
        {parentHint === undefined ? null : (
          <span className="code-file-explorer__hint">{parentHint}</span>
        )}
        {availability === undefined ? null : (
          <small className="code-file-explorer__detail">{availability}</small>
        )}
      </OctantButton>
    );
  };

  return (
    <section
      aria-label="Code file explorer"
      className="code-file-explorer"
      data-bar-hosted={hosted ? "true" : undefined}
    >
      <div className="code-file-explorer__head">
        <label className="code-file-explorer__search">
          <span className="sr-only">Filter files</span>
          <Search aria-hidden="true" size={14} />
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
              <X aria-hidden="true" size={14} />
            </OctantButton>
          )}
        </label>

        {props.onRefresh === undefined || refreshInBar ? null : (
          <OctantIconButton
            disabled={props.refreshing === true}
            label="Refresh files"
            onClick={props.onRefresh}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={14} />
          </OctantIconButton>
        )}
      </div>

      {props.truncated === true ? (
        <p className="code-file-explorer__status" role="status">
          Octant listed part of this repository. The file tree is incomplete.
        </p>
      ) : null}

      {incomplete ? (
        <p className="code-file-explorer__status" role="status">
          Showing the first {MAX_CODE_FILE_EXPLORER_ENTRIES.toLocaleString("en")} entries. The file
          tree is incomplete.
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
          {/* Keep one wrapper across the virtualization threshold so expanding
              a folder past EXPLORER_VIRTUALIZATION_THRESHOLD never drops focus. */}
          <div
            className="code-file-explorer__virtual"
            style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
          >
            {virtualized
              ? virtualItems.map((virtualItem) => {
                  const entry = visible[virtualItem.index];
                  return entry === undefined
                    ? null
                    : renderEntry(entry, virtualItem.index, virtualItem.start);
                })
              : visible.map((entry, index) => renderEntry(entry, index))}
          </div>
        </div>
      )}
    </section>
  );
}

function entryLevel(path: CodeRelativePath): number {
  return String(path).split("/").length;
}

function measureExplorerRowElement(element: Element): number {
  if (element instanceof HTMLElement) {
    const height = element.getBoundingClientRect().height;
    if (height > 0) return height;
  }
  return EXPLORER_ROW_HEIGHT_PX;
}

function findFocusableIndex(
  entries: ReadonlyArray<CodeFileExplorerEntry>,
  startIndex: number,
  step: 1 | -1,
): number | undefined {
  for (let index = startIndex; index >= 0 && index < entries.length; index += step) {
    const entry = entries[index];
    if (entry !== undefined && canReceiveFocus(entry)) return index;
  }
  return undefined;
}

function findTreeRowElement(container: HTMLElement | null, path: string): HTMLElement | undefined {
  if (container === null) return undefined;
  for (const row of container.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    if (row.dataset.path === path) return row;
  }
  return undefined;
}

function virtualRowStyle(depth: number, start?: number): CSSProperties {
  if (start === undefined) {
    return { "--oct-file-depth": String(depth) } as CSSProperties;
  }
  return {
    "--oct-file-depth": String(depth),
    left: 0,
    position: "absolute",
    top: 0,
    transform: `translateY(${String(start)}px)`,
    width: "100%",
  } as CSSProperties;
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
