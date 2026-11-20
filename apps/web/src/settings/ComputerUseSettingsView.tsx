import { useState } from "react";
import { ComputerUseSetup } from "./ComputerUseSetup";
import { useComputerUseSetup, type ComputerBridge } from "./useComputerUseSetup";
import {
  type ComputerUseSettings,
  type ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";
import type { RememberedComputerUseApp, ShellSettings } from "@octant/contracts/shell";
import { thisComputerName, useHostPlatform } from "../platform";
import { getInjectedHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection, SettingsState } from "./primitives";

const NO_REMEMBERED_APPS: ReadonlyArray<RememberedComputerUseApp> = [];
const NO_PROJECT_NAMES: ReadonlyMap<string, string> = new Map();

export function ComputerUseSettingsView(props: {
  readonly settings: ComputerUseSettings;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => Promise<boolean> | boolean | void;
  readonly rememberedApps?: ReadonlyArray<RememberedComputerUseApp>;
  readonly projectNames?: ReadonlyMap<string, string>;
  readonly bridge?: ComputerBridge;
}) {
  const bridge = props.bridge ?? getInjectedHostBridge();
  const computer = thisComputerName(useHostPlatform());
  const setup = useComputerUseSetup(bridge, props.settings.enabled);
  const { status, busy, run } = setup;
  const supported = status?.supported === true;
  const rememberedApps = props.rememberedApps ?? NO_REMEMBERED_APPS;
  const projectNames = props.projectNames ?? NO_PROJECT_NAMES;
  const [forgettingKey, setForgettingKey] = useState<string>();
  const forgetApp = async (entry: RememberedComputerUseApp) => {
    const key = `${String(entry.projectId)}\0${entry.appId}`;
    setForgettingKey(key);
    try {
      await props.onSettingsChange({
        rememberedComputerUseApps: rememberedApps.filter(
          (candidate) =>
            String(candidate.projectId) !== String(entry.projectId) ||
            candidate.appId !== entry.appId,
        ),
      });
    } finally {
      setForgettingKey(undefined);
    }
  };
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
      <SettingsSection
        title="Plugin"
        description="While on, agents on a supported provider can use apps on this Mac. Below Full access, each app asks you first."
      >
        <div className="setgroup">
          <SettingRow
            settingId="computer-use-enabled"
            label="Computer use"
            description={`Allow tasks to request access to applications on ${computer}.`}
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
      </SettingsSection>
      <ComputerUseSetup
        settings={props.settings}
        onSettingsChange={props.onSettingsChange}
        bridge={bridge}
        setup={setup}
      />
      <SettingsSection
        title="Driver and updates"
        description="Which driver version Octant runs, and when it checks for updates."
      >
        <div className="setgroup">
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
          <SettingRow
            settingId="computer-use-update-check"
            label="Update check"
            description="Checks again without waiting for the daily routine."
            scope="host"
          >
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
          </SettingRow>
        </div>
        {status?.activeSessions ? (
          <p className="provider-settings__field-guidance">
            {status.activeSessions} computer-use task{status.activeSessions === 1 ? "" : "s"}{" "}
            active.
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        collapse={{
          open: rememberedApps.length > 0,
          summary:
            rememberedApps.length === 0
              ? "None remembered"
              : rememberedApps.length === 1
                ? "1 app remembered"
                : `${rememberedApps.length} apps remembered`,
        }}
        description="Granted by “Remember for this Project” on a Computer use approval below Full access. Forget one and the next thread asks again."
        title="Remembered applications"
      >
        {rememberedApps.length === 0 ? (
          <SettingsState kind="empty">No remembered applications.</SettingsState>
        ) : (
          <div className="setgroup">
            {rememberedApps.map((entry) => {
              const key = `${String(entry.projectId)}\0${entry.appId}`;
              const projectName = projectNames.get(String(entry.projectId)) ?? "Project";
              return (
                <SettingRow
                  description={`Threads in ${projectName} below Full access can use ${entry.appId} without asking.`}
                  key={key}
                  label={`${entry.appId} · ${projectName}`}
                  scope="host"
                  settingId="computer-use-remembered-apps"
                >
                  <OctantButton
                    disabled={forgettingKey === key}
                    onClick={() => void forgetApp(entry)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Forget
                  </OctantButton>
                </SettingRow>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
