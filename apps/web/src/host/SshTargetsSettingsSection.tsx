import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { decodeCodeTerminalId, type CodeTerminalId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type { SshRemoteProject, SshRemoteWorktree } from "@octant/contracts/ssh-remote-project";
import type { SshHostKeyProbe, SshTargetStatus } from "@octant/contracts/ssh-target";
import { describeSshAdmissionRefusal } from "@octant/domain/ssh-target-recovery";
import type { XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { thisComputerName, useHostPlatform } from "../platform";
import { SettingRow, SettingsPanel, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { ZenProjectTerminalCard } from "../zen/ZenProjectTerminalCard";
import type { SshTargetAdministrationBridge } from "../shell/hostBridge";
import {
  createSshTargetClient,
  type SshTargetAnswer,
  type SshTargetClient,
} from "./sshTargetClient";

/**
 * Settings › SSH targets: the machines the host reaches with `ssh`, the Code
 * Projects bound to folders on them, their managed worktrees, and a terminal
 * in either. Canonical: docs/design/remote-ssh-environments.md and DESIGN.md
 * § Page shell.
 *
 * Every action is a request to the host's local administration routes, sent
 * through this desktop window's main process; the host decides and admits
 * each one against the target's attestation, and this page says what it
 * answered. A host key is pinned only when the person confirms the
 * fingerprint the destination presented, and the page says what the pin and
 * the attestation do not prove rather than calling the target verified.
 */

type Pending =
  | { readonly kind: "add"; readonly probe: SshHostKeyProbe; readonly executorPath: string }
  | { readonly kind: "repin"; readonly probe: SshHostKeyProbe; readonly targetId: string };

interface OpenTerminal {
  readonly projectId: ProjectId;
  readonly terminalId: CodeTerminalId;
  readonly label: string;
}

const POSTURE_LABELS: Readonly<Record<string, string>> = {
  plan: "Plan · read-only",
  "approval-gated": "Ask for approvals",
  "auto-accept-edits": "Auto-accept edits",
};

const CONNECTION_LABELS: Readonly<Record<SshTargetStatus["connection"], string>> = {
  "not-connected": "Not connected",
  unreachable: "Not reachable",
  "host-key-changed": "Host key changed",
  "executor-missing": "Octant not found on the target",
  "executor-version-mismatch": "Another Octant version on the target",
  connected: "Connected",
};

export const PIN_LIMITS_NOTICE =
  "The pin proves only that later sessions reach this key. Whoever administers the target can read its files and alter the Octant there, whose attestation is its own report.";

/** The page in a desktop window, with one client for as long as it is open. */
export function SshTargetsSettingsPage({
  bridge,
}: {
  readonly bridge: SshTargetAdministrationBridge;
}) {
  const client = useMemo(() => createSshTargetClient(bridge), [bridge]);
  return <SshTargetsSettingsSection client={client} />;
}

export function SshTargetsSettingsSection({
  client,
  loadTerminalRuntime,
}: {
  readonly client: SshTargetClient;
  /** Replaces the terminal renderer; only tests do. */
  readonly loadTerminalRuntime?: () => Promise<XtermAdapterRuntime>;
}) {
  const computer = thisComputerName(useHostPlatform());
  const destinationId = useId();
  const executorId = useId();
  const bindTargetId = useId();
  const bindRootId = useId();
  const bindNameId = useId();
  const [targets, setTargets] = useState<ReadonlyArray<SshTargetStatus>>([]);
  const [projects, setProjects] = useState<ReadonlyArray<SshRemoteProject>>([]);
  const [worktrees, setWorktrees] = useState<ReadonlyArray<SshRemoteWorktree>>([]);
  const [message, setMessage] = useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState("");
  const [executorPath, setExecutorPath] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [bind, setBind] = useState({ targetId: "", remoteRoot: "", name: "" });
  const [worktreeNames, setWorktreeNames] = useState<Readonly<Record<string, string>>>({});
  const [removingTarget, setRemovingTarget] = useState<SshTargetStatus>();
  const [removingWorktree, setRemovingWorktree] = useState<SshRemoteWorktree>();
  const [terminal, setTerminal] = useState<OpenTerminal>();
  const shownTerminal = useRef<OpenTerminal | undefined>(undefined);
  const removeOpener = useRef<HTMLElement | null>(null);

  // The page shows one terminal and lists none, so a shell it stops showing
  // could not be reached again and would hold one of the session's terminals
  // on the target until the session ends. Leaving the page stops it.
  useEffect(() => {
    shownTerminal.current = terminal;
  }, [terminal]);
  useEffect(
    () => () => {
      const open = shownTerminal.current;
      if (open === undefined) return;
      void client.terminal({
        kind: "stop",
        projectId: open.projectId,
        terminalId: open.terminalId,
      });
    },
    [client],
  );

  const refresh = useCallback(async () => {
    const [listed, bound, made] = await Promise.all([
      client.list(),
      client.projects(),
      client.worktrees(),
    ]);
    if (listed.status === "ok") setTargets(listed.value);
    if (bound.status === "ok") setProjects(bound.value);
    if (made.status === "ok") setWorktrees(made.value);
    const refused = [listed, bound, made].find((answer) => answer.status === "refused");
    if (refused?.status === "refused") setMessage({ kind: "error", text: refused.message });
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs one request, says how it went, and reads the page's state again. */
  const act = async <T,>(
    request: () => Promise<SshTargetAnswer<T>>,
    success: (value: T) => string | undefined,
  ): Promise<T | undefined> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const answer = await request();
      if (answer.status === "refused") {
        setMessage({ kind: "error", text: answer.message });
        return undefined;
      }
      const text = success(answer.value);
      if (text !== undefined) setMessage({ kind: "success", text });
      return answer.value;
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const readHostKey = async () => {
    const probe = await act(
      () => client.probeHostKey(destination.trim()),
      () => undefined,
    );
    if (probe !== undefined) setPending({ kind: "add", probe, executorPath: executorPath.trim() });
  };

  const repin = async (status: SshTargetStatus) => {
    const probe = await act(
      () => client.probeHostKey(status.target.destination),
      () => undefined,
    );
    if (probe !== undefined)
      setPending({ kind: "repin", probe, targetId: String(status.target.id) });
  };

  const confirmPin = async (confirmed: Pending) => {
    setPending(undefined);
    const status = await act(
      () =>
        confirmed.kind === "add"
          ? client.register(confirmed.probe, confirmed.executorPath)
          : client.repin(confirmed.targetId, confirmed.probe),
      (value) => `Pinned the key of ${value.target.destination}. ${summary(value)}`,
    );
    if (status !== undefined && confirmed.kind === "add") {
      setDestination("");
      setExecutorPath("");
    }
  };

  const closeTerminal = async (open: OpenTerminal) => {
    setTerminal(undefined);
    await client.terminal({ kind: "stop", projectId: open.projectId, terminalId: open.terminalId });
  };

  const openTerminal = async (project: SshRemoteProject, worktree?: SshRemoteWorktree) => {
    setMessage(undefined);
    // Opening another replaces the one shown, so that one stops first.
    if (terminal !== undefined) await closeTerminal(terminal);
    const terminalId = decodeCodeTerminalId(crypto.randomUUID());
    const started = await client.terminal({
      kind: "start",
      projectId: project.id,
      terminalId,
      ...(worktree === undefined ? {} : { worktreeId: worktree.id }),
      columns: 100,
      rows: 30,
    });
    if (started.kind === "project-terminal-refused") {
      setMessage({ kind: "error", text: started.message });
      return;
    }
    setTerminal({
      projectId: project.id,
      terminalId,
      label: worktree === undefined ? project.name : `${project.name} · ${worktree.branch}`,
    });
  };

  const targetOf = (project: SshRemoteProject) =>
    targets.find((status) => String(status.target.id) === String(project.targetId));
  const bindTarget = bind.targetId === "" ? String(targets[0]?.target.id ?? "") : bind.targetId;

  return (
    <div className="settings-section-stack" id="settings-ssh-targets">
      <SettingsSection
        description={`Machines ${computer} reaches with ssh. A Code Project can keep its folder on one; Octant admits work there only after the target proves it confines it as ${computer} would.`}
        title="Targets"
      >
        <div className="setgroup">
          {targets.length === 0 ? (
            <SettingRow
              description="Add one below with the destination you would type after ssh."
              label="No SSH targets yet"
              scope="host"
              settingId="ssh-targets-list"
            >
              <span />
            </SettingRow>
          ) : null}
          {targets.map((status) => (
            <SettingRow
              description={<TargetDescription status={status} />}
              key={String(status.target.id)}
              label={status.target.destination}
              scope="host"
              settingId={`ssh-target-${String(status.target.id)}`}
            >
              <div className="host-settings__controls">
                <OctantButton
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => client.connect(String(status.target.id)),
                      (value) => summary(value),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Connect
                </OctantButton>
                <OctantButton
                  disabled={busy}
                  onClick={() => void repin(status)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Check host key…
                </OctantButton>
                <OctantButton
                  aria-haspopup="dialog"
                  aria-label={`Remove ${status.target.destination}`}
                  disabled={busy}
                  onClick={(event) => {
                    removeOpener.current = event.currentTarget;
                    setRemovingTarget(status);
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove…
                </OctantButton>
              </div>
            </SettingRow>
          ))}
          <SettingRow
            description="The destination as you would type it after ssh, and where the headless Octant of this version is installed on it. Octant reads the key the destination presents and pins it only when you confirm it."
            label="Add an SSH target"
            scope="host"
            settingId="ssh-target-add"
          >
            <div className="settings-panel__stack">
              <OctantField>
                <OctantFieldLabel htmlFor={destinationId}>Destination</OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={destinationId}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="build@devbox or devbox"
                  spellCheck={false}
                  value={destination}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={executorId}>Octant on the target</OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={executorId}
                  onChange={(event) => setExecutorPath(event.target.value)}
                  placeholder="/home/build/.local/octant/bin/octant"
                  spellCheck={false}
                  value={executorPath}
                />
              </OctantField>
              <div className="host-settings__controls">
                <OctantButton
                  disabled={
                    busy || destination.trim().length === 0 || executorPath.trim().length === 0
                  }
                  onClick={() => void readHostKey()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Read host key
                </OctantButton>
              </div>
            </div>
          </SettingRow>
        </div>
        {message === undefined ? null : (
          <SettingsState kind={message.kind}>{message.text}</SettingsState>
        )}
      </SettingsSection>

      <SettingsSection
        description={`A Code Project whose folder is on a target. Its terminals and worktrees run there, under the same confinement as on ${computer}.`}
        title="Remote Projects"
      >
        <div className="setgroup">
          {projects.map((project) => {
            const status = targetOf(project);
            const name = worktreeNames[String(project.id)] ?? "";
            return (
              <div key={String(project.id)}>
                <SettingRow
                  description={`${status?.target.destination ?? "Removed target"}:${project.remoteRoot}`}
                  label={project.name}
                  scope="host"
                  settingId={`ssh-remote-project-${String(project.id)}`}
                >
                  <div className="settings-panel__stack">
                    <div className="host-settings__controls">
                      <OctantButton
                        disabled={busy}
                        onClick={() => void openTerminal(project)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Open terminal
                      </OctantButton>
                    </div>
                    <div className="host-settings__controls">
                      <OctantInput
                        aria-label={`New worktree name for ${project.name}`}
                        autoComplete="off"
                        onChange={(event) =>
                          setWorktreeNames({
                            ...worktreeNames,
                            [String(project.id)]: event.target.value,
                          })
                        }
                        placeholder="fix-login"
                        spellCheck={false}
                        value={name}
                      />
                      <OctantButton
                        disabled={busy || name.trim().length === 0}
                        onClick={() =>
                          void act(
                            () => client.createWorktree(String(project.id), name.trim()),
                            (worktree) => {
                              setWorktreeNames({ ...worktreeNames, [String(project.id)]: "" });
                              return `Created ${worktree.branch} at ${worktree.path}.`;
                            },
                          )
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        New worktree
                      </OctantButton>
                    </div>
                  </div>
                </SettingRow>
                {worktrees
                  .filter((worktree) => String(worktree.projectId) === String(project.id))
                  .map((worktree) => (
                    <SettingRow
                      description={worktree.path}
                      key={String(worktree.id)}
                      label={`${project.name} · ${worktree.branch}`}
                      scope="host"
                      settingId={`ssh-remote-worktree-${String(worktree.id)}`}
                    >
                      <div className="host-settings__controls">
                        <OctantButton
                          disabled={busy}
                          onClick={() => void openTerminal(project, worktree)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Open terminal
                        </OctantButton>
                        <OctantButton
                          aria-haspopup="dialog"
                          aria-label={`Remove worktree ${worktree.branch}`}
                          disabled={busy}
                          onClick={(event) => {
                            removeOpener.current = event.currentTarget;
                            setRemovingWorktree(worktree);
                          }}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Remove…
                        </OctantButton>
                      </div>
                    </SettingRow>
                  ))}
              </div>
            );
          })}
          <SettingRow
            description="The folder on the target, as the target names it. Octant resolves it there and binds that folder; it never binds / or a folder holding your ~/.ssh."
            label="Bind a remote folder"
            scope="host"
            settingId="ssh-remote-project-bind"
          >
            <div className="settings-panel__stack">
              <OctantField>
                <OctantFieldLabel htmlFor={bindTargetId}>Target</OctantFieldLabel>
                <OctantSelectField
                  aria-label="Target"
                  disabled={targets.length === 0}
                  id={bindTargetId}
                  onValueChange={(value) => setBind({ ...bind, targetId: value })}
                  options={targets.map((status) => ({
                    id: String(status.target.id),
                    label: status.target.destination,
                  }))}
                  placeholder="Add a target first"
                  value={bindTarget}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={bindRootId}>Folder on the target</OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={bindRootId}
                  onChange={(event) => setBind({ ...bind, remoteRoot: event.target.value })}
                  placeholder="/home/build/src/app"
                  spellCheck={false}
                  value={bind.remoteRoot}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={bindNameId}>Project name</OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={bindNameId}
                  onChange={(event) => setBind({ ...bind, name: event.target.value })}
                  value={bind.name}
                />
              </OctantField>
              <div className="host-settings__controls">
                <OctantButton
                  disabled={
                    busy ||
                    bindTarget === "" ||
                    bind.remoteRoot.trim().length === 0 ||
                    bind.name.trim().length === 0
                  }
                  onClick={() =>
                    void act(
                      () => client.bind(bindTarget, bind.remoteRoot.trim(), bind.name.trim()),
                      (project) => {
                        setBind({ targetId: "", remoteRoot: "", name: "" });
                        return `Bound ${project.name} to ${project.remoteRoot}.`;
                      },
                    )
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Bind folder
                </OctantButton>
              </div>
            </div>
          </SettingRow>
          {projects.length === 0 ? null : (
            <SettingRow
              description="Not available in a remote Project yet. Its terminals and worktrees are, here."
              label="New threads"
              scope="host"
              settingId="ssh-remote-projects"
            >
              <span />
            </SettingRow>
          )}
        </div>
      </SettingsSection>

      {terminal === undefined ? null : (
        <SettingsPanel
          description="A shell on the target, with no network, confined as the target proved it confines Ask for approvals."
          title={`Terminal · ${terminal.label}`}
        >
          <div className="settings-panel__stack">
            <ZenProjectTerminalCard
              client={{ execute: (command) => client.terminal(command) }}
              live
              {...(loadTerminalRuntime === undefined ? {} : { loadRuntime: loadTerminalRuntime })}
              projectId={terminal.projectId}
              terminalId={terminal.terminalId}
            />
            <div className="host-settings__controls">
              <OctantButton
                onClick={() => void closeTerminal(terminal)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Close terminal
              </OctantButton>
            </div>
          </div>
        </SettingsPanel>
      )}

      {pending === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Don't pin"
          confirmLabel="Pin this key"
          details={<code>{pending.probe.fingerprint}</code>}
          onCancel={() => setPending(undefined)}
          onConfirm={() => void confirmPin(pending)}
          title={`Is this ${pending.probe.destination}'s key?`}
        >
          {pending.probe.destination} presented the {pending.probe.hostKey.algorithm} key below.
          Compare it with the key the target's administrator gives you. Octant will trust only this
          key for the target. {PIN_LIMITS_NOTICE}
        </OctantConfirmDialog>
      )}
      {removingTarget === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it"
          confirmLabel="Remove target"
          destructive
          onCancel={() => setRemovingTarget(undefined)}
          onConfirm={() => {
            const removing = removingTarget;
            setRemovingTarget(undefined);
            void act(
              () => client.remove(String(removing.target.id)),
              () => `Removed ${removing.target.destination}.`,
            );
          }}
          restoreFocus={removeOpener}
          title={`Remove ${removingTarget.target.destination}?`}
        >
          Octant ends its session and forgets its pinned key. Its Projects stay readable here and
          take no new work. Nothing on the target is deleted.
        </OctantConfirmDialog>
      )}
      {removingWorktree === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it"
          confirmLabel="Remove worktree"
          destructive
          onCancel={() => setRemovingWorktree(undefined)}
          onConfirm={() => {
            const removing = removingWorktree;
            setRemovingWorktree(undefined);
            void act(
              () => client.removeWorktree(String(removing.id)),
              () => `Removed the worktree of ${removing.branch}. The branch stays.`,
            );
          }}
          restoreFocus={removeOpener}
          title={`Remove the worktree of ${removingWorktree.branch}?`}
        >
          Git removes the folder only if it holds no change and no untracked file. The branch and
          its commits stay in the repository.
        </OctantConfirmDialog>
      )}
    </div>
  );
}

/** The connection, who and what it reached, and what each posture would admit now. */
function TargetDescription({ status }: { readonly status: SshTargetStatus }) {
  const platform =
    status.platform === undefined ? undefined : status.platform === "macos" ? "macOS" : "Linux";
  const reached = [status.remoteUser, platform]
    .filter((part): part is string => part !== undefined)
    .join(" on ");
  return (
    <>
      {CONNECTION_LABELS[status.connection]}
      {reached === "" ? "" : ` as ${reached}`} · {status.fingerprint}
      {status.admission.map((entry) => (
        <span key={entry.posture}>
          <br />
          {POSTURE_LABELS[entry.posture] ?? entry.posture}:{" "}
          {entry.decision.status === "admitted"
            ? "admitted"
            : describeSshAdmissionRefusal(entry.decision)}
        </span>
      ))}
    </>
  );
}

/** One sentence on what a target admits after a connection. */
function summary(status: SshTargetStatus): string {
  const admitted = status.admission.filter((entry) => entry.decision.status === "admitted");
  return admitted.length === status.admission.length
    ? `${status.target.destination} is connected, and confines every posture.`
    : `${status.target.destination}: ${CONNECTION_LABELS[status.connection].toLowerCase()}, ${String(admitted.length)} of ${String(status.admission.length)} postures admitted.`;
}
