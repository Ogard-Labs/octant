import type { AppUpdateState } from "@octant/contracts/app-updates";
import { OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import type { AppUpdateInstallOutcome, OctantHostBridge } from "../shell/hostBridge";

export interface AppUpdateSettingsProps {
  readonly hostBridge?: OctantHostBridge;
  readonly automaticChecks: boolean;
  readonly onAutomaticChecksChange: (enabled: boolean) => void;
}

/**
 * Check for, download, and apply an update — and say what a check discloses.
 *
 * The disclosure sits next to the switch rather than in a policy document
 * nobody opens: the person deciding whether to leave automatic checks on is the
 * person who should be able to read what those checks send.
 */
export function AppUpdateSettings(props: AppUpdateSettingsProps) {
  const bridge = props.hostBridge;
  const [state, setState] = useState<AppUpdateState>();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Extract<AppUpdateInstallOutcome, { kind: "wait" }>>();

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
  if (check === undefined || download === undefined || install === undefined) {
    return (
      <p className="app-update__notice" role="status">
        This copy of Octant is not the desktop app, so it does not update itself.
      </p>
    );
  }

  async function run(action: () => Promise<AppUpdateState>): Promise<void> {
    setBusy(true);
    setWaiting(undefined);
    try {
      setState(await action());
    } finally {
      setBusy(false);
    }
  }

  const status = state?.status ?? "idle";
  return (
    <div className="app-update">
      <p className="app-update__version">
        {state === undefined ? "Octant" : `Octant ${state.currentVersion}`}
        {status === "up-to-date" ? " — up to date" : null}
      </p>

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
          <OctantButton disabled={busy} onClick={() => void run(download)} size="sm" type="button">
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

      {status === "downloading" ? (
        <p className="app-update__notice" role="status">
          Downloading. Octant will not replace itself until you relaunch it.
        </p>
      ) : null}
      {status === "ready" ? (
        <p className="app-update__notice" role="status">
          An update is ready and applies the next time you relaunch Octant.
        </p>
      ) : null}
      {waiting === undefined ? null : (
        <p className="app-update__notice" role="alert">
          {describeWaiting(waiting)}
        </p>
      )}
      {state?.message === undefined ? null : (
        <p className="app-update__notice" role="alert">
          {state.message}
        </p>
      )}

      <div className="app-update__automatic">
        <OctantSwitch
          checked={props.automaticChecks}
          label="Check for updates automatically"
          onCheckedChange={(checked) => {
            props.onAutomaticChecksChange(checked);
            void setAutomatic?.(checked);
          }}
        />
        <p className="app-update__disclosure">
          Turning this off stops Octant contacting the update service at all. A check is a plain
          request for a file listing the latest version, and the comparison happens on this Mac. It
          sends:
        </p>
        <ul className="app-update__disclosure-list">
          {OCTANT_UPDATE_CHECK_DISCLOSURE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="app-update__disclosure">
          Nothing else travels with it — no account, no Project, no thread, no usage.
        </p>
      </div>
    </div>
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
