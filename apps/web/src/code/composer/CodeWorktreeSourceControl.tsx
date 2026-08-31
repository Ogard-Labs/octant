import {
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
    ? "No usable remote is configured for this branch, so the new worktree starts from the local commit."
    : props.startFromOrigin
      ? `Fetch and start from ${activeRemote ?? "origin"}/${props.branch}`
      : `Start from the local ${props.branch} commit.`;

  return (
    <section aria-label="Worktree source" className="code-worktree-source">
      <div className="code-worktree-source__row">
        <OctantSwitch
          checked={props.startFromOrigin && remoteAvailable}
          describedBy="code-worktree-source-copy"
          disabled={switchDisabled}
          label="Start from origin"
          onCheckedChange={props.onStartFromOriginChange}
        />
        <div className="code-worktree-source__labels">
          <span className="code-worktree-source__title">Start from origin</span>
          <span className="code-worktree-source__copy" id="code-worktree-source-copy">
            {supportingCopy}
          </span>
        </div>
      </div>

      {disclosure === undefined ? null : (
        <p aria-live="polite" className="code-worktree-source__disclosure" role="status">
          <span className="code-worktree-source__disclosure-label">{disclosure.label}</span>
          {disclosure.detail === undefined ? null : (
            <span className="code-worktree-source__disclosure-detail">{disclosure.detail}</span>
          )}
        </p>
      )}

      {props.resolution.kind === "failed" && props.onRefresh !== undefined ? (
        <div className="code-worktree-source__retry">
          <OctantButton onClick={props.onRefresh} size="sm" type="button" variant="ghost">
            Retry fetch
          </OctantButton>
        </div>
      ) : null}

      {props.startFromOrigin && remoteAvailable && props.remoteFacts.remotes.length > 0 ? (
        <label className="code-worktree-source__field">
          <span>Remote</span>
          <OctantSelectField
            aria-label="Remote"
            disabled={props.disabled === true || props.onSelectRemote === undefined}
            onValueChange={(value) => props.onSelectRemote?.(value)}
            options={props.remoteFacts.remotes.map((remote) => ({
              id: remote,
              label: remote,
            }))}
            value={activeRemote ?? props.remoteFacts.remotes[0] ?? ""}
          />
        </label>
      ) : null}
    </section>
  );
}
