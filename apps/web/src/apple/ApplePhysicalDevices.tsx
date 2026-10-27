import type {
  AppleDeviceDiscovery,
  AppleDeviceId,
  AppleDeviceRecord,
} from "@octant/contracts/apple-toolchain";
import { Check, CircleDashed, CircleX } from "lucide-react";
import { useId } from "react";
import type { DeviceSetupCheck } from "../device/deviceModel";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ApplePhysicalDevicesProps {
  readonly status: "loading" | "ready" | "failed";
  readonly discovery?: AppleDeviceDiscovery;
  /** Why the host's device layer could not be listed, in words. */
  readonly failure?: string;
  readonly selectedDeviceId?: string;
  /** The Team ID the person entered; device builds sign for it. */
  readonly team: string;
  /** The latest screenshot this thread took of the selected device. */
  readonly screenshotUrl?: string;
  readonly busy: boolean;
  /** Why the last request did not do what was asked. */
  readonly problem?: string;
  /** Whether this window can raise the desktop app's lease confirmation. */
  readonly canConfirmLease: boolean;
  readonly onSelect?: (deviceId: AppleDeviceId) => void;
  readonly onUseDevice?: (deviceId: AppleDeviceId) => void;
  readonly onRelease?: (deviceId: AppleDeviceId) => void;
  readonly onCapture?: (deviceId: AppleDeviceId) => void;
  readonly onTeamChange?: (team: string) => void;
  readonly onCheckAgain?: () => void;
}

const TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * The person's paired iPhones and iPads in the Apple workbench
 * (docs/design/apple-devices.md): a destination picker, the setup each one
 * still needs, the lease that lets this thread use one, and the latest
 * screenshot of it. A physical device has no live view and takes no input,
 * so the screen shown is always a screenshot the thread took. The host
 * decides every request; this only shows what it reported.
 */
export function ApplePhysicalDevices(props: ApplePhysicalDevicesProps) {
  const headingId = useId();
  const devices = props.discovery?.devices ?? [];
  const selected = devices.find((device) => String(device.deviceId) === props.selectedDeviceId);
  const checkAgain =
    props.onCheckAgain === undefined ? null : (
      <div className="apple-workbench__actions apple-devices__check">
        <OctantButton
          disabled={props.busy || props.status === "loading"}
          onClick={props.onCheckAgain}
          type="button"
          variant="outline"
        >
          Check again
        </OctantButton>
      </div>
    );
  return (
    <section aria-labelledby={headingId} className="apple-workbench__section apple-devices">
      <h2 id={headingId}>Physical devices</h2>
      {props.status === "loading" ? (
        <p>Looking for iPhones and iPads paired with this Mac…</p>
      ) : props.status === "failed" ? (
        <>
          <p>{props.failure ?? "This Mac's paired devices could not be listed."}</p>
          {checkAgain}
        </>
      ) : devices.length === 0 ? (
        <>
          <p>
            No iPhone or iPad is paired with this Mac. Pair one in Xcode › Window › Devices and
            Simulators, then check again.
          </p>
          {checkAgain}
        </>
      ) : (
        <>
          <ul aria-label="Paired devices" className="apple-devices__picker">
            {devices.map((device) => {
              const holder = holderOf(props.discovery, device);
              return (
                <li key={device.deviceId}>
                  <OctantButton
                    aria-pressed={String(device.deviceId) === props.selectedDeviceId}
                    disabled={props.onSelect === undefined}
                    onClick={() => props.onSelect?.(device.deviceId)}
                    type="button"
                    variant="ghost"
                  >
                    <strong>{device.name}</strong>
                    <span>
                      {device.model} · iOS {device.osVersion} · {connectionWord(device)} ·{" "}
                      {stateWord(device.state)}
                      {holder === "this-thread"
                        ? " · This thread"
                        : holder === "another-thread"
                          ? " · Another thread"
                          : ""}
                    </span>
                  </OctantButton>
                </li>
              );
            })}
          </ul>
          {selected === undefined ? (
            <p>Choose a device to see what it needs.</p>
          ) : (
            <DeviceDetail {...props} device={selected} />
          )}
          {checkAgain}
        </>
      )}
    </section>
  );
}

function DeviceDetail(props: ApplePhysicalDevicesProps & { readonly device: AppleDeviceRecord }) {
  const { device } = props;
  const teamId = useId();
  const holder = holderOf(props.discovery, device);
  const screenshotsOffered = props.discovery?.tooling.includes("screenshot") === true;
  const checks = setupChecks(device, props.team);
  return (
    <div className="apple-devices__detail">
      <p role="status">{stateSentence(device.state)}</p>
      <ul aria-label="Device setup" className="device-checks">
        {checks.map((check) => (
          <li data-state={check.state} key={check.id}>
            <span className="device-checks__mark">
              {check.state === "ok" ? (
                <Check aria-hidden="true" size={16} />
              ) : check.state === "missing" ? (
                <CircleX aria-hidden="true" size={16} />
              ) : (
                <CircleDashed aria-hidden="true" size={16} />
              )}
            </span>
            <span className="device-checks__body">
              <span>{check.label}</span>
              <span className="sr-only">
                {check.state === "ok"
                  ? "Done"
                  : check.state === "missing"
                    ? "Missing"
                    : "Not checked yet"}
              </span>
              {check.detail === undefined ? null : (
                <span className="device-checks__detail">{check.detail}</span>
              )}
              {check.fix === undefined ? null : (
                <span className="device-checks__fix">{check.fix}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {props.onTeamChange === undefined ? null : (
        <div className="apple-devices__team">
          <label htmlFor={teamId}>Team ID</label>
          <OctantInput
            autoCapitalize="characters"
            autoComplete="off"
            id={teamId}
            maxLength={10}
            onChange={(event) => props.onTeamChange?.(event.target.value.trim().toUpperCase())}
            placeholder="A1B2C3D4E5"
            spellCheck={false}
            value={props.team}
          />
        </div>
      )}
      <LeaseControls {...props} holder={holder} />
      {!screenshotsOffered ? (
        <p>Screenshots are unavailable: this Mac's Xcode offers no device screenshot.</p>
      ) : holder === "this-thread" ? (
        <>
          <p>A physical device has no live view: the pane shows the latest screenshot.</p>
          {props.onCapture === undefined ? null : (
            <div className="apple-workbench__actions apple-devices__capture">
              <OctantButton
                aria-label={`Capture ${device.name}'s screen`}
                disabled={props.busy || device.state !== "connected"}
                onClick={() => props.onCapture?.(device.deviceId)}
                type="button"
                variant="secondary"
              >
                Capture screen
              </OctantButton>
            </div>
          )}
        </>
      ) : null}
      {props.screenshotUrl === undefined ? null : (
        <figure className="apple-simulator-frame apple-devices__screenshot">
          <img alt={`Latest screenshot of ${device.name}`} src={props.screenshotUrl} />
          <figcaption>Latest screenshot</figcaption>
        </figure>
      )}
      {props.problem === undefined ? null : (
        <OctantAlert className="apple-workbench__action-message" tone="warning">
          {props.problem}
        </OctantAlert>
      )}
    </div>
  );
}

function LeaseControls(
  props: ApplePhysicalDevicesProps & {
    readonly device: AppleDeviceRecord;
    readonly holder: "this-thread" | "another-thread" | undefined;
  },
) {
  const { device } = props;
  if (props.holder === "another-thread") {
    // The host never says which thread; neither does the pane.
    return <p>Another thread is using {device.name}.</p>;
  }
  if (props.holder === "this-thread") {
    return (
      <div className="apple-devices__lease">
        <p>This thread is using {device.name}.</p>
        {props.onRelease === undefined ? null : (
          <OctantButton
            aria-label={`Stop using ${device.name}`}
            disabled={props.busy}
            onClick={() => props.onRelease?.(device.deviceId)}
            type="button"
            variant="outline"
          >
            Stop using
          </OctantButton>
        )}
      </div>
    );
  }
  if (device.state === "unavailable") {
    return <p>Reconnect {device.name} before a thread can use it.</p>;
  }
  if (!props.canConfirmLease || props.onUseDevice === undefined) {
    return (
      <p>
        Letting this thread use {device.name} is confirmed in Octant on the Mac it is paired with.
      </p>
    );
  }
  return (
    <div className="apple-devices__lease">
      <OctantButton
        disabled={props.busy}
        onClick={() => props.onUseDevice?.(device.deviceId)}
        type="button"
      >
        {`Let this thread use ${device.name}…`}
      </OctantButton>
    </div>
  );
}

function holderOf(
  discovery: AppleDeviceDiscovery | undefined,
  device: AppleDeviceRecord,
): "this-thread" | "another-thread" | undefined {
  return discovery?.leases.find((lease) => String(lease.deviceId) === String(device.deviceId))
    ?.holder;
}

/**
 * The host decides a device's state in this order: reachable, then paired,
 * then Developer Mode, then locked. A row after the one that failed has not
 * been checked, so it never reads as passed. A lock is not setup: the person
 * unlocks the phone, so it is said in the state line instead.
 */
function setupChecks(device: AppleDeviceRecord, team: string): ReadonlyArray<DeviceSetupCheck> {
  const unreachable = device.state === "unavailable";
  const untrusted = device.state === "untrusted";
  return [
    unreachable
      ? {
          id: "reachable",
          label: "Reachable from this Mac",
          state: "missing",
          detail: "Xcode can't reach it.",
          fix: "Connect it with a cable or to this Mac's network.",
        }
      : {
          id: "reachable",
          label: "Reachable from this Mac",
          state: "ok",
          detail: connectionWord(device),
        },
    unreachable
      ? {
          id: "paired",
          label: "Paired and trusted",
          state: "waiting",
          detail: "Checked once Xcode can reach it",
        }
      : untrusted
        ? {
            id: "paired",
            label: "Paired and trusted",
            state: "missing",
            detail: "It isn't paired with this Mac.",
            fix: "Tap Trust on the device, then pair it in Xcode › Window › Devices and Simulators.",
          }
        : { id: "paired", label: "Paired and trusted", state: "ok" },
    unreachable || untrusted
      ? {
          id: "developer-mode",
          label: "Developer Mode on",
          state: "waiting",
          detail: "Checked once it is paired",
        }
      : device.state === "developer-mode-off"
        ? {
            id: "developer-mode",
            label: "Developer Mode on",
            state: "missing",
            detail: "Development builds won't run on it.",
            fix: "Turn on Settings › Privacy & Security › Developer Mode on the device, then restart it.",
          }
        : { id: "developer-mode", label: "Developer Mode on", state: "ok" },
    TEAM_ID.test(team)
      ? { id: "team", label: "Development team", state: "ok", detail: team }
      : {
          id: "team",
          label: "Development team",
          state: "missing",
          detail: "Device builds sign with your own identity for this team.",
          fix: "Enter the 10-character Team ID shown in Xcode › Settings › Accounts.",
        },
  ];
}

function stateWord(state: AppleDeviceRecord["state"]): string {
  const words: Record<AppleDeviceRecord["state"], string> = {
    connected: "Ready",
    locked: "Locked",
    "developer-mode-off": "Developer Mode off",
    untrusted: "Not trusted",
    unavailable: "Unavailable",
  };
  return words[state];
}

function stateSentence(state: AppleDeviceRecord["state"]): string {
  const sentences: Record<AppleDeviceRecord["state"], string> = {
    connected: "Ready to use.",
    locked: "Locked. Unlock it to capture its screen or run an app on it.",
    "developer-mode-off": "Developer Mode is off, so development builds won't run on it.",
    untrusted: "Not trusted. Tap Trust on the device and finish pairing in Xcode.",
    unavailable: "Unavailable. Connect it with a cable or to this Mac's network, then check again.",
  };
  return sentences[state];
}

function connectionWord(device: AppleDeviceRecord): string {
  return device.connection === "wired" ? "Cable" : "Network";
}
