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
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingRow, SettingsFactList, SettingsPanel, SettingsState } from "../settings/primitives";
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
      <section aria-label="Identity" className="settings-card-section settings-card-section--open">
        <div className="settings-section-head">
          <h2>Identity</h2>
          <OctantButton onClick={() => void refresh()} size="sm" type="button" variant="secondary">
            Refresh status
          </OctantButton>
        </div>
        <p className="settings-section-note">The host process serving this workspace.</p>
        <SettingsFactList
          facts={[
            { label: "Host", value: <Identifier>{status.identity.hostId}</Identifier> },
            { label: "Instance", value: <Identifier>{status.identity.instanceId}</Identifier> },
            { label: "Owner mode", value: OWNER_MODE_LABELS[status.identity.serviceMode] },
            { label: "Server version", value: <Identifier>{status.versions.server}</Identifier> },
            { label: "Wire version", value: <Identifier>{status.versions.wire}</Identifier> },
          ]}
        />
      </section>

      <section
        aria-label="Service policy"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Service policy</h2>
        <div className="setgroup">
          <SettingRow
            description={
              policy.kind === "known"
                ? policy.enabled
                  ? `Automatic startup is enabled (updated ${policy.updatedAt}).`
                  : `Automatic startup is disabled (updated ${policy.updatedAt}).`
                : `Startup policy is unavailable. ${policy.reason}`
            }
            label="Automatic startup"
            scope="host"
            settingId="host-automatic-startup"
          >
            <OctantButton
              aria-describedby="host-automatic-startup-description"
              disabled={lifecycleBusy || policyToggle.kind === "unavailable"}
              onClick={() => void runLifecycle(policyToggleAction)}
              size="sm"
              type="button"
              variant="secondary"
            >
              {policyToggleAction === "disable"
                ? "Disable automatic startup"
                : "Enable automatic startup"}
            </OctantButton>
          </SettingRow>
        </div>
      </section>

      <section aria-label="Readiness" className="settings-card-section settings-card-section--open">
        <h2>Readiness</h2>
        <p className="settings-section-note">Current storage and client health.</p>
        <SettingsFactList
          facts={[
            {
              label: "Store",
              value: `${status.readiness.store.state}, integrity ${status.readiness.store.integrity}`,
            },
            {
              label: "Replay (journal / projections)",
              value: (
                <Identifier>
                  {`${status.readiness.replay.journalHead} / ${status.readiness.replay.projections}`}
                </Identifier>
              ),
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
      </section>

      <section
        aria-label="Capabilities"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Capabilities</h2>
        <p className="settings-section-note">Host services available to this app.</p>
        {status.capabilities.length === 0 ? (
          <SettingsState kind="empty">No platform capabilities reported.</SettingsState>
        ) : (
          <ul className="host-settings__capabilities">
            {status.capabilities.map((capability) => (
              <li className="oct-meta--mono" key={capability}>
                {capability}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Lifecycle" className="settings-card-section settings-card-section--open">
        <h2>Lifecycle</h2>
        <div className="setgroup">
          <SettingRow
            description="Stop or restart the selected host process."
            label="Host process"
            scope="host"
            settingId="host-lifecycle"
          >
            <div className="host-settings__controls">
              <OctantButton
                disabled={lifecycleBusy || status.lifecycle.stop.kind === "unavailable"}
                onClick={() => void runLifecycle("stop")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Stop host
              </OctantButton>
              <OctantButton
                disabled={lifecycleBusy || status.lifecycle.restart.kind === "unavailable"}
                onClick={() => void runLifecycle("restart")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Restart host
              </OctantButton>
            </div>
          </SettingRow>
        </div>
        {status.lifecycle.stop.kind === "unavailable" ? (
          <p className="settings-section-line">{status.lifecycle.stop.reason}</p>
        ) : null}
        {status.lifecycle.restart.kind === "unavailable" ? (
          <p className="settings-section-line">{status.lifecycle.restart.reason}</p>
        ) : null}
        {lifecycleMessage === undefined ? null : lifecycleMessage.kind === "accepted" ? (
          <SettingsState kind="success">{lifecycleMessage.text}</SettingsState>
        ) : (
          <SettingsState kind="error">{lifecycleMessage.text}</SettingsState>
        )}
      </section>

      <section aria-label="Backup" className="settings-card-section settings-card-section--open">
        <h2>Backup</h2>
        <div className="setgroup">
          <SettingRow
            description="Create a named snapshot before risky changes."
            label="Snapshot"
            scope="host"
            settingId="host-backup"
          >
            <div className="host-settings__controls">
              <OctantInput
                aria-label="Backup label"
                className="settings-view__text-input"
                id={backupLabelId}
                maxLength={64}
                onChange={(event) => setBackupLabel(event.target.value)}
                placeholder="Optional label, e.g. pre-upgrade"
                value={backupLabel}
              />
              <OctantButton
                disabled={backupState.kind === "pending" || !backupLabelValid}
                onClick={() => void runBackup()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {backupState.kind === "pending" ? "Creating backup…" : "Create backup"}
              </OctantButton>
            </div>
          </SettingRow>
        </div>
        {backupState.kind === "done" ? <BackupOutcomeView outcome={backupState.outcome} /> : null}
        {backupState.kind === "error" ? (
          <SettingsState kind="error">{backupState.message}</SettingsState>
        ) : null}
      </section>

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
          <OctantSelectField
            id="thread-retention-scope"
            onValueChange={(value) => {
              if (isRetentionScopeKind(value)) setScopeKind(value);
            }}
            options={[
              { id: "host", label: "This host" },
              { id: "project", label: "One Project" },
              { id: "thread", label: "One thread" },
            ]}
            value={scopeKind}
          />
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
              <OctantSelectField
                id="thread-retention-mode"
                onValueChange={(value) => {
                  if (isThreadMode(value)) setMode(value);
                }}
                options={[
                  { id: "chat", label: "Chat" },
                  { id: "work", label: "Work" },
                  { id: "code", label: "Code" },
                ]}
                value={mode}
              />
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
          <OctantSelectField
            id="thread-retention-window"
            onValueChange={(value) => setWindowValue(value)}
            options={[
              { id: "forever", label: "Keep forever" },
              { id: "7", label: "7 days" },
              { id: "30", label: "30 days" },
              { id: "90", label: "90 days" },
              { id: "365", label: "365 days" },
            ]}
            value={windowValue}
          />
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

/** An id or version: the mono identifier role at the row's control edge. */
function Identifier({ children }: { readonly children: string }) {
  return <span className="oct-meta--mono">{children}</span>;
}

function BackupOutcomeView({ outcome }: { readonly outcome: HostBackupOutcome }) {
  if (outcome.kind === "failed") {
    return (
      <p className="settings-section-line" role="alert">
        The backup was not created ({outcome.code}). Check the host logs.
      </p>
    );
  }
  return (
    <p aria-live="polite" className="settings-section-line">
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
