import type { ArchivedWorktreesClient } from "@octant/client-runtime/archived-worktrees-client";
import type { CleanedUpWorktree } from "@octant/contracts/cleaned-up-worktrees";
import { useCallback, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface CleanedUpWorktreesSettingsProps {
  /** Absent where the host cleans up no worktrees, such as a paired device. */
  readonly client: ArchivedWorktreesClient | undefined;
  readonly focusedSetting?: string | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
}

export const CLEANED_UP_WORKTREES_FACT =
  "These threads' worktree folders were removed to save space. The branch, the thread and its checkpoints are kept, and a thread takes no new turn until its worktree is restored.";

const STATE_COPY: Record<CleanedUpWorktree["state"], string> = {
  "cleaned-up": "Cleaned up",
  "cleaning-up": "Cleanup was interrupted",
  restoring: "Restore was interrupted",
};

/**
 * Settings › Code › Worktrees › Cleaned up. Lists the threads whose worktree
 * the host removed and can bring back. Restore recreates the folder on the
 * recorded branch and commit; the host refuses it when the branch has moved.
 */
export function CleanedUpWorktreesSettings(props: CleanedUpWorktreesSettingsProps) {
  const { client } = props;
  const [worktrees, setWorktrees] = useState<ReadonlyArray<CleanedUpWorktree>>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setWorktrees(await client.listCleanedUp());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(worktree: CleanedUpWorktree): Promise<void> {
    if (client === undefined) return;
    setBusy(String(worktree.threadId));
    setProblem(undefined);
    try {
      const result = await client.restore(worktree.threadId);
      if (result.kind === "cleaned-up-worktree-refused") setProblem(result.message);
      await load();
    } catch {
      setProblem("The worktree could not be restored.");
    } finally {
      setBusy(undefined);
    }
  }

  // A host with nothing cleaned up shows no section at all: most people never
  // turn cleanup on, and an empty list would only ask a question they never had.
  // A warning from a restore stays, though its row is gone, until dismissed.
  if (client === undefined) return null;
  if (worktrees !== undefined && worktrees.length === 0 && problem === undefined) return null;

  return (
    <SettingsSection description={CLEANED_UP_WORKTREES_FACT} title="Cleaned-up worktrees">
      {worktrees === undefined ? (
        <SettingsState kind={loadFailed ? "error" : "loading"}>
          {loadFailed ? "Cleaned-up worktrees could not be read." : "Reading worktrees…"}
        </SettingsState>
      ) : (
        <>
          {worktrees.length === 0 ? null : (
            <div className="setgroup">
              {worktrees.map((worktree, index) => (
                <SettingRow
                  description={
                    <>
                      {props.projectNames.get(String(worktree.projectId)) ?? "Code Project"} ·{" "}
                      <span className="archived-worktrees__mono">{worktree.branch}</span> ·{" "}
                      {STATE_COPY[worktree.state]}
                    </>
                  }
                  focused={props.focusedSetting === "cleaned-up-worktrees" && index === 0}
                  key={String(worktree.threadId)}
                  label={worktree.title.trim() === "" ? "Untitled thread" : worktree.title}
                  scope="host"
                  settingId="cleaned-up-worktrees"
                >
                  <OctantButton
                    disabled={busy !== undefined}
                    onClick={() => void restore(worktree)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {busy === String(worktree.threadId) ? "Restoring…" : "Restore worktree"}
                  </OctantButton>
                </SettingRow>
              ))}
            </div>
          )}
          <div className="settings-feedback-slot" aria-live="polite">
            {problem === undefined ? null : (
              <>
                <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
                <OctantButton
                  onClick={() => setProblem(undefined)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Dismiss
                </OctantButton>
              </>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
