import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import {
  MEMBER_REMOVAL_STEPS,
  MEMBER_UPDATE_STEPS,
  type MemberInstallRefusalReason,
  type MemberInstallResult,
  type MemberRemovalPlan,
  type MemberRemovalProgress,
  type MemberRemovalStep,
  type MemberUpdateFailure,
  type MemberUpdatePlan,
  type MemberUpdateProgress,
  type MemberUpdateStep,
  type ShieldServer,
} from "@octant/contracts/shield-servers";
import { useEffect, useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantDialog } from "../ui/base/OctantDialog";

export const MEMBER_UPDATE_ACTION = "Update";
export const MEMBER_REMOVAL_ACTION = "Remove Octant";

type StepRunState = "waiting" | "running" | "succeeded" | "failed" | "not-run";

const STATE_LABELS: Readonly<Record<StepRunState, string>> = {
  waiting: "Waiting",
  running: "Running…",
  succeeded: "Done",
  failed: "Failed",
  "not-run": "Not run",
};

/** How often a sheet reads its running steps. */
const PROGRESS_POLL_MS = 1_000;

/** Why the swapped build was rolled back, as the sheet says it. */
const ROLLBACK_REASONS: Readonly<Record<MemberUpdateFailure, string>> = {
  "server-unreachable": "the server could not be reached",
  "digest-mismatch": "the copy did not match the build checked here",
  "build-mismatch": "what arrived was not the build checked here",
  "command-failed": "the update did not apply",
  "timed-out": "a step did not finish in time",
  "recovery-required": "its store needs restoring",
  "rollback-unsafe": "its store was migrated",
  "health-check-failed": "it did not pass its health check",
  "hello-unproven": "its hello was not signed by its own key",
  "version-mismatch": "its hello named another version",
  "protocol-not-covered": "its protocol range does not cover this computer",
};

type Sheet<Plan, Progress> =
  | { readonly kind: "reading" }
  | { readonly kind: "plan"; readonly plan: Plan }
  | {
      readonly kind: "refused";
      readonly reason: MemberInstallRefusalReason;
      readonly message: string;
    }
  | { readonly kind: "progress"; readonly progress: Progress };

interface MemberSheetProps {
  readonly server: ShieldServer;
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly onClose: () => void;
}

/**
 * Reads the plan once, then a running progress every second until it stops.
 * `pick` turns an answer into the sheet's next state, or nothing for an
 * answer this sheet does not show.
 */
function useMemberSheet<Plan, Progress extends { readonly state: string }>(input: {
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly prepare: Parameters<ShieldServersClient["memberInstall"]>[0];
  readonly read: (progress: Progress) => Parameters<ShieldServersClient["memberInstall"]>[0];
  readonly pick: (result: MemberInstallResult) => Sheet<Plan, Progress> | undefined;
  readonly failure: string;
}) {
  const { client, prepare, read, pick, failure } = input;
  const [state, setState] = useState<Sheet<Plan, Progress>>({ kind: "reading" });
  const prepareKey = JSON.stringify(prepare);

  useEffect(() => {
    let current = true;
    client.memberInstall(prepare).then(
      (result) => {
        const next = pick(result);
        if (current && next !== undefined) setState(next);
      },
      () => {
        if (current) setState({ kind: "refused", reason: "unavailable", message: failure });
      },
    );
    return () => {
      current = false;
    };
    // The prepare command is read by its contents; a new object each render is the same read.
  }, [client, prepareKey]);

  const running = state.kind === "progress" && state.progress.state === "running";
  useEffect(() => {
    if (!running || state.kind !== "progress") return;
    // Polls until the operation leaves "running". A failed read (a paired
    // device briefly offline) schedules the next one instead of leaving the
    // sheet on its running steps; a refusal is terminal and is shown.
    const command = read(state.progress);
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(() => {
        client.memberInstall(command).then(
          (result) => {
            if (!current) return;
            const next = pick(result);
            if (next?.kind === "refused") {
              setState(next);
            } else if (next?.kind === "progress") {
              setState(next);
              if (next.progress.state === "running") poll();
            } else {
              poll();
            }
          },
          () => {
            if (current) poll();
          },
        );
      }, PROGRESS_POLL_MS);
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `read` and `pick` are rebuilt each render and say the same thing; the
    // operation's id, read once when it starts running, drives the poll.
  }, [client, running]);

  return [state, setState] as const;
}

function StepList<Step extends string>(props: {
  readonly labels: Readonly<Record<Step, string>>;
  readonly steps: ReadonlyArray<{
    readonly step: Step;
    readonly state?: StepRunState | undefined;
    readonly message?: string | undefined;
  }>;
}) {
  return (
    <ol aria-label="Steps" className="member-install__steps">
      {props.steps.map((step) => (
        <li data-state={step.state} key={step.step}>
          <span className="member-install__step-name">{props.labels[step.step]}</span>
          {step.state === undefined ? null : (
            <span className="member-install__step-state">{STATE_LABELS[step.state]}</span>
          )}
          {step.message === undefined ? null : (
            <span className="member-install__step-message">{step.message}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Refusal(props: { readonly message: string; readonly onClose: () => void }) {
  return (
    <>
      <OctantAlert tone="danger">{props.message}</OctantAlert>
      <div className="member-install__actions">
        <OctantButton onClick={props.onClose} type="button" variant="ghost">
          Close
        </OctantButton>
      </div>
    </>
  );
}

function updateStepLabels(from: string, to: string): Readonly<Record<MemberUpdateStep, string>> {
  return {
    copy: "Copy the build",
    verify: "Verify it on the server",
    drain: "Stop running turns",
    swap: `Swap to ${to}`,
    confirm: "Confirm its signed hello",
    "roll-back": `Roll back to ${from}`,
  };
}

/**
 * Update: one sheet that states, before anything runs, which signed build
 * replaces which, how running turns stop, and what makes Octant roll the
 * member back, then shows each step as it runs. The host checks the person,
 * the build and the member's hello itself.
 */
export function MemberUpdateSheet(props: MemberSheetProps) {
  const { server, client } = props;
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useMemberSheet<MemberUpdatePlan, MemberUpdateProgress>({
    client,
    prepare: { kind: "prepare-member-update", serverId: server.serverId },
    read: (progress) => ({ kind: "read-member-update", updateId: progress.updateId }),
    pick: (result) =>
      result.kind === "member-update-plan"
        ? { kind: "plan", plan: result.plan }
        : result.kind === "member-update-progress"
          ? { kind: "progress", progress: result.progress }
          : result.kind === "member-install-refused"
            ? { kind: "refused", reason: result.reason, message: result.message }
            : undefined,
    failure: "Octant could not read the server. Try again.",
  });
  // The confirmed plan's versions stay known while the steps run, for their labels.
  const [versions, setVersions] = useState<{ readonly from: string; readonly to: string }>();
  const labels =
    state.kind === "plan"
      ? updateStepLabels(state.plan.fromVersion, state.plan.toVersion)
      : updateStepLabels(versions?.from ?? "the previous version", versions?.to ?? "it");

  async function confirm(plan: MemberUpdatePlan) {
    setConfirming(true);
    setVersions({ from: plan.fromVersion, to: plan.toVersion });
    try {
      const result = await client.memberInstall({
        kind: "confirm-member-update",
        planId: plan.planId,
        drain: "stop-now",
      });
      if (result.kind === "member-update-progress") {
        setState({ kind: "progress", progress: result.progress });
      } else if (result.kind === "member-install-refused") {
        setState({ kind: "refused", reason: result.reason, message: result.message });
      }
    } catch {
      setState({
        kind: "refused",
        reason: "unavailable",
        message: "Octant could not start the update. Nothing ran.",
      });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <OctantDialog
      className="member-install__dialog"
      label={`Update Octant on ${server.alias}`}
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <h2 className="octant-dialog__title" id={titleId}>
        Update Octant on {server.alias}
      </h2>
      {state.kind === "reading" ? (
        <p className="member-install__note" role="status">
          Reading {server.alias} over SSH…
        </p>
      ) : null}
      {state.kind === "refused" ? (
        <Refusal message={state.message} onClose={props.onClose} />
      ) : null}
      {state.kind === "plan" ? (
        <>
          <dl aria-label="What the update will do" className="member-install__facts">
            <dt>Server</dt>
            <dd>
              {state.plan.user}@{state.plan.alias}
            </dd>
            <dt>Octant</dt>
            <dd>
              From {state.plan.fromVersion} to {state.plan.toVersion}, from the {state.plan.ring}{" "}
              release. Its release signature and every file's digest were checked on this computer,
              and the server checks the signature again before swapping.
            </dd>
            <dt>Running turns</dt>
            <dd>
              Octant on {state.plan.alias} stops now, before the swap. Turns the stop cuts off
              continue by themselves once it starts again. Waiting for running turns to finish first
              is not offered yet.
            </dd>
            <dt>Swap</dt>
            <dd>
              <code>octant server upgrade</code> on {state.plan.alias} installs it beside{" "}
              {state.plan.fromVersion} in <code>{state.plan.installRoot}</code>, switches to it, and
              goes back by itself if its health check fails.
              {state.plan.storeMigration
                ? ` This version migrates Octant's store, so it makes a verified backup first. If it is rolled back after the swap, Octant does not start ${state.plan.fromVersion} against the migrated store: you restore the backup.`
                : ""}
            </dd>
            <dt>Rolls back when</dt>
            <dd>
              After the swap this hub reads {state.plan.alias}'s signed hello. If it does not
              answer, is not signed by {state.plan.alias}'s own key, names a version other than{" "}
              {state.plan.toVersion}, or speaks no protocol this computer does, Octant puts{" "}
              {state.plan.fromVersion} back and says why.
            </dd>
          </dl>
          <StepList labels={labels} steps={MEMBER_UPDATE_STEPS.map((step) => ({ step }))} />
          <div className="member-install__actions">
            <OctantButton
              disabled={confirming}
              onClick={() => void confirm(state.plan)}
              type="button"
              variant="secondary"
            >
              Update to {state.plan.toVersion}
            </OctantButton>
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              Cancel
            </OctantButton>
          </div>
        </>
      ) : null}
      {state.kind === "progress" ? (
        <>
          <StepList labels={labels} steps={state.progress.steps} />
          <div aria-live="polite">
            {state.progress.state === "updated" ? (
              <p className="member-install__note">
                {server.alias} runs Octant {versions?.to}.
              </p>
            ) : state.progress.state === "rolled-back" ? (
              <p className="member-install__note">
                {server.alias} was rolled back to {versions?.from}, because{" "}
                {state.progress.rollbackReason === undefined
                  ? "the update did not apply"
                  : ROLLBACK_REASONS[state.progress.rollbackReason]}
                .
              </p>
            ) : state.progress.state === "failed" ? (
              <p className="member-install__note">Nothing ran after the step that failed.</p>
            ) : null}
          </div>
          <div className="member-install__actions">
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              {state.progress.state === "running" ? "Hide" : "Close"}
            </OctantButton>
          </div>
        </>
      ) : null}
    </OctantDialog>
  );
}

function removalStepLabels(deleteData: boolean): Readonly<Record<MemberRemovalStep, string>> {
  return {
    leave: "Leave the hub",
    stop: "Stop and remove the service",
    delete: deleteData ? "Delete the install and the data folder" : "Delete the install",
  };
}

/**
 * Remove Octant: one sheet that says plainly what is deleted and what stays,
 * with the data folder kept unless the person ticks it, then shows each step.
 */
export function MemberRemovalSheet(props: MemberSheetProps) {
  const { server, client } = props;
  const titleId = useId();
  const deleteDataId = useId();
  const [confirming, setConfirming] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [state, setState] = useMemberSheet<MemberRemovalPlan, MemberRemovalProgress>({
    client,
    prepare: { kind: "prepare-member-removal", serverId: server.serverId },
    read: (progress) => ({ kind: "read-member-removal", removalId: progress.removalId }),
    pick: (result) =>
      result.kind === "member-removal-plan"
        ? { kind: "plan", plan: result.plan }
        : result.kind === "member-removal-progress"
          ? { kind: "progress", progress: result.progress }
          : result.kind === "member-install-refused"
            ? { kind: "refused", reason: result.reason, message: result.message }
            : undefined,
    failure: "Octant could not read the server. Try again.",
  });

  async function confirm(plan: MemberRemovalPlan) {
    setConfirming(true);
    try {
      const result = await client.memberInstall({
        kind: "confirm-member-removal",
        planId: plan.planId,
        deleteData,
      });
      if (result.kind === "member-removal-progress") {
        setState({ kind: "progress", progress: result.progress });
      } else if (result.kind === "member-install-refused") {
        setState({ kind: "refused", reason: result.reason, message: result.message });
      }
    } catch {
      setState({
        kind: "refused",
        reason: "unavailable",
        message: "Octant could not start removing Octant. Nothing ran.",
      });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <OctantDialog
      className="member-install__dialog"
      label={`Remove Octant from ${server.alias}`}
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <h2 className="octant-dialog__title" id={titleId}>
        Remove Octant from {server.alias}
      </h2>
      {state.kind === "reading" ? (
        <p className="member-install__note" role="status">
          Reading {server.alias} over SSH…
        </p>
      ) : null}
      {state.kind === "refused" ? (
        <Refusal message={state.message} onClose={props.onClose} />
      ) : null}
      {state.kind === "plan" ? (
        <>
          <dl aria-label="What removing Octant will do" className="member-install__facts">
            <dt>Server</dt>
            <dd>
              {state.plan.user}@{state.plan.alias}. The server stays registered here.
            </dd>
            <dt>Hub</dt>
            <dd>
              {state.plan.alias} leaves your hub. If it cannot, this hub removes it from its roster.
            </dd>
            <dt>Service</dt>
            <dd>
              {state.plan.user}'s Octant{" "}
              {state.plan.service === "systemd-user" ? "systemd user service" : "launchd agent"} is
              stopped and removed.
            </dd>
            <dt>Deleted</dt>
            <dd>
              <span>
                The install, <code>{state.plan.installRoot}</code>, and Octant's install and update
                work folders beside it.
              </span>
              {deleteData ? (
                <span>
                  The data folder, <code>{state.plan.dataFolder}</code>, with Octant's threads,
                  settings and keys on {state.plan.alias}. This cannot be undone.
                </span>
              ) : null}
            </dd>
            <dt>Kept</dt>
            <dd>
              {deleteData ? (
                `Service logs Octant keeps outside the data folder on ${state.plan.alias} (for example ~/.local/state/octant/logs on Linux or ~/Library/Logs/Octant on a Mac); logs inside the data folder go with it. Delete those by hand if you want them gone. Files Octant did not make stay on the server too.`
              ) : (
                <span>
                  The data folder, <code>{state.plan.dataFolder}</code>, with Octant's threads,
                  settings and keys on {state.plan.alias}.
                </span>
              )}
            </dd>
          </dl>
          <label className="member-install__choice" htmlFor={deleteDataId}>
            <OctantCheckbox
              checked={deleteData}
              id={deleteDataId}
              onChange={(event) => setDeleteData(event.currentTarget.checked)}
            />
            <span>Also delete the data folder</span>
          </label>
          <StepList
            labels={removalStepLabels(deleteData)}
            steps={MEMBER_REMOVAL_STEPS.map((step) => ({ step }))}
          />
          <div className="member-install__actions">
            <OctantButton
              disabled={confirming}
              onClick={() => void confirm(state.plan)}
              type="button"
              variant="destructive"
            >
              {deleteData ? "Remove Octant and its data" : "Remove Octant"}
            </OctantButton>
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              Cancel
            </OctantButton>
          </div>
        </>
      ) : null}
      {state.kind === "progress" ? (
        <>
          <StepList
            labels={removalStepLabels(state.progress.deleteData)}
            steps={state.progress.steps}
          />
          <div aria-live="polite">
            {state.progress.state === "removed" ? (
              <p className="member-install__note">
                Octant is removed from {server.alias}
                {state.progress.deleteData ? ", with its data folder." : "; its data folder stays."}
              </p>
            ) : state.progress.state === "failed" ? (
              <p className="member-install__note">Nothing ran after the step that failed.</p>
            ) : null}
          </div>
          <div className="member-install__actions">
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              {state.progress.state === "running" ? "Hide" : "Close"}
            </OctantButton>
          </div>
        </>
      ) : null}
    </OctantDialog>
  );
}
