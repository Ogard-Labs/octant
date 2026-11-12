import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { decodeCodeThread, type CodeThread } from "@octant/contracts/code";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ProjectSummary } from "@octant/contracts/projects";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import { decodeWorkThreadId, type WorkThread } from "@octant/contracts/work-threads";
import {
  defaultPermissionModeFor,
  resolveDraftProviderSelection,
  suggestCodeDeliveryOutcome,
  threadAccessOf,
  type PickerGroup,
} from "@octant/domain";
import { useState } from "react";
import type { useCodeController } from "../code/useCodeController";
import { useProjectController } from "../projects/useProjectController";
import { firstSelectableProviderSelection } from "../providers/firstSelectableProviderSelection";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { useWorkSettings } from "../work/useWorkSettings";

/** The mode's Projects a thread can start in now: active, and their folder reachable. */
function useStartableProjects(client: ProjectClient, mode: "work" | "code") {
  const controller = useProjectController({ activeMode: mode, client });
  const projects = controller.projects.filter(
    (project) =>
      project.type === mode &&
      project.lifecycle === "active" &&
      controller.availabilityByProject.get(project.id)?.status === "available",
  );
  const [chosenId, setChosenId] = useState<string>();
  const chosen = projects.find((project) => String(project.id) === chosenId) ?? projects[0];
  return { projects, chosen, choose: setChosenId };
}

function ProjectChoice(props: {
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly chosen: ProjectSummary | undefined;
  readonly disabled: boolean;
  readonly onChoose: (projectId: string) => void;
}) {
  // One Project needs no choosing; the thread says where it lives once open.
  if (props.projects.length < 2) return null;
  return (
    <OctantSelectField
      aria-label="Project for the new thread"
      disabled={props.disabled}
      onValueChange={props.onChoose}
      options={props.projects.map((project) => ({ id: String(project.id), label: project.name }))}
      value={props.chosen === undefined ? "" : String(props.chosen.id)}
    />
  );
}

export interface RemoteWorkThreadStartProps {
  readonly projectClient: ProjectClient;
  readonly workThreadClient: Pick<WorkThreadClient, "bootstrap" | "execute">;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  /** False while the session is stale: the host would not hear the command. */
  readonly connected: boolean;
  readonly onCreated: (thread: WorkThread) => void;
}

/**
 * Starts a Work thread from a browser the host's own person paired, with the
 * command a local window sends. The host gives the thread its Project's mode
 * or the default, Full access included (maintainer decision, 2026-11-12); the
 * first message is then sent from the open thread.
 */
export function RemoteWorkThreadStart(props: RemoteWorkThreadStartProps) {
  const { projects, chosen, choose } = useStartableProjects(props.projectClient, "work");
  const settings = useWorkSettings(props.workThreadClient).settings;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  if (projects.length === 0) return null;

  const saved =
    settings?.defaultProviderInstanceId === undefined || settings.defaultModelId === undefined
      ? undefined
      : {
          providerInstanceId: settings.defaultProviderInstanceId,
          modelId: settings.defaultModelId,
        };
  const model =
    (saved === undefined
      ? undefined
      : resolveDraftProviderSelection(props.providerGroups, saved)) ??
    firstSelectableProviderSelection(props.providerGroups);

  const start = async () => {
    if (chosen?.type !== "work") return;
    if (model === undefined) {
      setMessage("No provider is available. Configure a provider before starting a Work thread.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const created = await props.workThreadClient.execute({
        kind: "create-work-thread",
        threadId: decodeWorkThreadId(globalThis.crypto.randomUUID()),
        projectId: chosen.id,
        title: "New thread",
        providerInstanceId: model.providerInstanceId,
        modelId: model.modelId,
        // The command runs on the host, whose own id is the local one.
        hostId: LOCAL_HOST_ID,
        bindingRevisionId: chosen.bindingRevisionId,
        workingDirectory: decodeThreadWorkingDirectory("."),
      });
      if ("kind" in created && created.kind === "thread-created") props.onCreated(created.thread);
      else setMessage("message" in created ? created.message : "The host did not create a thread.");
    } catch {
      setMessage("The host did not create a thread.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <ProjectChoice chosen={chosen} disabled={busy} onChoose={choose} projects={projects} />
      <OctantButton
        disabled={!props.connected || busy}
        onClick={() => void start()}
        size="sm"
        type="button"
        variant="secondary"
      >
        New thread
      </OctantButton>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </div>
  );
}

export interface RemoteCodeThreadStartProps {
  readonly projectClient: ProjectClient;
  readonly controller: Pick<
    ReturnType<typeof useCodeController>,
    "bootstrap" | "execute" | "lastExecuteError" | "startThreadTurn"
  >;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  /** False while the session is stale: the host would not hear the command. */
  readonly connected: boolean;
  readonly onCreated: (thread: CodeThread) => void;
}

/**
 * Starts a Code thread from a browser the host's own person paired, by the
 * steps a local window's start screen takes: prepare the Project's checkout,
 * create the thread on it at the Project's mode or the default (Full access
 * included; maintainer decision, 2026-11-12), then send the first message.
 * The delivery outcome is read from that message, as the composer reads it.
 */
export function RemoteCodeThreadStart(props: RemoteCodeThreadStartProps) {
  const { controller } = props;
  const { projects, chosen, choose } = useStartableProjects(props.projectClient, "code");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  if (projects.length === 0) return null;

  const start = async (): Promise<string | undefined> => {
    const text = prompt.trim();
    const settings = controller.bootstrap?.settings;
    if (chosen?.type !== "code" || text.length === 0) return undefined;
    if (settings === undefined) return "Code is still loading on this host.";
    const model = firstSelectableProviderSelection(props.providerGroups);
    if (model === undefined) {
      return "No provider is available. Configure a provider before starting a Code thread.";
    }
    const prepared = await controller.execute({
      kind: "prepare-code-project-checkout",
      projectId: chosen.id,
    });
    if (prepared?.kind !== "checkout-prepared") {
      return (
        controller.lastExecuteError.current?.message ??
        `The host could not prepare a checkout for ${chosen.name}.`
      );
    }
    if (prepared.checkout.head.kind !== "branch") {
      return "Create or select a branch before starting a Code thread.";
    }
    const access = threadAccessOf(defaultPermissionModeFor({ project: chosen, settings }));
    const timestamp = new Date().toISOString();
    const created = await controller.execute({
      kind: "create-code-thread",
      thread: decodeCodeThread({
        id: globalThis.crypto.randomUUID(),
        projectId: chosen.id,
        bindingRevisionId: prepared.bindingRevisionId,
        repositoryId: prepared.checkout.repositoryId,
        checkoutId: prepared.checkout.id,
        title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        lifecycle: "active",
        providerInstanceId: model.providerInstanceId,
        modelId: model.modelId,
        executionPolicy: access.executionPolicy,
        ...(access.autoApprove ? { autoApprove: true } : {}),
        permissionPersistence: settings.defaultPermissionPersistence,
        deliveryTarget: {
          branchIntent: prepared.checkout.head.name,
          remoteName: "origin",
          proposedBaseRepository: `local/${chosen.name}`,
          proposedBaseBranch: "development",
          outcomeKind: suggestCodeDeliveryOutcome(text),
          confirmedAt: timestamp,
        },
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    });
    if (created?.kind !== "thread-created") return "The Code thread could not be created.";
    // The thread is durable whether or not its first turn starts, so it is
    // opened first and a failed send is retried from there.
    props.onCreated(created.thread);
    setPrompt("");
    const started = await controller.startThreadTurn({
      threadId: created.thread.id,
      checkoutId: created.thread.checkoutId,
      prompt: text,
    });
    return started ? undefined : "The first message could not be sent. Retry from the open thread.";
  };

  const submit = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage(await start());
    } catch {
      setMessage("The Code thread could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ProjectChoice chosen={chosen} disabled={busy} onChoose={choose} projects={projects} />
      <OctantInput
        aria-label="First message"
        disabled={busy}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the task"
        value={prompt}
      />
      <OctantButton
        disabled={!props.connected || busy || prompt.trim().length === 0}
        size="sm"
        type="submit"
        variant="secondary"
      >
        Start thread
      </OctantButton>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </form>
  );
}
