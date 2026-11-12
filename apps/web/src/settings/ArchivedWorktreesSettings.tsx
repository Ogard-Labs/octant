import type { ArchivedWorktreesClient } from "@octant/client-runtime/archived-worktrees-client";
import type { ArchivedWorktree } from "@octant/contracts/archived-worktrees";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../environment/threadMove/threadMoveSize";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantFieldError } from "../ui/base/OctantField";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface ArchivedWorktreesSettingsProps {
  /** Absent where the host lists no worktrees, such as a paired device. */
  readonly client: ArchivedWorktreesClient | undefined;
  readonly focusedSetting?: string | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
}

/** What the section says archiving does, in the person's words. */
export const ARCHIVED_WORKTREES_FACT =
  "Archiving a thread removes its worktree when it has no uncommitted changes and its branch is pushed or merged. These are the ones archiving kept.";

/**
 * Settings › Code › Worktrees. Lists the managed worktrees archived threads
 * still keep on this computer, largest first. Remove asks once, because the
 * folder's ignored files (build output, installed dependencies) go with it;
 * the host still refuses a worktree with uncommitted changes and keeps the
 * branch.
 */
export function ArchivedWorktreesSettings(props: ArchivedWorktreesSettingsProps) {
  const { client } = props;
  const [worktrees, setWorktrees] = useState<ReadonlyArray<ArchivedWorktree>>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirming, setConfirming] = useState<ArchivedWorktree>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setWorktrees(await client.list());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(worktree: ArchivedWorktree): Promise<void> {
    if (client === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.remove(worktree.threadId);
      if (result.kind === "archived-worktree-refused") setProblem(result.message);
      await load();
    } catch {
      setProblem("The worktree could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  const body =
    client === undefined ? (
      <SettingsState kind="empty">Worktrees are managed on the host machine.</SettingsState>
    ) : worktrees === undefined ? (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed ? "Worktrees could not be read from this host." : "Reading worktrees…"}
      </SettingsState>
    ) : worktrees.length === 0 ? (
      <SettingsState kind="empty">No archived thread keeps a worktree.</SettingsState>
    ) : (
      <>
        <div className="setgroup">
          {worktrees.map((worktree, index) => (
            <SettingRow
              description={
                <>
                  {props.projectNames.get(String(worktree.projectId)) ?? "Code Project"} ·{" "}
                  <span className="archived-worktrees__mono">{worktree.branch}</span> ·{" "}
                  {worktree.sizeComplete
                    ? formatBytes(worktree.sizeBytes)
                    : `more than ${formatBytes(worktree.sizeBytes)}`}
                  <br />
                  <span className="archived-worktrees__mono">{worktree.path}</span>
                </>
              }
              focused={props.focusedSetting === "archived-worktrees" && index === 0}
              key={String(worktree.threadId)}
              label={worktree.title.trim() === "" ? "Untitled thread" : worktree.title}
              scope="host"
              settingId="archived-worktrees"
            >
              <OctantButton
                disabled={busy}
                onClick={() => setConfirming(worktree)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Remove
              </OctantButton>
            </SettingRow>
          ))}
        </div>
        <div className="settings-feedback-slot" aria-live="polite">
          {problem === undefined ? null : (
            <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
          )}
        </div>
      </>
    );

  return (
    <SettingsSection description={ARCHIVED_WORKTREES_FACT} title="Worktrees">
      {body}
      <OctantDialogPresence>
        {confirming === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel="Remove worktree"
            destructive
            onCancel={() => setConfirming(undefined)}
            onConfirm={() => {
              const worktree = confirming;
              setConfirming(undefined);
              void remove(worktree);
            }}
            pending={busy}
            title="Remove this worktree?"
          >
            Deletes {confirming.path}, including ignored files such as build output and installed
            dependencies. The branch {confirming.branch} and its commits stay. A worktree with
            uncommitted changes is kept.
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </SettingsSection>
  );
}
