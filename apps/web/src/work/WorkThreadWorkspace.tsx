import {
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeThreadWorkingDirectory,
  decodeWorkMutationRequestId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type MentionableThreadId,
  type WorkAttachmentId,
  type WorkRequest,
  type WorkThread,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnState,
  type WorkTurnStreamFrame,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { PickerGroup } from "@octant/domain";
import type { ChatComposerThreadMentionChip } from "../chat/ChatComposer";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import {
  WorkTurnClientFailure,
  type WorkTurnClient,
} from "@octant/client-runtime/work-turn-client";
import type { FileMentionClient, ThreadMentionClient } from "@octant/client-runtime";
import { Check, FileText, Globe2, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  applyComposerCaret,
  type ComposerThreadDraftStore,
} from "../composer/composerThreadDraftStore";
import { useComposerThreadDraft } from "../composer/useComposerThreadDraft";
import { useSteeredSend } from "../composer/useSteeredSend";
import type { TurnSettlement } from "../composer/steeredSend";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import { GeneratedImageList } from "../image/GeneratedImageList";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../chat/ThreadMentionPicker";
import { useThreadMentions } from "../chat/useThreadMentions";
import { clipboardHasImage } from "../chat/composerImagePaste";
import { PathMentionTypeahead } from "../code/CodePathMentionPicker";
import { selectedModelReadsImages, useWorkComposerImages } from "./composer/useWorkComposerImages";
import { WorkImageAttachmentChips } from "./composer/WorkImageAttachmentChips";
import { useWorkFileMentions } from "./useWorkFileMentions";
import { samePollingData } from "../polling/samePollingData";
import { TrackerReferenceComposerHints } from "../tracker/TrackerReferenceComposerHints";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";
import {
  documentIsVisible,
  scheduleVisibleInterval,
  waitUntilDocumentVisible,
} from "../polling/documentVisibility";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import { TurnHeader, turnWorkedFor, type TurnHeaderOutcome } from "../transcript/TurnHeader";
import { providerModelLabel } from "../providers/providerModelLabel";

/**
 * A message the user sent while a turn was still running.
 *
 * The prompt and every context selection travel with it. Context is detached
 * from the composer before a second draft can start, then restored if this
 * message is refused so the sent message never borrows a later draft.
 */
interface WorkSteeredMessage {
  readonly id: string;
  readonly originRestore: (message: WorkSteeredMessage) => void;
  readonly threadKey: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<File>;
  readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
  readonly threadMentionChips: ReadonlyArray<ChatComposerThreadMentionChip>;
  readonly fileMentionPaths: ReadonlyArray<string>;
  readonly draftRevision: number;
}

type WorkTranscriptRow =
  | { readonly kind: "empty"; readonly key: "empty" }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly entry: WorkTurnState["transcript"][number];
    }
  | { readonly kind: "steered"; readonly key: string; readonly prompt: string }
  | { readonly kind: "request"; readonly key: string; readonly request: WorkRequest }
  | {
      readonly kind: "files";
      readonly key: string;
      readonly wrote: NonNullable<WorkTurnState["wroteFiles"]>;
    }
  | { readonly kind: "status"; readonly key: "status"; readonly text: string }
  | {
      readonly kind: "head";
      readonly key: string;
      readonly turn: WorkTurnState;
    };

const WORK_TRANSCRIPT_RECONNECTING_MESSAGE = "Work transcript is reconnecting.";

/**
 * Where a turn's header sits: before its first assistant entry, or after the
 * whole turn when no reply exists yet. A turn that ended without a reply used
 * to leave the transcript silent — the journal recorded the failure while the
 * surface showed only the user's own message — so the header is emitted for
 * every turn, reply or not.
 */
function turnHeaderOutcome(turn: WorkTurnState): TurnHeaderOutcome {
  switch (turn.status) {
    case "accepted":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
  }
}

export interface WorkThreadWorkspaceProps {
  readonly title: string;
  readonly threadId: WorkThreadId;
  /** Machine-owned navigation snapshot; avoids rescanning every Project before transcript read. */
  readonly initialThread?: WorkThread;
  readonly onDisplayReadyChange?: (ready: boolean) => void;
  readonly changeRevision?: number;
  readonly threadClient: WorkThreadClient;
  readonly turnClient?: WorkTurnClient;
  readonly requestClient?: WorkRequestClient;
  readonly mutationClient?: WorkMutationClient;
  readonly onOpenBrowser?: () => void;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly threadMentionClient?: ThreadMentionClient;
  readonly fileMentionClient?: FileMentionClient;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageGenerationProfiles?: ReadonlyArray<ImageGenerationProfileView>;
  readonly onOpenSettings?: () => void;
  readonly hostId?: HostId;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  readonly onThreadUpdated?: (thread: WorkThread) => void;
  /**
   * Compact live child-run chrome for this thread. Rendered in the thread
   * header so it stays visible with the rest of the thread chrome.
   */
  readonly childRunStatus?: ReactNode;
  readonly draftStore?: ComposerThreadDraftStore;
}

function artifactNameFromPrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "notes.md";
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug.length > 0 ? slug : "notes"}.md`;
}

function applyWorkTurnStreamFrame(
  turns: ReadonlyArray<WorkTurnState>,
  frame: WorkTurnStreamFrame,
): ReadonlyArray<WorkTurnState> {
  if (frame.kind === "snapshot-required") return turns;
  const index = turns.findIndex(
    (turn) =>
      String(turn.requestId) ===
      String(frame.kind === "turn-settled" ? frame.turn.requestId : frame.requestId),
  );
  if (frame.kind === "turn-settled") {
    if (index === -1) return [...turns, frame.turn];
    const next = turns.slice();
    next[index] = frame.turn;
    return next;
  }
  if (index === -1) return turns;
  const current = turns[index];
  if (current === undefined) return turns;
  const assistantIndex = current.transcript.findIndex((entry) => entry.role === "assistant");
  const previousText = current.transcript[assistantIndex]?.text ?? current.response ?? "";
  const text = previousText + frame.text;
  const transcript = current.transcript.slice();
  const assistant = { role: "assistant" as const, text, status: "running" as const };
  if (assistantIndex === -1) transcript.push(assistant);
  else transcript[assistantIndex] = assistant;
  const next = turns.slice();
  next[index] = { ...current, status: "running", response: text, transcript };
  return next;
}

async function consumeWorkTurnStream(input: {
  readonly client: WorkTurnClient;
  readonly threadId: WorkThreadId;
  readonly afterSequence: number;
  readonly signal: AbortSignal;
  readonly active: () => boolean;
  readonly apply: (frame: WorkTurnStreamFrame) => void;
  readonly replace: (snapshot: WorkThreadTranscript) => void;
}): Promise<void> {
  let cursor = input.afterSequence;
  let retryMs = 250;
  while (input.active() && !input.signal.aborted) {
    try {
      let received = false;
      for await (const frame of input.client.subscribe(input.threadId, cursor, input.signal)) {
        if (!input.active() || input.signal.aborted) return;
        received = true;
        if (frame.kind === "snapshot-required") {
          const snapshot = await input.client.transcript(input.threadId, input.signal);
          if (!input.active() || input.signal.aborted) return;
          input.replace(snapshot);
          cursor = snapshot.liveCursor;
          break;
        }
        cursor = frame.sequence;
        input.apply(frame);
      }
      retryMs = received ? 50 : Math.min(retryMs * 2, 2_000);
    } catch {
      if (!input.active() || input.signal.aborted) return;
      retryMs = Math.min(retryMs * 2, 2_000);
    }
    await waitForWorkStreamReconnect(input.signal, retryMs);
  }
}

async function waitForWorkStreamReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function WorkThreadWorkspace(props: WorkThreadWorkspaceProps) {
  const composerDraft = useComposerThreadDraft({
    mode: "work",
    threadId: String(props.threadId),
    ...(props.draftStore === undefined ? {} : { store: props.draftStore }),
  });
  const prompt = composerDraft.text;
  const [projectId, setProjectId] = useState<ProjectId | undefined>(props.initialThread?.projectId);
  const [thread, setThread] = useState<WorkThread | undefined>(props.initialThread);
  const [turns, setTurns] = useState<ReadonlyArray<WorkTurnState>>([]);
  const [pendingRequests, setPendingRequests] = useState<ReadonlyArray<WorkRequest>>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [providerChanging, setProviderChanging] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionFormOpen, setCompletionFormOpen] = useState(false);
  const [completionEvidence, setCompletionEvidence] = useState("");
  const changeDriven = props.changeRevision !== undefined;
  const transcriptGeneration = useRef(0);
  const initialThread = useRef(props.initialThread);
  if (String(props.initialThread?.id) === String(props.threadId)) {
    initialThread.current = props.initialThread;
  } else if (String(initialThread.current?.id) !== String(props.threadId)) {
    initialThread.current = undefined;
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentThreadKeyRef = useRef(String(props.threadId));
  currentThreadKeyRef.current = String(props.threadId);
  const sendSteeredRef = useRef<(message: WorkSteeredMessage) => Promise<boolean>>(
    async () => false,
  );
  const mentionListId = useId();
  const fileMentionListId = useId();
  const trimmed = prompt.trim();
  const completionLocked = thread?.completionConfirmed === true;
  const steered = useSteeredSend<WorkSteeredMessage>({
    threadKey: String(props.threadId),
    settlement: workTurnSettlement(turns),
    ready: !providerChanging && !creating && !completionLocked,
    send: (message) => sendSteeredRef.current(message),
    restore: (message) => message.originRestore(message),
  });
  const turnRunning = workTurnSettlement(turns) === "running";
  const images = useWorkComposerImages();
  const imageSupport = selectedModelReadsImages(props.providerGroups ?? [], {
    ...(thread === undefined ? {} : { providerInstanceId: thread.providerInstanceId }),
    ...(thread === undefined ? {} : { modelId: thread.modelId }),
  });
  const threadMentions = useThreadMentions({
    ...(props.threadMentionClient === undefined ? {} : { client: props.threadMentionClient }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft: prompt,
    onDraftChange: composerDraft.setDraft,
    textarea: () => textareaRef.current,
    disabled: creating || completionLocked,
  });
  const fileMentions = useWorkFileMentions({
    ...(props.fileMentionClient === undefined ? {} : { client: props.fileMentionClient }),
    threadId: props.threadId,
    draft: prompt,
    onDraftChange: composerDraft.setDraft,
    textarea: () => textareaRef.current,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const fileMentionOpen = fileMentions.open && !mention.open;
  const canSubmit =
    trimmed.length > 0 &&
    !creating &&
    !completionLocked &&
    steered.pending === undefined &&
    projectId !== undefined &&
    (props.turnClient !== undefined || props.mutationClient !== undefined);
  const transcriptRows = useMemo<ReadonlyArray<WorkTranscriptRow>>(() => {
    const rows: WorkTranscriptRow[] = [];
    if (turns.length === 0) rows.push({ kind: "empty", key: "empty" });
    for (const [turnIndex, turn] of turns.entries()) {
      const head: WorkTranscriptRow = {
        kind: "head",
        key: `${String(turn.requestId)}-${String(turnIndex)}-head`,
        turn,
      };
      let headPlaced = false;
      for (const [index, entry] of turn.transcript.entries()) {
        if (entry.role === "assistant" && !headPlaced) {
          rows.push(head);
          headPlaced = true;
        }
        rows.push({
          kind: "message",
          key: `${String(turn.requestId)}-${String(turnIndex)}-${entry.role}-${String(index)}`,
          entry,
        });
      }
      if (!headPlaced) rows.push(head);
      // The files land after the turn that produced them, so the transcript
      // reads as what was said and then what came out of it.
      if (turn.wroteFiles !== undefined) {
        rows.push({
          kind: "files",
          key: `${String(turn.requestId)}-${String(turnIndex)}-files`,
          wrote: turn.wroteFiles,
        });
      }
    }
    if (steered.pending !== undefined) {
      rows.push({
        kind: "steered",
        key: `steered-${steered.pending.id}`,
        prompt: steered.pending.prompt,
      });
    }
    for (const request of pendingRequests) {
      rows.push({ kind: "request", key: `request-${String(request.requestId)}`, request });
    }
    if (status !== undefined) rows.push({ kind: "status", key: "status", text: status });
    return rows;
  }, [pendingRequests, status, steered.pending, turns]);

  // A confirmed completion means this thread will never run the message, so it
  // goes back to the composer instead of waiting for a settlement that is not
  // coming.
  useEffect(() => {
    if (completionLocked) steered.drop();
  }, [completionLocked, steered.drop]);

  useEffect(() => {
    const requestGeneration = ++transcriptGeneration.current;
    const streamAbort = new AbortController();
    let cancelled = false;
    props.onDisplayReadyChange?.(false);
    void (async () => {
      try {
        const thread =
          String(initialThread.current?.id) === String(props.threadId)
            ? initialThread.current
            : (await props.threadClient.bootstrap(streamAbort.signal)).threads.find(
                (candidate) => String(candidate.id) === String(props.threadId),
              );
        if (thread === undefined) {
          composerDraft.purge(String(props.threadId));
          setErrorMessage("This task is no longer available.");
          return;
        }
        setThread(thread);
        setProjectId(thread.projectId);
        const transcriptRead = async () => {
          const turnClient = props.turnClient;
          if (turnClient === undefined) {
            props.onDisplayReadyChange?.(true);
            return;
          }
          let retryMs = 250;
          let transcript: WorkThreadTranscript;
          for (;;) {
            try {
              transcript = await turnClient.transcript(props.threadId, streamAbort.signal);
              break;
            } catch (error) {
              if (cancelled || streamAbort.signal.aborted) return;
              const permanentlyRefused =
                error instanceof WorkTurnClientFailure && error.status >= 400 && error.status < 500;
              if (!changeDriven || permanentlyRefused) throw error;
              setErrorMessage(WORK_TRANSCRIPT_RECONNECTING_MESSAGE);
              await waitUntilDocumentVisible(streamAbort.signal);
              if (streamAbort.signal.aborted) return;
              await waitForWorkStreamReconnect(streamAbort.signal, retryMs);
              retryMs = Math.min(retryMs * 2, 2_000);
            }
          }
          if (cancelled || requestGeneration !== transcriptGeneration.current) return;
          setErrorMessage((current) =>
            current === WORK_TRANSCRIPT_RECONNECTING_MESSAGE ? undefined : current,
          );
          setTurns((current) =>
            samePollingData(current, transcript.turns) ? current : transcript.turns,
          );
          props.onDisplayReadyChange?.(true);
          if (typeof turnClient.subscribe === "function") {
            void consumeWorkTurnStream({
              client: turnClient,
              threadId: props.threadId,
              afterSequence: transcript.liveCursor,
              signal: streamAbort.signal,
              active: () => !cancelled && requestGeneration === transcriptGeneration.current,
              apply: (frame) => setTurns((current) => applyWorkTurnStreamFrame(current, frame)),
              replace: (next) =>
                setTurns((current) =>
                  samePollingData(current, next.turns) ? current : next.turns,
                ),
            });
          }
        };
        const requestRead = async () => {
          const requestClient = props.requestClient;
          if (requestClient === undefined) return;
          const requests = await requestClient.list(
            thread.projectId,
            props.threadId,
            streamAbort.signal,
          );
          if (cancelled || requestGeneration !== transcriptGeneration.current) return;
          const pending = requests.requests.filter((request) => request.status === "pending");
          setPendingRequests((current) => (samePollingData(current, pending) ? current : pending));
        };
        await Promise.all([transcriptRead(), requestRead()]);
      } catch {
        if (!cancelled) setErrorMessage("This task could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
      streamAbort.abort();
      transcriptGeneration.current += 1;
    };
  }, [
    changeDriven,
    composerDraft.purge,
    props.onDisplayReadyChange,
    props.requestClient,
    props.threadClient,
    props.threadId,
    props.turnClient,
  ]);

  useEffect(() => {
    const next = props.initialThread;
    if (next === undefined || String(next.id) !== String(props.threadId)) return;
    setThread((current) => (samePollingData(current, next) ? current : next));
    setProjectId(next.projectId);
  }, [props.initialThread, props.threadId]);

  useEffect(() => {
    const turnClient = props.turnClient;
    const requestClient = props.requestClient;
    if (turnClient === undefined && requestClient === undefined) return;
    if (props.changeRevision !== undefined) return;
    let cancelled = false;
    const pollAbort = new AbortController();
    // A cycle that outlives the interval must finish before the next one
    // starts. Without this guard, a poll slower than the interval is always
    // superseded by the next tick's generation bump before its response
    // arrives, so a host that consistently takes longer than 1s to answer
    // would never see its transcript or pending requests update at all.
    let inFlight = false;
    const stop = scheduleVisibleInterval(() => {
      if (cancelled || inFlight || !documentIsVisible()) return;
      inFlight = true;
      const streamAvailable = typeof turnClient?.subscribe === "function";
      const requestGeneration = streamAvailable
        ? transcriptGeneration.current
        : ++transcriptGeneration.current;
      const transcript =
        turnClient === undefined || streamAvailable
          ? Promise.resolve()
          : turnClient.transcript(props.threadId, pollAbort.signal).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              setTurns((current) => (samePollingData(current, next.turns) ? current : next.turns));
            });
      const requests =
        requestClient === undefined || projectId === undefined
          ? Promise.resolve()
          : requestClient.list(projectId, props.threadId, pollAbort.signal).then((next) => {
              if (cancelled || requestGeneration !== transcriptGeneration.current) return;
              const pending = next.requests.filter((request) => request.status === "pending");
              setPendingRequests((current) =>
                samePollingData(current, pending) ? current : pending,
              );
            });
      void Promise.allSettled([transcript, requests]).finally(() => {
        inFlight = false;
      });
    }, 1_000);
    return () => {
      cancelled = true;
      pollAbort.abort();
      stop();
    };
  }, [projectId, props.changeRevision, props.requestClient, props.threadId, props.turnClient]);

  useEffect(() => {
    if (
      props.changeRevision === undefined ||
      props.changeRevision <= 0 ||
      props.requestClient === undefined ||
      projectId === undefined
    )
      return;
    let cancelled = false;
    const refreshAbort = new AbortController();
    void props.requestClient
      .list(projectId, props.threadId, refreshAbort.signal)
      .then((next) => {
        if (cancelled) return;
        const pending = next.requests.filter((request) => request.status === "pending");
        setPendingRequests((current) => (samePollingData(current, pending) ? current : pending));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      refreshAbort.abort();
    };
  }, [projectId, props.changeRevision, props.requestClient, props.threadId]);

  const changeProvider = useCallback(
    async (selection: {
      readonly providerInstanceId: WorkThread["providerInstanceId"];
      readonly modelId: WorkThread["modelId"];
    }) => {
      if (
        thread === undefined ||
        thread.completionConfirmed === true ||
        providerChanging ||
        (selection.providerInstanceId === thread.providerInstanceId &&
          selection.modelId === thread.modelId)
      ) {
        return;
      }
      setProviderChanging(true);
      setErrorMessage(undefined);
      setStatus(undefined);
      try {
        const result = await props.threadClient.execute({
          kind: "change-work-thread-provider",
          threadId: thread.id,
          expectedVersion: thread.version,
          providerInstanceId: selection.providerInstanceId,
          modelId: selection.modelId,
        });
        if (!("kind" in result) || result.kind !== "thread-updated") {
          setErrorMessage("The selected Work provider could not be applied.");
          return;
        }
        setThread(result.thread);
        props.onThreadUpdated?.(result.thread);
        setStatus("Provider handoff ready for the next Work turn.");
      } catch {
        setErrorMessage(
          "The selected Work provider could not be applied. Choose a ready provider and model.",
        );
      } finally {
        setProviderChanging(false);
      }
    },
    [props.threadClient, providerChanging, thread],
  );

  const sendWorkTurn = useCallback(
    async (message?: WorkSteeredMessage): Promise<boolean> => {
      if (
        thread !== undefined &&
        thread.bindingRevisionId === undefined &&
        props.turnClient !== undefined
      ) {
        setErrorMessage(
          "This task must be rebound before sending a follow-up. Its Project folder is no longer authorized.",
        );
        return false;
      }
      if (
        thread === undefined ||
        thread.completionConfirmed === true ||
        providerChanging ||
        props.turnClient === undefined ||
        thread.bindingRevisionId === undefined ||
        projectId === undefined
      ) {
        return false;
      }
      const promptText = (message?.prompt ?? composerDraft.text).trim();
      if (promptText.length === 0) return false;
      const sendingThreadId = String(thread.id);
      const draftRevision = composerDraft.revisionFor(String(props.threadId));
      const attachmentIds: WorkAttachmentId[] = [];
      const discardUploadedAttachments = async (): Promise<void> => {
        await Promise.allSettled(
          attachmentIds.map((attachmentId) =>
            props.turnClient?.discardAttachment(props.threadId, attachmentId),
          ),
        );
      };
      setCreating(true);
      setErrorMessage(undefined);
      setStatus(undefined);
      try {
        if (String(props.threadId) !== sendingThreadId) return false;
        const staged = message?.images ?? images.filesForSend();
        const fileMentionPaths = message?.fileMentionPaths ?? [...fileMentions.selectedPaths];
        const threadMentionIds =
          message?.threadMentionIds ?? (await threadMentions.resolveForSend());
        for (const file of staged) {
          const attachmentId = decodeWorkAttachmentId(globalThis.crypto.randomUUID());
          await props.turnClient.putAttachment({
            threadId: props.threadId,
            attachmentId,
            displayName: file.name.trim() === "" ? "Pasted image" : file.name,
            mediaType: decodeWorkAttachmentMediaType(file.type),
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          attachmentIds.push(attachmentId);
        }
        const started = await props.turnClient.startFirstTurn({
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
          threadId: props.threadId,
          turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
          prompt: promptText,
          authority: {
            hostId: props.hostId ?? LOCAL_HOST_ID,
            projectId,
            bindingRevisionId: thread.bindingRevisionId,
            workingDirectory: thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
            confinementPosture: "project-root-confined",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          },
          ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
          ...(threadMentionIds.length === 0 ? {} : { threadMentionIds }),
          ...(fileMentionPaths.length === 0 ? {} : { fileMentionPaths: [...fileMentionPaths] }),
        });
        if (started.kind !== "accepted") {
          await discardUploadedAttachments();
          setErrorMessage("The Work turn could not be started.");
          return false;
        }
        if (message === undefined) {
          images.clearAfterAccepted();
          threadMentions.clear();
          fileMentions.clear();
          // Do not clear text typed while this send was resolving, even when it
          // happens to be identical to the text this send carried.
          if (composerDraft.revisionFor(String(props.threadId)) === draftRevision) {
            composerDraft.clear();
          }
        }
        setTurns((current) =>
          current.some((turn) => String(turn.requestId) === String(started.turn.requestId))
            ? current
            : [...current, started.turn],
        );
        textareaRef.current?.focus();
        return true;
      } catch {
        await discardUploadedAttachments();
        setErrorMessage("The Work turn could not be started.");
        return false;
      } finally {
        setCreating(false);
      }
    },
    [
      composerDraft,
      fileMentions,
      images,
      projectId,
      props.hostId,
      props.threadId,
      props.turnClient,
      providerChanging,
      thread,
      threadMentions,
    ],
  );
  sendSteeredRef.current = (message) => sendWorkTurn(message);
  const restoreWorkMessage = useCallback(
    (message: WorkSteeredMessage): void => {
      const originThreadKey = message.threadKey;
      // A newer draft the user typed while this one waited is the one worth
      // keeping. The revision check also catches a user who typed the same words
      // again, rather than mistaking identical text for an unchanged draft.
      if (composerDraft.revisionFor(originThreadKey) !== message.draftRevision + 1) {
        return;
      }
      composerDraft.writeFor(originThreadKey, message.prompt);
      // A navigation can reuse this hook instance for another thread. Restore
      // text into the originating draft store, but never attach its context to
      // the newly selected thread's composer.
      if (currentThreadKeyRef.current !== originThreadKey) return;
      images.restore(message.images);
      threadMentions.restore(message.threadMentionChips);
      fileMentions.restore(message.fileMentionPaths);
    },
    [composerDraft, fileMentions, images, threadMentions],
  );

  const submit = useCallback(async () => {
    if (steered.pending !== undefined) return;
    if (turnRunning) {
      // Sending during a running turn is still sending: the message leaves the
      // composer now and joins the transcript, and the host runs it as soon as
      // this thread stops running one.
      if (!canSubmit) return;
      const threadMentionChips = [...threadMentions.chips];
      const steeredMessage: WorkSteeredMessage = {
        id: globalThis.crypto.randomUUID(),
        originRestore: restoreWorkMessage,
        threadKey: String(props.threadId),
        prompt: trimmed,
        images: images.filesForSend(),
        threadMentionIds: threadMentionChips.map((chip) => chip.threadId),
        threadMentionChips,
        fileMentionPaths: [...fileMentions.selectedPaths],
        draftRevision: composerDraft.revisionFor(String(props.threadId)),
      };
      if (!steered.steer(steeredMessage)) return;
      // Detach this message's context before the user can start a second draft;
      // a refused send restores it through the same public hook APIs.
      images.takeForSend();
      threadMentions.clear();
      fileMentions.clear();
      composerDraft.clear();
      return;
    }
    if (!canSubmit || projectId === undefined) {
      return;
    }
    if (props.turnClient !== undefined) {
      await sendWorkTurn();
      return;
    }
    if (props.mutationClient === undefined) return;
    setCreating(true);
    setErrorMessage(undefined);
    setStatus(undefined);
    try {
      const reply = await props.mutationClient.mutate({
        kind: "create-artifact",
        requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
        projectId,
        format: "markdown",
        displayName: artifactNameFromPrompt(trimmed),
        content: trimmed,
      });
      if (reply.outcome.kind !== "created") {
        setErrorMessage("The artifact could not be created.");
        return;
      }
      composerDraft.clear();
      setStatus(`Created ${reply.outcome.artifact.displayName} in the bound folder.`);
      textareaRef.current?.focus();
    } catch {
      setErrorMessage("The artifact could not be created. Review the Work project status.");
    } finally {
      setCreating(false);
    }
  }, [
    canSubmit,
    composerDraft,
    projectId,
    props.mutationClient,
    props.turnClient,
    sendWorkTurn,
    steered,
    trimmed,
    turnRunning,
  ]);

  const confirmCompletion = useCallback(async () => {
    const evidence = completionEvidence.trim();
    if (
      thread === undefined ||
      completing ||
      thread.lifecycle !== "active" ||
      thread.completionConfirmed === true ||
      evidence.length === 0
    ) {
      return;
    }
    setCompleting(true);
    setErrorMessage(undefined);
    setStatus(undefined);
    try {
      const result = await props.threadClient.execute({
        kind: "confirm-work-thread-completion",
        threadId: thread.id,
        expectedVersion: thread.version,
        deliveryTarget: thread.title,
        satisfactionEvidence: evidence,
      });
      if (!("kind" in result) || result.kind !== "thread-completion-confirmed") {
        setErrorMessage("This task could not be marked complete.");
        return;
      }
      setThread(result.thread);
      props.onThreadUpdated?.(result.thread);
      setCompletionFormOpen(false);
      setCompletionEvidence("");
      setStatus("Delivery target marked complete.");
    } catch {
      setErrorMessage("This task could not be marked complete. Try again.");
    } finally {
      setCompleting(false);
    }
  }, [completing, completionEvidence, props.threadClient, thread]);

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (items === null) return false;
    if (!clipboardHasImage(items)) return false;
    if (imageSupport === false) {
      images.refuse("The selected model does not accept images. Choose an image-capable model.");
      return true;
    }
    return images.consumePaste(items);
  }

  const restoredCaret = composerDraft.caretIndex;
  const restoredLength = prompt.length;
  useLayoutEffect(() => {
    applyComposerCaret(textareaRef.current, restoredCaret, restoredLength);
    // Restore only when this thread's composer is shown, not on every keystroke.
  }, [props.threadId]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.handleKeyDown(event)) return;
    if (fileMentions.handleKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function rememberDraft(text: string, caretIndex: number | null) {
    if (caretIndex === null) composerDraft.setDraft(text);
    else composerDraft.setDraft(text, caretIndex);
  }

  function syncMentions(value: string, caret: number | null) {
    mention.sync(value, caret);
    fileMentions.sync(value, caret);
  }

  return (
    <section aria-label="Task workspace" className="work-thread-workspace">
      <header className="work-thread-workspace__header">
        {/* The pane's tab already names the task; repeating it here cost a
            heading, an eyebrow, and a subtitle for nothing. Chat resolved the
            same duplication by keeping the name for assistive technology only. */}
        <h1 className="sr-only">{props.title}</h1>
        {props.childRunStatus}
        <div aria-label="Work tools" className="work-thread-workspace__toolbar" role="toolbar">
          {props.onOpenBrowser === undefined ? null : (
            <OctantButton
              className="code-thread-workspace__tool window-no-drag"
              onClick={props.onOpenBrowser}
              size="sm"
              type="button"
              variant="outline"
            >
              <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
              <span>Browser</span>
            </OctantButton>
          )}
          {thread?.lifecycle === "active" && thread.completionConfirmed !== true ? (
            <OctantButton
              aria-label="Mark this task complete"
              disabled={completing || providerChanging || creating}
              onClick={() => setCompletionFormOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Check aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>{completing ? "Marking complete" : "Mark complete"}</span>
            </OctantButton>
          ) : null}
        </div>
      </header>

      {completionFormOpen && thread?.lifecycle === "active" && !completionLocked ? (
        <section aria-label="Mark this task complete" className="work-thread-workspace__completion">
          <p>
            Say what <strong>{thread.title}</strong> delivered. Octant records your words as the
            evidence that this task is done.
          </p>
          <OctantTextarea
            aria-label="What this task delivered"
            disabled={completing}
            onChange={(event) => setCompletionEvidence(event.target.value)}
            placeholder="Describe what was delivered…"
            rows={3}
            value={completionEvidence}
          />
          <OctantButton
            aria-label="Confirm this task is complete"
            disabled={completing || completionEvidence.trim().length === 0}
            onClick={() => void confirmCompletion()}
            size="sm"
            type="button"
            variant="default"
          >
            {completing ? "Confirming completion" : "Confirm completion"}
          </OctantButton>
        </section>
      ) : null}

      <TranscriptWindow
        ariaLabel="Work transcript"
        className="work-thread-workspace__conversation"
        estimateSize={92}
        gap={18}
        itemKey={(row) => row.key}
        items={transcriptRows}
        listClassName="work-thread-workspace__transcript"
        renderItem={(row) => {
          if (row.kind === "empty") {
            return (
              <p className="work-thread-workspace__opening">
                Describe what you want made. Files this task writes stay inside its folder.
              </p>
            );
          }
          if (row.kind === "message") {
            if (row.entry.role === "user") {
              return (
                <article aria-label="Your message" className="turn-user">
                  <div className="bubble">
                    <TrackerReferenceText asParagraph text={row.entry.text} />
                  </div>
                </article>
              );
            }
            return (
              <article aria-label="Assistant message" className="turn-agent">
                {row.entry.text === "" ? null : (
                  <TrackerReferenceText asParagraph text={row.entry.text} />
                )}
              </article>
            );
          }
          if (row.kind === "head") {
            const outcome = turnHeaderOutcome(row.turn);
            const workedFor = turnWorkedFor(outcome, row.turn.acceptedAt, row.turn.updatedAt);
            return (
              <TurnHeader
                at={row.turn.updatedAt}
                outcome={outcome}
                provider={providerModelLabel(props.providerGroups ?? [], row.turn.authority)}
                {...(workedFor === undefined ? {} : { workedFor })}
                {...(row.turn.failure === undefined ? {} : { reason: row.turn.failure.message })}
              />
            );
          }
          if (row.kind === "steered") {
            return (
              <article aria-label="Your message" className="turn-user">
                <div className="bubble">
                  <TrackerReferenceText asParagraph text={row.prompt} />
                </div>
              </article>
            );
          }
          if (row.kind === "files") {
            return (
              <section
                aria-label="Files this turn changed"
                className="work-thread-workspace__files"
              >
                <h3 className="oct-section-label">
                  {/* A watcher that failed reports no paths and marks itself
                      truncated. Counting that as zero told the person nothing
                      changed, which is not what the host observed. An empty
                      list that is not truncated really is nothing. */}
                  {row.wrote.paths.length === 0 && row.wrote.truncated
                    ? "Changed files could not be observed while this ran"
                    : row.wrote.paths.length === 1
                      ? "1 file changed while this ran"
                      : `${String(row.wrote.paths.length)} files changed while this ran`}
                </h3>
                <ul className="work-thread-workspace__file-list">
                  {row.wrote.paths.map((path) => (
                    <li className="work-thread-workspace__file" key={path}>
                      <FileText aria-hidden="true" size={14} strokeWidth={1.7} />
                      <span>{path}</span>
                    </li>
                  ))}
                </ul>
                {row.wrote.truncated ? (
                  <p className="oct-row-detail" role="status">
                    {/* "More changed" claims a file changed. A watcher that
                        failed establishes no such thing. */}
                    {row.wrote.paths.length === 0
                      ? "Octant could not watch the folder while this ran. Open Files for the folder itself."
                      : "More changed than Octant could record. Open Files for the folder itself."}
                  </p>
                ) : null}
              </section>
            );
          }
          if (row.kind === "request") {
            return (
              <p className="runstatus" role="status">
                {row.request.detail.kind === "approval"
                  ? `Approval required — ${row.request.detail.action}: ${row.request.detail.description}`
                  : `Input required — ${row.request.detail.prompt}`}
              </p>
            );
          }
          return (
            <p className="runstatus" role="status">
              {row.text}
            </p>
          );
        }}
        restoreKey={`work:${String(props.threadId)}`}
        role="log"
        trail={
          props.imageGenerationClient === undefined ||
          props.imageGenerationProfiles === undefined ? null : (
            <div className="work-thread-workspace__transcript-trail">
              <GeneratedImageList
                canSaveToProject
                client={props.imageGenerationClient}
                onAttach={(file) => images.attach([file])}
                onSaveToProject={(job, artifact) => {
                  void props.imageGenerationClient
                    ?.save({
                      jobId: job.id,
                      attachmentId: artifact.attachmentId,
                      relativePath: `generated/${String(artifact.attachmentId).slice(0, 8)}.png`,
                    })
                    .then((result) => {
                      if (result.status === "saved") setStatus(`Saved ${result.relativePath}.`);
                      else setStatus(result.reason);
                    })
                    .catch(() => {
                      setStatus("The image could not be saved.");
                    });
                }}
                profiles={props.imageGenerationProfiles}
                scopeId={decodeImageGenerationScopeId(String(props.threadId))}
                threadKind="work-thread"
              />
            </div>
          )
        }
      />

      <div className="work-thread-workspace__composer">
        <div className="work-thread-workspace__composer-shell">
          <ThreadComposer
            chips={
              <>
                <ThreadMentionChips
                  chips={threadMentions.chips}
                  onRemove={(mentionedThreadId) =>
                    threadMentions.composer?.onRemoveChip(mentionedThreadId)
                  }
                />
                <TrackerReferenceComposerHints draft={prompt} />
                <WorkImageAttachmentChips images={images} />
                {composerDraft.persistError === undefined ? null : (
                  <p className="work-thread-workspace__hint" role="status">
                    {composerDraft.persistError}
                  </p>
                )}
              </>
            }
            input={
              <OctantTextarea
                aria-label="Work prompt"
                autoFocus
                className="composer-input"
                disabled={
                  creating ||
                  completionLocked ||
                  (props.mutationClient === undefined && props.turnClient === undefined)
                }
                onChange={(event) => {
                  rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
                  syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => {
                  rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
                  syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(event) => {
                  rememberDraft(event.currentTarget.value, event.currentTarget.selectionStart);
                  syncMentions(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
                  if (creating || completionLocked) return;
                  if (attachFromTransfer(event.clipboardData)) event.preventDefault();
                }}
                placeholder={
                  turnRunning
                    ? "Send the next message…"
                    : "Describe the deliverable or paste a draft…"
                }
                ref={textareaRef}
                rows={4}
                value={prompt}
              />
            }
            typeahead={
              <>
                {mention.open ? (
                  <ThreadMentionTypeahead
                    activeIndex={mention.activeIndex}
                    {...(threadMentions.composer?.busy === undefined
                      ? {}
                      : { busy: threadMentions.composer.busy })}
                    candidates={threadMentions.composer?.candidates ?? []}
                    listId={mentionListId}
                    onChoose={mention.choose}
                    onHover={mention.setActiveIndex}
                  />
                ) : null}
                {fileMentionOpen ? (
                  <PathMentionTypeahead
                    activeIndex={fileMentions.activeIndex}
                    busy={fileMentions.busy}
                    candidates={fileMentions.candidates}
                    listId={fileMentionListId}
                    onChoose={fileMentions.choose}
                    onHover={fileMentions.setActiveIndex}
                  />
                ) : null}
              </>
            }
            row={{
              leading: (
                <>
                  {/* Model sits beside send, not on a strip above the composer:
                      the bar holds how the task runs (0073). */}
                  {thread === undefined ? null : (
                    <span
                      aria-label="Bound provider and model"
                      className="work-thread-workspace__bound-model"
                    >
                      <ComposerModelPicker
                        ariaLabel="Provider and model"
                        disabled={providerChanging || creating || completionLocked}
                        groups={props.providerGroups ?? []}
                        onSelect={(selection) => void changeProvider(selection)}
                        {...(props.onOpenSettings === undefined
                          ? {}
                          : { onOpenSettings: props.onOpenSettings })}
                        selectedModelId={thread.modelId}
                        selectedProviderInstanceId={thread.providerInstanceId}
                      />
                    </span>
                  )}
                  {props.turnClient === undefined ? null : (
                    <>
                      <label>
                        <span className="work-composer-adapter__visually-hidden">
                          Add attachment
                        </span>
                        {/* ui-boundary-exception: native-file-input */}
                        <input
                          aria-label="Choose attachment file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="work-composer-adapter__file-input"
                          disabled={creating || completionLocked || imageSupport === false}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.item(0);
                            if (file !== null && file !== undefined) {
                              if (imageSupport === false) {
                                images.refuse(
                                  "The selected model does not accept images. Choose an image-capable model.",
                                );
                              } else {
                                images.attach([file]);
                              }
                            }
                            event.currentTarget.value = "";
                          }}
                          type="file"
                        />
                      </label>
                      <OctantButton
                        aria-label="Add attachment"
                        disabled={creating || completionLocked || imageSupport === false}
                        onClick={(event) => {
                          event.currentTarget.parentElement
                            ?.querySelector<HTMLInputElement>('input[type="file"]')
                            ?.click();
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />
                      </OctantButton>
                    </>
                  )}
                  <ComposerVoiceButton
                    disabled={creating || completionLocked}
                    onTranscript={(transcript) =>
                      rememberDraft(appendTranscript(prompt, transcript), null)
                    }
                  />
                </>
              ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel:
                    props.turnClient === undefined && !turnRunning
                      ? "Create artifact"
                      : "Send follow-up",
                  disabled: !canSubmit,
                  onSend: () => void submit(),
                },
              },
            }}
          />
          {errorMessage === undefined ? null : (
            <p className="draft-thread__error" role="alert">
              {errorMessage}
            </p>
          )}
          {steered.pending === undefined ? null : (
            <p className="draft-thread__hint" role="status">
              Sent. It runs when the turn in progress finishes.
            </p>
          )}
          <p className="draft-thread__hint">
            {completionLocked
              ? "Reactivate this task before creating another file or changing its provider."
              : turnRunning
                ? "Enter sends when this response finishes"
                : props.turnClient === undefined
                  ? "Enter saves a Markdown artifact · Shift+Enter for a new line"
                  : "Enter to send · Shift+Enter for a new line · # mentions a thread · @ mentions a file"}
          </p>
        </div>
      </div>
    </section>
  );
}

function workTurnSettlement(turns: ReadonlyArray<WorkTurnState>): TurnSettlement | "idle" {
  const latest = turns.at(-1);
  if (latest === undefined) return "idle";
  switch (latest.status) {
    case "accepted":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}
