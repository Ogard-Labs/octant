import {
  MEMBER_UPDATE_MAX_WAIT_MINUTES,
  type MemberUpdateDrain,
  type MemberUpdateDrainKind,
} from "@octant/contracts/shield-servers";
import {
  planFleetUpdate,
  type FleetUpdateMachinePlan,
  type FleetUpdateStep,
} from "@octant/domain/fleet-update-policy";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";
import {
  collectFleetUpdateInventory,
  retryFleetUpdateStep,
  runFleetUpdatePlan,
  type FleetUpdateInventorySnapshot,
  type FleetUpdateSources,
  type FleetUpdateStepState,
  type FleetUpdateStepStatus,
} from "./fleetUpdateEngine";

const DEFAULT_WAIT_MINUTES = 10;

const STEP_STATUS_LABELS: Readonly<Record<FleetUpdateStepStatus, string>> = {
  waiting: "Waiting",
  running: "Running…",
  succeeded: "Done",
  failed: "Failed",
  held: "Held",
  "waiting-for-work": "Waiting for work",
};

function minutesText(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function stepLabel(step: FleetUpdateStep): string {
  switch (step.phase) {
    case "provider-cli":
      return `${step.hostDisplayName} · ${step.providerDisplayName}${
        step.toVersion === undefined ? "" : ` → ${step.toVersion}`
      }`;
    case "remote-octant-ssh":
      return `${step.hostDisplayName} · Octant ${step.fromVersion} → ${step.toVersion}`;
    case "local-app":
      return `${step.hostDisplayName} · Octant${
        step.toVersion === undefined ? "" : ` → ${step.toVersion}`
      } (restarts last)`;
  }
}

function machineVersionSummary(machine: FleetUpdateMachinePlan): string {
  if (machine.octantAction === "local-app" || machine.octantAction === "remote-octant-ssh") {
    const from = machine.currentVersion ?? "current";
    const to = machine.targetOctantVersion;
    return to === undefined ? `Octant ${from} · Update ready` : `Octant ${from} → ${to}`;
  }
  if (machine.octantAction === "deferred") {
    return machine.currentVersion === undefined
      ? "Octant · Restart later"
      : `Octant ${machine.currentVersion} · Restart later`;
  }
  if (machine.octantAction === "up-to-date") {
    return machine.currentVersion === undefined
      ? "Octant up to date"
      : `Octant ${machine.currentVersion} · Up to date`;
  }
  if (machine.currentVersion !== undefined) {
    return `Octant ${machine.currentVersion}`;
  }
  return "Octant version unknown";
}

export interface FleetUpdateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sources: FleetUpdateSources;
}

/**
 * One confirmation that lists every connected computer (desktop and headless
 * servers alike), its Octant and provider CLI versions, or why it is skipped,
 * and runs updates in strict order: provider CLIs, remote servers, then this
 * app last (with Later deferring only this app).
 */
export function FleetUpdateDialog(props: FleetUpdateDialogProps) {
  const titleId = useId();
  const sourcesRef = useRef(props.sources);
  sourcesRef.current = props.sources;

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [inventory, setInventory] = useState<FleetUpdateInventorySnapshot>();
  const [drainKind, setDrainKind] = useState<MemberUpdateDrainKind>("wait");
  const [waitMinutes, setWaitMinutes] = useState(DEFAULT_WAIT_MINUTES);
  const [running, setRunning] = useState(false);
  const [deferredLocalApp, setDeferredLocalApp] = useState(false);
  const [stepStates, setStepStates] = useState<ReadonlyArray<FleetUpdateStepState>>();
  const [retryingStepIds, setRetryingStepIds] = useState<ReadonlySet<string>>(() => new Set());
  const runningRef = useRef(false);
  runningRef.current = running || retryingStepIds.size > 0;
  // Set when the dialog is closed ("Hide") while a run or retry is in flight so
  // reopening restores that run's live progress or finished retry controls
  // instead of discarding it and starting a second inventory.
  const preserveHiddenRunRef = useRef(false);

  const handleClose = (): void => {
    preserveHiddenRunRef.current = runningRef.current;
    props.onClose();
  };

  useEffect(() => {
    if (!props.open) return;
    if (runningRef.current || preserveHiddenRunRef.current) {
      preserveHiddenRunRef.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    setInventory(undefined);
    setStepStates(undefined);
    setRunning(false);
    setDeferredLocalApp(false);
    collectFleetUpdateInventory(sourcesRef.current, controller.signal).then(
      (snapshot) => {
        if (!controller.signal.aborted) {
          setInventory(snapshot);
          setLoading(false);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error ? error.message : "Octant could not check connected computers.",
          );
          setLoading(false);
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [props.open]);

  const plan = useMemo(
    () =>
      inventory === undefined
        ? undefined
        : planFleetUpdate(inventory.hosts, { deferLocalApp: false }),
    [inventory],
  );

  const deferredPlan = useMemo(
    () =>
      inventory === undefined
        ? undefined
        : planFleetUpdate(inventory.hosts, { deferLocalApp: true }),
    [inventory],
  );

  const currentDrain: MemberUpdateDrain =
    drainKind === "wait" ? { kind: "wait", minutes: waitMinutes } : { kind: "stop-now" };

  async function startRun(deferLocalApp: boolean): Promise<void> {
    if (inventory === undefined) return;
    const chosenPlan = deferLocalApp ? deferredPlan : plan;
    if (chosenPlan === undefined || chosenPlan.steps.length === 0) {
      if (deferLocalApp) props.onClose();
      return;
    }
    setDeferredLocalApp(deferLocalApp);
    setRunning(true);
    try {
      await runFleetUpdatePlan({
        plan: chosenPlan,
        inventory,
        sources: sourcesRef.current,
        drain: currentDrain,
        onStepStatesChange: setStepStates,
      });
    } finally {
      setRunning(false);
    }
  }

  async function retryOne(step: FleetUpdateStep): Promise<void> {
    if (inventory === undefined) return;
    setRetryingStepIds((current) => new Set(current).add(step.stepId));
    setStepStates((current) =>
      current?.map((entry) =>
        entry.step.stepId === step.stepId ? { step: entry.step, status: "running" } : entry,
      ),
    );
    try {
      const outcome = await retryFleetUpdateStep({
        step,
        inventory,
        sources: sourcesRef.current,
        drain: currentDrain,
      });
      setStepStates((current) =>
        current?.map((entry) =>
          entry.step.stepId === step.stepId ? { ...entry, ...outcome } : entry,
        ),
      );
    } finally {
      setRetryingStepIds((current) => {
        const next = new Set(current);
        next.delete(step.stepId);
        return next;
      });
    }
  }

  const inProgressOrDone = stepStates !== undefined;
  const anyFailure = stepStates?.some((entry) => entry.status === "failed") === true;
  const allSucceeded =
    stepStates !== undefined &&
    stepStates.length > 0 &&
    stepStates.every((entry) => entry.status === "succeeded");

  return (
    <OctantDialog
      className="fleet-update__dialog"
      label="Update all computers"
      labelledBy={titleId}
      onClose={handleClose}
      open={props.open}
    >
      <h2 className="octant-dialog__title" id={titleId}>
        Update all computers
      </h2>

      {loading ? (
        <p className="fleet-update__note" role="status">
          Checking connected computers and provider CLIs…
        </p>
      ) : null}

      {loadError !== undefined ? <OctantAlert tone="danger">{loadError}</OctantAlert> : null}

      {!loading && plan !== undefined && !inProgressOrDone ? (
        <>
          <ul aria-label="Connected computers" className="fleet-update__machines">
            {plan.machines.map((machine) => (
              <li
                className="fleet-update__machine"
                data-disposition={machine.disposition}
                key={machine.hostId}
              >
                <div className="fleet-update__machine-head">
                  <span className="fleet-update__machine-name">{machine.displayName}</span>
                  <span className="fleet-update__machine-badges">
                    {machine.isHeadless ? (
                      <span className="fleet-update__badge">Headless server</span>
                    ) : null}
                    {machine.restartsLast ? (
                      <span className="fleet-update__badge">This app, restarts last</span>
                    ) : null}
                    {machine.disposition === "skipped" ? (
                      <span className="fleet-update__badge">Skipped</span>
                    ) : null}
                  </span>
                </div>
                <p className="fleet-update__machine-detail">{machineVersionSummary(machine)}</p>
                {machine.outdatedProviders.length > 0 ? (
                  <p className="fleet-update__machine-detail">
                    Provider CLIs:{" "}
                    {machine.outdatedProviders
                      .map((provider) =>
                        provider.currentVersion !== undefined &&
                        provider.latestVersion !== undefined
                          ? `${provider.displayName} ${provider.currentVersion} → ${provider.latestVersion}`
                          : provider.displayName,
                      )
                      .join(", ")}
                  </p>
                ) : machine.providers.length > 0 && machine.disposition !== "skipped" ? (
                  <p className="fleet-update__machine-meta">
                    Provider CLIs up to date (
                    {machine.providers
                      .map((provider) =>
                        provider.currentVersion === undefined
                          ? provider.displayName
                          : `${provider.displayName} ${provider.currentVersion}`,
                      )
                      .join(", ")}
                    )
                  </p>
                ) : null}
                {machine.skipMessage !== undefined ? (
                  <p className="fleet-update__machine-meta">{machine.skipMessage}</p>
                ) : null}
                {machine.octantNote !== undefined ? (
                  <p className="fleet-update__machine-meta">{machine.octantNote}</p>
                ) : null}
                {machine.providerNote !== undefined ? (
                  <p className="fleet-update__machine-meta">{machine.providerNote}</p>
                ) : null}
              </li>
            ))}
          </ul>

          {plan.hasRemoteServerUpdates ? (
            <div className="fleet-update__drain">
              <p className="fleet-update__drain-label">Before updating remote servers</p>
              <OctantRadioGroup
                aria-label="Before updating remote servers"
                className="member-update__drains"
                onValueChange={setDrainKind}
                value={drainKind}
              >
                <OctantRadioGroupItem
                  value="wait"
                  variant={drainKind === "wait" ? "secondary" : "ghost"}
                >
                  {`Wait up to ${minutesText(waitMinutes)} for running work`}
                </OctantRadioGroupItem>
                <OctantRadioGroupItem
                  value="stop-now"
                  variant={drainKind === "stop-now" ? "secondary" : "ghost"}
                >
                  Stop now
                </OctantRadioGroupItem>
              </OctantRadioGroup>
              {drainKind === "wait" ? (
                <OctantNumberStepper
                  field
                  label="Minutes to wait for running work"
                  max={MEMBER_UPDATE_MAX_WAIT_MINUTES}
                  min={1}
                  onChange={setWaitMinutes}
                  suffix="min"
                  value={waitMinutes}
                />
              ) : null}
            </div>
          ) : null}

          {plan.steps.length === 0 ? (
            <p className="fleet-update__note" role="status">
              Everything reachable is up to date.
            </p>
          ) : (
            <p className="fleet-update__note">
              Order: provider CLIs first, then remote servers
              {plan.hasLocalAppUpdate ? ", then this app restarts last." : "."}
            </p>
          )}

          <div className="member-install__actions">
            {plan.steps.length > 0 ? (
              <OctantButton disabled={running} onClick={() => void startRun(false)} type="button">
                {plan.actionableMachineCount === 1
                  ? "Update 1 computer"
                  : `Update ${plan.actionableMachineCount} computers`}
              </OctantButton>
            ) : null}
            {plan.hasLocalAppUpdate ? (
              <OctantButton
                disabled={running}
                onClick={() => void startRun(true)}
                type="button"
                variant="secondary"
              >
                Later
              </OctantButton>
            ) : null}
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              {plan.steps.length > 0 ? "Cancel" : "Close"}
            </OctantButton>
          </div>
        </>
      ) : null}

      {inProgressOrDone ? (
        <>
          <ol aria-label="Update progress" className="member-install__steps">
            {stepStates.map((entry) => (
              <li data-state={entry.status} key={entry.step.stepId}>
                <span className="member-install__step-name">{stepLabel(entry.step)}</span>
                <span className="member-install__step-state">
                  {STEP_STATUS_LABELS[entry.status]}
                </span>
                {entry.message === undefined ? null : (
                  <span className="member-install__step-message">{entry.message}</span>
                )}
                {!running &&
                entry.retryable === true &&
                (entry.status === "failed" ||
                  entry.status === "held" ||
                  entry.status === "waiting-for-work") ? (
                  <span className="fleet-update__step-retry">
                    <OctantButton
                      disabled={retryingStepIds.has(entry.step.stepId)}
                      onClick={() => void retryOne(entry.step)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {entry.step.phase === "local-app" ? "Relaunch this app" : "Retry"}
                    </OctantButton>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          <div aria-live="polite">
            {!running && deferredLocalApp ? (
              <p className="fleet-update__note">
                This app's restart was deferred. Relaunch from Settings › Updates when ready.
              </p>
            ) : null}
            {!running && allSucceeded && !deferredLocalApp ? (
              <p className="fleet-update__note">All selected updates finished.</p>
            ) : null}
            {!running && anyFailure ? (
              <OctantAlert tone="warning">
                One or more updates did not finish. Other computers completed normally; you can
                retry any failed step above.
              </OctantAlert>
            ) : null}
          </div>

          <div className="member-install__actions">
            <OctantButton onClick={handleClose} type="button" variant="ghost">
              {running ? "Hide" : "Close"}
            </OctantButton>
          </div>
        </>
      ) : null}
    </OctantDialog>
  );
}
