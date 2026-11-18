import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type {
  CloudMachine,
  CloudMachinesCommand,
  CloudMachinesView,
} from "@octant/contracts/cloud-machines";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingsPanel } from "./primitives";

export type CloudMachinesClient = Required<
  Pick<ServerProjectsClient, "cloudMachinesRead" | "cloudMachinesCommand">
>;

export const CLOUD_MACHINES_INTRO =
  "Machines Octant creates in your own cloud account through a cloud machine plugin you enabled, each bound as a server Project. Octant shows only the state and cost your provider reports.";

/** What a suspended machine's Project says where its calls are refused. */
export const CLOUD_MACHINE_SUSPENDED_NOTICE =
  "This machine is suspended; resume it first. Its Project's turns and commands are refused until then.";

const STATE_LABELS: Readonly<Record<NonNullable<CloudMachine["state"]>, string>> = {
  provisioning: "Provisioning",
  running: "Running",
  suspending: "Suspending",
  suspended: "Suspended",
  resuming: "Resuming",
  destroying: "Destroying",
  destroyed: "Destroyed",
  unknown: "State unknown",
};

function stateLabel(machine: CloudMachine): string {
  switch (machine.lifecycle) {
    case "creating":
      return "Creating";
    case "creation-refused":
      return "Not created";
    case "creation-uncertain":
      return "Creation uncertain";
    case "destroyed":
      return "Destroyed";
    case "created":
      return machine.state === undefined ? "State unknown" : STATE_LABELS[machine.state];
  }
}

function isLive(machine: CloudMachine): boolean {
  return machine.lifecycle !== "destroyed" && machine.lifecycle !== "creation-refused";
}

function seen(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : time.toLocaleString();
}

/**
 * Settings › Permissions › Servers: machines in the person's own cloud
 * account. Absent when no cloud machine plugin is offered and nothing is on
 * record, and when this host refuses the list, as it does for a restricted
 * device. Every act is the host's to allow; a refusal is shown as it arrived.
 */
export function CloudMachinesSettings(props: {
  readonly client: CloudMachinesClient;
  /** Bumped when a change elsewhere (a Project row's Resume) may have moved a machine. */
  readonly revision?: number;
  /** A machine's server Project may have been bound or changed. */
  readonly onChanged?: () => void;
}) {
  const { client, onChanged } = props;
  const fieldId = useId();
  const [view, setView] = useState<CloudMachinesView | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [createProblem, setCreateProblem] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<
    | {
        readonly machineId: CloudMachine["id"];
        readonly name: string;
        readonly confirmation: string;
      }
    | undefined
  >(undefined);
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<"code" | "work">("code");
  const [image, setImage] = useState("");
  const [size, setSize] = useState("");
  const [region, setRegion] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [setupScript, setSetupScript] = useState("");

  const revision = props.revision ?? 0;
  const load = useCallback(async () => {
    try {
      setView(await client.cloudMachinesRead());
    } catch {
      // Refused here (a restricted device) or unavailable: the section stays absent.
      setView(undefined);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load, revision]);

  async function send(
    command: CloudMachinesCommand,
    report: (message: string | undefined) => void = setProblem,
  ): Promise<boolean> {
    report(undefined);
    setBusy(true);
    try {
      const result = await client.cloudMachinesCommand(command);
      if (result.kind === "cloud-machines-updated") {
        setView(result.view);
        onChanged?.();
        return true;
      }
      if (result.kind === "cloud-machine-destroy-confirmation") {
        setConfirming({
          machineId: result.machineId,
          name: result.name,
          confirmation: result.confirmation,
        });
        return true;
      }
      report(result.message);
      // A refused act may still have recorded what the provider said.
      void load();
      return false;
    } catch {
      report("The cloud machine change could not be sent to this host.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (view === undefined) return null;
  if (view.targets.length === 0 && !view.machines.some(isLive)) return null;

  const chosenTarget =
    view.targets.find((target) => target.targetId === targetId) ?? view.targets[0];
  const targetName = (id: string) =>
    view.targets.find((target) => target.targetId === id)?.displayName ?? id;
  const ready =
    chosenTarget !== undefined &&
    name.trim() !== "" &&
    folder.trim().startsWith("/") &&
    image.trim() !== "" &&
    size.trim() !== "" &&
    region.trim() !== "" &&
    credentialReference.trim() !== "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || chosenTarget === undefined) return;
    void send(
      {
        kind: "create-cloud-machine",
        targetId: chosenTarget.targetId,
        name: name.trim(),
        folder: folder.trim(),
        credentialReference: credentialReference.trim(),
        recipe: {
          image: image.trim(),
          size: size.trim(),
          region: region.trim(),
          ...(setupScript.trim() === "" ? {} : { setupScript }),
        },
        ...(mode === "work" ? { mode: "work" as const } : {}),
      },
      setCreateProblem,
    ).then((created) => {
      if (!created) return;
      setName("");
      setFolder("");
      setSetupScript("");
    });
  }

  return (
    <div className="shield-servers" data-setting-id="cloud-machines">
      <SettingsPanel
        collapse={{
          open: view.machines.length > 0,
          summary:
            view.machines.length === 0
              ? "No cloud machines"
              : view.machines.length === 1
                ? "1 cloud machine"
                : `${view.machines.length} cloud machines`,
        }}
        description={CLOUD_MACHINES_INTRO}
        title="Machines in your cloud account"
      >
        {view.machines.length === 0 ? (
          <p className="shield-servers__empty">No machines were created.</p>
        ) : (
          <ul aria-label="Cloud machines" className="shield-servers__list">
            {view.machines.map((machine) => {
              const machineId = machine.id;
              const created = machine.lifecycle === "created";
              return (
                <li className="shield-servers__server" key={String(machineId)}>
                  <span className="shield-servers__name">{machine.name}</span>
                  <span className="shield-servers__login">
                    {stateLabel(machine)} · {targetName(machine.targetId)}
                    {machine.stateObservedAt === undefined
                      ? ""
                      : ` · last seen ${seen(machine.stateObservedAt)}`}
                  </span>
                  <span className="shield-servers__row-actions">
                    {created ? (
                      <OctantButton
                        aria-label={`Refresh ${machine.name}`}
                        disabled={busy}
                        onClick={() => void send({ kind: "refresh-cloud-machine", machineId })}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Refresh
                      </OctantButton>
                    ) : null}
                    {created && machine.state === "running" ? (
                      <OctantButton
                        aria-label={`Suspend ${machine.name}`}
                        disabled={busy}
                        onClick={() => void send({ kind: "suspend-cloud-machine", machineId })}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Suspend
                      </OctantButton>
                    ) : null}
                    {created && machine.state === "suspended" ? (
                      <OctantButton
                        aria-label={`Resume ${machine.name}`}
                        disabled={busy}
                        onClick={() => void send({ kind: "resume-cloud-machine", machineId })}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Resume
                      </OctantButton>
                    ) : null}
                    {created && machine.projectId === undefined ? (
                      <OctantButton
                        aria-label={`Bind a Project on ${machine.name}`}
                        disabled={busy}
                        onClick={() => void send({ kind: "bind-cloud-machine-project", machineId })}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Bind Project
                      </OctantButton>
                    ) : null}
                    {created ? (
                      <OctantButton
                        aria-label={`Destroy ${machine.name}`}
                        disabled={busy}
                        onClick={() =>
                          void send({ kind: "request-cloud-machine-destroy", machineId })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Destroy
                      </OctantButton>
                    ) : null}
                  </span>
                  <div className="basis-full min-w-0">
                    {machine.costPerHour === undefined ? null : (
                      <p className="shield-servers__login">
                        {machine.costPerHour.amount} {machine.costPerHour.currency} per hour, as
                        reported by {machine.costPerHour.source} at{" "}
                        {seen(machine.costPerHour.observedAt)}
                      </p>
                    )}
                    {created && machine.endpoint !== undefined ? (
                      <p className="shield-servers__login">
                        {machine.endpoint.user}@{machine.endpoint.host} ·{" "}
                        {machine.endpoint.hostKeys === undefined
                          ? "host key not reported; your known hosts decide"
                          : "host key pinned as the provider reported it"}
                      </p>
                    ) : null}
                    {machine.detail === undefined ? null : (
                      <p className="shield-servers__login">{machine.detail}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div aria-live="polite">
          {problem === undefined ? null : (
            <OctantAlert className="shield-servers__problem" tone="danger">
              {problem}
            </OctantAlert>
          )}
        </div>
      </SettingsPanel>
      <OctantDialogPresence>
        {confirming === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel="Destroy machine"
            destructive
            onCancel={() => setConfirming(undefined)}
            onConfirm={() => {
              const answer = confirming;
              setConfirming(undefined);
              void send({
                kind: "destroy-cloud-machine",
                machineId: answer.machineId,
                confirmation: answer.confirmation,
              });
            }}
            pending={busy}
            title={`Destroy ${confirming.name}?`}
          >
            Your provider deletes this machine and everything on it, and it stops costing your
            account money. This cannot be undone. Its server Project and server registration stay
            for you to remove.
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
      {chosenTarget === undefined ? null : (
        <SettingsPanel
          collapse={{ summary: "Create a machine in your cloud account" }}
          description="Your provider makes the machine from this recipe. Octant links a server Project to the folder once it answers."
          title="Create a cloud machine"
        >
          <form
            aria-label="Create a cloud machine"
            className="shield-servers__form"
            noValidate
            onSubmit={submit}
          >
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-target`}>Cloud</label>
              <OctantSelectField
                aria-label="Cloud"
                id={`${fieldId}-target`}
                onValueChange={(next) => setTargetId(next)}
                options={view.targets.map((target) => ({
                  id: target.targetId,
                  label: target.displayName,
                }))}
                value={chosenTarget.targetId}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-name`}>Machine and Project name</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-name`}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Build box"
                type="text"
                value={name}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-mode`}>Project kind</label>
              <OctantSelectField
                aria-label="Project kind"
                id={`${fieldId}-mode`}
                onValueChange={(next) => setMode(next === "work" ? "work" : "code")}
                options={[
                  { id: "code", label: "Code" },
                  { id: "work", label: "Work" },
                ]}
                value={mode}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-folder`}>Folder on the machine</label>
              <OctantInput
                autoCapitalize="off"
                autoComplete="off"
                id={`${fieldId}-folder`}
                onChange={(event) => setFolder(event.currentTarget.value)}
                placeholder="/home/octant/work"
                spellCheck={false}
                type="text"
                value={folder}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-image`}>Image</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-image`}
                onChange={(event) => setImage(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={image}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-size`}>Size</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-size`}
                onChange={(event) => setSize(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={size}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-region`}>Region</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-region`}
                onChange={(event) => setRegion(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={region}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-credential`}>Cloud account credential reference</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-credential`}
                onChange={(event) => setCredentialReference(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={credentialReference}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-setup`}>Setup script (optional)</label>
              <OctantTextarea
                id={`${fieldId}-setup`}
                onChange={(event) => setSetupScript(event.currentTarget.value)}
                rows={3}
                spellCheck={false}
                value={setupScript}
              />
            </div>
            <div aria-live="polite">
              {createProblem === undefined ? null : (
                <OctantAlert className="shield-servers__problem" tone="danger">
                  {createProblem}
                </OctantAlert>
              )}
            </div>
            <div className="shield-servers__actions">
              <OctantButton disabled={busy || !ready} size="sm" type="submit" variant="secondary">
                {busy ? "Asking your provider…" : "Create machine"}
              </OctantButton>
            </div>
          </form>
        </SettingsPanel>
      )}
    </div>
  );
}
