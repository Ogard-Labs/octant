import { homeRelativePath } from "../lib/homeRelativePath";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type { ProjectId } from "@octant/contracts/projects";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Network,
  Search,
} from "../ui/icons";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  Fragment,
} from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { ProjectIcon } from "./ProjectIcon";

const GitHubRepositoryOnboardingFlow = lazy(() =>
  import("../code/GitHubRepositoryOnboarding").then((module) => ({
    default: module.GitHubRepositoryOnboardingFlow,
  })),
);

/**
 * One row in the composer's Project picker: a Project already saved on this
 * host, the control that creates one from a folder, or the default folder.
 * A Work or Code thread still belongs to a Project; the
 * default-folder row is how a thread gets one without the person choosing a
 * folder — the host provisions a Project under the default folder for it.
 */
export type ComposerProjectEntry =
  | {
      readonly kind: "saved-project";
      readonly projectId: ProjectId;
      readonly displayName: string;
      readonly rootPath: string;
    }
  | { readonly kind: "unfiled" }
  | { readonly kind: "add-folder" }
  /** A Code Project bound to a folder on one of the person's servers, listed with where it is. */
  | {
      readonly kind: "server-project";
      readonly projectId: ProjectId;
      readonly displayName: string;
      /** `alias:folder`. */
      readonly location: string;
    }
  | {
      readonly kind: "default-folder";
      readonly rootPath: string;
      /** Code keeps this visible while its opt-in setting is disabled. */
      readonly disabled?: boolean;
      readonly disabledReason?: string;
    };

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

/**
 * A search field appears only when the list is long enough to need one: with
 * seven Projects or fewer every row is on screen without scrolling, and a
 * field over them only adds a stop and a row of height (maintainer request,
 * 2026-11-16).
 */
const SEARCH_PROJECT_THRESHOLD = 7;

export const NEW_PROJECT_FROM_FOLDER_LABEL = "New Project from folder…";
export const NEW_PROJECT_FROM_GITHUB_LABEL = "New Project from GitHub repository…";
export const START_IN_DEFAULT_FOLDER_LABEL = "No Project";
export const UNFILED_THREAD_LABEL = "No Project";

/**
 * The composer's one Project menu: saved Projects (searchable once there are
 * many), then the ways to make a new one. It is the shared popover float, so
 * it carries the same face, motion, outside press and focus return as every
 * other popup. Choosing GitHub swaps the menu's body for the managed-clone
 * flow in place, so the composer never grows a second repository control
 * beside the Project.
 */
export function ComposerProjectSelector(props: ComposerProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectionLabel =
    props.selection?.displayName ??
    (props.entries.some((entry) => entry.kind === "unfiled")
      ? UNFILED_THREAD_LABEL
      : "Choose a Project");

  return (
    <div className="composer-folder-selector">
      <OctantPopover
        align="start"
        className="composer-folder-selector__menu"
        onOpenChange={setOpen}
        open={open}
        // Under its button, where the start screen has its room; the popover
        // turns it over only when there is none below. Preferring the top put
        // a short list over the screen's own question.
        side="bottom"
        title="Choose a Project"
        trigger={
          // The same chip as "where this thread works" beside it: icon, name,
          // chevron. Without a chevron the Project read as a label, not a
          // control, and stood out bolder than its neighbour.
          <>
            <Folder aria-hidden="true" size={14} />
            <span className="composer-folder-selector__label">{selectionLabel}</span>
            <ChevronDown
              aria-hidden="true"
              className="composer-folder-selector__chevron"
              size={12}
            />
          </>
        }
        triggerClassName="composer-folder-selector__trigger composer-tray__item"
        triggerLabel={`Project: ${selectionLabel}`}
        triggerVariant="ghost"
        {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
      >
        <ProjectMenu {...props} close={() => setOpen(false)} />
      </OctantPopover>
    </div>
  );
}

/** Mounted only while the popup is open, so every open starts from a clean search and view. */
function ProjectMenu(props: ComposerProjectSelectorProps & { readonly close: () => void }) {
  const { github, close } = props;
  const [view, setView] = useState<"projects" | "github">("projects");
  const [query, setQuery] = useState("");
  // The menu is as tall as its content is when it opens and stays that tall:
  // typing in the search, a list that arrives late and the swap to the GitHub
  // flow scroll inside the frame instead of resizing the menu.
  const [frameHeight, setFrameHeight] = useState<number>();
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const projectsLabelId = `${listboxId}-projects`;
  const serversLabelId = `${listboxId}-servers`;

  const projectCount = props.entries.filter(
    (entry) => entry.kind === "saved-project" || entry.kind === "server-project",
  ).length;
  const searchShown = projectCount > SEARCH_PROJECT_THRESHOLD;
  // Both groups are labelled only when both exist; a lone group reads fine
  // without a label over it.
  const labelGroups =
    props.entries.some((entry) => entry.kind === "saved-project") &&
    props.entries.some((entry) => entry.kind === "server-project");

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
  const serverEntries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return props.entries.filter(
      (entry): entry is Extract<ComposerProjectEntry, { kind: "server-project" }> =>
        entry.kind === "server-project" &&
        (trimmed === "" ||
          entry.displayName.toLowerCase().includes(trimmed) ||
          entry.location.toLowerCase().includes(trimmed)),
    );
  }, [props.entries, query]);
  const actionEntries = useMemo((): ReadonlyArray<MenuEntry> => {
    const actions: MenuEntry[] = props.entries.filter(
      (entry) =>
        entry.kind === "unfiled" || entry.kind === "default-folder" || entry.kind === "add-folder",
    );
    if (github !== undefined) actions.push({ kind: "add-github" });
    return actions;
  }, [github, props.entries]);
  const flatEntries = useMemo(
    (): ReadonlyArray<MenuEntry> => [...savedEntries, ...serverEntries, ...actionEntries],
    [actionEntries, savedEntries, serverEntries],
  );

  const isChosen = useCallback(
    (entry: MenuEntry) => {
      if (entry.kind === "saved-project" || entry.kind === "server-project") {
        return String(entry.projectId) === String(props.selection?.projectId);
      }
      return entry.kind === "unfiled" && props.selection === undefined;
    },
    [props.selection],
  );

  // Opening starts on the chosen Project; with none chosen, on the first row,
  // or in the search field when there is one.
  const [activeIndex, setActiveIndex] = useState(() => {
    const chosen = flatEntries.findIndex(isChosen);
    if (chosen >= 0) return chosen;
    return searchShown ? -1 : 0;
  });

  // The highlight follows the keyboard only. Drawn from the moment the list
  // opened, the chosen row read as a filled, pressed row before anything was
  // pressed (2026-11-17); the pointer has its own hover fill.
  const [keyboardMoved, setKeyboardMoved] = useState(false);

  const activate = useCallback(
    (entry: MenuEntry) => {
      if (entry.kind === "add-github") {
        setView("github");
        setActiveIndex(-1);
        return;
      }
      if (entry.kind === "default-folder" && entry.disabled === true) return;
      if (entry.kind === "add-folder") props.onAddFolder();
      else props.onSelect(entry);
      close();
    },
    [close, props],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (view !== "projects" || flatEntries.length === 0) return;
      const inSearch = event.target === searchRef.current;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) setKeyboardMoved(true);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1 >= flatEntries.length ? 0 : i + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 < 0 ? flatEntries.length - 1 : i - 1));
      } else if (event.key === "Home" && !inSearch) {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End" && !inSearch) {
        event.preventDefault();
        setActiveIndex(flatEntries.length - 1);
      } else if (
        event.key === "Enter" ||
        // Space is a character in the search field, whose keydown reaches this
        // container. Only the list itself reads Space as activation; Project
        // names and paths commonly contain spaces.
        (event.key === " " && !inSearch)
      ) {
        const entry = flatEntries[activeIndex];
        if (entry === undefined) return;
        event.preventDefault();
        activate(entry);
      }
    },
    [activate, activeIndex, flatEntries, view],
  );

  useEffect(() => {
    if (view !== "projects") return;
    (searchRef.current ?? listboxRef.current)?.focus();
  }, [view]);

  // The list can shrink while the popup is open (a Project removed elsewhere,
  // a narrower search): the highlight then moves to the last row instead of
  // pointing at a row that is gone.
  useEffect(() => {
    if (activeIndex >= flatEntries.length) setActiveIndex(flatEntries.length - 1);
  }, [activeIndex, flatEntries.length]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId]);

  useLayoutEffect(() => {
    if (frameHeight !== undefined) return;
    // The layout height, not the drawn box: the popup is still at 98% scale
    // on the frame it arrives, and a height measured from its box came out a
    // few pixels short, which gave a short list a needless scrollbar.
    const natural = bodyRef.current?.offsetHeight;
    if (natural !== undefined && natural > 0) setFrameHeight(natural);
  }, [frameHeight]);

  const optionProps = (index: number) => ({
    className: "octant-popover-option composer-folder-selector__option",
    "data-active": keyboardMoved && index === activeIndex ? "true" : undefined,
    id: `${listboxId}-option-${index}`,
    role: "option" as const,
    tabIndex: -1,
    type: "button" as const,
    variant: "bare" as const,
  });
  const check = (chosen: boolean): ReactNode =>
    chosen ? <Check aria-hidden="true" className="octant-popover-option__check" size={14} /> : null;

  const activeDescendant = activeIndex < 0 ? undefined : `${listboxId}-option-${activeIndex}`;
  const nothingToList = savedEntries.length === 0 && serverEntries.length === 0;

  return (
    <div
      className={`composer-folder-selector__body${view === "github" ? " composer-folder-selector__body--github" : ""}`}
      onKeyDown={handleKeyDown}
      ref={bodyRef}
      {...(frameHeight === undefined || view === "github"
        ? {}
        : { style: { height: frameHeight } })}
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
              <ArrowLeft aria-hidden="true" size={14} />
            </OctantButton>
            <span className="composer-folder-selector__head-title">
              New Project from GitHub repository
            </span>
          </div>
          <Suspense
            fallback={
              <p className="octant-popover-empty" role="status">
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
          {searchShown ? (
            <label className="octant-popover-search">
              <Search aria-hidden="true" size={14} />
              <OctantInput
                aria-activedescendant={activeDescendant}
                aria-controls={listboxId}
                aria-expanded="true"
                aria-label="Search Projects"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(-1);
                }}
                placeholder="Search Projects…"
                ref={searchRef}
                role="combobox"
                type="search"
                unstyled
                value={query}
              />
            </label>
          ) : null}
          {nothingToList ? (
            <p className="octant-popover-empty composer-folder-selector__empty" role="status">
              {query.trim() === "" ? "No Projects yet" : "No Projects match your search"}
            </p>
          ) : null}
          <div
            aria-activedescendant={searchShown ? undefined : activeDescendant}
            aria-label="Project options"
            className="composer-folder-selector__list"
            id={listboxId}
            ref={listboxRef}
            role="listbox"
            tabIndex={searchShown ? -1 : 0}
          >
            {nothingToList ? null : (
              <div className="composer-folder-selector__scroll">
                {savedEntries.length === 0 ? null : (
                  <div
                    {...(labelGroups ? { "aria-labelledby": projectsLabelId, role: "group" } : {})}
                    className="composer-folder-selector__group"
                  >
                    {labelGroups ? (
                      <p className="octant-popover-group" id={projectsLabelId}>
                        Projects
                      </p>
                    ) : null}
                    {savedEntries.map((entry, index) => {
                      const chosen = isChosen(entry);
                      return (
                        <OctantButton
                          aria-selected={chosen}
                          key={String(entry.projectId)}
                          onClick={() => activate(entry)}
                          title={entry.rootPath}
                          {...optionProps(index)}
                        >
                          <ProjectIcon
                            fallback={<FolderOpen aria-hidden="true" size={14} />}
                            projectId={String(entry.projectId)}
                            size={14}
                          />
                          <span className="composer-folder-selector__option-copy">
                            <span className="composer-folder-selector__option-name">
                              {entry.displayName}
                            </span>
                            {entry.rootPath === "" ? null : (
                              <span className="composer-folder-selector__option-path">
                                {homeRelativePath(entry.rootPath)}
                              </span>
                            )}
                          </span>
                          {check(chosen)}
                        </OctantButton>
                      );
                    })}
                  </div>
                )}
                {serverEntries.length === 0 ? null : (
                  <div
                    {...(labelGroups ? { "aria-labelledby": serversLabelId, role: "group" } : {})}
                    className="composer-folder-selector__group"
                  >
                    {labelGroups ? (
                      <p className="octant-popover-group" id={serversLabelId}>
                        On your servers
                      </p>
                    ) : null}
                    {serverEntries.map((entry, offset) => {
                      const index = savedEntries.length + offset;
                      const chosen = isChosen(entry);
                      return (
                        <OctantButton
                          aria-selected={chosen}
                          key={String(entry.projectId)}
                          onClick={() => activate(entry)}
                          title={entry.location}
                          {...optionProps(index)}
                        >
                          <Network aria-hidden="true" size={14} />
                          <span className="composer-folder-selector__option-copy">
                            <span className="composer-folder-selector__option-name">
                              {entry.displayName}
                            </span>
                            <span className="composer-folder-selector__option-path">
                              {entry.location}
                            </span>
                          </span>
                          {check(chosen)}
                        </OctantButton>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {actionEntries.length === 0 ? null : (
              <div className="composer-folder-selector__actions">
                {actionEntries.map((entry, offset) => {
                  const index = savedEntries.length + serverEntries.length + offset;
                  const chosen = isChosen(entry);
                  const label =
                    entry.kind === "add-github"
                      ? NEW_PROJECT_FROM_GITHUB_LABEL
                      : entry.kind === "unfiled"
                        ? UNFILED_THREAD_LABEL
                        : entry.kind === "default-folder"
                          ? START_IN_DEFAULT_FOLDER_LABEL
                          : NEW_PROJECT_FROM_FOLDER_LABEL;
                  const reason =
                    entry.kind === "default-folder" && entry.disabled === true
                      ? entry.disabledReason
                      : undefined;
                  const refused = entry.kind === "default-folder" && entry.disabled === true;
                  const nameId = `${listboxId}-option-${index}-name`;
                  // The ways to make a Project are a group of their own, apart
                  // from the place a thread can start without one.
                  const startsCreate =
                    (entry.kind === "add-folder" || entry.kind === "add-github") &&
                    offset > 0 &&
                    actionEntries[offset - 1]?.kind !== "add-folder" &&
                    actionEntries[offset - 1]?.kind !== "add-github";
                  const reasonId = `${listboxId}-option-${index}-reason`;
                  return (
                    <Fragment key={entry.kind}>
                      {startsCreate ? (
                        <div aria-hidden="true" className="composer-folder-selector__divider" />
                      ) : null}
                      <OctantButton
                        aria-selected={chosen}
                        {...(refused ? { "aria-disabled": true } : {})}
                        {...(reason === undefined
                          ? {}
                          : { "aria-describedby": reasonId, "aria-labelledby": nameId })}
                        onClick={() => activate(entry)}
                        {...(entry.kind === "default-folder" && reason === undefined
                          ? { title: entry.rootPath }
                          : {})}
                        {...optionProps(index)}
                        {...(reason === undefined
                          ? {}
                          : {
                              className:
                                "octant-popover-option composer-folder-selector__option composer-folder-selector__option--two-line",
                            })}
                      >
                        {entry.kind === "add-github" ? (
                          <FolderGit2 aria-hidden="true" size={14} />
                        ) : entry.kind === "default-folder" || entry.kind === "unfiled" ? (
                          <FolderOpen aria-hidden="true" size={14} />
                        ) : (
                          <FolderPlus aria-hidden="true" size={14} />
                        )}
                        <span className="composer-folder-selector__option-copy">
                          <span className="composer-folder-selector__option-name" id={nameId}>
                            {label}
                          </span>
                          {reason !== undefined ? (
                            // A refused row says why in full under its name, wrapping
                            // if it must; the reason is also the row's description.
                            <span
                              className="composer-folder-selector__option-path composer-folder-selector__option-reason"
                              id={reasonId}
                            >
                              {reason}
                            </span>
                          ) : entry.kind === "unfiled" ? (
                            <span className="composer-folder-selector__option-path">
                              Start an unfiled thread
                            </span>
                          ) : entry.kind === "default-folder" ? (
                            <span className="composer-folder-selector__option-path">
                              {homeRelativePath(entry.rootPath)}
                            </span>
                          ) : null}
                        </span>
                        {check(chosen)}
                      </OctantButton>
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
