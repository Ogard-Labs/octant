import { useEffect, useState } from "react";
import type {
  BackgroundHostChange,
  BackgroundHostState,
  OctantHostBridge,
} from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "./primitives";

/**
 * Settings → General: keep the host running in the background, and open the
 * app at login. Both are off until turned on. The rows exist only where the
 * desktop app offers them; a remote client and Octant Nightly have neither,
 * so a paired device can never change them. Each switch shows what the main
 * process read back from the operating system, never only what was asked.
 */
export function BackgroundHostSettings(props: {
  readonly bridge:
    | Pick<OctantHostBridge, "readBackgroundHost" | "changeBackgroundHost">
    | undefined;
  readonly focused?: boolean;
}) {
  const read = props.bridge?.readBackgroundHost;
  const change = props.bridge?.changeBackgroundHost;
  const [state, setState] = useState<BackgroundHostState>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (read === undefined) return;
    let active = true;
    void read().then(
      (next) => {
        if (active) setState(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [read]);

  if (state === undefined || state.status !== "available" || change === undefined) return null;

  async function apply(request: BackgroundHostChange): Promise<void> {
    if (change === undefined) return;
    setBusy(true);
    try {
      setState(await change(request));
    } catch {
      // The bridge refused before main answered; read again so the switch
      // still shows what is installed.
      if (read !== undefined) setState(await read().catch(() => state));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingRow
        description="Starts Octant's host when you log in, without a window, and starts it again if it stops unexpectedly. Quitting Octant still stops it."
        focused={props.focused === true}
        label="Keep Octant running in the background"
        scope="app"
        settingId="background-host"
      >
        <OctantSwitch
          checked={state.backgroundService}
          disabled={busy}
          label="Keep Octant running in the background"
          onCheckedChange={(checked) => void apply({ backgroundService: checked })}
        />
      </SettingRow>
      {state.openAtLogin === undefined ? null : (
        <SettingRow
          description="Opens Octant's window when you log in."
          label="Open Octant at login"
          scope="app"
          settingId="open-at-login"
        >
          <OctantSwitch
            checked={state.openAtLogin}
            disabled={busy}
            label="Open Octant at login"
            onCheckedChange={(checked) => void apply({ openAtLogin: checked })}
          />
        </SettingRow>
      )}
      {state.failure === undefined ? null : (
        <OctantAlert tone="danger">
          {state.failure === "background-service"
            ? "Octant could not change its background service. The switch shows what is installed now."
            : "Octant could not change its login item. The switch shows what is set now."}
        </OctantAlert>
      )}
    </>
  );
}
