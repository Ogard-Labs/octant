import type {
  FolderBrowseMode,
  FolderBrowseResult,
  FolderCandidate,
  FolderCandidateId,
} from "@octant/contracts/folder-browse";
import type { HostId } from "@octant/contracts/host";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import { ChevronRight, FolderOpen, GitBranch, Home, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface FolderPickerProps {
  /**
   * The host's browser. `select` is only needed to bind a Project root; a
   * picker that reports candidates itself takes `onSelectCandidate` instead and
   * never asks the host to bind anything.
   */
  readonly client: Pick<FolderBrowseClient, "browse"> & Partial<Pick<FolderBrowseClient, "select">>;
  readonly mode: FolderBrowseMode;
  readonly hostId: string;
  /** Needed only to bind a Project root; a candidate picker omits it. */
  readonly onSelect?: (
    receiptId: string,
    displayName: string,
    selection?: { readonly initializeGit?: boolean },
  ) => void;
  /**
   * Report the chosen candidate to the caller instead of binding it as a
   * Project root — for a choice that is not a binding, like an export folder.
   */
  readonly onSelectCandidate?: (candidate: FolderCandidate) => void;
  readonly onCancel: () => void;
  /** Overrides the mode-derived title, e.g. when browsing for a clone destination. */
  readonly title?: string;
  readonly hint?: string;
  /** Defaults to on for Code; the clone destination browser has no Git checkbox. */
  readonly showGitInit?: boolean;
  /**
   * Whether the header names the mode above the title. Defaults to on; a
   * picker that is not binding a Project, such as the sync folder, hides it.
   */
  readonly showMode?: boolean;
}

type PickerStatus = "loading" | "ready" | "error";

/**
 * Host folder browser for Code/Work Project binding. Any directory can be
 * selected in either mode; Git status is shown as information only.
 */
export function FolderPicker(props: FolderPickerProps) {
  const titleId = useId();
  const hintId = useId();
  const [status, setStatus] = useState<PickerStatus>("loading");
  const [result, setResult] = useState<FolderBrowseResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [searchInput, setSearchInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [initializeGit, setInitializeGit] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const parentCandidateIdRef = useRef<string | undefined>(undefined);
  // Retry must re-issue the exact request that failed, not reset to the root.
  const lastRequestRef = useRef<{
    parentCandidateId: string | undefined;
    search: string | undefined;
  }>({ parentCandidateId: undefined, search: undefined });

  const load = useCallback(
    async (parentCandidateId?: string, search?: string) => {
      lastRequestRef.current = { parentCandidateId, search };
      setStatus("loading");
      setErrorMessage(undefined);
      try {
        const browseResult = await props.client.browse({
          hostId: props.hostId as HostId,
          mode: props.mode,
          ...(parentCandidateId !== undefined
            ? { parentCandidateId: parentCandidateId as FolderCandidateId }
            : {}),
          ...(search !== undefined && search.trim() !== "" ? { search: search.trim() } : {}),
        });
        if (!mounted.current) return;
        parentCandidateIdRef.current = parentCandidateId;
        setResult(browseResult);
        setStatus("ready");
      } catch (error) {
        if (!mounted.current) return;
        const message = error instanceof Error ? error.message : "Cannot browse folders.";
        setErrorMessage(message);
        setStatus("error");
      }
    },
    [props.client, props.hostId, props.mode],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    };
  }, [load]);

  function clearSearchTimer() {
    if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
  }

  function handleSearchChange(value: string) {
    setSearchInput(value);
    clearSearchTimer();
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      void load(parentCandidateIdRef.current, value).finally(() => {
        if (mounted.current) setSearching(false);
      });
    }, 300);
  }

  function navigateInto(candidate: FolderCandidate) {
    clearSearchTimer();
    setSearchInput("");
    void load(candidate.candidateId);
  }

  async function selectCandidate(candidate: FolderCandidate) {
    if (!candidate.isSelectable || selecting) return;
    if (props.onSelectCandidate !== undefined) {
      props.onSelectCandidate(candidate);
      return;
    }
    const select = props.client.select;
    if (select === undefined) return;
    setSelecting(true);
    setErrorMessage(undefined);
    try {
      const selection = await select({
        hostId: props.hostId as HostId,
        mode: props.mode,
        candidateId: candidate.candidateId as FolderCandidateId,
      });
      props.onSelect?.(
        selection.receiptId,
        selection.displayName,
        props.mode === "code" ? { initializeGit } : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cannot select folder.";
      setErrorMessage(message);
      setSelecting(false);
    }
  }

  function navigateToBreadcrumb(candidateId: FolderCandidateId) {
    clearSearchTimer();
    setSearchInput("");
    void load(candidateId);
  }

  function requestClose() {
    if (selecting) return;
    props.onCancel();
  }

  const title = props.title ?? (props.mode === "work" ? "Add Work folder" : "Add Code folder");
  const hint =
    props.hint ??
    (props.mode === "code"
      ? "Navigate into a folder, then Select the directory to bind."
      : "Navigate into a folder, then Select the confined project root.");

  return (
    <OctantDialog
      className="folder-picker"
      describedBy={hintId}
      label={title}
      labelledBy={titleId}
      onClose={requestClose}
      open
    >
      <div className="folder-picker__header">
        <div>
          {props.showMode === false ? null : <span>{props.mode === "code" ? "Code" : "Work"}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <OctantButton
          aria-label="Cancel"
          disabled={selecting}
          onClick={requestClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p className="folder-picker__hint" id={hintId}>
        {hint}
      </p>
      <div className="folder-picker__search">
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          aria-label="Search folders"
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search folders…"
          type="search"
          value={searchInput}
        />
      </div>
      {result !== null && result.breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="folder-picker__breadcrumbs">
          {result.breadcrumbs.map((crumb, i) => {
            const candidateId = crumb.candidateId;
            return (
              <span
                className="folder-picker__breadcrumb-wrap"
                key={`${candidateId ?? "current"}-${crumb.label}-${i}`}
              >
                {i > 0 ? <ChevronRight aria-hidden="true" size={12} strokeWidth={1.8} /> : null}
                {candidateId === undefined ? (
                  <span
                    aria-current="page"
                    className="folder-picker__breadcrumb folder-picker__breadcrumb--current"
                  >
                    {i === 0 ? <Home aria-hidden="true" size={12} strokeWidth={1.8} /> : null}
                    <span>{crumb.label}</span>
                  </span>
                ) : (
                  <OctantButton
                    className="folder-picker__breadcrumb"
                    onClick={() => navigateToBreadcrumb(candidateId)}
                    type="button"
                    variant="ghost"
                  >
                    {i === 0 ? <Home aria-hidden="true" size={12} strokeWidth={1.8} /> : null}
                    <span>{crumb.label}</span>
                  </OctantButton>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
      <div className="folder-picker__list" role="listbox" aria-label="Folders">
        {status === "loading" || searching ? (
          <p className="folder-picker__status" role="status">
            Loading…
          </p>
        ) : status === "error" ? (
          <div className="folder-picker__status folder-picker__status--error">
            <p>{errorMessage}</p>
            <OctantButton
              onClick={() => {
                const last = lastRequestRef.current;
                void load(last.parentCandidateId, last.search);
              }}
              type="button"
              variant="outline"
            >
              Retry
            </OctantButton>
          </div>
        ) : result !== null && result.candidates.length === 0 ? (
          <p className="folder-picker__status">No folders found.</p>
        ) : result !== null ? (
          result.candidates.map((candidate) => (
            <div
              aria-disabled={false}
              aria-selected={false}
              className={`folder-picker__item${candidate.isSelectable ? "" : " folder-picker__item--disabled"}`}
              key={candidate.candidateId}
              role="option"
              title={candidate.unselectableReason}
            >
              <OctantButton
                className="folder-picker__item-nav"
                onClick={() => navigateInto(candidate)}
                type="button"
                variant="ghost"
              >
                {candidate.isGitRepository ? (
                  <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
                ) : (
                  <FolderOpen aria-hidden="true" size={14} strokeWidth={1.8} />
                )}
                <span className="folder-picker__item-name">{candidate.displayName}</span>
                {props.mode === "code" && !candidate.isGitRepository ? (
                  <OctantBadge variant="secondary">Not a git repo</OctantBadge>
                ) : null}
              </OctantButton>
              {candidate.isSelectable ? (
                <OctantButton
                  className="folder-picker__item-select"
                  disabled={selecting}
                  onClick={() => void selectCandidate(candidate)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Select
                </OctantButton>
              ) : (
                <OctantButton
                  className="folder-picker__item-open"
                  onClick={() => navigateInto(candidate)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Open
                </OctantButton>
              )}
            </div>
          ))
        ) : null}
      </div>
      {errorMessage === undefined || status === "error" ? null : (
        <OctantAlert className="folder-picker__error" tone="danger">
          {errorMessage}
        </OctantAlert>
      )}
      {props.mode === "code" && props.showGitInit !== false ? (
        <label className="folder-picker__git-init" htmlFor="folder-picker-initialize-git">
          <OctantCheckbox
            checked={initializeGit}
            disabled={selecting}
            id="folder-picker-initialize-git"
            onChange={(event) => setInitializeGit(event.target.checked)}
          />
          <span>Initialize as a Git repository when needed</span>
        </label>
      ) : null}
      <div className="folder-picker__actions">
        <OctantButton
          className="project-button project-button--quiet"
          disabled={selecting}
          onClick={requestClose}
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
