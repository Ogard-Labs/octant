import type {
  ComposerFolderEntry,
  ComposerFolderSelection,
} from "@octant/contracts/rootless-thread";
import { FolderOpen, FolderPlus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ComposerFolderSelectorProps {
  readonly entries: ReadonlyArray<ComposerFolderEntry>;
  readonly selection: ComposerFolderSelection;
  readonly onSelect: (entry: ComposerFolderEntry) => void;
  readonly onAddFolder: () => void;
  readonly disabled?: boolean;
}

export function ComposerFolderSelector(props: ComposerFolderSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") return props.entries;
    return props.entries.filter((entry) => {
      if (entry.kind !== "saved-project") return true;
      return (
        entry.displayName.toLowerCase().includes(trimmed) ||
        entry.rootPath.toLowerCase().includes(trimmed)
      );
    });
  }, [props.entries, query]);

  const flatEntries = useMemo(() => filtered, [filtered]);

  const selectionLabel = useMemo(() => {
    if (props.selection.kind === "no-folder") return "No folder";
    return props.selection.displayName;
  }, [props.selection]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (flatEntries.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1 >= flatEntries.length ? 0 : i + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 < 0 ? flatEntries.length - 1 : i - 1));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const entry = flatEntries[activeIndex];
        if (entry !== undefined) {
          if (entry.kind === "add-folder") {
            props.onAddFolder();
          } else {
            props.onSelect(entry);
          }
          setOpen(false);
          setQuery("");
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setQuery("");
        triggerRef.current?.focus();
      }
    },
    [flatEntries, activeIndex, props],
  );

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const handler = (event: MouseEvent) => {
      if (
        listRef.current &&
        !listRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="composer-folder-selector" aria-label="Folder selector">
      <OctantButton
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Folder: ${selectionLabel}`}
        className="composer-folder-selector__trigger"
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        ref={triggerRef}
        type="button"
        variant="ghost"
      >
        <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
        <span className="composer-folder-selector__label">{selectionLabel}</span>
      </OctantButton>
      {open ? (
        <div className="composer-folder-selector__menu" onKeyDown={handleKeyDown} ref={listRef}>
          <OctantInput
            aria-activedescendant={
              activeIndex < 0 ? undefined : `${listboxId}-option-${activeIndex}`
            }
            aria-controls={listboxId}
            aria-expanded="true"
            aria-label="Search folders"
            className="composer-folder-selector__search"
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(-1);
            }}
            placeholder="Search folders…"
            ref={searchRef}
            role="combobox"
            type="search"
            value={query}
          />
          <div aria-label="Folder options" id={listboxId} role="listbox">
            {flatEntries.map((entry, index) => {
              const isActive = index === activeIndex;
              const isSelected =
                entry.kind === "saved-project" &&
                props.selection.kind === "project" &&
                entry.projectId === props.selection.projectId;
              const isNoFolder = entry.kind === "no-folder" && props.selection.kind === "no-folder";
              const optionId = `${listboxId}-option-${index}`;

              if (entry.kind === "add-folder") {
                return (
                  <OctantButton
                    aria-selected={false}
                    className={`composer-folder-selector__option${isActive ? " composer-folder-selector__option--active" : ""}`}
                    id={optionId}
                    key="add-folder"
                    onClick={() => {
                      props.onAddFolder();
                      setOpen(false);
                      setQuery("");
                    }}
                    role="option"
                    type="button"
                    variant="ghost"
                  >
                    <FolderPlus aria-hidden="true" size={14} />
                    <span>Add local folder…</span>
                  </OctantButton>
                );
              }

              if (entry.kind === "no-folder") {
                return (
                  <OctantButton
                    aria-selected={isNoFolder}
                    className={`composer-folder-selector__option${isActive ? " composer-folder-selector__option--active" : ""}${isNoFolder ? " composer-folder-selector__option--selected" : ""}`}
                    id={optionId}
                    key="no-folder"
                    onClick={() => {
                      props.onSelect(entry);
                      setOpen(false);
                      setQuery("");
                    }}
                    role="option"
                    type="button"
                    variant="ghost"
                  >
                    <X aria-hidden="true" size={14} />
                    <span>No folder</span>
                    {isNoFolder ? (
                      <span aria-hidden="true" className="composer-folder-selector__check">
                        ✓
                      </span>
                    ) : null}
                  </OctantButton>
                );
              }

              return (
                <OctantButton
                  aria-selected={isSelected}
                  className={`composer-folder-selector__option${isActive ? " composer-folder-selector__option--active" : ""}${isSelected ? " composer-folder-selector__option--selected" : ""}`}
                  id={optionId}
                  key={String(entry.projectId)}
                  onClick={() => {
                    props.onSelect(entry);
                    setOpen(false);
                    setQuery("");
                  }}
                  role="option"
                  title={entry.rootPath}
                  type="button"
                  variant="ghost"
                >
                  <FolderOpen aria-hidden="true" size={14} />
                  <span className="composer-folder-selector__option-name">{entry.displayName}</span>
                  <span className="composer-folder-selector__option-path">{entry.rootPath}</span>
                  {isSelected ? (
                    <span aria-hidden="true" className="composer-folder-selector__check">
                      ✓
                    </span>
                  ) : null}
                </OctantButton>
              );
            })}
            {flatEntries.length === 0 ? (
              <p className="composer-folder-selector__empty" role="status">
                No folders match your search.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
