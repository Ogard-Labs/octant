import type { AppReleaseRing, AppUpdateState } from "@octant/contracts/app-updates";
import {
  OCTANT_UPDATE_CHECK_DISCLOSURE,
  OCTANT_UPDATE_CHECK_INFERENCE,
} from "@octant/contracts/app-updates";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { AppUpdateInstallOutcome, OctantHostBridge } from "../shell/hostBridge";
import { SettingRow } from "./primitives";

export interface AppUpdateSettingsProps {
  readonly hostBridge?: OctantHostBridge;
  readonly automaticChecks: boolean;
  readonly onAutomaticChecksChange: (enabled: boolean) => void;
  readonly onReleaseRingChange: (ring: AppReleaseRing) => void;
  /** A deep link landed on the Updates group. */
  readonly focused?: boolean;
}

/**
 * Check for, download, and apply an update — and say what a check discloses.
 *
 * Three rows of the Updates group: the version with its check, the release
 * ring, and automatic checks. What a check sends sits behind a disclosure
 * under those rows rather than in a policy document nobody opens: the person
 * deciding whether to leave automatic checks on is the person who should be
 * able to read it.
 */
export function AppUpdateSettings(props: AppUpdateSettingsProps) {
  const bridge = props.hostBridge;
  const [state, setState] = useState<AppUpdateState>();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Extract<AppUpdateInstallOutcome, { kind: "wait" }>>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (bridge?.subscribeAppUpdateState === undefined) return;
    return bridge.subscribeAppUpdateState(setState);
  }, [bridge]);

  // Narrowed once, so the rest of this reads without asserting a bridge method
  // is there. A client without them is a remote client, served by a host it
  // does not update.
  const check = bridge?.checkForAppUpdate;
  const download = bridge?.downloadAppUpdate;
  const install = bridge?.installAppUpdate;
  const setAutomatic = bridge?.setAutomaticAppUpdateChecks;
  const setRing = bridge?.setAppUpdateRing;
  if (check === undefined || download === undefined || install === undefined) {
    return (
      <SettingRow
        description="This copy of Octant is not the desktop app, so it does not update itself."
        focused={props.focused ?? false}
        label="Version"
        scope="app"
        settingId="app-updates"
      >
        {null}
      </SettingRow>
    );
  }

  async function run(action: () => Promise<AppUpdateState>): Promise<void> {
    setBusy(true);
    setWaiting(undefined);
    setFailure(undefined);
    try {
      setState(await action());
    } catch (error) {
      // The host refuses rather than guessing when it cannot use the endpoint
      // it was configured with. Saying so is the point; a rejected request that
      // left the button spinning would read as a broken app instead of a
      // setting to fix.
      setFailure(error instanceof Error ? error.message : "Octant could not check for updates.");
    } finally {
      setBusy(false);
    }
  }

  const status = state?.status ?? "idle";
  const notice =
    status === "downloading"
      ? "Downloading. Octant will not replace itself until you relaunch it."
      : status === "ready"
        ? "An update is ready and applies the next time you relaunch Octant."
        : undefined;
  const alert = waiting === undefined ? (failure ?? state?.message) : describeWaiting(waiting);
  return (
    <>
      <SettingRow
        description={
          <>
            {state === undefined ? "Octant" : `Octant ${state.currentVersion}`}
            {status === "up-to-date" ? " · Up to date" : null}
            {notice === undefined ? null : (
              <span className="app-update__notice" role="status">
                {notice}
              </span>
            )}
            {alert === undefined ? null : (
              <span className="app-update__notice" role="alert">
                {alert}
              </span>
            )}
          </>
        }
        focused={props.focused ?? false}
        label="Version"
        scope="app"
        settingId="app-updates"
      >
        <div className="app-update__actions">
          <OctantButton
            disabled={busy || status === "checking" || status === "downloading"}
            onClick={() => void run(check)}
            size="sm"
            type="button"
            variant="secondary"
          >
            {status === "checking" ? "Checking…" : "Check for updates"}
          </OctantButton>
          {status === "available" && state?.available !== undefined ? (
            <OctantButton
              disabled={busy}
              onClick={() => void run(download)}
              size="sm"
              type="button"
            >
              {`Download ${state.available.version}`}
            </OctantButton>
          ) : null}
          {status === "ready" ? (
            <OctantButton
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void install()
                  .then((outcome) => {
                    // Never a countdown that expires: if work is running the app
                    // says what it is waiting for and stays where it is.
                    if (outcome.kind === "wait") setWaiting(outcome);
                  })
                  .finally(() => setBusy(false));
              }}
              size="sm"
              type="button"
            >
              Relaunch to update
            </OctantButton>
          ) : null}
        </div>
      </SettingRow>

      <SettingRow
        description="Stable is the released build; Preview is a nightly build of what has been merged and takes effect at the next check."
        label="Release ring"
        scope="app"
        settingId="app-update-ring"
      >
        <OctantToggleGroup<AppReleaseRing>
          aria-label="Release ring"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === undefined) return;
            props.onReleaseRingChange(selected);
            void setRing?.(selected);
          }}
          value={[state?.ring ?? "stable"]}
        >
          <OctantToggleGroupItem value="stable">Stable</OctantToggleGroupItem>
          <OctantToggleGroupItem value="preview">Preview</OctantToggleGroupItem>
        </OctantToggleGroup>
      </SettingRow>

      <SettingRow
        description="Turning this off stops Octant contacting the update service; you can still check by hand."
        label="Automatic checks"
        scope="app"
        settingId="app-update-automatic-checks"
      >
        <OctantSwitch
          checked={props.automaticChecks}
          label="Check for updates automatically"
          onCheckedChange={(checked) => {
            props.onAutomaticChecksChange(checked);
            void setAutomatic?.(checked);
          }}
        />
      </SettingRow>

      <details className="settings-disclosure app-update__disclosure">
        <summary>
          <ChevronRight aria-hidden="true" size={12} />
          What a check sends
        </summary>
        <div className="app-update__disclosure-body">
          <p>
            A check is a plain request for a file listing the latest version, and Octant compares it
            on this machine. It sends:
          </p>
          <ul>
            {OCTANT_UPDATE_CHECK_DISCLOSURE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>From that, whoever serves the update file learns:</p>
          <ul>
            {OCTANT_UPDATE_CHECK_INFERENCE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>Nothing else travels with it — no account, no Project, no thread, no usage.</p>
        </div>
      </details>
    </>
  );
}

function describeWaiting(work: Extract<AppUpdateInstallOutcome, { kind: "wait" }>): string {
  const parts: string[] = [];
  if (work.activeAgentCount > 0) {
    parts.push(
      `${work.activeAgentCount} ${work.activeAgentCount === 1 ? "agent is" : "agents are"} still working`,
    );
  }
  if (work.attentionRequired) parts.push("a thread is waiting on you");
  return `Octant will not relaunch while ${parts.join(" and ")}. Let the work finish or checkpoint it, then relaunch.`;
}
