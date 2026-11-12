import type { DiskCleanupClient } from "@octant/client-runtime/disk-cleanup-client";
import type {
  HostWorktree,
  HostWorktreeScan,
  RemoveHostWorktreeResult,
  UnpushedCommit,
} from "@octant/contracts/disk-cleanup";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../environment/threadMove/threadMoveSize";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantFieldError } from "../ui/base/OctantField";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

export interface HostWorktreesSettingsProps {
  /** Absent where the host lists no worktrees, such as a paired device. */
  readonly client: DiskCleanupClient | undefined;
  readonly focusedSetting?: string | undefined;
}

export const HOST_WORKTREES_FACT =
  "Worktrees other tools and agents made, found in your home folder and your Code Projects' repositories. Removing one keeps its branch, and Octant refuses one with uncommitted changes.";

interface Target {
  readonly repositoryPath: string;
  readonly worktree: HostWorktree;
}

type Asking =
  | { readonly kind: "remove"; readonly target: Target }
  | { readonly kind: "bulk"; readonly targets: ReadonlyArray<Target> }
  | {
      readonly kind: "unpushed";
      readonly target: Target;
      readonly commits: ReadonlyArray<UnpushedCommit>;
      readonly count: number;
    }
  | {
      readonly kind: "recent";
      readonly target: Target;
      readonly confirmedCommits?: ReadonlyArray<string>;
    };

function worktrees(count: number): string {
  return count === 1 ? "1 worktree" : `${String(count)} worktrees`;
}

/** Safe to remove without asking more: its folder is gone, or its work is pushed or merged. */
function looksSafe(worktree: HostWorktree): boolean {
  return !worktree.locked && (worktree.missing || worktree.delivered === true);
}

function describe(worktree: HostWorktree): string {
  const facts: string[] = [];
  if (worktree.missing) facts.push("Folder is gone");
  if (worktree.locked) facts.push("Locked by Git");
  if (!worktree.missing && worktree.delivered === true) facts.push("Merged or pushed");
  if (!worktree.missing && worktree.delivered === false) facts.push("Has commits only here");
  if (worktree.sizeBytes !== undefined) {
    facts.push(
      worktree.sizeComplete === false
        ? `more than ${formatBytes(worktree.sizeBytes)}`
        : formatBytes(worktree.sizeBytes),
    );
  }
  if (worktree.lastActivityAt !== undefined) {
    facts.push(`last used ${new Date(worktree.lastActivityAt).toLocaleDateString()}`);
  }
  return facts.join(" · ");
}

/**
 * Settings › Code › Worktrees on this computer. The host scans when asked and
 * keeps the result until it restarts. Remove asks first; the host then works
 * out again what the worktree holds and may ask about commits only it has, or
 * about recent use, before it removes anything.
 */
export function HostWorktreesSettings(props: HostWorktreesSettingsProps) {
  const { client } = props;
  const [scan, setScan] = useState<HostWorktreeScan>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [asking, setAsking] = useState<Asking>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setScan(await client.worktrees());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function scanNow() {
    if (client === undefined) return;
    setScanning(true);
    setMessage(undefined);
    try {
      setScan(await client.scanWorktrees());
    } catch {
      setMessage("This computer could not be scanned for worktrees.");
    } finally {
      setScanning(false);
    }
  }

  async function attempt(
    target: Target,
    confirmedCommits?: ReadonlyArray<string>,
    confirmedRecentActivity?: boolean,
  ): Promise<RemoveHostWorktreeResult | undefined> {
    if (client === undefined) return undefined;
    return client.removeWorktree({
      repositoryPath: target.repositoryPath,
      worktreePath: target.worktree.path,
      confirmed: true,
      ...(confirmedCommits === undefined ? {} : { confirmedCommits: [...confirmedCommits] }),
      ...(confirmedRecentActivity === undefined ? {} : { confirmedRecentActivity }),
    });
  }

  async function remove(
    target: Target,
    confirmedCommits?: ReadonlyArray<string>,
    confirmedRecentActivity?: boolean,
  ) {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await attempt(target, confirmedCommits, confirmedRecentActivity);
      if (result === undefined) return;
      if (result.kind === "host-worktree-needs-confirmation") {
        if (result.reason === "unpushed-commits") {
          setAsking({
            kind: "unpushed",
            target,
            commits: result.commits ?? [],
            count: result.commitCount ?? result.commits?.length ?? 0,
          });
        } else {
          setAsking({
            kind: "recent",
            target,
            ...(confirmedCommits === undefined ? {} : { confirmedCommits }),
          });
        }
        return;
      }
      if (result.kind === "host-worktree-refused") setMessage(result.message);
      await load();
    } catch {
      setMessage("The worktree could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  /** Removes every worktree that looks safe, skipping any the host still asks about. */
  async function removeSafe(targets: ReadonlyArray<Target>) {
    setBusy(true);
    setMessage(undefined);
    let removed = 0;
    let kept = 0;
    try {
      for (const target of targets) {
        const result = await attempt(target).catch(() => undefined);
        if (
          result?.kind === "host-worktree-removed" ||
          result?.kind === "host-worktree-forgotten"
        ) {
          removed += 1;
        } else {
          kept += 1;
        }
      }
      setMessage(
        kept === 0
          ? `Removed ${worktrees(removed)}.`
          : `Removed ${worktrees(removed)}; ${String(kept)} stayed because they need a look first.`,
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  const targets: ReadonlyArray<Target> =
    scan?.repositories.flatMap((repo) =>
      repo.worktrees.map((worktree) => ({ repositoryPath: repo.path, worktree })),
    ) ?? [];
  const safe = targets.filter((target) => looksSafe(target.worktree));

  const body =
    client === undefined ? (
      <SettingsState kind="empty">Worktrees are managed on the host machine.</SettingsState>
    ) : scan === undefined ? (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed ? "Worktrees could not be read from this host." : "Reading worktrees…"}
      </SettingsState>
    ) : (
      <>
        <div className="setgroup">
          <SettingRow
            description={
              scan.scannedAt === undefined
                ? "Not scanned since Octant started."
                : `Scanned ${new Date(scan.scannedAt).toLocaleString()}${scan.complete ? "" : ", stopped early in a very large home folder"}. ${String(targets.length)} found.`
            }
            focused={props.focusedSetting === "host-worktrees"}
            label="Scan this computer"
            scope="host"
            settingId="host-worktrees"
          >
            <div className="host-worktrees__actions">
              {safe.length === 0 ? null : (
                <OctantButton
                  disabled={busy || scanning}
                  onClick={() => setAsking({ kind: "bulk", targets: safe })}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove {String(safe.length)} merged or gone
                </OctantButton>
              )}
              <OctantButton
                disabled={busy || scanning}
                onClick={() => void scanNow()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {scanning ? "Scanning…" : "Scan"}
              </OctantButton>
            </div>
          </SettingRow>
        </div>
        {scan.repositories.map((repo) => (
          <div className="setgroup" key={repo.path}>
            <p className="settings-section-line archived-worktrees__mono">{repo.path}</p>
            {repo.worktrees.map((worktree) => (
              <SettingRow
                description={
                  <>
                    {describe(worktree)}
                    <br />
                    <span className="archived-worktrees__mono">{worktree.path}</span>
                  </>
                }
                key={worktree.path}
                label={worktree.branch ?? "Detached HEAD"}
                scope="host"
                settingId="host-worktrees"
              >
                <OctantButton
                  disabled={busy || worktree.locked}
                  onClick={() =>
                    setAsking({ kind: "remove", target: { repositoryPath: repo.path, worktree } })
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {worktree.missing ? "Forget" : "Remove"}
                </OctantButton>
              </SettingRow>
            ))}
          </div>
        ))}
        <div className="settings-feedback-slot" aria-live="polite">
          {message === undefined ? null : (
            <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
          )}
        </div>
      </>
    );

  return (
    <SettingsSection description={HOST_WORKTREES_FACT} title="Worktrees on this computer">
      {body}
      {asking === undefined ? null : asking.kind === "bulk" ? (
        <OctantConfirmDialog
          confirmLabel="Remove worktrees"
          destructive
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const { targets } = asking;
            setAsking(undefined);
            void removeSafe(targets);
          }}
          pending={busy}
          title={`Remove ${worktrees(asking.targets.length)} whose work is merged or whose folder is gone?`}
        >
          Deletes each folder, including ignored files such as build output and installed
          dependencies, and forgets those already gone. Branches and their commits stay. Any that
          now have changes, commits only on their branch, or recent use are kept for you to look at.
        </OctantConfirmDialog>
      ) : asking.kind === "remove" ? (
        <OctantConfirmDialog
          confirmLabel={asking.target.worktree.missing ? "Forget worktree" : "Remove worktree"}
          destructive
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const target = asking.target;
            setAsking(undefined);
            void remove(target);
          }}
          pending={busy}
          title={asking.target.worktree.missing ? "Forget this worktree?" : "Remove this worktree?"}
        >
          {asking.target.worktree.missing
            ? `Its folder is already gone. Git's record of ${asking.target.worktree.path} is removed; the branch stays.`
            : `Deletes ${asking.target.worktree.path}, including ignored files such as build output and installed dependencies. The branch and its commits stay.`}
        </OctantConfirmDialog>
      ) : asking.kind === "unpushed" ? (
        <OctantConfirmDialog
          confirmLabel="Remove worktree"
          destructive
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const { target, commits } = asking;
            setAsking(undefined);
            void remove(
              target,
              commits.map((commit) => commit.hash),
            );
          }}
          pending={busy}
          title={
            asking.count === 1
              ? "1 commit exists only on this branch"
              : `${String(asking.count)} commits exist only on this branch`
          }
        >
          {asking.count === 1 ? "It is" : "They are"} not pushed or merged anywhere. The branch{" "}
          {asking.target.worktree.branch} stays, so {asking.count === 1 ? "it is" : "they are"} kept
          on it:{" "}
          {asking.commits
            .slice(0, 10)
            .map((commit) => `${commit.hash.slice(0, 8)} ${commit.subject}`)
            .join("; ")}
          {asking.count > 10 ? `; and ${String(asking.count - 10)} more.` : "."}
        </OctantConfirmDialog>
      ) : (
        <OctantConfirmDialog
          confirmLabel="Remove anyway"
          destructive
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const { target, confirmedCommits } = asking;
            setAsking(undefined);
            void remove(target, confirmedCommits, true);
          }}
          pending={busy}
          title="This worktree was used in the last 15 minutes"
        >
          Another program or agent may be working in {asking.target.worktree.path} right now.
        </OctantConfirmDialog>
      )}
    </SettingsSection>
  );
}
