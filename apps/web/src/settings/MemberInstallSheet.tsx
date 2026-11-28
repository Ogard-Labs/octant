import {
  ShieldServersClientFailure,
  type ShieldServersClient,
} from "@octant/client-runtime/shield-servers-client";
import type {
  MemberBuildDownload,
  MemberInstallPlan,
  MemberInstallProgress,
  MemberInstallRefusalReason,
  MemberInstallStep,
  MemberInstallStepState,
  ShieldServer,
} from "@octant/contracts/shield-servers";
import { useEffect, useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { MemberBuildDownloadStatus } from "./MemberBuildDownloadStatus";

export const MEMBER_INSTALL_ACTION = "Make this an Octant computer";

const STEP_LABELS: Readonly<Record<MemberInstallStep, string>> = {
  copy: "Copy the build",
  verify: "Verify it on the server",
  install: "Install",
  start: "Start the service",
  listen: "Turn on the listener",
  join: "Join the hub",
};

const STATE_LABELS: Readonly<Record<MemberInstallStepState["state"], string>> = {
  waiting: "Waiting",
  running: "Running…",
  succeeded: "Done",
  failed: "Failed",
  "not-run": "Not run",
};

const NETWORK_LABELS = { tailscale: "Tailscale", "lan-private": "private network" } as const;

/** How often the sheet reads a running install's steps. */
const PROGRESS_POLL_MS = 1_000;

type SheetState =
  | { readonly kind: "reading" }
  | { readonly kind: "plan"; readonly plan: MemberInstallPlan }
  | {
      readonly kind: "refused";
      readonly reason: MemberInstallRefusalReason;
      readonly message: string;
    }
  | { readonly kind: "progress"; readonly progress: MemberInstallProgress }
  | { readonly kind: "download"; readonly download: MemberBuildDownload };

export interface MemberInstallSheetProps {
  readonly server: ShieldServer;
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly onClose: () => void;
  /** Opens the guide to putting a computer on Tailscale or a private network. */
  readonly onOpenPrivateNetworkGuide?: (() => void) | undefined;
}

/**
 * Make this an Octant computer: one sheet that states, before anything runs,
 * what Octant read from the server and what it will do there, then shows each
 * step as it runs. The one button installs and approves the hub join for
 * that one install; the host checks the person, the build and the comparison
 * code itself.
 */
export function MemberInstallSheet(props: MemberInstallSheetProps) {
  const { server, client } = props;
  const titleId = useId();
  const addressId = useId();
  const [state, setState] = useState<SheetState>({ kind: "reading" });
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  // Read again once a build downloaded for the server is ready.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    // Closing the sheet ends its prepare request, so the host starts no
    // download for a sheet that is gone.
    const request = new AbortController();
    client
      .memberInstall({ kind: "prepare-member-install", serverId: server.serverId }, request.signal)
      .then(
        (result) => {
          if (!current) return;
          if (result.kind === "member-install-plan") {
            setState({ kind: "plan", plan: result.plan });
            setAddress(result.plan.addresses[0]?.address);
          } else if (result.kind === "member-build-download") {
            setState({ kind: "download", download: result.download });
          } else if (result.kind === "member-install-refused") {
            setState({ kind: "refused", reason: result.reason, message: result.message });
          }
        },
        () => {
          if (current) {
            setState({
              kind: "refused",
              reason: "unavailable",
              message: "Octant could not read the server. Try again.",
            });
          }
        },
      );
    return () => {
      current = false;
      request.abort();
    };
  }, [attempt, client, server.serverId]);

  const runningId =
    state.kind === "progress" && state.progress.state === "running"
      ? state.progress.installId
      : undefined;
  useEffect(() => {
    if (runningId === undefined) return;
    // Polls until the install leaves "running". A failed read (a paired
    // device briefly offline) schedules the next one instead of leaving the
    // sheet on "Running…"; a refusal is terminal and is shown.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(() => {
        client.memberInstall({ kind: "read-member-install", installId: runningId }).then(
          (result) => {
            if (!current) return;
            if (result.kind === "member-install-progress") {
              setState({ kind: "progress", progress: result.progress });
              if (result.progress.state === "running") poll();
            } else if (result.kind === "member-install-refused") {
              setState({ kind: "refused", reason: result.reason, message: result.message });
            } else {
              poll();
            }
          },
          (error: unknown) => {
            if (!current) return;
            // The host refusing this window (signed out, or no longer the
            // person's) does not pass by waiting, so it ends the polling.
            if (
              error instanceof ShieldServersClientFailure &&
              (error.status === 401 || error.status === 403)
            ) {
              setState({
                kind: "refused",
                reason: "not-the-person",
                message:
                  "This computer no longer accepts this window, so the install's progress cannot be read here.",
              });
            } else {
              poll();
            }
          },
        );
      }, PROGRESS_POLL_MS);
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, runningId]);

  async function confirm(plan: MemberInstallPlan, listenAddress: string) {
    setConfirming(true);
    try {
      const result = await client.memberInstall({
        kind: "confirm-member-install",
        planId: plan.planId,
        listenAddress,
      });
      if (result.kind === "member-install-progress") {
        setState({ kind: "progress", progress: result.progress });
      } else if (result.kind === "member-install-refused") {
        setState({ kind: "refused", reason: result.reason, message: result.message });
      }
    } catch {
      setState({
        kind: "refused",
        reason: "unavailable",
        message: "Octant could not start the install. Nothing ran.",
      });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <OctantDialog
      className="member-install__dialog"
      label={`Make ${server.alias} an Octant computer`}
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <h2 className="octant-dialog__title" id={titleId}>
        Make {server.alias} an Octant computer
      </h2>
      {state.kind === "reading" ? (
        <p className="member-install__note" role="status">
          Reading {server.alias} over SSH…
        </p>
      ) : null}
      {state.kind === "download" ? (
        <>
          <MemberBuildDownloadStatus
            client={client}
            download={state.download}
            key={state.download.downloadId}
            onReady={() => setAttempt((count) => count + 1)}
          />
          <div className="member-install__actions">
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              Close
            </OctantButton>
          </div>
        </>
      ) : null}
      {state.kind === "refused" ? (
        <>
          <OctantAlert tone="danger">{state.message}</OctantAlert>
          {state.reason === "no-private-address" &&
          props.onOpenPrivateNetworkGuide !== undefined ? (
            <OctantButton
              onClick={props.onOpenPrivateNetworkGuide}
              size="sm"
              type="button"
              variant="secondary"
            >
              Open the private network guide
            </OctantButton>
          ) : null}
        </>
      ) : null}
      {state.kind === "plan" ? (
        <>
          <dl aria-label="What Octant will do" className="member-install__facts">
            <dt>Server</dt>
            <dd>
              {state.plan.user}@{state.plan.alias}, which reports <code>{state.plan.system}</code>{" "}
              (read with <code>uname -sm</code>)
            </dd>
            <dt>Octant</dt>
            <dd>
              Version {state.plan.artifactVersion} from the {state.plan.ring} release. Its release
              signature and every file's digest were checked on this computer, and the server checks
              the signature again before installing.
            </dd>
            <dt>Install location</dt>
            <dd>
              <code>{state.plan.installRoot}</code>, in {state.plan.user}'s own data folder. Octant
              never uses sudo.
            </dd>
            <dt>Runs as</dt>
            <dd>
              A user service of {state.plan.user} (
              {state.plan.service === "systemd-user" ? "systemd user service" : "launchd agent"}).
            </dd>
            <dt>Starting at boot</dt>
            <dd>
              {state.plan.startsAtBoot ? (
                <>
                  {state.plan.alias} already starts {state.plan.user}'s services at boot.
                </>
              ) : state.plan.bootCommand === undefined ? (
                <>
                  It runs while {state.plan.user} is signed in on {state.plan.alias}. Starting at
                  boot with no one signed in is not offered for a Mac added over SSH yet.
                </>
              ) : (
                <BootCommand alias={state.plan.alias} command={state.plan.bootCommand} />
              )}
            </dd>
            <dt>
              <label htmlFor={addressId}>Listens on</label>
            </dt>
            <dd>
              <OctantSelectField
                aria-label="Listens on"
                id={addressId}
                onValueChange={(next) => setAddress(next)}
                options={state.plan.addresses.map((option) => ({
                  id: option.address,
                  label: `${option.address} (${NETWORK_LABELS[option.network]})`,
                }))}
                value={address ?? ""}
              />
              <span className="member-install__note">
                Port {state.plan.listenPort}, reached only over Tailscale or your private network.
              </span>
            </dd>
            <dt>Joins</dt>
            <dd>
              Your hub, {state.plan.joins.hubName}. Installing also approves this one join, and only
              when the comparison code {state.plan.alias} shows matches the one this hub sees.
            </dd>
          </dl>
          <div className="member-install__actions">
            <OctantButton
              disabled={confirming || address === undefined}
              onClick={() => {
                if (address !== undefined) void confirm(state.plan, address);
              }}
              type="button"
              variant="secondary"
            >
              Install and join
            </OctantButton>
            <OctantButton onClick={props.onClose} type="button" variant="ghost">
              Cancel
            </OctantButton>
          </div>
        </>
      ) : null}
      {state.kind === "progress" ? (
        <>
          <ol aria-label="Steps" className="member-install__steps">
            {state.progress.steps.map((step) => (
              <li data-state={step.state} key={step.step}>
                <span className="member-install__step-name">{STEP_LABELS[step.step]}</span>
                <span className="member-install__step-state">{STATE_LABELS[step.state]}</span>
                {step.message === undefined ? null : (
                  <span className="member-install__step-message">{step.message}</span>
                )}
              </li>
            ))}
          </ol>
          <div aria-live="polite">
            {state.progress.state === "joined" ? (
              <p className="member-install__note">
                {server.alias} is now an Octant computer in your hub.
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

/** The one administrator command, for the person to copy and run themselves. */
function BootCommand(props: { readonly alias: string; readonly command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="member-install__boot">
      <span>
        Until then it runs while the login has a session on {props.alias}. To start it at boot with
        no one logged in, run this once there; it needs an administrator:
      </span>
      <code className="member-install__command">{props.command}</code>
      <OctantButton
        aria-label="Copy the command"
        onClick={() => {
          void navigator.clipboard?.writeText(props.command).then(
            () => setCopied(true),
            () => {},
          );
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        {copied ? "Copied" : "Copy"}
      </OctantButton>
    </span>
  );
}
