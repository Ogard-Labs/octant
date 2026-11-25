import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createMobileCodeFromPrompt,
  createMobileWorkFromPrompt,
  fetchMobileCodeProjects,
  fetchMobileWorkProjects,
  MobileCodeCreationFailure,
  MobileInboxFailure,
  type MobileCodeCreationRetry,
  type MobileCodeDeliveryTargetProposal,
  type MobileCodeProjectOption,
  type MobileInboxRow,
  type MobileWorkProjectOption,
} from "@octant/client-runtime";
import { changeMobileTodos } from "@octant/client-runtime/mobile-todo-client";
import type { CodeDeliveryTarget } from "@octant/contracts";
import type { Todo } from "@octant/contracts/todos";
import { MOBILE_COPY } from "../copy";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import {
  mobileTodoLinkCommand,
  mobileTodoStartDraft,
  type MobileStartedThread,
} from "../todos/todosPresentation";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { useVoiceDictation } from "../voice/useVoiceDictation";
import { appendTranscript } from "../voice/voiceDictation";
import { CodeDeliveryTargetSheet } from "./CodeDeliveryTargetSheet";
import type { MobileCreateMode } from "./createModePresentation";
import { HomeComposerSheet } from "./HomeComposerSheet";
import { useMobileThreads } from "./MobileThreadsContext";
import { createRequestGuard } from "./requestGuard";
import { usePlacement } from "./usePlacement";

/** The new-thread sheet, which New opens from every place. */
export interface NewThread {
  readonly openNewThread: () => void;
  /** Why this computer takes no new thread from the phone; New is off while it stands. */
  readonly accessReason: string | undefined;
  /** What a new thread waits on besides access: a computer gone stale. */
  readonly staleReason: string | undefined;
}

const Context = createContext<NewThread | undefined>(undefined);

export function useNewThread(): NewThread {
  const value = useContext(Context);
  if (value === undefined) throw new Error("New threads start inside NewThreadProvider.");
  return value;
}

export function NewThreadProvider(props: {
  readonly children: ReactNode;
  readonly onOpenThread: (row: MobileInboxRow) => void;
  /** A Start pressed on To-dos: the sheet opens with it once this computer's Projects are read. */
  readonly todoStart?: Todo | undefined;
  readonly onTodoStartOpened?: (() => void) | undefined;
  /** Whether the list took the link to a thread a Start made. */
  readonly onTodoLinked?:
    | ((todoId: string, thread: MobileStartedThread, linked: boolean) => void)
    | undefined;
}) {
  const { onOpenThread, onTodoLinked, onTodoStartOpened, todoStart } = props;
  const { environment, transport, hostsLoaded } = useMobileSession();
  const { refresh } = useMobileThreads();
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [composerError, setComposerError] = useState<string | undefined>();
  const [modelOpen, setModelOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<MobileCreateMode>("chat");
  const [workProjects, setWorkProjects] = useState<ReadonlyArray<MobileWorkProjectOption>>([]);
  const [codeProjects, setCodeProjects] = useState<ReadonlyArray<MobileCodeProjectOption>>([]);
  const [workProjectId, setWorkProjectId] = useState<string | undefined>();
  const [codeProjectId, setCodeProjectId] = useState<string | undefined>();
  // Set once the Projects of the computer new threads go to are read, so a
  // Start picks its Project from them rather than from an empty list.
  // "failed" when either list could not be read: an empty list is then no
  // proof the to-do's Project is missing, so a Start says so instead.
  const [projectsRead, setProjectsRead] = useState<"no" | "read" | "failed">("no");
  // The to-do this draft came from; the host's create command carries nothing about it.
  // It also names the Project the Start chose, so a reload of the Projects (a
  // reconnect hands a new transport) keeps that Project rather than the first.
  const [todoSource, setTodoSource] = useState<
    { readonly todoId: string; readonly projectId?: string } | undefined
  >();
  const startedProjectId = useRef<string | undefined>(undefined);
  startedProjectId.current = todoSource?.projectId;
  const [codeRetry, setCodeRetry] = useState<MobileCodeCreationRetry | undefined>();
  const [deliveryTargetProposal, setDeliveryTargetProposal] = useState<
    MobileCodeDeliveryTargetProposal | undefined
  >();
  const projectRequestGuard = useRef(createRequestGuard()).current;
  const deliveryTargetResolver = useRef<
    ((target: CodeDeliveryTarget | undefined) => void) | undefined
  >(undefined);

  const {
    placementTransport,
    placementLabel,
    placementAccessReason,
    placementDisabledReason,
    refreshPlacement,
    staleGate,
    models,
    modelOptionId,
    setModelOptionId,
    selectedModel,
    modelLabel,
    createChat,
  } = usePlacement({ fallbackToFirstHost: false });
  const requestDeliveryTarget = useCallback((proposal: MobileCodeDeliveryTargetProposal) => {
    return new Promise<CodeDeliveryTarget | undefined>((resolve) => {
      deliveryTargetResolver.current?.(undefined);
      deliveryTargetResolver.current = resolve;
      setDeliveryTargetProposal(proposal);
    });
  }, []);

  const finishDeliveryTarget = useCallback((target: CodeDeliveryTarget | undefined) => {
    const resolve = deliveryTargetResolver.current;
    deliveryTargetResolver.current = undefined;
    setDeliveryTargetProposal(undefined);
    resolve?.(target);
  }, []);

  useEffect(
    () => () => {
      deliveryTargetResolver.current?.(undefined);
      deliveryTargetResolver.current = undefined;
    },
    [],
  );

  useEffect(() => {
    setCodeRetry(undefined);
  }, [placementTransport]);
  const composerEditable =
    staleGate.allowProductMutations &&
    placementTransport !== undefined &&
    placementAccessReason === undefined;
  const appendToDraft = useCallback((text: string) => {
    setPrompt((draft) => appendTranscript(draft, text));
    setCodeRetry(undefined);
  }, []);
  const voice = useVoiceDictation({
    transport:
      environment.kind === "mock" && environment.offlineDemo ? undefined : placementTransport,
    editable: composerEditable && !creating,
    appendToDraft,
  });
  useEffect(() => {
    const request = projectRequestGuard.begin();
    setWorkProjects([]);
    setCodeProjects([]);
    setWorkProjectId(undefined);
    setCodeProjectId(undefined);
    setProjectsRead("no");
    if (placementTransport === undefined) {
      return () => projectRequestGuard.invalidate();
    }
    let cancelled = false;
    let failed = false;
    const unread = () => {
      failed = true;
      return [];
    };
    void Promise.all([
      fetchMobileWorkProjects(placementTransport).catch(unread),
      fetchMobileCodeProjects(placementTransport).catch(unread),
    ]).then(([nextWork, nextCode]) => {
      if (cancelled || !projectRequestGuard.isCurrent(request)) return;
      setWorkProjects(nextWork);
      setCodeProjects(nextCode);
      const started = startedProjectId.current;
      setWorkProjectId((current) =>
        nextWork.some((project) => project.projectId === started)
          ? started
          : nextWork.some((project) => project.projectId === current)
            ? current
            : nextWork[0]?.projectId,
      );
      setCodeProjectId((current) =>
        nextCode.some((project) => project.projectId === started)
          ? started
          : nextCode.some((project) => project.projectId === current)
            ? current
            : nextCode[0]?.projectId,
      );
      setProjectsRead(failed ? "failed" : "read");
    });
    return () => {
      cancelled = true;
      projectRequestGuard.invalidate();
    };
  }, [placementTransport, projectRequestGuard]);

  useEffect(() => {
    // Without a computer for new threads the sheet still opens, as a Chat that
    // says why it cannot send; until the paired list is read, the Start waits.
    const ready = projectsRead !== "no" || (placementTransport === undefined && hostsLoaded);
    if (todoStart === undefined || !ready) return;
    const draft = mobileTodoStartDraft(todoStart, {
      hostId: placementTransport?.hostId ?? "",
      workProjects,
      codeProjects,
    });
    setPrompt(draft.prompt);
    setComposerMode(draft.mode);
    if (draft.mode === "work") setWorkProjectId(draft.projectId);
    if (draft.mode === "code") setCodeProjectId(draft.projectId);
    setTodoSource({
      todoId: String(todoStart.id),
      ...(draft.projectId === undefined ? {} : { projectId: draft.projectId }),
    });
    setComposerError(projectsRead === "failed" ? MOBILE_COPY.todoStartProjectsUnread : undefined);
    setCodeRetry(undefined);
    setOpen(true);
    onTodoStartOpened?.();
  }, [
    codeProjects,
    hostsLoaded,
    onTodoStartOpened,
    placementTransport,
    projectsRead,
    todoStart,
    workProjects,
  ]);

  const selectedWorkProject = workProjects.find((project) => project.projectId === workProjectId);
  const selectedCodeProject = codeProjects.find((project) => project.projectId === codeProjectId);
  // The link is sent once the host answered with the thread, before the person
  // reads it; a list that refuses or cannot be reached leaves the thread as it is.
  const linkTodo = async (todoId: string, row: MobileInboxRow) => {
    const thread: MobileStartedThread = {
      hostId: row.hostId,
      threadId: row.threadId,
      mode: row.mode,
    };
    let linked = false;
    if (transport !== undefined) {
      try {
        const result = await changeMobileTodos(transport, mobileTodoLinkCommand(todoId, thread));
        linked = result.status === "loaded";
      } catch {
        linked = false;
      }
    }
    onTodoLinked?.(todoId, thread, linked);
  };

  const createThread = async (mode: MobileCreateMode) => {
    // Read before the create awaits: a Start pressed meanwhile is another draft.
    // The link goes out once the host has made the thread, before its first
    // turn, so a turn that fails still leaves a linked thread, and the source is
    // spent then so a resend of the same draft does not link a second thread.
    let source = todoSource;
    const started = (row: MobileInboxRow) => {
      if (source === undefined) return;
      const todoId = source.todoId;
      source = undefined;
      setTodoSource(undefined);
      void linkTodo(todoId, row);
    };
    if (placementTransport === undefined) {
      setComposerError(MOBILE_COPY.pairBeforeCreate);
      return;
    }
    if (!staleGate.allowProductMutations) {
      setComposerError(staleGate.message);
      return;
    }
    if (placementAccessReason !== undefined) {
      setComposerError(placementAccessReason);
      return;
    }
    setCreating(true);
    setComposerError(undefined);
    try {
      if (mode === "code") {
        if (selectedCodeProject === undefined) {
          setComposerError(MOBILE_COPY.codeNoProject);
          return;
        }
        if (selectedModel === undefined) {
          setComposerError("Choose a model from your computer before starting Code.");
          return;
        }
        const row = await createMobileCodeFromPrompt({
          transport: placementTransport,
          prompt,
          project: selectedCodeProject,
          providerInstanceId: selectedModel.providerInstanceId,
          modelId: selectedModel.modelId,
          confirmDeliveryTarget: requestDeliveryTarget,
          onCreated: started,
          ...(codeRetry === undefined ? {} : { retry: codeRetry }),
        });
        setPrompt("");
        setCodeRetry(undefined);
        setOpen(false);
        void refresh();
        onOpenThread(row);
        return;
      }
      if (mode === "work") {
        if (selectedWorkProject === undefined) {
          setComposerError(MOBILE_COPY.workNoProject);
          return;
        }
        if (selectedModel === undefined) {
          setComposerError("Choose a model from your computer before starting Work.");
          return;
        }
        const row = await createMobileWorkFromPrompt({
          transport: placementTransport,
          prompt,
          projectId: selectedWorkProject.projectId,
          providerInstanceId: selectedModel.providerInstanceId,
          modelId: selectedModel.modelId,
          bindingRevisionId: selectedWorkProject.bindingRevisionId,
          onCreated: started,
        });
        setPrompt("");
        setOpen(false);
        void refresh();
        onOpenThread(row);
        return;
      }
      const row = await createChat(prompt, started);
      setPrompt("");
      setOpen(false);
      void refresh();
      onOpenThread(row);
    } catch (cause) {
      if (cause instanceof MobileCodeCreationFailure) setCodeRetry(cause.retry);
      setComposerError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not create a thread on the host.",
      );
    } finally {
      setCreating(false);
    }
  };

  const projectChoices = (
    composerMode === "code" ? codeProjects : composerMode === "work" ? workProjects : []
  ).map((project) => ({
    id: project.projectId,
    label: formatScreenshotSafeLabel(project.name),
  }));
  const chosenProject =
    composerMode === "code"
      ? selectedCodeProject
      : composerMode === "work"
        ? selectedWorkProject
        : undefined;

  const openNewThread = useCallback(() => {
    setComposerMode("chat");
    setTodoSource(undefined);
    setComposerError(undefined);
    setCodeRetry(undefined);
    setOpen(true);
  }, []);
  const value = useMemo<NewThread>(
    () => ({
      openNewThread,
      accessReason: placementAccessReason,
      staleReason:
        placementTransport === undefined || staleGate.allowProductMutations
          ? undefined
          : staleGate.message,
    }),
    [openNewThread, placementAccessReason, placementTransport, staleGate],
  );

  return (
    <Context.Provider value={value}>
      {props.children}
      <HomeComposerSheet
        busy={creating}
        editable={composerEditable}
        error={composerError}
        mode={composerMode}
        modelLabel={modelLabel}
        onChangePrompt={(next) => {
          setPrompt(next);
          setCodeRetry(undefined);
        }}
        onClose={() => {
          // The label lives only in this sheet; a draft sent later must not
          // carry a source the person cannot see.
          setTodoSource(undefined);
          setOpen(false);
        }}
        onPressModel={() => setModelOpen(true)}
        onSelectMode={(mode) => {
          setComposerMode(mode);
          setComposerError(undefined);
          setCodeRetry(undefined);
        }}
        onSelectProject={(projectId) => {
          if (composerMode === "code") setCodeProjectId(projectId);
          else setWorkProjectId(projectId);
          setCodeRetry(undefined);
        }}
        onSubmit={() => void createThread(composerMode)}
        {...(todoSource === undefined
          ? {}
          : {
              sourceLabel: MOBILE_COPY.todoSource,
              onRemoveSource: () => setTodoSource(undefined),
            })}
        onRefreshHost={refreshPlacement}
        placementLabel={placementLabel}
        placementDisabledReason={placementDisabledReason}
        projectLabel={chosenProject?.name}
        projects={projectChoices}
        prompt={prompt}
        selectedProjectId={chosenProject?.projectId}
        visible={open}
        voice={voice}
      />
      <ModelPickerSheet
        onClose={() => setModelOpen(false)}
        onSelect={(id) => {
          setModelOptionId(id);
          setModelOpen(false);
          setCodeRetry(undefined);
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={modelOptionId}
        visible={modelOpen}
      />
      <CodeDeliveryTargetSheet
        onClose={() => finishDeliveryTarget(undefined)}
        onConfirm={finishDeliveryTarget}
        proposal={deliveryTargetProposal}
      />
    </Context.Provider>
  );
}
