import type { CodeClient } from "@octant/client-runtime/code-client";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { decodeCodeThread, type CodeThread } from "@octant/contracts/code";
import { DEFAULT_CODE_NEW_THREAD_WORKSPACE } from "@octant/contracts/projects";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ProjectSummary } from "@octant/contracts/projects";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import { decodeWorkThreadId, type WorkThread } from "@octant/contracts/work-threads";
import {
  defaultDeliveryBranchIntent,
  defaultPermissionModeFor,
  resolveDraftProviderSelection,
  selectWorktreeRemote,
  suggestCodeDeliveryOutcome,
  threadAccessOf,
  type PickerGroup,
} from "@octant/domain";
import { useState } from "react";
import { planCodeThreadCreate } from "../code/codeThreadCreate";
import type { useCodeController } from "../code/useCodeController";
import { FolderPicker } from "../projects/FolderPicker";
import { providerGroupsForProject } from "../projects/ProjectProviderPolicySection";
import { useProjectController } from "../projects/useProjectController";
import { firstSelectableProviderSelection } from "../providers/firstSelectableProviderSelection";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { useWorkSettings } from "../work/useWorkSettings";

/**
 * The base branch a plain folder's delivery target records. The folder has no
 * Git, so nothing reads it; the local composer records the same name.
 */
const PLAIN_FOLDER_BASE_BRANCH = "development";

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
  return { projects, chosen, choose: setChosenId, controller };
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
  /** Reread at start: the default may have changed since this view loaded. */
  readonly codeClient: Pick<CodeClient, "bootstrap">;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  /** False while the session is stale: the host would not hear the command. */
  readonly connected: boolean;
  readonly onCreated: (thread: CodeThread) => void;
  /**
   * That computer's folders, for a new Code Project there. Present only where
   * the host takes it, from a device its own person paired.
   */
  readonly folderBrowse?: Pick<FolderBrowseClient, "browse" | "select">;
}

/**
 * Starts a Code thread from a browser the host's own person paired, by the
 * steps a local window's start screen takes: prepare the Project's checkout,
 * create the thread on it at the Project's mode or the default (Full access
 * included; maintainer decision, 2026-11-12), then send the first message.
 * The delivery outcome is read from that message, as the composer reads it;
 * the repository, remote and base branch are the host's own reading.
 */
export function RemoteCodeThreadStart(props: RemoteCodeThreadStartProps) {
  const { controller } = props;
  const {
    projects,
    chosen,
    choose,
    controller: projectActions,
  } = useStartableProjects(props.projectClient, "code");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pickingFolder, setPickingFolder] = useState(false);
  const { folderBrowse } = props;
  if (projects.length === 0 && folderBrowse === undefined) return null;

  // A folder on that computer becomes a Code Project there: the receipt is
  // that host's own, so the Project is its local one.
  const newProject =
    folderBrowse === undefined ? null : (
      <>
        <OctantButton
          aria-label="New Project from a folder on this computer"
          disabled={!props.connected || busy}
          onClick={() => setPickingFolder(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          New Project from a folder…
        </OctantButton>
        {pickingFolder ? (
          <FolderPicker
            client={folderBrowse}
            hostId={LOCAL_HOST_ID}
            mode="code"
            onCancel={() => setPickingFolder(false)}
            onSelect={(receiptId, displayName, selection) => {
              setPickingFolder(false);
              void projectActions
                .create("code", displayName, receiptId, LOCAL_HOST_ID, selection?.initializeGit)
                .then((projectId) => {
                  if (projectId === undefined) {
                    setMessage(`The computer could not make ${displayName} a Code Project.`);
                    return;
                  }
                  choose(String(projectId));
                });
            }}
            showGitInit
            title="Choose a folder on this computer"
          />
        ) : null}
      </>
    );
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        {newProject}
        {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
      </div>
    );
  }

  const start = async (): Promise<string | undefined> => {
    const text = prompt.trim();
    const settings = controller.bootstrap?.settings;
    if (chosen?.type !== "code" || text.length === 0) return undefined;
    if (settings === undefined) return "Code is still loading on this host.";
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
    // A host that does not require Git admits a plain folder: it has no branch
    // and no remotes, so it starts in that folder itself, as a local start does.
    const plainFolder = prepared.checkout.kind === "plain-folder";
    if (!plainFolder && prepared.checkout.head.kind !== "branch") {
      return "Create or select a branch before starting a Code thread.";
    }
    // The delivery target is read by the host afterwards: the base branch for
    // a pull-request draft's diff, the repository for GitHub reads. So each
    // part is what the host says of this repository, and where the host
    // cannot say, the thread is not started on an assumption.
    const remote = plainFolder
      ? ({ status: "unavailable", reason: "no-remote" } as const)
      : await (async () => {
          const facts = await controller.execute({
            kind: "get-worktree-remote-facts",
            projectId: chosen.id,
          });
          if (facts?.kind !== "worktree-remote-facts-retrieved") return undefined;
          const { remotes, upstreamRemote, defaultRemote } = facts.facts;
          return selectWorktreeRemote({
            remotes,
            ...(upstreamRemote === undefined ? {} : { upstreamRemote }),
            ...(defaultRemote === undefined ? {} : { defaultRemote }),
          });
        })();
    if (remote === undefined) {
      return (
        controller.lastExecuteError.current?.message ??
        `The host could not read the remotes of ${chosen.name}.`
      );
    }
    if (remote.status === "unavailable" && remote.reason === "ambiguous") {
      return `${chosen.name} has more than one remote and none is its default. Start this thread at the host, where the remote can be chosen.`;
    }
    // The Default modes panel changes the host's default and each Project's
    // mode through its own reads, and this view's snapshots are not refreshed
    // by it; starting from them could open a thread at Full access the person
    // just lowered, with its first turn sent at once. So both are reread here.
    const [current, currentProjects] = await Promise.all([
      props.codeClient.bootstrap(),
      props.projectClient.bootstrap(),
    ]);
    const currentProject = currentProjects.active.find(
      (project) => String(project.id) === String(chosen.id),
    );
    if (currentProject?.type !== "code" || currentProject.lifecycle !== "active") {
      return `${chosen.name} is no longer an active Code Project on this host.`;
    }
    const currentSettings = current.settings;
    const access = threadAccessOf(
      defaultPermissionModeFor({ project: currentProject, settings: currentSettings }),
    );
    // The host refuses a model its Project's provider policy does not allow,
    // so the start picks the first model the policy admits; an EU or ZDR tag
    // may sit on the model alone, so the models are filtered, not just providers.
    const model = firstSelectableProviderSelection(
      providerGroupsForProject(currentProject, props.providerGroups),
    );
    if (model === undefined) {
      return `No provider allowed by ${chosen.name}'s provider policy is available on this host.`;
    }
    const timestamp = new Date().toISOString();
    const threadId = globalThis.crypto.randomUUID();
    const baseBranch =
      prepared.checkout.head.kind === "branch"
        ? String(prepared.checkout.head.name)
        : PLAIN_FOLDER_BASE_BRANCH;
    // The same planner a local start screen uses, so a Project whose default is
    // a dedicated worktree gets one here too instead of the current checkout.
    const plan = planCodeThreadCreate({
      composer: {
        prompt: text,
        executionPolicy: access.executionPolicy,
        permissionPersistence: currentSettings.defaultPermissionPersistence,
        ...(access.autoApprove ? { autoApprove: true } : {}),
        // A worktree needs a repository, so a plain folder is worked in place.
        workspace: plainFolder
          ? "current-checkout"
          : (currentProject.newThreadWorkspace ?? DEFAULT_CODE_NEW_THREAD_WORKSPACE),
        worktreeSource: {
          startFromOrigin: remote.status === "selected",
          remoteName: remote.status === "selected" ? remote.remoteName : "",
        },
        deliveryTarget: {
          branchIntent: defaultDeliveryBranchIntent(baseBranch, threadId.slice(0, 8)),
          // A repository with no remote still needs a name here; Git's own
          // default is the one the host's own thread starts use, and a draft
          // diff falls back to the local base branch when no such remote exists.
          remoteName: remote.status === "selected" ? remote.remoteName : "origin",
          // The connected GitHub repository, or the host's own id for a
          // repository connected to none, which no GitHub read mistakes for
          // an owner and a name.
          proposedBaseRepository:
            chosen.connectedRepository === undefined
              ? String(prepared.checkout.repositoryId)
              : `${chosen.connectedRepository.owner}/${chosen.connectedRepository.repository}`,
          // The thread is based on the branch the prepared checkout is on.
          proposedBaseBranch: baseBranch,
          outcomeKind: suggestCodeDeliveryOutcome(text),
        },
      },
      modelId: model.modelId,
      prepared,
      projectId: chosen.id,
      providerInstanceId: model.providerInstanceId,
      threadId,
      timestamp,
      title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
    });
    if (plan.kind === "rejected") return plan.message;
    const created = await controller.execute(plan.command);
    if (created?.kind !== "thread-created" && created?.kind !== "managed-thread-created") {
      // The host's own reason, such as a worktree source branch that was never
      // published, tells the person what to change; the message stays typed.
      return (
        controller.lastExecuteError.current?.message ?? "The Code thread could not be created."
      );
    }
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
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ProjectChoice chosen={chosen} disabled={busy} onChoose={choose} projects={projects} />
      {newProject}
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
