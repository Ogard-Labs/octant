import type { AppUpdateChannel } from "@octant/contracts/shell";
import type {
  AppReleaseRing,
  AppUpdateState,
  NightlyDataChoice,
  NightlyDataState,
  NightlyInstallState,
} from "@octant/contracts/app-updates";
import {
  OCTANT_UPDATE_CHECK_DISCLOSURE,
  OCTANT_UPDATE_CHECK_INFERENCE,
} from "@octant/contracts/app-updates";
import { useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type {
  AppUpdateInstallOutcome,
  BundledWhatsNew,
  OctantHostBridge,
} from "../shell/hostBridge";
import { SettingRow, SettingsDisclosure } from "./primitives";
import { acknowledgeWhatsNewOnce } from "./whatsNewAcknowledgement";
import { WhatsNewDialog } from "./WhatsNewDialog";

export interface AppUpdateSettingsProps {
  readonly hostBridge?: OctantHostBridge;
  readonly automaticChecks: boolean;
  readonly onAutomaticChecksChange: (enabled: boolean) => void;
  /** The channel chosen in Settings, when one has been stored. */
  readonly updateChannel?: AppUpdateChannel | undefined;
  /**
   * Stores the channel with the ring it follows. Preview and Nightly both
   * follow `candidate`; Octant itself never follows `preview`.
   */
  readonly onUpdateChannelChange: (channel: AppUpdateChannel, ring: AppReleaseRing) => void;
  /** A deep link landed on the Updates group. */
  readonly focused?: boolean;
}

/**
 * Check for, download, and apply an update — and say what a check discloses.
 *
 * Updates group: the version with its check and What's new, the release ring,
 * and automatic checks. What a check sends sits behind a disclosure under
 * those rows rather than in a policy document nobody opens: the person
 * deciding whether to leave automatic checks on is the person who should be
 * able to read it.
 */
export function AppUpdateSettings(props: AppUpdateSettingsProps) {
  const bridge = props.hostBridge;
  const localPreferences = bridge?.appUpdatePreferenceScope === "local";
  // Nightly's own test host keeps its preferences on that host, but it is
  // still Nightly: it follows Nightly's ring and never offers to install itself.
  const nightly = localPreferences || bridge?.applicationIdentity?.flavor === "nightly";
  const productName = nightly ? "Octant Nightly" : "Octant";
  const [state, setState] = useState<AppUpdateState>();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Extract<AppUpdateInstallOutcome, { kind: "wait" }>>();
  const [failure, setFailure] = useState<string>();
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState<BundledWhatsNew>();
  const [chosenChannel, setChosenChannel] = useState<AppUpdateChannel>();

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
  const readWhatsNew = bridge?.readBundledWhatsNew;
  const acknowledgeWhatsNew = bridge?.acknowledgeWhatsNew;
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
  // Nightly follows its one ring and Octant chooses between Stable and
  // Preview. The switch waits for the host's first state: before it, a
  // packaged Octant would offer Nightly's ring and a click would store a ring
  // its host refuses on every launch. Only a development build, whose state
  // names no rings, offers all three.
  const allowedRings = state?.allowedRings;
  const offersRingChoice =
    state !== undefined && !nightly && (allowedRings === undefined || allowedRings.length > 1);
  const channel = effectiveChannel(chosenChannel ?? props.updateChannel, state?.ring);
  const offeredNotes =
    status === "available" && state?.available?.notes !== undefined && state.available.notes !== ""
      ? state.available.notes
      : undefined;

  function openWhatsNew(): void {
    if (readWhatsNew === undefined) return;
    setWhatsNew(undefined);
    setWhatsNewOpen(true);
    void readWhatsNew()
      .then((document) => {
        setWhatsNew(document);
        acknowledgeWhatsNewOnce(document.version, () => acknowledgeWhatsNew?.());
      })
      .catch(() => {
        setWhatsNew({ kind: "empty", version: state?.currentVersion ?? "", showAfterApply: false });
      });
  }

  const notice =
    status === "downloading"
      ? `Downloading. ${productName} will not replace itself until you relaunch it.`
      : status === "ready"
        ? `An update is ready and applies the next time you relaunch ${productName}.`
        : undefined;
  const alert = waiting === undefined ? (failure ?? state?.message) : describeWaiting(waiting);
  return (
    <>
      <SettingRow
        description={
          <>
            {state === undefined ? productName : `${productName} ${state.currentVersion}`}
            {status === "up-to-date" ? " · Up to date" : null}
          </>
        }
        focused={props.focused ?? false}
        label="Version"
        scope="app"
        settingId="app-updates"
      >
        <div className="app-update__actions">
          {readWhatsNew === undefined ? null : (
            <OctantButton onClick={openWhatsNew} size="sm" type="button" variant="secondary">
              What's new
            </OctantButton>
          )}
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
                setFailure(undefined);
                void install()
                  .then((outcome) => {
                    // Never a countdown that expires: if work is running the app
                    // says what it is waiting for and stays where it is.
                    if (outcome.kind === "wait") setWaiting(outcome);
                  })
                  .catch((error: unknown) => {
                    setFailure(
                      error instanceof Error
                        ? error.message
                        : "Octant could not install the update.",
                    );
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
      {notice === undefined ? null : <OctantAlert tone="neutral">{notice}</OctantAlert>}
      {alert === undefined ? null : (
        <OctantAlert tone={waiting === undefined ? "danger" : "warning"}>{alert}</OctantAlert>
      )}

      {offeredNotes === undefined ? null : (
        <p className="app-update__offer-notes" role="note">
          {offeredNotes}
        </p>
      )}

      {offersRingChoice ? (
        <SettingRow
          description={
            allowedRings === undefined || allowedRings.includes("candidate")
              ? "Stable is the released build. Preview tests the next release. Nightly adds Octant Nightly, a separate app with what is being built now. Switching takes effect at the next check, and going back to Stable waits for a stable release newer than this one."
              : "Stable is the released build. Switching takes effect at the next check."
          }
          label="Update channel"
          scope="app"
          settingId="app-update-ring"
        >
          <OctantToggleGroup<AppUpdateChannel>
            aria-label="Update channel"
            onValueChange={(value) => {
              const selected = value[0];
              if (selected === undefined) return;
              // Octant follows `candidate` for both Preview and Nightly; the
              // preview ring is read only by the Octant Nightly installer.
              const ring: AppReleaseRing = selected === "stable" ? "stable" : "candidate";
              setChosenChannel(selected);
              props.onUpdateChannelChange(selected, ring);
              if (setRing !== undefined) void run(() => setRing(ring));
            }}
            value={[channel]}
          >
            {allowedRings?.includes("stable") !== false ? (
              <OctantToggleGroupItem value="stable">Stable</OctantToggleGroupItem>
            ) : null}
            {allowedRings?.includes("candidate") !== false ? (
              <OctantToggleGroupItem value="preview">Preview</OctantToggleGroupItem>
            ) : null}
            {allowedRings?.includes("candidate") !== false ? (
              <OctantToggleGroupItem value="nightly">Nightly</OctantToggleGroupItem>
            ) : null}
          </OctantToggleGroup>
        </SettingRow>
      ) : null}

      {nightly ? (
        <p className="app-update__offer-notes">
          Octant Nightly gets a new build of what is being built every night.
        </p>
      ) : (
        <NightlyInstallRow bridge={bridge} channel={channel} ring={state?.ring} />
      )}

      <NightlyDataRow bridge={bridge} />

      <SettingRow
        description={`Turning this off stops ${productName} contacting the update service; you can still check by hand.`}
        label="Automatic checks"
        scope="app"
        settingId="app-update-automatic-checks"
      >
        <OctantSwitch
          checked={localPreferences ? (state?.automaticChecks ?? false) : props.automaticChecks}
          label="Check for updates automatically"
          onCheckedChange={(checked) => {
            if (!localPreferences) props.onAutomaticChecksChange(checked);
            if (setAutomatic !== undefined) void run(() => setAutomatic(checked));
          }}
        />
      </SettingRow>

      <SettingsDisclosure
        className="app-update__disclosure"
        title="What a check sends"
        variant="inline"
      >
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
          <p>
            What's new for the build you are running is a file inside the app; opening it does not
            contact the update service.
          </p>
        </div>
      </SettingsDisclosure>

      <WhatsNewDialog
        document={whatsNew}
        onClose={() => setWhatsNewOpen(false)}
        open={whatsNewOpen}
      />
    </>
  );
}

/**
 * The channel the switch shows. A stored channel counts only while it agrees
 * with the ring the host follows (a hub's offer can move the ring without
 * naming a channel); otherwise it is derived from the ring.
 */
function effectiveChannel(
  stored: AppUpdateChannel | undefined,
  ring: AppReleaseRing | undefined,
): AppUpdateChannel {
  if (stored === "stable" && ring !== "candidate") return "stable";
  if ((stored === "preview" || stored === "nightly") && ring === "candidate") return stored;
  return ring === "candidate" ? "preview" : "stable";
}

function describeWaiting(work: Extract<AppUpdateInstallOutcome, { kind: "wait" }>): string {
  if (work.activeAgentCount > 0) {
    return `Octant will not relaunch while ${work.activeAgentCount} ${work.activeAgentCount === 1 ? "agent is" : "agents are"} still working. Let the work finish or checkpoint it, then relaunch.`;
  }
  return "Octant could not check what is running, so it did not relaunch. Try again in a moment.";
}

const NIGHTLY_IN_FLIGHT_READ_MS = 2_000;
const NIGHTLY_IN_FLIGHT_READS = 600;

/**
 * The Octant Nightly row below the ring switch.
 *
 * It shows on the Nightly channel, and on any channel while Octant Nightly is
 * installed; the host still refuses an install unless Octant follows
 * `candidate`. Octant Nightly itself has no such row. Read again whenever the ring changes, because the
 * answer depends on it.
 */
function NightlyInstallRow(props: {
  readonly bridge: OctantHostBridge | undefined;
  readonly channel: AppUpdateChannel;
  readonly ring: AppReleaseRing | undefined;
}) {
  const read = props.bridge?.readNightlyInstall;
  const installNightly = props.bridge?.installNightly;
  const openNightly = props.bridge?.openNightly;
  const removeNightly = props.bridge?.removeNightly;
  const [nightly, setNightly] = useState<NightlyInstallState>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (read === undefined || props.ring === undefined) return;
    let active = true;
    void read().then(
      (next) => {
        if (active) setNightly(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [read, props.ring]);

  // A row mounted while main is installing or removing (Settings reopened
  // mid-install) has no pending request of its own to settle it, so it reads
  // again until main finishes. Bounded by the download deadline main applies,
  // plus room for extraction and the signature check.
  const inFlightReads = useRef(0);
  const inFlight = nightly?.status === "installing" || nightly?.status === "removing";
  useEffect(() => {
    if (!inFlight) {
      inFlightReads.current = 0;
      return;
    }
    if (busy || read === undefined || inFlightReads.current >= NIGHTLY_IN_FLIGHT_READS) return;
    let active = true;
    const timer = setTimeout(() => {
      inFlightReads.current += 1;
      void read().then(
        (next) => {
          if (active) setNightly(next);
        },
        () => undefined,
      );
    }, NIGHTLY_IN_FLIGHT_READ_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [nightly, inFlight, busy, read]);

  if (nightly === undefined || nightly.status === "unavailable") return null;
  // Visible on the Nightly channel, or whenever Octant Nightly is on disk so
  // it can still be opened or removed.
  if (props.channel !== "nightly" && nightly.status === "not-installed") return null;

  async function act(action: (() => Promise<NightlyInstallState>) | undefined): Promise<void> {
    if (action === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      setNightly(await action());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Octant could not reach Octant Nightly.");
    } finally {
      setBusy(false);
    }
  }

  const installed = nightly.status === "installed" || nightly.status === "removing";
  const working = busy || nightly.status === "installing" || nightly.status === "removing";
  const alert = failure ?? nightly.message;
  return (
    <>
      <SettingRow
        description={
          installed
            ? "Installed beside Octant and sharing its data. Removing it moves the app to the Trash and leaves that data alone."
            : "A second app with builds of what has been merged, beside Octant and sharing its data. It is checked against Octant's own signature before it is placed."
        }
        label="Octant Nightly"
        scope="app"
        settingId="app-update-nightly"
      >
        <div className="app-update__actions">
          {installed ? (
            <>
              <OctantButton
                disabled={working}
                onClick={() => void act(openNightly)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Open Octant Nightly
              </OctantButton>
              <OctantButton
                disabled={working}
                onClick={() => void act(removeNightly)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {nightly.status === "removing" ? "Removing…" : "Remove Octant Nightly"}
              </OctantButton>
            </>
          ) : (
            <OctantButton
              disabled={working}
              onClick={() => void act(installNightly)}
              size="sm"
              type="button"
              variant="secondary"
            >
              {working ? "Installing…" : "Install Octant Nightly"}
            </OctantButton>
          )}
        </div>
      </SettingRow>
      {alert === undefined ? null : <OctantAlert tone="danger">{alert}</OctantAlert>}
    </>
  );
}

const NIGHTLY_DATA_LABELS: Readonly<Record<NightlyDataChoice, string>> = {
  octant: "Octant's data",
  "test-data": "Separate test data",
};

const NIGHTLY_DATA_REMOVAL_MESSAGES: Readonly<
  Record<NonNullable<NightlyDataState["removal"]>, string | undefined>
> = {
  removed: undefined,
  absent: undefined,
  "test-host-running":
    "Octant Nightly is running on its test data. Switch to Octant's data and relaunch before removing it.",
  "unsafe-folder": "Octant Nightly did not remove the test data: its folder is not one it made.",
  "not-nightly": "Only Octant Nightly removes its test data.",
  failed: "Octant Nightly could not move the test data to the Trash.",
};

/**
 * Nightly's Data row: Octant's data through Octant's host (the default), or a
 * host of Nightly's own on separate test data for development and testing.
 * A change applies on the next launch, so the row says so and offers the
 * relaunch. The test data can be moved to the Trash while Nightly is not
 * running on it.
 */
function NightlyDataRow(props: { readonly bridge: OctantHostBridge | undefined }) {
  const read = props.bridge?.readNightlyData;
  const choose = props.bridge?.chooseNightlyData;
  const remove = props.bridge?.removeNightlyTestData;
  const relaunch = props.bridge?.relaunchNightly;
  const [data, setData] = useState<NightlyDataState>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (read === undefined) return;
    let active = true;
    void read().then(
      (next) => {
        if (active) setData(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [read]);

  if (read === undefined || choose === undefined || data === undefined) return null;

  async function act(action: (() => Promise<NightlyDataState>) | undefined): Promise<void> {
    if (action === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      setData(await action());
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Octant Nightly could not change its data.",
      );
    } finally {
      setBusy(false);
    }
  }

  const pending = data.chosen !== data.running;
  const removalMessage =
    data.removal === undefined ? undefined : NIGHTLY_DATA_REMOVAL_MESSAGES[data.removal];
  return (
    <>
      <SettingRow
        description="Octant's data uses Octant's host and your real work. Separate test data runs Nightly's own host on data that is never Octant's, for development and testing; you sign in again there. A change applies when Octant Nightly relaunches."
        label="Data"
        scope="app"
        settingId="app-nightly-data"
      >
        <OctantToggleGroup<NightlyDataChoice>
          aria-label="Data"
          disabled={busy}
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === undefined || selected === data.chosen) return;
            void act(() => choose(selected));
          }}
          value={[data.chosen]}
        >
          <OctantToggleGroupItem value="octant">{NIGHTLY_DATA_LABELS.octant}</OctantToggleGroupItem>
          <OctantToggleGroupItem value="test-data">
            {NIGHTLY_DATA_LABELS["test-data"]}
          </OctantToggleGroupItem>
        </OctantToggleGroup>
      </SettingRow>
      {pending ? (
        <OctantAlert tone="neutral">
          <span>
            Octant Nightly uses {NIGHTLY_DATA_LABELS[data.chosen].toLowerCase()} after it
            relaunches.
          </span>{" "}
          <OctantButton
            disabled={busy || relaunch === undefined}
            onClick={() => {
              if (relaunch === undefined) return;
              setBusy(true);
              void relaunch().then(
                () => setBusy(false),
                (error: unknown) => {
                  setBusy(false);
                  setFailure(
                    error instanceof Error ? error.message : "Octant Nightly could not relaunch.",
                  );
                },
              );
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Relaunch Octant Nightly
          </OctantButton>
        </OctantAlert>
      ) : null}
      {data.testDataPresent ? (
        <SettingRow
          description={
            data.running === "test-data"
              ? "Octant Nightly is running on its test data. Switch to Octant's data and relaunch before removing it."
              : "Moves Octant Nightly's test data to the Trash. Octant's data is not touched."
          }
          label="Test data"
          scope="app"
          settingId="app-nightly-test-data"
        >
          <OctantButton
            disabled={busy || data.running === "test-data" || remove === undefined}
            onClick={() => void act(remove)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Remove test data
          </OctantButton>
        </SettingRow>
      ) : null}
      {failure === undefined && removalMessage === undefined ? null : (
        <OctantAlert tone="danger">{failure ?? removalMessage}</OctantAlert>
      )}
    </>
  );
}
