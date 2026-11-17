import {
  branchDisplayName,
  describeWorktreeSource,
  selectWorktreeRemote,
  type WorktreeRemoteFacts,
  type WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantSwitch } from "../../ui/base/OctantSwitch";

export interface CodeWorktreeSourceControlProps {
  readonly branch: string;
  readonly remoteFacts: WorktreeRemoteFacts;
  readonly resolution: WorktreeSourceResolution;
  readonly startFromOrigin: boolean;
  readonly onStartFromOriginChange: (value: boolean) => void;
  readonly selectedRemote?: string;
  readonly onSelectRemote?: (remoteName: string) => void;
  readonly onRefresh?: () => void;
  readonly now?: () => Date;
  readonly disabled?: boolean;
}

/**
 * Composer-first "Start from origin" control for new managed Code worktrees.
 * Presentational and controlled: the authoritative fetch, exact-ref resolution,
 * worktree creation, and receipt provenance live on the server. This only
 * surfaces the default, the remote preference, the exact resolved SHA /
 * freshness disclosure, and an explicit retry on failure. It never mutates a
 * checkout or local ref and never infers a SHA client-side.
 */
export function CodeWorktreeSourceControl(props: CodeWorktreeSourceControlProps) {
  const now = props.now ?? (() => new Date());
  const selection = selectWorktreeRemote(props.remoteFacts);
  const remoteAvailable = selection.status === "selected";
  const switchDisabled = props.disabled === true || !remoteAvailable;
  const activeRemote =
    props.selectedRemote ?? (selection.status === "selected" ? selection.remoteName : undefined);
  const disclosure = describeWorktreeSource(props.resolution, now);

  const supportingCopy = !remoteAvailable
    ? "No usable remote is configured for this branch. It starts from the local commit."
    : props.startFromOrigin
      ? `Fetch and start from ${activeRemote ?? "origin"}/${branchDisplayName(props.branch)}`
      : `Start from the local ${branchDisplayName(props.branch)} commit.`;

  const remotes = props.remoteFacts.remotes;
  const remoteChoosable = props.startFromOrigin && remoteAvailable && remotes.length > 0;

  // Every row is laid out in every state: a missing remote, a fetch in flight
  // and a failed fetch change what the rows say, never how many there are, so
  // the panel that holds them keeps its size while the answer arrives.
  return (
    <section aria-label="Worktree source" className="code-worktree-source">
      <div className="code-worktree-source__row" data-reserved="">
        <div className="code-worktree-source__labels">
          <span className="oct-menu-option">Start from origin</span>
          <span
            className="oct-menu-detail code-worktree-source__copy"
            id="code-worktree-source-copy"
            title={supportingCopy}
          >
            {supportingCopy}
          </span>
        </div>
        <OctantSwitch
          checked={props.startFromOrigin && remoteAvailable}
          describedBy="code-worktree-source-copy"
          disabled={switchDisabled}
          label="Start from origin"
          onCheckedChange={props.onStartFromOriginChange}
        />
      </div>

      <p
        aria-live="polite"
        className="code-worktree-source__disclosure"
        data-reserved=""
        role="status"
      >
        {disclosure === undefined ? null : (
          <>
            <span className="code-worktree-source__disclosure-label">{disclosure.label}</span>
            {/* "May differ from the remote" says nothing when there is no
                remote to differ from; the note above already says so. */}
            {disclosure.detail === undefined || !remoteAvailable ? null : (
              <span className="oct-menu-detail code-worktree-source__disclosure-detail">
                {disclosure.detail}
              </span>
            )}
          </>
        )}
        {props.resolution.kind === "failed" && props.onRefresh !== undefined ? (
          <OctantButton onClick={props.onRefresh} size="sm" type="button" variant="ghost">
            Retry fetch
          </OctantButton>
        ) : null}
      </p>

      {remotes.length === 0 ? (
        // With no remote there is nothing to choose; a disabled list reading
        // "None" looked like a control that was broken.
        <div className="code-worktree-source__field" data-reserved="">
          <span className="oct-menu-option">Remote</span>
          <span className="oct-menu-detail">None</span>
        </div>
      ) : (
        <label className="code-worktree-source__field" data-reserved="">
          <span className="oct-menu-option">Remote</span>
          <OctantSelectField
            aria-label="Remote"
            disabled={
              props.disabled === true || props.onSelectRemote === undefined || !remoteChoosable
            }
            onValueChange={(value) => props.onSelectRemote?.(value)}
            options={remotes.map((remote) => ({ id: remote, label: remote }))}
            value={activeRemote ?? remotes[0] ?? ""}
          />
        </label>
      )}
    </section>
  );
}
