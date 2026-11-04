import type { NightlyInstallationState } from "@octant/contracts/nightly-installation";
import { useEffect, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow } from "./primitives";

/** Manual installation of the separate application; never changes Stable's update ring. */
export function NightlyInstallationSettings({ bridge }: { readonly bridge: OctantHostBridge }) {
  const [state, setState] = useState<NightlyInstallationState>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const revision = useRef(0);
  const lifetime = useRef(0);
  const requests = useRef(0);
  useEffect(() => {
    lifetime.current++;
    requests.current = 0;
    setPending(false);
    if (bridge.appUpdatePreferenceScope === "local") return;
    let active = true;
    let receivedLive = false;
    const stop = bridge.subscribeNightlyInstallationState?.((value) => {
      if (!active) return;
      receivedLive = true;
      revision.current++;
      setFailure(undefined);
      setState(value);
    });
    void bridge
      .readNightlyInstallationState?.()
      .then((value) => {
        if (active && !receivedLive) setState(value);
      })
      .catch(() => {
        if (active) setFailure("The Nightly installation controls are unavailable.");
      });
    return () => {
      active = false;
      lifetime.current++;
      stop?.();
    };
  }, [bridge]);
  if (
    bridge.appUpdatePreferenceScope === "local" ||
    bridge.readNightlyInstallationState === undefined
  )
    return null;
  async function run(action: (() => Promise<NightlyInstallationState>) | undefined) {
    if (action === undefined) return;
    const observedRevision = revision.current;
    const observedLifetime = lifetime.current;
    requests.current++;
    setPending(true);
    setFailure(undefined);
    try {
      const receipt = await action();
      if (lifetime.current === observedLifetime && revision.current === observedRevision)
        setState(receipt);
    } catch {
      if (lifetime.current === observedLifetime && revision.current === observedRevision)
        setFailure(
          "Octant could not confirm the operation. Check the installation before retrying.",
        );
    } finally {
      if (lifetime.current === observedLifetime) {
        requests.current--;
        setPending(requests.current > 0);
      }
    }
  }
  const application = state !== undefined && "application" in state ? state.application : undefined;
  const working = state?.status === "working";
  const productName = state?.productName;
  const message =
    failure ?? (state !== undefined && "message" in state ? state.message : undefined);
  const description = working
    ? (
        {
          checking: "Checking the installed application…",
          downloading: "Downloading the latest scheduled build…",
          verifying: "Verifying the downloaded application…",
          installing: "Installing beside Octant…",
          opening: "Opening the verified application…",
          removing: "Moving the application to the Trash…",
          cancelling: "Stopping and cleaning up…",
        } as const
      )[state.phase]
    : application?.kind === "installed"
      ? `${productName} ${application.version}${application.running ? " · Running" : ""}`
      : "A separate app for scheduled builds. It shares your workspace without changing Octant's release ring.";
  return (
    <>
      <SettingRow
        label="Nightly application"
        description={
          <span role="status" aria-live="polite">
            {description}
          </span>
        }
        scope="app"
        settingId="nightly-installation"
      >
        <div className="app-update__actions">
          {application?.kind === "absent" && productName !== undefined ? (
            <OctantButton
              size="sm"
              type="button"
              disabled={pending || working || state?.status === "unavailable"}
              onClick={() => void run(bridge.installNightly)}
            >
              Install {productName}
            </OctantButton>
          ) : null}
          {application?.kind === "installed" && productName !== undefined ? (
            <>
              <OctantButton
                size="sm"
                type="button"
                variant="secondary"
                disabled={pending || working}
                onClick={() => void run(bridge.openNightly)}
              >
                Open {productName}
              </OctantButton>
              <OctantButton
                size="sm"
                type="button"
                variant="secondary"
                disabled={pending || working || application.running}
                onClick={() => void run(bridge.removeNightly)}
              >
                Remove {productName}
              </OctantButton>
            </>
          ) : null}
          {working && state.cancellable ? (
            <OctantButton
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void run(bridge.cancelNightlyInstallation)}
            >
              Cancel
            </OctantButton>
          ) : null}
          {!working ? (
            <OctantButton
              size="sm"
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void run(bridge.refreshNightlyInstallationState)}
            >
              Check installation
            </OctantButton>
          ) : null}
        </div>
      </SettingRow>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </>
  );
}
