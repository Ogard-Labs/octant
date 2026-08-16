import { useCallback, useEffect, useId, useState } from "react";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type {
  HostControlStatus,
  HostBackupOutcome,
  HostLifecycleAction,
  HostRestoreOutcome,
} from "@octant/contracts/host-control";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import {
  AutomationNotificationSettings,
  type AutomationNotificationSettingsProps,
} from "./AutomationNotificationSettings";
import { FederatedHostsLifecyclePanel } from "./FederatedHostsLifecyclePanel";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";

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
  }, [client]);

  useEffect(() => {
    setStatusState({ kind: "loading" });
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
        <p role="status">Loading host status…</p>
      </section>
    );
  }

  if (statusState.kind === "error") {
    return (
      <section aria-label="Host" className="host-settings" id="settings-host">
        <p role="alert">{statusState.message}</p>
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

      <h2 className="host-settings__heading">Identity</h2>
      <dl className="host-settings__facts">
        <dt>Host</dt>
        <dd>{status.identity.hostId}</dd>
        <dt>Instance</dt>
        <dd>{status.identity.instanceId}</dd>
        <dt>Owner mode</dt>
        <dd>{OWNER_MODE_LABELS[status.identity.serviceMode]}</dd>
        <dt>Server version</dt>
        <dd>{status.versions.server}</dd>
        <dt>Wire version</dt>
        <dd>{status.versions.wire}</dd>
      </dl>

      <h2 className="host-settings__heading">Service policy</h2>
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

      <h2 className="host-settings__heading">Readiness</h2>
      <dl className="host-settings__facts">
        <dt>Store</dt>
        <dd>
          {status.readiness.store.state}, integrity {status.readiness.store.integrity}
        </dd>
        <dt>Replay (journal / projections)</dt>
        <dd>
          {status.readiness.replay.journalHead} / {status.readiness.replay.projections}
        </dd>
        <dt>Connected clients</dt>
        <dd>{status.readiness.clientsConnected}</dd>
        <dt>Uptime</dt>
        <dd>{formatUptime(status.readiness.uptimeSeconds)}</dd>
        <dt>Active work</dt>
        <dd>
          {status.work.active}
          {status.work.attentionRequired ? " (attention required)" : ""}
        </dd>
      </dl>

      <h2 className="host-settings__heading">Capabilities</h2>
      {status.capabilities.length === 0 ? (
        <p className="host-settings__note">No platform capabilities reported.</p>
      ) : (
        <ul className="host-settings__capabilities">
          {status.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      )}

      <h2 className="host-settings__heading">Lifecycle</h2>
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
        <p className="host-settings__note" role="status">
          {lifecycleMessage.text}
        </p>
      ) : (
        <p className="host-settings__note" role="alert">
          {lifecycleMessage.text}
        </p>
      )}

      <h2 className="host-settings__heading">Backup</h2>
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
        <p className="host-settings__note" role="alert">
          {backupState.message}
        </p>
      ) : null}

      <h2 className="host-settings__heading">Recovery</h2>
      <p className="host-settings__note">
        Restore replaces the live store, so it never runs while the host is online. Requesting a
        restore returns the offline procedure.
      </p>
      <div className="host-settings__controls">
        <OctantButton onClick={() => void runRestore()} type="button" variant="secondary">
          Restore from backup
        </OctantButton>
      </div>
      {restoreOutcome === undefined ? null : (
        <p aria-live="polite" className="host-settings__note">
          {restoreOutcome.guidance}
        </p>
      )}

      {automationNotifications === undefined ? null : (
        <AutomationNotificationSettings client={automationNotifications} />
      )}

      {hostFederationLifecycle === undefined ? null : (
        <FederatedHostsLifecyclePanel lifecycle={hostFederationLifecycle} />
      )}
    </section>
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
