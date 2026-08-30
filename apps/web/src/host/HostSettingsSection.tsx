import { useCallback, useEffect, useId, useState } from "react";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type {
  HostControlStatus,
  HostBackupOutcome,
  HostLifecycleAction,
  HostRestoreOutcome,
} from "@octant/contracts/host-control";
import type {
  PurgeThreadsOutcome,
  RetentionScope,
  RetentionWindow,
  SetThreadRetentionOutcome,
  ThreadRetentionState,
} from "@octant/contracts/thread-retention";
import { purgeComposerThreadDrafts } from "../composer/composerThreadDraftStore";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingsFactList, SettingsPanel, SettingsState } from "../settings/primitives";
import {
  AutomationNotificationSettings,
  type AutomationNotificationSettingsProps,
} from "./AutomationNotificationSettings";
import { FederatedHostsLifecyclePanel } from "./FederatedHostsLifecyclePanel";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { HostDataMap } from "@octant/contracts/host-data-map";
import { HostDataMapView } from "./HostDataMap";

/**
 * The Settings host card for one local or headless
 * host. An authorized local principal sees compact identity, owner mode,
 * service policy, versions, readiness, capabilities, and lifecycle,
 * backup, and recovery controls. Every state is honest: unreachable hosts,
 * refused transitions, and failed backups render as such — never as
 * fabricated success. All authority checks happen server-side; this
 * component only renders what the authenticated host control surface
 * returned.
 *
 * Post-preview B6 adds an optional federated-hosts panel for per-host
 * reconnect / revoke / remove without blocking healthy hosts.
 */

export interface HostSettingsSectionProps {
  readonly client: HostControlClient;
  readonly automationNotifications?: AutomationNotificationSettingsProps["client"];
  readonly hostFederationLifecycle?: HostFederationLifecycle;
}

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: HostControlStatus };

type DataMapState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly report: HostDataMap };

type LifecycleMessage =
  | { readonly kind: "accepted"; readonly text: string }
  | { readonly kind: "refused"; readonly text: string };

type BackupState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly outcome: HostBackupOutcome }
  | { readonly kind: "error"; readonly message: string };

const OWNER_MODE_LABELS: Readonly<Record<HostControlStatus["identity"]["serviceMode"], string>> = {
  desktop: "Desktop app",
  foreground: "Foreground run",
  web: "Web session",
  service: "Managed service",
};

const BACKUP_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function HostSettingsSection({
  client,
  automationNotifications,
  hostFederationLifecycle,
}: HostSettingsSectionProps) {
  const policyStateId = useId();
  const backupLabelId = useId();
  const [statusState, setStatusState] = useState<StatusState>({ kind: "loading" });
  const [dataMapState, setDataMapState] = useState<DataMapState>({ kind: "loading" });
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleMessage, setLifecycleMessage] = useState<LifecycleMessage>();
  const [backupLabel, setBackupLabel] = useState("");
  const [backupState, setBackupState] = useState<BackupState>({ kind: "idle" });
  const [restoreOutcome, setRestoreOutcome] = useState<HostRestoreOutcome>();

  const refresh = useCallback(async () => {
    try {
      const status = await client.status();
      setStatusState({ kind: "ready", status });
    } catch (error) {
      setStatusState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The host control service is unreachable.",
      });
    }
    try {
      const report = await client.readDataMap();
      setDataMapState({ kind: "ready", report });
    } catch (error) {
      setDataMapState({
        kind: "error",
        message: error instanceof Error ? error.message : "The host data map is unreachable.",
      });
    }
  }, [client]);

  useEffect(() => {
    setStatusState({ kind: "loading" });
    setDataMapState({ kind: "loading" });
    void refresh();
  }, [refresh]);

  const runLifecycle = async (action: HostLifecycleAction) => {
    setLifecycleBusy(true);
    setLifecycleMessage(undefined);
    try {
      const outcome = await client.lifecycle(action);
      setLifecycleMessage(
        outcome.kind === "accepted"
          ? { kind: "accepted", text: outcome.message }
          : { kind: "refused", text: outcome.guidance },
      );
      // Policy changes leave the host up, so the card can show the new state
      // immediately. An accepted stop/restart drains this very host — an
      // immediate refetch would race the drain and replace the acceptance
      // message with a transport error, so the user refreshes when ready.
      if (action === "enable" || action === "disable") {
        await refresh();
      }
    } catch (error) {
      setLifecycleMessage({
        kind: "refused",
        text:
          error instanceof Error ? error.message : "The lifecycle request could not be delivered.",
      });
    } finally {
      setLifecycleBusy(false);
    }
  };

  const runBackup = async () => {
    setBackupState({ kind: "pending" });
    const label = backupLabel.trim();
    try {
      const outcome = await client.backup(label === "" ? undefined : label);
      setBackupState({ kind: "done", outcome });
    } catch (error) {
      setBackupState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The backup request could not be delivered.",
      });
    }
  };

  const runRestore = async () => {
    setRestoreOutcome(undefined);
    try {
      setRestoreOutcome(await client.restore());
    } catch {
      setRestoreOutcome({
        kind: "refused-online",
        guidance: "The restore request could not be delivered. Use the offline restore command.",
      });
    }
  };

  if (statusState.kind === "loading") {
    return (
      <section aria-label="Host" className="host-settings" id="settings-host">
        <SettingsState kind="loading">Loading host status…</SettingsState>
      </section>
    );
  }

  if (statusState.kind === "error") {
    return (
      <section aria-label="Host" className="host-settings" id="settings-host">
        <SettingsState kind="error">{statusState.message}</SettingsState>
        <OctantButton
          onClick={() => {
            setStatusState({ kind: "loading" });
            void refresh();
          }}
          type="button"
          variant="secondary"
        >
          Retry
        </OctantButton>
      </section>
    );
  }

  const { status } = statusState;
  const policy = status.policy;
  const policyToggleAction: HostLifecycleAction =
    policy.kind === "known" && policy.enabled ? "disable" : "enable";
  const policyToggle = status.lifecycle[policyToggleAction];
  const trimmedBackupLabel = backupLabel.trim();
  const backupLabelValid =
    trimmedBackupLabel === "" || BACKUP_LABEL_PATTERN.test(trimmedBackupLabel);

  return (
    <section aria-label="Host" className="host-settings" id="settings-host">
      <div className="host-settings__controls">
        <OctantButton onClick={() => void refresh()} type="button" variant="secondary">
          Refresh status
        </OctantButton>
      </div>

      <SettingsPanel title="Identity" description="The host process serving this workspace.">
        <SettingsFactList
          facts={[
            { label: "Host", value: status.identity.hostId },
            { label: "Instance", value: status.identity.instanceId },
            { label: "Owner mode", value: OWNER_MODE_LABELS[status.identity.serviceMode] },
            { label: "Server version", value: status.versions.server },
            { label: "Wire version", value: status.versions.wire },
          ]}
        />
      </SettingsPanel>

      <SettingsPanel title="Service policy" description="Controls automatic host startup.">
        <div className="settings-panel__stack">
          <p className="host-settings__note" id={policyStateId}>
            {policy.kind === "known"
              ? policy.enabled
                ? `Automatic startup is enabled (updated ${policy.updatedAt}).`
                : `Automatic startup is disabled (updated ${policy.updatedAt}).`
              : `Startup policy is unavailable. ${policy.reason}`}
          </p>
          <div className="host-settings__controls">
            <OctantButton
              aria-describedby={policyStateId}
              disabled={lifecycleBusy || policyToggle.kind === "unavailable"}
              onClick={() => void runLifecycle(policyToggleAction)}
              type="button"
              variant="secondary"
            >
              {policyToggleAction === "disable"
                ? "Disable automatic startup"
                : "Enable automatic startup"}
            </OctantButton>
          </div>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Readiness" description="Current storage and client health.">
        <SettingsFactList
          facts={[
            {
              label: "Store",
              value: `${status.readiness.store.state}, integrity ${status.readiness.store.integrity}`,
            },
            {
              label: "Replay (journal / projections)",
              value: `${status.readiness.replay.journalHead} / ${status.readiness.replay.projections}`,
            },
            { label: "Connected clients", value: status.readiness.clientsConnected },
            { label: "Uptime", value: formatUptime(status.readiness.uptimeSeconds) },
            {
              label: "Active work",
              // Reporting "0 (attention required)" reads as a contradiction, so the
              // qualifier only appears when there is live work to attend to.
              value: `${status.work.active}${status.work.attentionRequired && status.work.active > 0 ? " (attention required)" : ""}`,
            },
          ]}
        />
      </SettingsPanel>

      <SettingsPanel title="Capabilities" description="Host services available to this app.">
        <div className="settings-panel__stack">
          {status.capabilities.length === 0 ? (
            <SettingsState kind="empty">No platform capabilities reported.</SettingsState>
          ) : (
            <ul className="host-settings__capabilities">
              {status.capabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          )}
        </div>
      </SettingsPanel>

      <SettingsPanel title="Lifecycle" description="Stop or restart the selected host process.">
        <div className="settings-panel__stack">
          <div className="host-settings__controls">
            <OctantButton
              disabled={lifecycleBusy || status.lifecycle.stop.kind === "unavailable"}
              onClick={() => void runLifecycle("stop")}
              type="button"
              variant="secondary"
            >
              Stop host
            </OctantButton>
            <OctantButton
              disabled={lifecycleBusy || status.lifecycle.restart.kind === "unavailable"}
              onClick={() => void runLifecycle("restart")}
              type="button"
              variant="secondary"
            >
              Restart host
            </OctantButton>
          </div>
          {status.lifecycle.stop.kind === "unavailable" ? (
            <p className="host-settings__note">{status.lifecycle.stop.reason}</p>
          ) : null}
          {status.lifecycle.restart.kind === "unavailable" ? (
            <p className="host-settings__note">{status.lifecycle.restart.reason}</p>
          ) : null}
          {lifecycleMessage === undefined ? null : lifecycleMessage.kind === "accepted" ? (
            <SettingsState kind="success">{lifecycleMessage.text}</SettingsState>
          ) : (
            <SettingsState kind="error">{lifecycleMessage.text}</SettingsState>
          )}
        </div>
      </SettingsPanel>

      <SettingsPanel title="Backup" description="Create a named snapshot before risky changes.">
        <div className="settings-panel__stack">
          <div className="host-settings__field">
            <label htmlFor={backupLabelId}>Backup label</label>
            <OctantInput
              id={backupLabelId}
              maxLength={64}
              onChange={(event) => setBackupLabel(event.target.value)}
              placeholder="Optional label, e.g. pre-upgrade"
              value={backupLabel}
            />
          </div>
          <div className="host-settings__controls">
            <OctantButton
              disabled={backupState.kind === "pending" || !backupLabelValid}
              onClick={() => void runBackup()}
              type="button"
              variant="secondary"
            >
              {backupState.kind === "pending" ? "Creating backup…" : "Create backup"}
            </OctantButton>
          </div>
          {backupState.kind === "done" ? <BackupOutcomeView outcome={backupState.outcome} /> : null}
          {backupState.kind === "error" ? (
            <SettingsState kind="error">{backupState.message}</SettingsState>
          ) : null}
        </div>
      </SettingsPanel>

      <SettingsPanel
        title="Recovery"
        description="Restore replaces the live store and runs only while the host is offline."
      >
        <div className="settings-panel__stack">
          <div className="host-settings__controls">
            <OctantButton onClick={() => void runRestore()} type="button" variant="secondary">
              Restore from backup
            </OctantButton>
          </div>
          {restoreOutcome === undefined ? null : (
            <SettingsState kind="loading">{restoreOutcome.guidance}</SettingsState>
          )}
        </div>
      </SettingsPanel>

      <DataMapPanel state={dataMapState} />

      <ThreadRetentionPanel client={client} />

      {automationNotifications === undefined ? null : (
        <AutomationNotificationSettings client={automationNotifications} />
      )}

      {hostFederationLifecycle === undefined ? null : (
        <FederatedHostsLifecyclePanel lifecycle={hostFederationLifecycle} />
      )}
    </section>
  );
}

function DataMapPanel({ state }: { readonly state: DataMapState }) {
  if (state.kind === "loading") {
    return (
      <SettingsPanel title="Data map" description="What this host stores, and where.">
        <SettingsState kind="loading">Loading data map…</SettingsState>
      </SettingsPanel>
    );
  }
  if (state.kind === "error") {
    return (
      <SettingsPanel title="Data map" description="What this host stores, and where.">
        <SettingsState kind="error">{state.message}</SettingsState>
      </SettingsPanel>
    );
  }
  return <HostDataMapView report={state.report} />;
}

function formatRetentionWindow(state: ThreadRetentionState | undefined): string {
  const host = state?.windows.find((entry) => entry.scope.kind === "host");
  if (host === undefined || host.window.kind === "forever") return "forever";
  return `${host.window.days} days`;
}

const WINDOW_OPTIONS: ReadonlyArray<{ readonly value: string; readonly window: RetentionWindow }> =
  [
    { value: "forever", window: { kind: "forever" } },
    { value: "7", window: { kind: "duration-days", days: 7 } },
    { value: "30", window: { kind: "duration-days", days: 30 } },
    { value: "90", window: { kind: "duration-days", days: 90 } },
    { value: "365", window: { kind: "duration-days", days: 365 } },
  ];

function isRetentionScopeKind(value: string): value is RetentionScope["kind"] {
  return value === "host" || value === "project" || value === "thread";
}

function isThreadMode(value: string): value is "chat" | "work" | "code" {
  return value === "chat" || value === "work" || value === "code";
}

function ThreadRetentionPanel({ client }: { readonly client: HostControlClient }) {
  const [state, setState] = useState<ThreadRetentionState | undefined>();
  const [scopeKind, setScopeKind] = useState<RetentionScope["kind"]>("host");
  const [mode, setMode] = useState<"chat" | "work" | "code">("chat");
  const [threadId, setThreadId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [windowValue, setWindowValue] = useState("forever");
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SetThreadRetentionOutcome | PurgeThreadsOutcome>();

  const load = useCallback(async () => {
    setState(await client.readThreadRetention());
  }, [client]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const scope = (): RetentionScope | undefined => {
    if (scopeKind === "host") return { kind: "host" };
    if (scopeKind === "project") {
      const trimmed = projectId.trim();
      return trimmed === "" ? undefined : { kind: "project", projectId: trimmed as never };
    }
    const trimmed = threadId.trim();
    return trimmed === "" ? undefined : { kind: "thread", mode, threadId: trimmed as never };
  };

  const selectedWindow =
    WINDOW_OPTIONS.find((option) => option.value === windowValue)?.window ??
    ({ kind: "forever" } as const);

  return (
    <SettingsPanel
      title="Thread retention"
      description="Set retention windows or permanently purge selected thread history."
      tone="danger"
    >
      <div className="settings-panel__stack" id="settings-thread-retention">
        <p className="host-settings__note">
          A retention window never deletes on its own. A confirmed purge removes the named thread —
          or expired threads in a Project or on this host — from ordinary reads, including derived
          projections and that thread's own journal events. Unsent composer drafts for those threads
          are removed from this client. Other threads, Projects, usage, and credentials stay. SQLite
          free pages may keep bytes until the next store rebuild.
        </p>
        <p className="host-settings__note">Host default: {formatRetentionWindow(state)}.</p>
        <div className="host-settings__field">
          <label htmlFor="thread-retention-scope">Scope</label>
          <OctantNativeSelect
            id="thread-retention-scope"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isRetentionScopeKind(value)) setScopeKind(value);
            }}
            value={scopeKind}
          >
            <option value="host">This host</option>
            <option value="project">One Project</option>
            <option value="thread">One thread</option>
          </OctantNativeSelect>
        </div>
        {scopeKind === "project" ? (
          <div className="host-settings__field">
            <label htmlFor="thread-retention-project">Project id</label>
            <OctantInput
              id="thread-retention-project"
              onChange={(event) => setProjectId(event.currentTarget.value)}
              value={projectId}
            />
          </div>
        ) : null}
        {scopeKind === "thread" ? (
          <>
            <div className="host-settings__field">
              <label htmlFor="thread-retention-mode">Mode</label>
              <OctantNativeSelect
                id="thread-retention-mode"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (isThreadMode(value)) setMode(value);
                }}
                value={mode}
              >
                <option value="chat">Chat</option>
                <option value="work">Work</option>
                <option value="code">Code</option>
              </OctantNativeSelect>
            </div>
            <div className="host-settings__field">
              <label htmlFor="thread-retention-thread">Thread id</label>
              <OctantInput
                id="thread-retention-thread"
                onChange={(event) => setThreadId(event.currentTarget.value)}
                value={threadId}
              />
            </div>
          </>
        ) : null}
        <div className="host-settings__field">
          <label htmlFor="thread-retention-window">Retention window</label>
          <OctantNativeSelect
            id="thread-retention-window"
            onChange={(event) => setWindowValue(event.currentTarget.value)}
            value={windowValue}
          >
            <option value="forever">Keep forever</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">365 days</option>
          </OctantNativeSelect>
        </div>
        <div className="host-settings__controls">
          <OctantButton
            disabled={busy || scope() === undefined}
            onClick={() => {
              const next = scope();
              if (next === undefined) return;
              setBusy(true);
              void client
                .setThreadRetention({ scope: next, window: selectedWindow })
                .then((result) => {
                  setOutcome(result);
                  // Success is the state snapshot; only a refusal carries `kind`.
                  if (!("kind" in result)) setState(result);
                })
                .finally(() => setBusy(false));
            }}
            type="button"
          >
            Set retention window
          </OctantButton>
        </div>
        <label className="host-settings__note">
          <OctantCheckbox
            checked={confirmPurge}
            onChange={(event) => setConfirmPurge(event.currentTarget.checked)}
          />{" "}
          I understand this permanently erases the selected thread history.
        </label>
        <div className="host-settings__controls">
          <OctantButton
            disabled={busy || !confirmPurge || scope() === undefined}
            onClick={() => {
              const next = scope();
              if (next === undefined) return;
              setBusy(true);
              void client
                .purgeThreads({ scope: next, confirm: true })
                .then(async (result) => {
                  setOutcome(result);
                  if (!("kind" in result)) {
                    purgeComposerThreadDrafts([
                      ...result.purged.map((thread) => String(thread.threadId)),
                      ...result.alreadyPurged.map((thread) => String(thread.threadId)),
                    ]);
                  }
                  await load();
                })
                .finally(() => {
                  setBusy(false);
                  setConfirmPurge(false);
                });
            }}
            type="button"
            variant="secondary"
          >
            Purge
          </OctantButton>
        </div>
        {outcome === undefined ? null : "kind" in outcome ? (
          <SettingsState kind="error">{outcome.guidance}</SettingsState>
        ) : "operation" in outcome ? (
          <SettingsState kind="success">
            Purged {outcome.purged.length} thread{outcome.purged.length === 1 ? "" : "s"}
            {outcome.alreadyPurged.length === 0
              ? ""
              : `, ${outcome.alreadyPurged.length} already purged`}
            . Deleted {outcome.deleted.join(", ") || "nothing"}. Retained{" "}
            {outcome.retained.join(", ")}.
          </SettingsState>
        ) : (
          <SettingsState kind="success">Retention window saved.</SettingsState>
        )}
      </div>
    </SettingsPanel>
  );
}

function BackupOutcomeView({ outcome }: { readonly outcome: HostBackupOutcome }) {
  if (outcome.kind === "failed") {
    return (
      <p className="host-settings__note" role="alert">
        The backup was not created ({outcome.code}). Check the host logs.
      </p>
    );
  }
  return (
    <p aria-live="polite" className="host-settings__note">
      Backup {outcome.label} created — migration version {outcome.migrationVersion}, journal head{" "}
      {outcome.journalHead}, {outcome.byteLength.toLocaleString()} bytes.
    </p>
  );
}

function formatUptime(uptimeSeconds: number): string {
  const hours = Math.floor(uptimeSeconds / 3_600);
  const minutes = Math.floor((uptimeSeconds % 3_600) / 60);
  if (hours === 0 && minutes === 0) return `${uptimeSeconds}s`;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
