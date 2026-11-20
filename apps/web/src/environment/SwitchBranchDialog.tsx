import type { CodeWorktreeRef } from "@octant/contracts";
import { useEffect, useId, useState } from "react";
import type {
  CodeBranchPreviewOutcome,
  CodeBranchStatePreview,
  SwitchCodeBranchOutcome,
} from "../code/switchCodeBranch";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export interface SwitchBranchDialogProps {
  /** The checkout's current branch, so it is never offered as a target. */
  readonly currentBranch: string;
  readonly onSwitch: (request: {
    readonly branch: string;
    readonly dirty: "refuse" | "stash";
    readonly expectedStateToken: string;
  }) => Promise<SwitchCodeBranchOutcome>;
  /** Server-authoritative ref list, read once when the dialog opens. */
  readonly fetchRefs: () => Promise<ReadonlyArray<CodeWorktreeRef>>;
  /**
   * The working-tree reading the person consents against: its token travels
   * with the switch, so a checkout that changed in between is refused rather
   * than stashed unseen. Read again only after a stale answer.
   */
  readonly fetchPreview: () => Promise<CodeBranchPreviewOutcome>;
  /** Opens the Git pane's reviewed stage/commit form for this checkout. */
  readonly onOpenGit?: (() => void) | undefined;
  readonly onClose: () => void;
}

/** What a status entry's two Git columns read as in the consent list. */
function entryKind(entry: CodeBranchStatePreview["entries"][number]): string {
  if (entry.index === "?" || entry.worktree === "?") return "untracked";
  if (entry.index !== " ") return "staged";
  return "modified";
}

/**
 * Switches this thread's checkout to another existing local branch. The first
 * attempt always asks the host to refuse on a dirty tree; only then does the
 * person choose between the existing commit flow (the Git pane) and an
 * explicit stash, against the observed entries on screen. A stale answer
 * means the checkout moved since that reading: the preview is re-read and
 * shown again, and nothing is sent until the person chooses a second time.
 */
export function SwitchBranchDialog(props: SwitchBranchDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [refs, setRefs] = useState<ReadonlyArray<CodeWorktreeRef>>();
  const [refsFailed, setRefsFailed] = useState(false);
  const [preview, setPreview] = useState<CodeBranchStatePreview>();
  const [previewFailed, setPreviewFailed] = useState<string>();
  const [branch, setBranch] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);

  useEffect(() => {
    let mounted = true;
    void props
      .fetchRefs()
      .then((listed) => {
        if (mounted) setRefs(listed);
      })
      .catch(() => {
        if (mounted) setRefsFailed(true);
      });
    void props
      .fetchPreview()
      .then((outcome) => {
        if (!mounted) return;
        if (outcome.status === "ok") setPreview(outcome.preview);
        else setPreviewFailed(outcome.message);
      })
      .catch(() => {
        if (mounted) setPreviewFailed("The checkout could not be read.");
      });
    return () => {
      mounted = false;
    };
    // The ref list is read once at open; refetching would move the rows under
    // a person who is already choosing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choices = (refs ?? []).filter(
    (ref) =>
      ref.kind === "local" &&
      ref.isCurrent !== true &&
      ref.hasWorktree !== true &&
      ref.name !== props.currentBranch,
  );

  async function refreshPreview(): Promise<boolean> {
    try {
      const outcome = await props.fetchPreview();
      if (outcome.status === "ok") {
        setPreview(outcome.preview);
        setPreviewFailed(undefined);
        setStaleNotice(true);
        return true;
      }
      setPreview(undefined);
      setPreviewFailed(outcome.message);
      return false;
    } catch {
      setPreview(undefined);
      setPreviewFailed("The checkout could not be read.");
      return false;
    }
  }

  async function requestSwitch(target: string, dirtyMode: "refuse" | "stash"): Promise<void> {
    if (busy || preview === undefined) return;
    setBusy(true);
    setRefusal(undefined);
    setStaleNotice(false);
    try {
      const outcome = await props.onSwitch({
        branch: target,
        dirty: dirtyMode,
        expectedStateToken: preview.stateToken,
      });
      if (outcome.status === "ok") {
        props.onClose();
        return;
      }
      if (outcome.reason === "stale-state") {
        // The tree moved since the preview on screen: re-read it and ask
        // again, so consent is always to what was last shown.
        setDirty(dirtyMode === "stash");
        await refreshPreview();
        return;
      }
      if (outcome.reason === "dirty-checkout" && dirtyMode === "refuse") {
        setDirty(true);
        return;
      }
      setRefusal(outcome.message);
    } finally {
      setBusy(false);
    }
  }

  const pendingEntries = preview?.entries ?? [];

  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Switch branch"
      labelledBy={titleId}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      open
      popupId="switch-branch-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Switch branch</h1>
      </div>
      <p id={descriptionId}>
        {dirty
          ? "This checkout has the uncommitted changes listed below. Commit them in Git, or stash them before switching. Nothing is committed or discarded without a choice."
          : `Move this task's checkout from ${props.currentBranch} to another local branch.`}
      </p>
      {dirty ? (
        pendingEntries.length === 0 ? null : (
          <ul aria-label="Uncommitted changes" className="move-thread__list">
            {pendingEntries.map((entry) => (
              <li key={`${entry.index}:${entry.worktree}:${entry.path}`}>
                <span className="move-thread__title">
                  <span className="move-thread__name">{entry.path}</span>
                </span>{" "}
                <span className="move-thread__reason">{entryKind(entry)}</span>
              </li>
            ))}
          </ul>
        )
      ) : refs === undefined && !refsFailed ? (
        <p>Reading local branches…</p>
      ) : choices.length === 0 ? (
        <p>
          {refsFailed
            ? "Local branches could not be read."
            : "No other local branch is free for this checkout."}
        </p>
      ) : (
        <ul aria-label="Local branches" className="move-thread__list">
          {choices.map((ref) => (
            <li key={ref.name}>
              <OctantButton
                aria-pressed={branch === ref.name}
                className="move-thread__choice"
                disabled={busy}
                onClick={() => setBranch(ref.name)}
                type="button"
                variant="outline"
              >
                <span className="move-thread__title">
                  <span className="move-thread__name">{ref.name}</span>
                </span>
              </OctantButton>
              {branch === ref.name ? <span className="move-thread__reason">Selected</span> : null}
            </li>
          ))}
        </ul>
      )}
      {staleNotice ? (
        <OctantAlert tone="warning">
          The checkout changed since it was read. Review it again before switching.
        </OctantAlert>
      ) : null}
      {previewFailed !== undefined ? (
        <OctantAlert tone="danger">{previewFailed}</OctantAlert>
      ) : null}
      {refusal === undefined ? null : <OctantAlert tone="danger">{refusal}</OctantAlert>}
      <div className="project-dialog__actions">
        {dirty ? (
          <>
            {props.onOpenGit === undefined ? null : (
              <OctantButton
                onClick={() => {
                  props.onOpenGit?.();
                  props.onClose();
                }}
                type="button"
                variant="outline"
              >
                Commit in Git
              </OctantButton>
            )}
            <OctantButton
              disabled={busy || branch === undefined || preview === undefined}
              onClick={() => {
                if (branch !== undefined) void requestSwitch(branch, "stash");
              }}
              type="button"
              variant="solid"
            >
              Stash and switch
            </OctantButton>
          </>
        ) : (
          <OctantButton
            disabled={busy || branch === undefined || preview === undefined}
            onClick={() => {
              if (branch !== undefined) void requestSwitch(branch, "refuse");
            }}
            type="button"
            variant="solid"
          >
            Switch
          </OctantButton>
        )}
        <OctantButton
          disabled={busy}
          onClick={() => props.onClose()}
          type="button"
          variant="outline"
        >
          Cancel
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
