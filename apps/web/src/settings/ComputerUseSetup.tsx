import { useState } from "react";
import type { ComputerUseSettings } from "@octant/contracts/computer-use-plugin";
import type { ShellSettings } from "@octant/contracts/shell";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow, SettingsSection } from "./primitives";
import type { useComputerUseSetup, ComputerBridge } from "./useComputerUseSetup";

export interface ComputerUseSetupProps {
  readonly settings: ComputerUseSettings;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => Promise<boolean> | boolean | void;
  readonly bridge: ComputerBridge | undefined;
}

export function ComputerUseSetup(
  props: ComputerUseSetupProps & {
    readonly setup: ReturnType<typeof useComputerUseSetup>;
  },
) {
  const { status, error, busy, run } = props.setup;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const supported = status?.supported === true;
  const working =
    status?.verification === "passed" &&
    status.enabled &&
    props.settings.enabled &&
    status.driver === "ready" &&
    status.permissions.accessibility &&
    status.permissions.screenRecording;
  const blocked = busy || saving || status?.verification === "running";
  async function save(patch: Partial<ComputerUseSettings>) {
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await props.onSettingsChange({ computerUse: { ...props.settings, ...patch } });
      if (saved !== true) {
        setSaveError("Computer use setup was not saved. Try again.");
        return false;
      }
      return true;
    } catch {
      setSaveError("Computer use setup was not saved. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function begin() {
    if (await save({ enabled: true, setupPending: true }))
      await run(props.bridge?.requestComputerUsePermissions);
  }
  async function test() {
    const next = await run(props.bridge?.testComputerUse);
    if (next?.verification === "passed" && props.settings.setupPending)
      await save({ setupPending: false });
  }
  return (
    <SettingsSection
      title="macOS permissions"
      description="Set up Computer use to see and interact with approved apps. Octant manages its own driver; an existing CuaDriver installation is left untouched."
    >
      <div className="setgroup">
        <SettingRow
          settingId="computer-use-setup"
          label="Guided setup"
          description={
            props.settings.enabled
              ? "Enabled. macOS permissions and a working test are checked separately."
              : "Computer use is off. Set up enables it and saves your progress."
          }
          scope="host"
        >
          <div className="settings-view__actions">
            <OctantButton
              size="sm"
              variant="secondary"
              disabled={
                blocked || !supported || props.bridge?.requestComputerUsePermissions === undefined
              }
              onClick={() => void begin()}
            >
              Set up Computer use
            </OctantButton>
            {props.settings.setupPending ? (
              <OctantButton
                size="sm"
                variant="ghost"
                disabled={blocked}
                onClick={() => void save({ setupPending: false })}
              >
                Skip for now
              </OctantButton>
            ) : null}
          </div>
        </SettingRow>
        {(
          [
            ["accessibility", "Accessibility", "computer-use-accessibility"],
            ["screenRecording", "Screen Recording", "computer-use-screen-recording"],
          ] as const
        ).map(([permission, label, id]) => (
          <SettingRow
            key={permission}
            settingId={id}
            label={label}
            description={
              permission === "accessibility"
                ? "Allow interaction with approved apps in System Settings → Privacy & Security → Accessibility."
                : "Allow window capture in System Settings → Privacy & Security → Screen Recording."
            }
            scope="host"
          >
            <div className="settings-view__actions">
              <span>
                {status === undefined
                  ? "Not checked"
                  : status.permissions[permission]
                    ? "Allowed"
                    : "Not allowed"}
              </span>
              <OctantButton
                size="sm"
                variant="ghost"
                disabled={
                  blocked ||
                  !supported ||
                  props.bridge?.openComputerUsePermissionSettings === undefined
                }
                onClick={() =>
                  void run(async () => {
                    await props.bridge?.openComputerUsePermissionSettings?.(permission);
                  })
                }
              >
                Open {label} settings
              </OctantButton>
            </div>
          </SettingRow>
        ))}
        <SettingRow
          settingId="computer-use-permission-actions"
          label="Permission setup"
          description="If Octant is missing, add the installed app using + where available. Relaunch if macOS asks, then return here. Your setup progress is saved; permissions are rechecked when you return."
          scope="host"
        >
          <div className="settings-view__actions">
            <OctantButton
              size="sm"
              variant="secondary"
              disabled={
                blocked ||
                !supported ||
                !props.settings.enabled ||
                props.bridge?.requestComputerUsePermissions === undefined
              }
              onClick={() => void run(props.bridge?.requestComputerUsePermissions)}
            >
              Set up permissions
            </OctantButton>
            <OctantButton
              size="sm"
              variant="ghost"
              disabled={blocked || props.bridge?.getComputerUseStatus === undefined}
              onClick={() => void run(props.bridge?.getComputerUseStatus)}
            >
              Recheck
            </OctantButton>
          </div>
        </SettingRow>
        <SettingRow
          settingId="computer-use-test"
          label="Working test"
          description="After you approve, Octant captures and clicks a temporary test window, then closes it. Each app used by a task still needs approval."
          scope="host"
        >
          <div className="settings-view__actions">
            <span role="status">
              {working
                ? "Verified working"
                : status?.verification === "running"
                  ? "Testing…"
                  : status?.verification === "failed"
                    ? "Test needs attention"
                    : "Not tested"}
            </span>
            <OctantButton
              size="sm"
              variant="secondary"
              disabled={
                blocked ||
                !supported ||
                !props.settings.enabled ||
                !status?.enabled ||
                status.driver !== "ready" ||
                !status.permissions.accessibility ||
                !status.permissions.screenRecording ||
                props.bridge?.testComputerUse === undefined
              }
              onClick={() => void test()}
            >
              {working ? "Test again" : "Test Computer use"}
            </OctantButton>
          </div>
        </SettingRow>
      </div>
      {saveError || error || status?.verificationMessage || status?.message ? (
        <OctantAlert tone={saveError || error ? "danger" : "neutral"}>
          {saveError ?? error ?? status?.verificationMessage ?? status?.message}
        </OctantAlert>
      ) : null}
    </SettingsSection>
  );
}
