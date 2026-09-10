import { useEffect, useRef, useState } from "react";
import {
  decodeComputerUseStatus,
  type ComputerUseSettings,
  type ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";
import type { ShellSettings } from "@octant/contracts/shell";
import { getInjectedHostBridge, type OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "./primitives";

type ComputerBridge = Pick<
  OctantHostBridge,
  | "getComputerUseStatus"
  | "requestComputerUsePermissions"
  | "openComputerUsePermissionSettings"
  | "checkComputerUseUpdates"
>;

export function ComputerUseSettingsView(props: {
  readonly settings: ComputerUseSettings;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
  readonly bridge?: ComputerBridge;
}) {
  const bridge = props.bridge ?? getInjectedHostBridge();
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const read = async () => {
      if (!active || inFlight.current || document.visibilityState === "hidden") return;
      if (bridge?.getComputerUseStatus === undefined) {
        setError("Computer use requires the Octant desktop app on an Apple Silicon Mac.");
        return;
      }
      const request = ++revision.current;
      try {
        const next = decodeComputerUseStatus(await bridge.getComputerUseStatus());
        if (active && request === revision.current) {
          setStatus(next);
          setError(undefined);
        }
      } catch {
        if (active && request === revision.current)
          setError("Computer use status is unavailable. Try rechecking.");
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 3_000);
    return () => {
      active = false;
      mounted.current = false;
      revision.current += 1;
      clearInterval(timer);
    };
  }, [bridge, props.settings.enabled, props.settings.automaticUpdates]);

  async function run(operation: (() => Promise<unknown>) | undefined) {
    if (operation === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const request = ++revision.current;
    try {
      const value = await operation();
      const next = decodeComputerUseStatus(value ?? (await bridge?.getComputerUseStatus?.()));
      if (mounted.current && request === revision.current) {
        setStatus(next);
        setError(undefined);
      }
    } catch {
      if (mounted.current)
        setError("Computer use could not complete that request. Recheck its status and try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const supported = status?.supported === true;
  const updateLabels: Readonly<Record<ComputerUseStatus["update"], string>> = {
    idle: "Not checked yet",
    checking: "Checking for updates…",
    downloading: "Downloading update…",
    staged: "Update ready when computer-use tasks finish",
    current: "Up to date",
    failed: "Update unavailable",
  };
  return (
    <section aria-label="Computer use" id="settings-computer-use">
      <p className="provider-settings__field-guidance">
        Add <strong>@Computer</strong> to a task to use this bundled plugin with a supported
        provider.
      </p>
      <div className="settings-card-section settings-card-section--open">
        <h2>Plugin</h2>
        <SettingRow
          settingId="computer-use-enabled"
          label="Computer use"
          description="Allow tasks to request access to applications on this Mac."
          scope="host"
        >
          <OctantSwitch
            label="Enable Computer use"
            describedBy="computer-use-enabled-description"
            checked={props.settings.enabled}
            disabled={busy}
            onCheckedChange={(enabled) =>
              props.onSettingsChange({ computerUse: { ...props.settings, enabled } })
            }
          />
        </SettingRow>
      </div>
      <div className="settings-card-section settings-card-section--open">
        <h2>macOS permissions</h2>
        <SettingRow
          settingId="computer-use-accessibility"
          label="Accessibility"
          description="Allows interaction with controls in an approved application."
          scope="host"
        >
          <span>
            {status === undefined
              ? "Not checked"
              : status.permissions.accessibility
                ? "Allowed"
                : "Not allowed"}
          </span>
        </SettingRow>
        <SettingRow
          settingId="computer-use-screen-recording"
          label="Screen recording"
          description="Allows the agent to see the application window it is working in."
          scope="host"
        >
          <span>
            {status === undefined
              ? "Not checked"
              : status.permissions.screenRecording
                ? "Allowed"
                : "Not allowed"}
          </span>
        </SettingRow>
        <div className="settings-view__actions">
          <OctantButton
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !supported || bridge?.requestComputerUsePermissions === undefined}
            onClick={() => void run(bridge?.requestComputerUsePermissions)}
          >
            Set up permissions
          </OctantButton>
          <OctantButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || !supported || bridge?.openComputerUsePermissionSettings === undefined}
            onClick={() => void run(bridge?.openComputerUsePermissionSettings)}
          >
            Open System Settings
          </OctantButton>
          <OctantButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || bridge?.getComputerUseStatus === undefined}
            onClick={() => void run(bridge?.getComputerUseStatus)}
          >
            Recheck
          </OctantButton>
        </div>
      </div>
      <div className="settings-card-section settings-card-section--open">
        <h2>Driver and updates</h2>
        <SettingRow
          settingId="computer-use-version"
          label="Installed driver"
          description="Octant bundles and manages its own copy of CuaDriver."
          scope="host"
        >
          <span>
            {status?.version === undefined ? "Unavailable" : `CuaDriver ${status.version}`}
          </span>
        </SettingRow>
        <SettingRow
          settingId="computer-use-automatic-updates"
          label="Automatic updates"
          description="Check daily and upgrade after computer-use tasks finish."
          scope="host"
        >
          <OctantSwitch
            label="Automatically update Computer use"
            describedBy="computer-use-automatic-updates-description"
            checked={props.settings.automaticUpdates}
            disabled={busy}
            onCheckedChange={(automaticUpdates) =>
              props.onSettingsChange({ computerUse: { ...props.settings, automaticUpdates } })
            }
          />
        </SettingRow>
        <div className="settings-view__actions">
          <OctantButton
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !supported || bridge?.checkComputerUseUpdates === undefined}
            onClick={() => void run(bridge?.checkComputerUseUpdates)}
          >
            Check for updates
          </OctantButton>
          <span role="status">
            {status === undefined ? "Checking driver…" : updateLabels[status.update]}
          </span>
        </div>
        {status?.activeSessions ? (
          <p className="provider-settings__field-guidance">
            {status.activeSessions} computer-use task{status.activeSessions === 1 ? "" : "s"}{" "}
            active.
          </p>
        ) : null}
      </div>
      <p
        className="provider-settings__field-guidance"
        role={error === undefined ? "status" : "alert"}
      >
        {error ??
          status?.message ??
          "Each task asks before controlling an application. Stop or disable the plugin to revoke access."}
      </p>
    </section>
  );
}
