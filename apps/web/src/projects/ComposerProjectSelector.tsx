import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type { ProjectId } from "@octant/contracts/projects";
import { ArrowLeft, Check, FolderGit2, FolderOpen, FolderPlus } from "lucide-react";
import {
  lazy,
  Suspense,
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

const GitHubRepositoryOnboardingFlow = lazy(() =>
  import("../code/GitHubRepositoryOnboarding").then((module) => ({
    default: module.GitHubRepositoryOnboardingFlow,
  })),
);

/**
 * One row in the composer's Project picker: a Project already saved on this
 * host, or the control that creates one from a folder. There is no "no folder"
 * row — a Work or Code thread belongs to a Project (decision 0037), so the
 * composer's job is to make choosing one easy, not optional.
 */
export type ComposerProjectEntry =
  | {
      readonly kind: "saved-project";
      readonly projectId: ProjectId;
      readonly displayName: string;
      readonly rootPath: string;
    }
  | { readonly kind: "add-folder" };

/** The Project the composer will start the thread in, if the person picked one. */
export interface ComposerProjectSelection {
  readonly projectId: ProjectId;
  readonly displayName: string;
}

/**
 * What "New Project from GitHub repository" needs: the catalogue to pick
 * from, the managed-clone client, and the way a binding receipt becomes a
 * Project. Absent when the host has no GitHub clients, and the row with it.
 */
export interface ComposerProjectGithubSource {
  readonly client: GithubClient;
  readonly cloneClient: GithubCloneClient;
  readonly hostName: string;
  readonly createProject: (name: string, receiptId: string) => Promise<string | undefined>;
  readonly onProjectCreated: (projectId: string, name: string) => void;
}

export interface ComposerProjectSelectorProps {
  readonly entries: ReadonlyArray<ComposerProjectEntry>;
  readonly selection?: ComposerProjectSelection;
  readonly onSelect: (entry: ComposerProjectEntry) => void;
  readonly onAddFolder: () => void;
  readonly github?: ComposerProjectGithubSource;
  readonly disabled?: boolean;
}

type MenuEntry = ComposerProjectEntry | { readonly kind: "add-github" };

export const NEW_PROJECT_FROM_FOLDER_LABEL = "New Project from folder…";
export const NEW_PROJECT_FROM_GITHUB_LABEL = "New Project from GitHub repository…";

/**
 * The composer's one Project menu: saved Projects to search, then the two
 * ways to make a new one. Choosing GitHub swaps the menu's body for the
 * managed-clone flow in place, so the composer never grows a second
 * repository control beside the Project.
 */
export function ComposerProjectSelector(props: ComposerProjectSelectorProps) {
  const { github } = props;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"projects" | "github">("projects");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const savedEntries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return props.entries.filter(
      (entry): entry is Extract<ComposerProjectEntry, { kind: "saved-project" }> =>
        entry.kind === "saved-project" &&
        (trimmed === "" ||
          entry.displayName.toLowerCase().includes(trimmed) ||
          entry.rootPath.toLowerCase().includes(trimmed)),
    );
  }, [props.entries, query]);
  const actionEntries = useMemo((): ReadonlyArray<MenuEntry> => {
    const actions: MenuEntry[] = props.entries.filter((entry) => entry.kind === "add-folder");
    if (github !== undefined) actions.push({ kind: "add-github" });
    return actions;
  }, [github, props.entries]);
  const flatEntries = useMemo(
    (): ReadonlyArray<MenuEntry> => [...savedEntries, ...actionEntries],
    [actionEntries, savedEntries],
  );

  const selectionLabel = props.selection?.displayName ?? "Choose a Project";

  const close = useCallback(() => {
    setOpen(false);
    setView("projects");
    setQuery("");
    setActiveIndex(-1);
  }, []);

  const activate = useCallback(
    (entry: MenuEntry) => {
      if (entry.kind === "add-github") {
        setView("github");
        setActiveIndex(-1);
        return;
      }
      if (entry.kind === "add-folder") props.onAddFolder();
      else props.onSelect(entry);
      close();
    },
    [close, props],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (view !== "projects" || flatEntries.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1 >= flatEntries.length ? 0 : i + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 < 0 ? flatEntries.length - 1 : i - 1));
      } else if (event.key === "Enter" || event.key === " ") {
        const entry = flatEntries[activeIndex];
        if (entry === undefined) return;
        event.preventDefault();
        activate(entry);
      }
    },
    [activate, activeIndex, close, flatEntries, view],
  );

  useEffect(() => {
    if (!open || view !== "projects") return;
    searchRef.current?.focus();
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (
        listRef.current &&
        !listRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [close, open]);

  const optionClass = (index: number, selected = false) =>
    `composer-folder-selector__option${index === activeIndex ? " composer-folder-selector__option--active" : ""}${selected ? " composer-folder-selector__option--selected" : ""}`;

  return (
    <div className="composer-folder-selector">
      <OctantButton
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Project: ${selectionLabel}`}
        className="composer-folder-selector__trigger"
        disabled={props.disabled}
        onClick={() => (open ? close() : setOpen(true))}
        ref={triggerRef}
        type="button"
        variant="ghost"
      >
        <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
        <span className="composer-folder-selector__label">{selectionLabel}</span>
      </OctantButton>
      {open ? (
        <div
          className={`composer-folder-selector__menu${view === "github" ? " composer-folder-selector__menu--github" : ""}`}
          onKeyDown={handleKeyDown}
          ref={listRef}
        >
          {view === "github" && github !== undefined ? (
            <>
              <div className="composer-folder-selector__head">
                <OctantButton
                  aria-label="Back to Projects"
                  onClick={() => setView("projects")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft aria-hidden="true" size={14} strokeWidth={1.8} />
                </OctantButton>
                <span className="composer-folder-selector__head-title">
                  New Project from GitHub repository
                </span>
              </div>
              <Suspense
                fallback={
                  <p className="composer-folder-selector__empty" role="status">
                    Loading GitHub…
                  </p>
                }
              >
                <GitHubRepositoryOnboardingFlow
                  client={github.client}
                  cloneClient={github.cloneClient}
                  createProject={github.createProject}
                  hostName={github.hostName}
                  onDone={close}
                  onProjectCreated={github.onProjectCreated}
                />
              </Suspense>
            </>
          ) : (
            <>
              <OctantInput
                aria-activedescendant={
                  activeIndex < 0 ? undefined : `${listboxId}-option-${activeIndex}`
                }
                aria-controls={listboxId}
                aria-expanded="true"
                aria-label="Search Projects"
                className="composer-folder-selector__search"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(-1);
                }}
                placeholder="Search Projects…"
                ref={searchRef}
                role="combobox"
                type="search"
                value={query}
              />
              <div aria-label="Project options" id={listboxId} role="listbox">
                {savedEntries.length === 0 ? (
                  <p className="composer-folder-selector__empty" role="status">
                    {query.trim() === "" ? "No Projects yet." : "No Projects match your search."}
                  </p>
                ) : (
                  <p aria-hidden="true" className="composer-folder-selector__group">
                    Projects
                  </p>
                )}
                {savedEntries.map((entry, index) => {
                  const isSelected = String(entry.projectId) === String(props.selection?.projectId);
                  return (
                    <OctantButton
                      aria-selected={isSelected}
                      className={optionClass(index, isSelected)}
                      id={`${listboxId}-option-${index}`}
                      key={String(entry.projectId)}
                      onClick={() => activate(entry)}
                      role="option"
                      title={entry.rootPath}
                      type="button"
                      variant="ghost"
                    >
                      <FolderOpen aria-hidden="true" size={14} strokeWidth={1.8} />
                      <span className="composer-folder-selector__option-copy">
                        <span className="composer-folder-selector__option-name">
                          {entry.displayName}
                        </span>
                        {entry.rootPath === "" ? null : (
                          <span className="composer-folder-selector__option-path">
                            {entry.rootPath}
                          </span>
                        )}
                      </span>
                      {isSelected ? (
                        <Check
                          aria-hidden="true"
                          className="composer-folder-selector__check"
                          size={14}
                          strokeWidth={2}
                        />
                      ) : null}
                    </OctantButton>
                  );
                })}
                {actionEntries.length === 0 ? null : (
                  <p aria-hidden="true" className="composer-folder-selector__group">
                    New Project
                  </p>
                )}
                {actionEntries.map((entry, offset) => {
                  const index = savedEntries.length + offset;
                  const label =
                    entry.kind === "add-github"
                      ? NEW_PROJECT_FROM_GITHUB_LABEL
                      : NEW_PROJECT_FROM_FOLDER_LABEL;
                  return (
                    <OctantButton
                      aria-selected={false}
                      className={optionClass(index)}
                      id={`${listboxId}-option-${index}`}
                      key={entry.kind}
                      onClick={() => activate(entry)}
                      role="option"
                      type="button"
                      variant="ghost"
                    >
                      {entry.kind === "add-github" ? (
                        <FolderGit2 aria-hidden="true" size={14} strokeWidth={1.8} />
                      ) : (
                        <FolderPlus aria-hidden="true" size={14} strokeWidth={1.8} />
                      )}
                      <span className="composer-folder-selector__option-copy">
                        <span className="composer-folder-selector__option-name">{label}</span>
                      </span>
                    </OctantButton>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
