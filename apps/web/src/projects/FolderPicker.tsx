import type {
  FolderBrowseMode,
  FolderBrowseResult,
  FolderCandidate,
  FolderCandidateId,
} from "@octant/contracts/folder-browse";
import type { HostId } from "@octant/contracts/host";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import { ChevronRight, FolderOpen, GitBranch, Home, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FolderPickerProps {
  readonly client: FolderBrowseClient;
  readonly mode: FolderBrowseMode;
  readonly hostId: string;
  readonly onSelect: (receiptId: string, displayName: string) => void;
  readonly onCancel: () => void;
}

type PickerStatus = "loading" | "ready" | "error";

/**
 * Host folder browser for Code/Work Project binding. Any directory can be
 * selected in either mode; Git status is shown as information only.
 */
export function FolderPicker(props: FolderPickerProps) {
  const [status, setStatus] = useState<PickerStatus>("loading");
  const [result, setResult] = useState<FolderBrowseResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [searchInput, setSearchInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const parentCandidateIdRef = useRef<string | undefined>(undefined);

  const load = useCallback(
    async (parentCandidateId?: string, search?: string) => {
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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);

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
    setSelecting(true);
    setErrorMessage(undefined);
    try {
      const selection = await props.client.select({
        hostId: props.hostId as HostId,
        mode: props.mode,
        candidateId: candidate.candidateId as FolderCandidateId,
      });
      props.onSelect(selection.receiptId, selection.displayName);
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

  const title = props.mode === "work" ? "Add Work folder" : "Add Code folder";
  const hint =
    props.mode === "code"
      ? "Navigate into a folder, then Select the directory to bind."
      : "Navigate into a folder, then Select the confined project root.";

  return (
    <dialog
      aria-label="Add folder"
      className="folder-picker window-no-drag"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      ref={dialogRef}
    >
      <div className="folder-picker__header">
        <div>
          <span>{props.mode === "code" ? "Code" : "Work"}</span>
          <h2 id="folder-picker-title">{title}</h2>
        </div>
        <button aria-label="Cancel" disabled={selecting} onClick={requestClose} type="button">
          ×
        </button>
      </div>
      <p className="folder-picker__hint">{hint}</p>
      <div className="folder-picker__search">
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <input
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
                  <button
                    className="folder-picker__breadcrumb"
                    onClick={() => navigateToBreadcrumb(candidateId)}
                    type="button"
                  >
                    {i === 0 ? <Home aria-hidden="true" size={12} strokeWidth={1.8} /> : null}
                    <span>{crumb.label}</span>
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
      <div className="folder-picker__list" role="listbox" aria-label="Folders">
        {status === "loading" || searching ? (
          <p className="folder-picker__status">Loading…</p>
        ) : status === "error" ? (
          <div className="folder-picker__status folder-picker__status--error">
            <p>{errorMessage}</p>
            <button onClick={() => void load()} type="button">
              Retry
            </button>
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
              <button
                className="folder-picker__item-nav"
                onClick={() => navigateInto(candidate)}
                type="button"
              >
                {candidate.isGitRepository ? (
                  <GitBranch aria-hidden="true" size={14} strokeWidth={1.8} />
                ) : (
                  <FolderOpen aria-hidden="true" size={14} strokeWidth={1.8} />
                )}
                <span className="folder-picker__item-name">{candidate.displayName}</span>
                {props.mode === "code" && !candidate.isGitRepository ? (
                  <span className="folder-picker__item-badge">Not a git repo</span>
                ) : null}
              </button>
              {candidate.isSelectable ? (
                <button
                  className="folder-picker__item-select"
                  disabled={selecting}
                  onClick={() => void selectCandidate(candidate)}
                  type="button"
                >
                  Select
                </button>
              ) : (
                <button
                  className="folder-picker__item-open"
                  onClick={() => navigateInto(candidate)}
                  type="button"
                >
                  Open
                </button>
              )}
            </div>
          ))
        ) : null}
      </div>
      {errorMessage === undefined || status === "error" ? null : (
        <p className="folder-picker__error" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="folder-picker__actions">
        <button
          className="project-button project-button--quiet"
          disabled={selecting}
          onClick={requestClose}
          type="button"
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
