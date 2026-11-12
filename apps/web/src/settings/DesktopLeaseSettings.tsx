import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import {
  DESKTOP_LEASE_COUNT_MAXIMUM,
  type DesktopLeaseSettings as LeaseSettings,
  type DesktopPaneRequest,
} from "@octant/contracts/desktop-lease";
import { useEffect, useState } from "react";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow, SettingsSection } from "./primitives";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly settings: LeaseSettings }
  /** The host answers only a person at a local window. */
  | { readonly status: "local-only" }
  | { readonly status: "failed" };

type LeaseSettingsChange = Omit<
  Extract<DesktopPaneRequest, { readonly kind: "set-lease-settings" }>,
  "kind"
>;

const COUNT_OPTIONS = Array.from({ length: DESKTOP_LEASE_COUNT_MAXIMUM }, (_, index) => ({
  id: String(index + 1),
  label: String(index + 1),
}));

/**
 * Settings › Computer use › the host-wide rules for disposable desktops:
 * whether a person confirms each one that bills or runs off this computer,
 * and how many a thread and this host hold at once. The host enforces them,
 * and only a person at a local window may read or change them.
 */
export function DesktopLeaseSettings(props: {
  readonly client: Pick<DesktopPaneClient, "request">;
  readonly focusedSetting?: string | undefined;
}) {
  const { client } = props;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  function show(answer: Awaited<ReturnType<DesktopPaneClient["request"]>>): void {
    if (answer.status === "lease-settings") {
      setLoaded({ status: "loaded", settings: answer.settings });
    } else if (answer.status === "refused" && answer.reason === "not-permitted") {
      setLoaded({ status: "local-only" });
    } else {
      setLoaded({ status: "failed" });
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    client.request({ kind: "lease-settings" }, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) show(answer);
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [client]);

  async function save(change: LeaseSettingsChange): Promise<void> {
    setBusy(true);
    setProblem(undefined);
    try {
      show(await client.request({ kind: "set-lease-settings", ...change }));
    } catch {
      setProblem("The host didn't take the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const settings = loaded.status === "loaded" ? loaded.settings : undefined;
  const disabled = busy || settings === undefined;
  const status =
    loaded.status === "loading"
      ? "Checking this host's desktop settings…"
      : loaded.status === "local-only"
        ? "Set on the computer Octant runs on."
        : loaded.status === "failed"
          ? "This window can't ask the host about its desktop settings."
          : undefined;

  return (
    <SettingsSection
      title="Disposable desktops"
      description="What every thread on this host follows when it starts a disposable desktop."
    >
      <div className="setgroup">
        <SettingRow
          settingId="desktop-confirm-billed"
          label="Confirm each billed desktop"
          description="On, you confirm every desktop that bills you or runs off this computer before it starts, and every file sent to one. Off, they start and send without asking, inside your monthly cap; a thread in Plan still starts none."
          scope="host"
          focused={props.focusedSetting === "desktop-confirm-billed"}
        >
          <OctantSwitch
            // Shown on until the host answers: that is what it enforces by default.
            checked={settings?.confirmBilledDesktops ?? true}
            disabled={disabled}
            label="Confirm each billed desktop"
            onCheckedChange={(checked) => void save({ confirmBilledDesktops: checked })}
          />
        </SettingRow>
        <SettingRow
          settingId="desktop-leases-per-thread"
          label="Desktops per thread"
          description="How many desktops one thread may hold at once. Lowering it ends none that are running."
          scope="host"
          focused={props.focusedSetting === "desktop-leases-per-thread"}
        >
          <OctantSelectField
            aria-label="Desktops per thread"
            className="settings-view__select window-no-drag"
            disabled={disabled}
            onValueChange={(value) => void save({ leasesPerThread: Number(value) })}
            options={COUNT_OPTIONS}
            value={String(settings?.leasesPerThread ?? 2)}
          />
        </SettingRow>
        <SettingRow
          settingId="desktop-leases-on-host"
          label="Desktops on this host"
          description="How many desktops may run on this host itself at once, across every thread. Desktops in a cloud account don't count."
          scope="host"
          focused={props.focusedSetting === "desktop-leases-on-host"}
        >
          <OctantSelectField
            aria-label="Desktops on this host"
            className="settings-view__select window-no-drag"
            disabled={disabled}
            onValueChange={(value) => void save({ hostLocalLeasesPerHost: Number(value) })}
            options={COUNT_OPTIONS}
            value={String(settings?.hostLocalLeasesPerHost ?? 2)}
          />
        </SettingRow>
      </div>
      {status === undefined ? null : (
        <p className="provider-settings__field-guidance" role="status">
          {status}
        </p>
      )}
      {problem === undefined ? null : <OctantFieldError>{problem}</OctantFieldError>}
    </SettingsSection>
  );
}
