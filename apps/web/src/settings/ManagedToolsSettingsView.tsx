import { useEffect, useRef, useState } from "react";
import {
  decodeManagedToolsStatus,
  type ManagedToolStatus,
  type ManagedToolsStatus,
} from "@octant/contracts/managed-tooling";
import { getInjectedHostBridge, type OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection } from "./primitives";

type ManagedToolsBridge = Pick<
  OctantHostBridge,
  "getManagedToolsStatus" | "checkManagedToolUpdates" | "setManagedToolAutomaticUpdates"
>;

const TOOL_LABELS: Readonly<Record<string, string>> = {
  "serve-sim": "iOS Simulator stream",
  "serve-avd": "Android emulator stream",
};

const UPDATE_LABELS: Readonly<Record<ManagedToolStatus["update"], string>> = {
  idle: "Not checked yet",
  checking: "Checking for updates…",
  downloading: "Downloading update…",
  staged: "Update ready when tools are idle",
  current: "Up to date",
  failed: "Update unavailable",
};

function toolDescription(tool: ManagedToolStatus): string {
  const label = TOOL_LABELS[tool.tool] ?? tool.tool;
  const source = tool.installed ? "installed release" : "bundled with Octant";
  return `${label}, from the ${tool.packageName} package — ${source}.`;
}

export function ManagedToolsSettingsView(props: { readonly bridge?: ManagedToolsBridge }) {
  const bridge = props.bridge ?? getInjectedHostBridge();
  const [status, setStatus] = useState<ManagedToolsStatus>();
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
      if (bridge?.getManagedToolsStatus === undefined) {
        setError("Managed tools require the Octant desktop app.");
        return;
      }
      const request = ++revision.current;
      try {
        const next = decodeManagedToolsStatus(await bridge.getManagedToolsStatus());
        if (active && request === revision.current) {
          setStatus(next);
          setError(undefined);
        }
      } catch {
        if (active && request === revision.current)
          setError("Managed tool status is unavailable. Try rechecking.");
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 5_000);
    return () => {
      active = false;
      mounted.current = false;
      revision.current += 1;
      clearInterval(timer);
    };
  }, [bridge]);

  async function run(operation: (() => Promise<unknown>) | undefined) {
    if (operation === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const request = ++revision.current;
    try {
      const value = await operation();
      const next = decodeManagedToolsStatus(value ?? (await bridge?.getManagedToolsStatus?.()));
      if (mounted.current && request === revision.current) {
        setStatus(next);
        setError(undefined);
      }
    } catch {
      if (mounted.current)
        setError("Managed tools could not complete that request. Recheck status and try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const supported = status?.supported === true;
  const tools = (status?.tools ?? []).filter((tool) => tool.tool !== "opencode");
  return (
    <section
      aria-label="Device tools"
      className="settings-section-stack"
      id="settings-device-tools"
    >
      <SettingsSection
        title="Bundled tools"
        description="Octant ships its own verified copy of each tool and can replace it when upstream publishes a newer release."
      >
        <div className="setgroup">
          {tools.length === 0 ? (
            <SettingRow
              settingId="managed-tools-empty"
              label="Device tools"
              description="No managed tools are available on this host."
              scope="host"
            >
              <span>Unavailable</span>
            </SettingRow>
          ) : (
            tools.map((tool) => (
              <SettingRow
                key={tool.tool}
                settingId={`managed-tool-${tool.tool}`}
                label={tool.tool}
                description={toolDescription(tool)}
                scope="host"
              >
                <span>
                  {tool.available ? `${tool.packageName} ${tool.version}` : "Unavailable"}
                </span>
              </SettingRow>
            ))
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Updates"
        description="Which tool builds Octant runs, and when it looks for newer ones."
      >
        <div className="setgroup">
          <SettingRow
            settingId="managed-tools-automatic-updates"
            label="Automatic updates"
            description="Check daily and upgrade each tool while it is idle."
            scope="host"
          >
            <OctantSwitch
              label="Automatically update device tools"
              describedBy="managed-tools-automatic-updates-description"
              checked={status?.automaticUpdates ?? false}
              disabled={busy || !supported || bridge?.setManagedToolAutomaticUpdates === undefined}
              onCheckedChange={(enabled) => {
                const setter = bridge?.setManagedToolAutomaticUpdates;
                void run(setter === undefined ? undefined : () => setter(enabled));
              }}
            />
          </SettingRow>
          <SettingRow
            settingId="managed-tools-update-check"
            label="Update check"
            description="Checks again without waiting for the daily routine."
            scope="host"
          >
            <div className="settings-view__actions">
              <OctantButton
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !supported || bridge?.checkManagedToolUpdates === undefined}
                onClick={() => void run(bridge?.checkManagedToolUpdates)}
              >
                Check for updates
              </OctantButton>
              <span role="status">
                {status === undefined
                  ? "Checking tools…"
                  : tools.map((tool) => `${tool.tool}: ${UPDATE_LABELS[tool.update]}`).join(" · ")}
              </span>
            </div>
          </SettingRow>
        </div>
      </SettingsSection>
      <p
        className="provider-settings__field-guidance"
        role={error === undefined ? "status" : "alert"}
      >
        {error ??
          status?.message ??
          "Updates are verified against the package registry's published integrity hash before they replace the running copy."}
      </p>
    </section>
  );
}
