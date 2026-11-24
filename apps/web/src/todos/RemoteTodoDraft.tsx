import {
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionBridge,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  LOCAL_HOST_ID,
  decodeMentionableThreadId,
  decodeCodeAttachmentId,
  decodeCodeAttachmentMediaType,
  decodeChatAttachmentId,
  decodeChatSubmissionId,
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeThreadWorkingDirectory,
} from "@octant/contracts";
import type { ProjectSummary } from "@octant/contracts/projects";
import type { Todo, TodoThreadLink } from "@octant/contracts/todos";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { buildModelPickerGroups, defaultPermissionModeFor } from "@octant/domain";
import { pairedTodoThreadTitle } from "@octant/domain/automatic-model-policy";
import { useEffect, useMemo, useState } from "react";
import { useProviderController } from "../providers/useProviderController";
import { firstSelectableProviderSelection } from "../providers/firstSelectableProviderSelection";
import { useProjectController } from "../projects/useProjectController";
import { useCodeController } from "../code/useCodeController";
import { planCodeThreadCreate } from "../code/codeThreadCreate";
import type { CodeComposerSubmitInput } from "../code/composer/CodeComposerAdapter";
import {
  DraftThreadWorkspace,
  type DraftThreadWorkspaceProps,
} from "../shell/DraftThreadWorkspace";
import {
  createRemoteExtensionClient,
  createRemoteProductClients,
} from "../remote/remoteProductClients";
import { RemoteWorkspace } from "../remote/RemoteWorkspace";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantAlert } from "../ui/base/OctantAlert";

/** The ordinary draft, with every read and command bound to the Project's host. */
export function RemoteTodoDraft(props: {
  readonly bridge: RemoteSessionBridge;
  readonly hostId: string;
  readonly hostName?: string;
  readonly connected: boolean;
  readonly project?: ProjectSummary;
  readonly todo?: Todo;
  readonly thread?: TodoThreadLink;
  readonly onCreated: (link: TodoThreadLink) => Promise<void>;
  readonly onClose: () => void;
}) {
  const clients = useMemo(
    () => createRemoteProductClients(props.bridge, { threadEvents: "poll" }),
    [props.bridge],
  );
  const [standing, setStanding] = useState<RemoteSessionStanding>(RESTRICTED_REMOTE_SESSION);
  useEffect(() => {
    setStanding(RESTRICTED_REMOTE_SESSION);
    const connection = props.connected ? props.bridge.connection() : undefined;
    if (connection === undefined) return;
    let current = true;
    void readRemoteSessionStanding(connection).then((answer) => {
      if (current) setStanding(answer);
    });
    return () => {
      current = false;
    };
  }, [props.bridge, props.connected]);
  const extensionClient = useMemo(
    () => createRemoteExtensionClient(props.bridge, standing),
    [props.bridge, standing],
  );
  const mode = props.project?.type ?? props.thread?.mode ?? "chat";
  const providers = useProviderController({ client: clients.provider });
  const projects = useProjectController({ activeMode: mode, client: clients.project });
  const code = useCodeController({ client: clients.code, navigationRefreshMs: 0 });
  const groups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providers.instances,
        observedByInstance: providers.observedByInstance,
        providerOrder: providers.defaults.providerOrder,
        hiddenModels: providers.defaults.hiddenModels,
        mode,
      }),
    [providers.instances, providers.observedByInstance, providers.defaults, mode],
  );
  const [selection, select] = useState<{
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }>();
  const model = selection ?? firstSelectableProviderSelection(groups);
  const [source, setSource] = useState(props.todo);
  const [thread, setThread] = useState(props.thread);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [turnError, setTurnError] = useState<string>();
  const [unsentPrompt, setUnsentPrompt] = useState("");
  const project =
    projects.allProjects.find((candidate) => String(candidate.id) === String(props.project?.id)) ??
    props.project;
  const projectForSelection = (projectId: string | undefined) => {
    if (projectId === undefined) return undefined;
    return (
      projects.allProjects.find((candidate) => String(candidate.id) === String(projectId)) ??
      (project !== undefined && String(project.id) === String(projectId) ? project : undefined)
    );
  };
  const refuseCreate = (message: string): false => {
    setError(message);
    return false;
  };
  const keepUnsentPrompt = (prompt: string): void => {
    setUnsentPrompt(prompt);
    setTurnError(
      "The thread was created, but its first message could not be confirmed. Check the thread before copying the message below to retry.",
    );
  };
  const link = async (threadId: string) => {
    const value = {
      hostId: decodeStableHostId(props.hostId),
      threadId: decodeMentionableThreadId(threadId),
      mode,
    };
    setSource(undefined);
    try {
      if (source !== undefined) await props.onCreated(value);
    } finally {
      setThread(value);
    }
  };
  const createCode = async (input: CodeComposerSubmitInput): Promise<boolean> => {
    if (project?.type !== "code" || model === undefined || !props.connected) return false;

    setBusy(true);
    setError(undefined);
    let durable = false;
    try {
      const prepared = await code.execute({
        kind: "prepare-code-project-checkout",
        projectId: project.id,
      });
      if (prepared?.kind !== "checkout-prepared")
        return refuseCreate(
          code.lastExecuteError.current?.message ?? "The Project's checkout could not be prepared.",
        );
      const plan = planCodeThreadCreate({
        composer: input,
        prepared,
        projectId: project.id,
        providerInstanceId: model.providerInstanceId,
        modelId: model.modelId,
        threadId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        title: pairedTodoThreadTitle(input.prompt),
      });
      if (plan.kind === "rejected") return refuseCreate(plan.message);
      const created = await code.execute(plan.command);
      if (created?.kind !== "thread-created" && created?.kind !== "managed-thread-created")
        return refuseCreate(
          code.lastExecuteError.current?.message ?? "The host refused to create the thread.",
        );
      durable = true;
      await link(String(created.thread.id));
      const attachmentIds = [];
      for (const file of input.images ?? []) {
        const attachmentId = decodeCodeAttachmentId(crypto.randomUUID());
        await clients.code.putAttachment({
          threadId: created.thread.id,
          attachmentId,
          displayName: file.name,
          mediaType: decodeCodeAttachmentMediaType(file.type),
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        attachmentIds.push(attachmentId);
      }
      const started = await code.startThreadTurn({
        threadId: created.thread.id,
        checkoutId:
          created.kind === "managed-thread-created"
            ? created.checkout.id
            : created.thread.checkoutId,
        prompt: input.prompt,
        ...(input.computerUseSelection === undefined
          ? {}
          : { computerUseSelection: input.computerUseSelection }),
        ...(input.extensionSelections === undefined
          ? {}
          : { extensionSelections: input.extensionSelections }),
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        ...(input.threadMentionIds === undefined
          ? {}
          : { threadMentionIds: input.threadMentionIds }),
      });
      if (!started) {
        keepUnsentPrompt(input.prompt);
      }
      return true;
    } catch (failure) {
      if (durable) {
        keepUnsentPrompt(input.prompt);
        return true;
      }
      setError(failure instanceof Error ? failure.message : "The thread could not be created.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create: DraftThreadWorkspaceProps["onCreateThread"] = async (
    prompt,
    selectedProjectId,
    _outcome,
    images,
    _mentions,
    _issue,
    _linear,
    _computer,
    _extensions,
    _execution,
    _persistence,
    modelOptionValues,
    _terminalSession,
    workingFolder,
  ) => {
    if (model === undefined || !props.connected) return false;
    const selectedProject = projectForSelection(
      selectedProjectId === undefined ? undefined : String(selectedProjectId),
    );
    if (selectedProjectId !== undefined && selectedProject === undefined)
      return refuseCreate("The selected Project is no longer available.");
    if (mode !== "chat" && selectedProject === undefined)
      return refuseCreate("The Project is no longer available.");
    if (selectedProject !== undefined && selectedProject.type !== mode)
      return refuseCreate("The selected Project is not available in this mode.");
    if (selectedProject?.type === "code") return false;

    setBusy(true);
    setError(undefined);
    try {
      if (mode === "chat") {
        const created = await clients.chat.execute({
          kind: "create-chat-thread",
          title: pairedTodoThreadTitle(prompt),
          ...(selectedProject === undefined ? {} : { projectId: selectedProject.id }),
        });
        if (created.kind !== "thread-created")
          return refuseCreate("The host refused to create the thread.");
        await link(String(created.thread.id));
        try {
          const selected = await clients.chat.execute({
            kind: "change-chat-provider",
            threadId: created.thread.id,
            expectedVersion: created.thread.version,
            providerInstanceId: model.providerInstanceId,
            modelId: model.modelId,
            ...(modelOptionValues === undefined ? {} : { modelOptionValues }),
          });
          if (selected.kind !== "thread-updated") {
            keepUnsentPrompt(prompt);
            return true;
          }
          const attachmentIds = [];
          for (const file of images ?? []) {
            const attachment = await clients.chat.upload({
              threadId: created.thread.id,
              attachmentId: decodeChatAttachmentId(crypto.randomUUID()),
              displayName: file.name,
              mediaType: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
            attachmentIds.push(attachment.id);
          }
          const currentVersion =
            attachmentIds.length === 0
              ? selected.thread.version
              : (await clients.chat.thread(selected.thread.id)).thread.version;
          const submissionId = decodeChatSubmissionId(crypto.randomUUID());
          try {
            const sent = await clients.chat.execute({
              kind: "send-chat-turn",
              threadId: selected.thread.id,
              expectedVersion: currentVersion,
              submissionId,
              prompt,
              ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
            });
            if (sent.kind !== "turn-created") keepUnsentPrompt(prompt);
          } catch {
            const confirmed = await clients.chat
              .thread(created.thread.id)
              .then((view) =>
                view.turns.some(
                  (turn) =>
                    turn.submissionId !== undefined &&
                    String(turn.submissionId) === String(submissionId),
                ),
              )
              .catch(() => false);
            if (!confirmed) keepUnsentPrompt(prompt);
          }
        } catch {
          keepUnsentPrompt(prompt);
        }
      } else if (selectedProject?.type === "work") {
        const created = await clients.workThread.execute({
          kind: "create-work-thread",
          threadId: decodeWorkThreadId(crypto.randomUUID()),
          projectId: selectedProject.id,
          bindingRevisionId: selectedProject.bindingRevisionId,
          title: pairedTodoThreadTitle(prompt),
          providerInstanceId: model.providerInstanceId,
          modelId: model.modelId,
          hostId: LOCAL_HOST_ID,
          ...(workingFolder ?? { workingDirectory: decodeThreadWorkingDirectory(".") }),
          ...(modelOptionValues === undefined ? {} : { modelOptionValues }),
        });
        if (!("kind" in created) || created.kind !== "thread-created")
          return refuseCreate("The host refused to create the thread.");
        await link(String(created.thread.id));
        try {
          const attachmentIds = [];
          for (const file of images ?? []) {
            const attachmentId = decodeWorkAttachmentId(crypto.randomUUID());
            await clients.workTurn.putAttachment({
              threadId: created.thread.id,
              attachmentId,
              displayName: file.name,
              mediaType: decodeWorkAttachmentMediaType(file.type),
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
            attachmentIds.push(attachmentId);
          }
          const started = await clients.workTurn.startFirstTurn({
            kind: "start-work-thread-turn",
            requestId: decodeWorkTurnRequestId(crypto.randomUUID()),
            turnId: decodeWorkTurnId(crypto.randomUUID()),
            threadId: created.thread.id,
            prompt,
            ...(_computer === undefined ? {} : { computerUseSelection: _computer }),
            ...(_extensions === undefined ? {} : { extensionSelections: _extensions }),
            ...(_mentions === undefined ? {} : { threadMentionIds: _mentions }),
            ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
            authority: {
              hostId: LOCAL_HOST_ID,
              projectId: selectedProject.id,
              bindingRevisionId: selectedProject.bindingRevisionId,
              ...(created.thread.workingFolderId === undefined
                ? {}
                : { workingFolderId: created.thread.workingFolderId }),
              workingDirectory:
                created.thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
              confinementPosture: "project-root-confined",
              providerInstanceId: model.providerInstanceId,
              modelId: model.modelId,
            },
          });
          if (started.kind !== "accepted") {
            keepUnsentPrompt(prompt);
          }
        } catch {
          keepUnsentPrompt(prompt);
        }
      }
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The thread could not be created.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (thread !== undefined)
    return (
      <>
        {turnError === undefined ? null : <OctantAlert tone="warning">{turnError}</OctantAlert>}
        {unsentPrompt === "" ? null : (
          <OctantTextarea aria-label="Unsent first message" readOnly value={unsentPrompt} />
        )}
        <RemoteWorkspace
          clients={clients}
          mode={thread.mode}
          connected={props.connected}
          actsAsHostPerson={standing.actsAsHostPerson}
          extensionClient={extensionClient}
          initialThread={thread}
        />
      </>
    );
  if (project === undefined && mode !== "chat")
    return <OctantAlert tone="warning">The Project is no longer available.</OctantAlert>;
  return (
    <>
      <p className="oct-meta">On {props.hostName ?? "paired computer"}</p>
      {props.connected ? null : (
        <OctantAlert tone="warning">
          This computer cannot be reached. Your draft is kept here until it reconnects.
        </OctantAlert>
      )}
      <DraftThreadWorkspace
        mode={mode}
        {...(project === undefined ? {} : { projectId: project.id, projectName: project.name })}
        {...(project === undefined || project.type === "chat"
          ? {}
          : { projectRoot: project.binding.canonicalRoot })}
        projects={project === undefined ? [] : [project]}
        providerGroups={groups}
        {...(model === undefined
          ? {}
          : {
              selectedProviderInstanceId: model.providerInstanceId,
              selectedModelId: model.modelId,
            })}
        onSelectProvider={select}
        onCreateThread={create}
        onCreateCodeThread={createCode}
        codeExecute={code.execute}
        {...(code.bootstrap === undefined || project?.type !== "code"
          ? {}
          : {
              defaultPermissionMode: defaultPermissionModeFor({
                project,
                settings: code.bootstrap.settings,
              }),
              defaultPermissionPersistence: code.bootstrap.settings.defaultPermissionPersistence,
            })}
        onCancel={props.onClose}
        creating={busy || !props.connected}
        {...(error === undefined ? {} : { errorMessage: error })}
        pendingPrompt={
          props.todo === undefined
            ? ""
            : `${props.todo.title}${props.todo.notes === "" ? "" : `\n\n${props.todo.notes}`}`
        }
        {...(source === undefined
          ? {}
          : { todoSource: { title: source.title, onRemove: () => setSource(undefined) } })}
      />
    </>
  );
}
