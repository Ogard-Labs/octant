import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../ui/Icon";
import {
  chatAttemptStatusLabel,
  MOBILE_THREAD_LEVEL_LABELS,
  mobileAttachmentOffer,
  mobileThreadLevel,
  setMobileUsageResume,
  stopMobileCodeTurn,
  stopMobileWorkTurn,
  type MobileAttachmentSource,
  type MobileInboxRow,
  type RemoteSessionStanding,
  stopMobileLiveTasks,
  stopMobileSubagent,
} from "@octant/client-runtime";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { BottomSheet } from "../ui/BottomSheet";
import { useConnectionStatus } from "@octant/client-runtime/use-connection-status";
import { presentStaleHostSecurity } from "@octant/domain";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { ApprovalDeferralSheet } from "../approvals/ApprovalDeferralSheet";
import { MemoryProposalCard, RoutineProposalCard } from "../surfaces/AgentProposalCards";
import { BrowserSurfacePanel } from "../surfaces/BrowserSurfacePanel";
import { NativeHarnessSessionPanel } from "../surfaces/NativeHarnessSessionPanel";
import { BrowserApprovalCard } from "../surfaces/BrowserApprovalCard";
import { ExtensionToolApprovalCard } from "../surfaces/ExtensionToolApprovalCard";
import { ThreadSecretCards } from "../surfaces/ThreadSecretCard";
import { ServiceOfferCard } from "../surfaces/ServiceOfferCard";
import { ThreadVideoClips } from "../surfaces/ThreadVideoClips";
import { WorkRequestCards } from "../surfaces/WorkRequestCards";
import {
  conversationComposerAccess,
  listMobileThreadSurfaces,
} from "../surfaces/threadSurfacePresentation";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES, mobileModelLabel, mobileThreadHint } from "../copy";
import { PullRequestReviewPanel } from "../review/PullRequestReviewPanel";
import { CoordinatorProposalsPanel } from "../review/CoordinatorProposalsPanel";
import { ThreadRoutinesPanel } from "../review/ThreadRoutinesPanel";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { chosenReasoningLabel, selectableModelSettings } from "./modelSettings";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { mobileSpacing } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { ListRow, ListSection } from "../ui/NativeChrome";
import { useWhileHere } from "../ui/useWhileHere";
import { KeyboardRoom } from "../ui/KeyboardRoom";
import { AttachSourceSheet } from "../ui/AttachSourceSheet";
import { FloatingComposer } from "../ui/FloatingComposer";
import { SubagentsPill, SubagentsSheet } from "../agents/SubagentsSheet";
import { useThreadSubagents } from "../agents/useThreadSubagents";
import type { MobileThreadPaneId } from "../panes/threadPanesPresentation";
import { ThreadPanesSheet, type ThreadTool } from "../panes/ThreadPanesSheet";
import { listMobileThreadTools } from "../panes/threadPanesPresentation";
import { CanvasHtmlImportSheet } from "../surfaces/CanvasHtmlImportSheet";
import { ProjectPageSheet, ProjectTerminalSheet } from "../surfaces/ProjectToolSheets";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { RewindSheet } from "../ui/RewindSheet";
import { modelOptionForThread } from "./thread/pendingAttachments";
import { useVoiceDictation } from "../voice/useVoiceDictation";
import { appendTranscript } from "../voice/voiceDictation";
import { DefaultLevelsPanel } from "./thread/DefaultLevelsPanel";
import { createSelectedThreadGuard } from "./thread/selectedThreadGuard";
import { ThreadLevelPanel } from "./thread/ThreadLevelPanel";
import { useThreadTranscriptRows } from "./thread/ThreadTranscript";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { ResumeBar, type ResumeOffer } from "./thread/ResumeBar";
import { useThreadReplyDetail } from "./thread/useThreadReplyDetail";
import type { ThreadHookInput, ThreadTarget, ThreadUi } from "./thread/threadTypes";
import { useMobileThreads } from "./MobileThreadsContext";
import { useOutbox } from "../outbox/OutboxContext";
import { WaitingMessages } from "../outbox/WaitingMessages";
import { QueuedMessages } from "./thread/QueuedMessages";
import { threadPullRequestStatus } from "./threadRowState";
import { isLiveWorkTurn, turnSubagents } from "./thread/turnActivity";
import { useTurnControl } from "./thread/useTurnControl";
import { useChatThread } from "./thread/useChatThread";
import { useCodeThread } from "./thread/useCodeThread";
import { useThreadTurnActions } from "./thread/useThreadTurnActions";
import { useWorkThread } from "./thread/useWorkThread";
import { typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import {
  MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
  MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS,
  enteredMobileForeground,
} from "./threadRefreshPolicy";
import { useRemoteSessionStanding } from "./useRemoteSessionStanding";

// Shown while the host is unreachable, whether the app's connection or the
// chat event stream noticed first.
const RECONNECTING_COPY = "Reconnecting to the host…";

export interface ThreadScreenProps {
  readonly selected: MobileInboxRow | undefined;
  /** Opens the thread a fork made. */
  readonly onOpenThread: (row: MobileInboxRow) => void;
  /** A Chat turn a message search matched; the thread opens scrolled to it. */
  readonly focusTurnId?: string | undefined;
}

export function ThreadScreen(props: ThreadScreenProps) {
  const { colors } = useTheme();
  const { environment, transportForHost, hosts, health, hub, fullAccessWarnings } =
    useMobileSession();
  const offlineDemo = environment.kind === "mock" && environment.offlineDemo;
  const selected = props.selected;
  const hostId = selected?.hostId;
  const transport = useMemo(
    () => (hostId === undefined ? undefined : transportForHost(hostId)),
    [hostId, transportForHost],
  );
  const hostHealth =
    hostId === undefined
      ? "idle"
      : (health.find((entry) => entry.hostId === hostId)?.kind ?? "idle");
  const selectedHost = hosts.find((host) => host.hostId === hostId);
  const hostLabel = selectedHost?.label;
  const selectedOrigin = selectedHost?.origin;
  const supervisor = useMemo(
    () => (selectedOrigin === undefined ? undefined : hub.supervisorForOrigin(selectedOrigin)),
    [hub, selectedOrigin],
  );
  const connectionStatus = useConnectionStatus(supervisor);
  const staleGate = useMemo(() => presentStaleHostSecurity(hostHealth), [hostHealth]);
  const models = usePlacementHostModels(transport);
  // The page already ends above the bar, which the keyboard covers.
  const insets = useSafeAreaInsets();
  const { drafts, lastStanding: standingKept, noteStanding, projectName } = useMobileThreads();
  const draftKey =
    // With the computer's own key: another under its id starts from nothing.
    selected === undefined
      ? ""
      : `${selectedHost?.hostKeyFingerprint ?? ""}:${selected.hostId}:${selected.mode}:${selected.threadId}`;
  const [prompt, setPrompt] = useState(() => drafts.read(draftKey));
  // A send can land after this screen is gone, on the draft or on a later screen
  // of the same thread, so the words are cleared by what was sent.
  const sentPrompt = (next: string) => {
    if (next === "") drafts.sent(draftKey, prompt);
    else setPrompt(next);
  };
  useEffect(
    () =>
      drafts.onSent((thread, text) => {
        if (thread === draftKey) setPrompt((current) => (current === text ? "" : current));
      }),
    [draftKey, drafts],
  );
  useEffect(() => drafts.keep(draftKey, prompt), [draftKey, drafts, prompt]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [panesOpen, setPanesOpen] = useState(false);
  const [initialPane, setInitialPane] = useState<MobileThreadPaneId | undefined>();
  const openPanes = (pane: MobileThreadPaneId | undefined) => {
    setInitialPane(pane);
    setPanesOpen(true);
  };
  const [detailsOpen, setDetailsOpen] = useState(false);
  const listRef = useRef<LegendListRef>(null);
  const [surface, setSurface] = useState<RemoteThreadSurfaceKind>("chat");
  // The surfaces on offer come from the shared remote matrix, so a host that
  // would refuse one never has it shown here.
  const outbox = useOutbox();
  const whileHere = useWhileHere();
  const noteAnswered = useCallback(
    (answered: RemoteSessionStanding) => {
      if (hostId !== undefined) noteStanding(hostId, answered);
    },
    [hostId, noteStanding],
  );
  const standing = useRemoteSessionStanding(transport, offlineDemo, 0, noteAnswered);
  const watchingOnly = standing.accessLevel === "read-only";
  const surfaces = useMemo(
    () => listMobileThreadSurfaces({ mode: selected?.mode ?? "chat", session: standing }),
    [selected?.mode, standing],
  );
  const activeSurface = surfaces.some((entry) => entry.id === surface) ? surface : "chat";
  // A view can shrink to a small card over the conversation, so the person can
  // read the reply and watch the page at once; a view always opens full size.
  const [viewFloating, setViewFloating] = useState(false);
  const fullView = activeSurface !== "chat" && !viewFloating;
  const openSurface = (next: RemoteThreadSurfaceKind) => {
    setViewFloating(false);
    setSurface(next);
  };
  const browserReach = surfaces.find((entry) => entry.id === "browser")?.reach ?? "unavailable";

  const mode = selected?.mode;
  const threadId = selected?.threadId;
  const identity = hostId === undefined ? undefined : `${hostId}:${threadId}`;
  const guardRef = useRef(createSelectedThreadGuard());
  const guard = guardRef.current;
  guard.select(identity);
  const ui = useMemo<ThreadUi>(() => ({ setBusy, setError }), []);
  const targetFor = (wanted: ThreadTarget["mode"]) =>
    identity === undefined || hostId === undefined || threadId === undefined || mode !== wanted
      ? undefined
      : { identity, hostId, threadId, mode };
  const typedScope = `thread:${identity ?? "none"}`;
  const shared = (target: ThreadTarget | undefined): ThreadHookInput => ({
    transport,
    target,
    guard,
    ui,
    gate: staleGate,
    prompt,
    typedScope,
    setPrompt: sentPrompt,
  });

  const chat = useChatThread({ ...shared(targetFor("chat")), modelOptions: models.options });
  const work = useWorkThread(shared(targetFor("work")));
  const code = useCodeThread(shared(targetFor("code")), props.focusTurnId);
  // The Project the selected Work or Code thread belongs to, once it has loaded.
  const routinesProjectId =
    mode === "work"
      ? work.thread === undefined
        ? undefined
        : String(work.thread.projectId)
      : mode === "code"
        ? code.thread === undefined
          ? undefined
          : String(code.thread.projectId)
        : undefined;
  const refreshers = { chat: chat.refresh, work: work.refresh, code: code.refresh };
  const refreshSelected = refreshers[mode ?? "chat"];
  const refresh = useCallback(
    (options?: { readonly quiet?: boolean }) =>
      identity === undefined ? Promise.resolve() : refreshSelected(options),
    [identity, refreshSelected],
  );

  const [openTool, setOpenTool] = useState<ThreadTool>();
  const threadTools = listMobileThreadTools({
    mode: mode ?? "chat",
    actsAsHostPerson: standing.actsAsHostPerson,
    projectId: routinesProjectId,
  });

  useEffect(() => {
    setError(undefined);
    setBusy(false);
    setPanesOpen(false);
    setOpenTool(undefined);
  }, [identity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (identity === undefined) return;
    let previous = AppState.currentState ?? null;
    const subscription = AppState.addEventListener("change", (next) => {
      const returnedToForeground = enteredMobileForeground(previous, next);
      previous = next;
      if (returnedToForeground) {
        supervisor?.wake();
        void refresh({ quiet: true });
      }
    });
    return () => subscription.remove();
  }, [identity, refresh, supervisor]);

  // A Work or Code turn streams nowhere on the phone yet; while one is live the
  // durable transcript is re-read on a short cadence so the reply grows in
  // place, and the polling stops the moment the turn settles.
  const workTurnLive = work.live;
  const codeTurnLive = code.live;
  const codeRereads = code.rereads;
  useEffect(() => {
    if (mode === "chat" || (!workTurnLive && !codeRereads)) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh({ quiet: true });
    }, MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS);
    return () => clearInterval(timer);
  }, [codeRereads, mode, refresh, workTurnLive]);

  // A turn started on another device reaches a settled Code page no other
  // way, so the page takes one light look at the newest turn on the idle
  // cadence; a turn it does not show, even one that already finished,
  // refreshes it once, and for a running turn the re-reads above take over.
  const codeLooksForNewTurn = mode === "code" && code.looksForNewTurn;
  const noticeCodeTurn = code.noticeTurnStartedElsewhere;
  useEffect(() => {
    if (!codeLooksForNewTurn) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void noticeCodeTurn();
    }, MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS);
    return () => clearInterval(timer);
  }, [codeLooksForNewTurn, noticeCodeTurn]);

  const turnActions = useThreadTurnActions({
    transport,
    target:
      identity === undefined || hostId === undefined || threadId === undefined || mode === undefined
        ? undefined
        : { identity, hostId, threadId, mode },
    guard,
    ui,
    gate: staleGate,
    prompt,
    setPrompt,
    turnLive: chat.activeAttempt !== undefined || workTurnLive || codeTurnLive,
    refresh,
    onOpenThread: props.onOpenThread,
    chatThread: chat.view?.thread,
    workThread: work.thread,
    codeThread: code.thread,
  });

  const selectedModel = useMemo(
    () => models.options.find((option) => option.id === chat.modelOptionId),
    [chat.modelOptionId, models.options],
  );
  // What this thread may be sent, judged against the model its next turn runs
  // on: the host's own capability record, never a guess from the file.
  const attachmentModel =
    mode === "chat"
      ? (selectedModel ??
        (chat.view === undefined
          ? undefined
          : modelOptionForThread(models.options, chat.view.thread)))
      : mode === "work"
        ? work.thread === undefined
          ? undefined
          : modelOptionForThread(models.options, work.thread)
        : code.threadModel === undefined
          ? undefined
          : modelOptionForThread(models.options, code.threadModel);
  const attachmentOffer = mobileAttachmentOffer(mode ?? "chat", attachmentModel);
  const threadAttachments = mode === "work" ? work : mode === "code" ? code : chat;
  const pendingAttachments = threadAttachments.pendingAttachments;
  const attachFrom = (source: MobileAttachmentSource) => {
    if (offlineDemo || !composerAccess.editable) return;
    setAttachOpen(false);
    void threadAttachments.attach(source, attachmentOffer);
  };
  // A read-only pairing has no composer, so it has nothing to attach to either.
  const composerAccess = conversationComposerAccess(surfaces);
  const attachProps =
    !offlineDemo &&
    composerAccess.editable &&
    staleGate.allowProductMutations &&
    attachmentOffer.sources.length > 0
      ? { onPressAttach: () => setAttachOpen(true) }
      : {};
  // Only a computer that cannot be reached right now is written to for later;
  // one that rejected this phone, or that the phone may only watch, is not.
  // Which of the two it is, is what that computer last said of this session.
  const lastStanding = hostId === undefined ? undefined : standingKept(hostId);
  const unreached =
    !offlineDemo &&
    lastStanding !== undefined &&
    conversationComposerAccess(
      listMobileThreadSurfaces({ mode: mode ?? "chat", session: lastStanding }),
    ).editable &&
    ["idle", "connecting", "stale", "unavailable"].includes(hostHealth);
  const waiting =
    selected === undefined
      ? []
      : outbox.waitingFor({
          hostId: selected.hostId,
          mode: selected.mode,
          threadId: selected.threadId,
        });
  const keepForLater = (text: string, typedByPerson: boolean, unansweredId?: string): boolean => {
    if (selected === undefined) return false;
    const refused = outbox.keep({
      id: unansweredId ?? globalThis.crypto.randomUUID(),
      hostId: selected.hostId,
      mode: selected.mode,
      threadId: selected.threadId,
      text,
      writtenAt: new Date().toISOString(),
      ...(unansweredId === undefined ? {} : { attempted: true }),
      ...(typedByPerson ? { typedByPerson: true } : {}),
    });
    if (refused !== undefined && refused !== "") ui.setError(refused);
    return refused === undefined;
  };
  // Files stay with the draft: they go through the computer as they are added.
  const sendLater = () => {
    const keepIt = () => {
      const typed = typedClaimFor(typedScope, prompt).typedByPerson === true;
      if (keepForLater(prompt.trim(), typed, isUnanswered ? unanswered?.id : undefined)) {
        drafts.noteUnanswered(draftKey, undefined);
        drafts.noteMayBeSent(draftKey, undefined);
        sentPrompt("");
      }
    };
    if (pendingAttachments.length > 0) ui.setError(MOBILE_COPY.outboxNoFiles);
    else if (isUnanswered) keepIt();
    else unlessMayBeSent(keepIt);
  };
  // Words that a failed send may have delivered are not queued as new ones
  // without the person: the queue would deliver them a second time.
  const unlessMayBeSent = (send: () => void) => {
    if (drafts.mayBeSent(draftKey) !== prompt.trim()) {
      send();
      return;
    }
    Alert.alert(MOBILE_COPY.outboxMayBeSentTitle, MOBILE_COPY.outboxMayBeSentBody, [
      { text: "Cancel", style: "cancel" },
      { text: MOBILE_COPY.outboxSendAnyway, onPress: whileHere(send) },
    ]);
  };
  const sendNow = (send: () => Promise<unknown>) =>
    unlessMayBeSent(() => {
      const text = prompt;
      // Noted before it leaves, for a screen that is gone when the answer comes.
      drafts.noteMayBeSent(draftKey, text);
      void send().then((outcome) => {
        if (outcome !== "failed" && outcome !== "stale") drafts.noteMayBeSent(draftKey, undefined);
      });
    });
  // Words whose answer is still out are the same message, so they go the same
  // way, under the same id, whether or not a turn runs now.
  const unanswered = drafts.unanswered(draftKey);
  const isUnanswered =
    unanswered?.words ===
    JSON.stringify([prompt.trim(), pendingAttachments.map((attachment) => attachment.id)]);
  const queueNow = () => {
    // A queued Chat message runs on the thread's model as it is then; a model
    // or setting chosen since goes only with a message sent once the turn ends.
    if (mode === "chat" && chat.choiceWaits) {
      ui.setError(MOBILE_COPY.queueKeepsThreadModel);
      return;
    }
    // The claim is of the words pressed Send on, read before anything is awaited.
    const typed = typedClaimFor(typedScope, prompt).typedByPerson === true;
    if (isUnanswered) void turnControl.queueMessage(typed);
    else unlessMayBeSent(() => void turnControl.queueMessage(typed));
  };
  const runningWorkTurn = workTurnLive
    ? work.turns?.findLast((turn) => isLiveWorkTurn(turn))
    : undefined;
  const runningCodeTurn = codeTurnLive
    ? code.turns?.findLast((turn) => turn.status === "waiting")
    : undefined;
  const mayAct = !offlineDemo && composerAccess.editable && staleGate.allowProductMutations;
  const turnLive = chat.activeAttempt !== undefined || workTurnLive || codeTurnLive;
  const turnControl = useTurnControl({
    ...shared(
      identity === undefined ||
        offlineDemo ||
        hostId === undefined ||
        threadId === undefined ||
        mode === undefined
        ? undefined
        : { identity, hostId, threadId, mode },
    ),
    live: turnLive,
    stopTurn:
      !mayAct || transport === undefined
        ? undefined
        : runningWorkTurn !== undefined
          ? () =>
              stopMobileWorkTurn({
                transport,
                threadId: String(runningWorkTurn.threadId),
                turnId: String(runningWorkTurn.turnId),
                requestId: String(runningWorkTurn.requestId),
              })
          : runningCodeTurn !== undefined && code.thread !== undefined
            ? () =>
                stopMobileCodeTurn({
                  transport,
                  threadId: String(code.thread?.id),
                  checkoutId: String(code.thread?.checkoutId),
                  turnOperationId: runningCodeTurn.operationId,
                })
            : undefined,
    attachmentIds: pendingAttachments.map((attachment) => attachment.id),
    onQueued: () => threadAttachments.attachmentsSent(),
    onStopped: () => void refresh({ quiet: true }),
    unanswered: drafts.unanswered(draftKey),
    // The words too: without the queue, or with the files a reopened screen no
    // longer has, they would otherwise go another way as a new message.
    noteUnanswered: (message) => {
      drafts.noteUnanswered(draftKey, message);
      drafts.noteMayBeSent(draftKey, message === undefined ? undefined : prompt);
    },
    onUnanswered: ({ id, text, typedByPerson }) => keepForLater(text, typedByPerson, id),
  });
  // Where the queue cannot be read, a running turn still closes the composer.
  const queues = mayAct && turnLive && turnControl.queue !== undefined;
  const mayQueue = queues || (isUnanswered && turnControl.queue !== undefined);
  const subagents = runningWorkTurn === undefined ? [] : turnSubagents(runningWorkTurn);
  const subagentsWorking = subagents.filter((agent) => agent.working).length;
  const threadAgents = useThreadSubagents({
    transport,
    threadId: selected?.threadId,
    mode: selected?.mode,
    turnLive,
  });
  const [agentsOpen, setAgentsOpen] = useState(false);
  const threadHint = mode === "code" || mode === "work" ? mobileThreadHint(mode) : undefined;
  const sendFollowUp = () => void sendNow(() => (mode === "work" ? work : code).sendFollowUp());
  const runningChatTurn = chat.view?.turns.at(-1);
  const liveBusy = busy || chat.activeAttempt !== undefined;
  const [resumeBusy, setResumeBusy] = useState(false);
  const resetLabel = (resetsAt: string | undefined) =>
    resetsAt === undefined
      ? undefined
      : `Resets ${new Date(resetsAt).toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })}`;
  const usageResume = async (
    mode: "work" | "code",
    thread: { readonly id: unknown; readonly version: number },
    action: { readonly kind: "schedule"; readonly turnId: string } | { readonly kind: "cancel" },
  ) => {
    if (transport === undefined) return;
    setResumeBusy(true);
    try {
      const result = await setMobileUsageResume({
        transport,
        row: { mode, threadId: String(thread.id), version: thread.version },
        action,
      });
      if (result.status === "refused") setError(result.message);
      await (mode === "work" ? work.refresh({ quiet: true }) : code.refresh({ quiet: true }));
    } catch {
      setError("The host could not be reached. Nothing changed.");
    } finally {
      setResumeBusy(false);
    }
  };
  // A turn the provider stopped at a usage limit still holds the thread, as on
  // the desktop, but nothing runs until the limit resets, so the composer must
  // not say the computer is working.
  const latestTurnAtUsageLimit =
    selected?.mode === "work"
      ? work.turns?.at(-1)?.status === "waiting" &&
        work.turns.at(-1)?.failure?.usageLimit !== undefined
      : selected?.mode === "code"
        ? code.conversation?.hasLater === false &&
          code.conversation.turns.at(-1)?.usageLimit !== undefined
        : false;
  // Only over an empty composer: a draft the person is writing is the next turn.
  const resumeOffer: ResumeOffer | undefined = (() => {
    if (prompt.trim().length > 0 || !staleGate.allowProductMutations || offlineDemo)
      return undefined;
    if (selected?.mode === "chat") {
      const stopped = chat.retryableAttempt;
      if (stopped === undefined || chat.activeAttempt !== undefined) return undefined;
      const interrupted = stopped.outcome === "interrupted";
      return {
        label: interrupted ? "This turn was interrupted." : "This turn failed.",
        actionLabel: interrupted ? "Resume" : "Retry",
        onPress: () => void chat.retry(),
      };
    }
    const thread =
      selected?.mode === "work" ? work.thread : selected?.mode === "code" ? code.thread : undefined;
    const mode = selected?.mode === "work" ? "work" : "code";
    if (thread === undefined) return undefined;
    if (thread.usageResume?.status === "scheduled") {
      const detail = resetLabel(thread.usageResume.record.usageLimit.resetsAt);
      return {
        label: "Resume scheduled",
        ...(detail === undefined ? {} : { detail }),
        actionLabel: "Cancel",
        onPress: () => void usageResume(mode, thread, { kind: "cancel" }),
      };
    }
    // A turn knows it stopped at a usage limit from the turn itself. Only the
    // thread's latest turn can resume, so an earlier page a search hit opened
    // offers nothing; the host re-checks the whole premise either way.
    const stopped = (() => {
      if (selected?.mode === "work") {
        const last = work.turns?.at(-1);
        const limit = last?.failure?.usageLimit;
        return last === undefined || limit === undefined || last.status !== "waiting"
          ? undefined
          : { turnId: String(last.turnId), limit };
      }
      if (code.conversation?.hasLater !== false) return undefined;
      const last = code.conversation.turns.at(-1);
      return last?.usageLimit === undefined
        ? undefined
        : { turnId: last.operationId, limit: last.usageLimit };
    })();
    if (stopped === undefined) return undefined;
    const detail = resetLabel(stopped.limit.resetsAt);
    return {
      label: "Usage limit reached",
      ...(detail === undefined ? {} : { detail }),
      actionLabel: "Resume when it resets",
      onPress: () => void usageResume(mode, thread, { kind: "schedule", turnId: stopped.turnId }),
    };
  })();
  const composerEditable =
    unreached ||
    (composerAccess.editable &&
      (mode === "chat"
        ? staleGate.allowProductMutations && (chat.activeAttempt === undefined || queues)
        : staleGate.allowProductMutations &&
          ((!workTurnLive && !codeTurnLive) || queues) &&
          (mode === "code" || work.thread !== undefined)));
  const appendToDraft = useCallback(
    (text: string) => setPrompt((draft) => appendTranscript(typedScope, draft, text)),
    [typedScope],
  );
  const voice = useVoiceDictation({
    transport: offlineDemo ? undefined : transport,
    editable: composerEditable,
    appendToDraft,
  });
  const replyDetail = useThreadReplyDetail({ transport, mode, threadId });

  const transcriptRows = useThreadTranscriptRows({
    ...(props.focusTurnId === undefined ? {} : { focus: { turnId: props.focusTurnId } }),
    allowProductMutations: staleGate.allowProductMutations,
    chat,
    codeConversation: code.conversation,
    modelOptions: models.options,
    providerDirectory: models.providerDirectory,
    ...(offlineDemo || transport === undefined || selected?.mode !== "code"
      ? {}
      : { onOpenReview: () => openPanes("review") }),
    replyDetail,
    turnActionsFor: turnActions.actionsFor,
    workTurns: work.turns,
  });
  // A search hit lands on its turn once that turn has been read.
  const focusIndex = transcriptRows.findIndex((row) => row.focused);
  const landed = useRef<string | undefined>(undefined);
  // The thread opened again from its row after a search hit, in the same
  // screen (an iPad's column): once the newest page is in, the reader is
  // taken to its end, as a freshly opened thread starts there.
  const lastFocus = useRef(props.focusTurnId);
  const toNewest = useRef(false);
  useEffect(() => {
    const reopened = lastFocus.current !== undefined && props.focusTurnId === undefined;
    lastFocus.current = props.focusTurnId;
    if (!reopened) return;
    // The same hit tapped again later jumps to it again.
    landed.current = undefined;
    // Chat and Work show their whole conversation, so they go to its end at
    // once; a Code thread waits for its newest page below.
    if (mode === "code") toNewest.current = true;
    else void listRef.current?.scrollToEnd({ animated: false });
  }, [mode, props.focusTurnId]);
  const shownPage = code.conversation;
  useEffect(() => {
    if (!toNewest.current || shownPage === undefined || shownPage.hasLater) return;
    toNewest.current = false;
    void listRef.current?.scrollToEnd({ animated: false });
  }, [shownPage]);
  // A search hit opened in this screen is in the conversation, so a full
  // view (the Browser) gives way to it.
  useEffect(() => {
    if (props.focusTurnId === undefined) return;
    setViewFloating(false);
    setSurface("chat");
  }, [props.focusTurnId]);
  useEffect(() => {
    if (focusIndex < 0 || props.focusTurnId === undefined) return;
    if (landed.current === props.focusTurnId) return;
    landed.current = props.focusTurnId;
    void listRef.current?.scrollToIndex({ index: focusIndex, viewOffset: 12, animated: true });
  }, [focusIndex, props.focusTurnId]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        scroll: { flex: 1 },
        details: {
          gap: mobileSpacing.md,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.xl,
        },
        // Left and right, not horizontal: the list's browser build passes
        // this style to the page as it is.
        content: {
          paddingLeft: mobileSpacing.md,
          paddingRight: mobileSpacing.md,
          paddingBottom: mobileSpacing.xl,
          gap: mobileSpacing.sm,
          flexGrow: 1,
          maxWidth: 720,
          width: "100%",
          alignSelf: "center",
        },
        help: {
          color: colors.textSecondary,
          paddingHorizontal: mobileSpacing.md,
          lineHeight: 20,
        },
        error: { color: colors.danger },
        connectionStatus: {
          color: colors.textSecondary,
          fontSize: 12,
          lineHeight: 16,
        },
        pendingWrap: {
          gap: mobileSpacing.xs,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.xs,
        },
        pendingChip: {
          color: colors.textSecondary,
          fontSize: 12,
        },
        viewBar: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.xs,
        },
        viewReturn: {
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          minHeight: 30,
          paddingLeft: 6,
          paddingRight: 10,
          borderRadius: 15,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        viewReturnLabel: { color: colors.accent, fontSize: 13, fontWeight: "500" },
        viewName: { flex: 1, color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
        viewFloat: { padding: 4 },
        stage: { flex: 1 },
        listEnds: { gap: mobileSpacing.sm },
        floatingView: {
          position: "absolute",
          top: mobileSpacing.sm,
          right: mobileSpacing.md,
          width: 148,
          borderRadius: 12,
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStrokeStrong,
          // Solid, not glass: the card sits over transcript text, and a see-through
          // fill let that text show through the page picture and its label.
          backgroundColor: colors.surfaceElevatedSolid,
          shadowColor: colors.shadow,
          shadowOpacity: 0.25,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
          elevation: 6,
        },
        floatingHeader: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 8,
          paddingVertical: 5,
        },
        floatingLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "500" },
      }),
    [colors],
  );

  if (selected === undefined) {
    return (
      <View style={styles.shell}>
        <ScreenHeader title={MOBILE_SCREEN_TITLES.thread} />
        <Text style={styles.help}>{MOBILE_COPY.threadEmpty}</Text>
      </View>
    );
  }

  const title = formatScreenshotSafeLabel(selected.title);
  const projectLabel = projectName(selected);
  const project = projectLabel === undefined ? undefined : formatScreenshotSafeLabel(projectLabel);
  const effortLabel = chosenReasoningLabel(selectedModel?.settings, chat.modelOptionValues);
  const modelLabel =
    selectedModel === undefined
      ? chat.view !== undefined
        ? mobileModelLabel(models.options, String(chat.view.thread.modelId))
        : MOBILE_COPY.modelHostOnly
      : effortLabel === undefined
        ? selectedModel.label
        : `${selectedModel.label} · ${effortLabel}`;
  const codePolicy = code.policy;
  // The mode the next turn runs under, named where the turn is written. A
  // restricted session is shown no mode, as the panel itself shows it none.
  const levelSubject =
    selected.mode === "code" && code.thread !== undefined
      ? ({ mode: "code", thread: code.thread } as const)
      : selected.mode === "work" && work.thread !== undefined
        ? ({ mode: "work", thread: work.thread } as const)
        : undefined;
  const levelLabel =
    levelSubject === undefined || offlineDemo || !standing.actsAsHostPerson
      ? undefined
      : MOBILE_THREAD_LEVEL_LABELS[mobileThreadLevel(levelSubject)];

  return (
    <KeyboardRoom leaves={insets.bottom} style={styles.shell} testID="mobile-thread-screen">
      <ScreenHeader
        actions={
          offlineDemo || transport === undefined
            ? []
            : [
                ...(threadTools.includes("terminal")
                  ? [
                      {
                        label: MOBILE_COPY.projectTerminalTitle,
                        icon: "terminal-outline" as const,
                        onPress: () => setOpenTool("terminal"),
                        testID: "mobile-thread-terminal-open",
                      },
                    ]
                  : []),
                ...(selected.mode === "code" && selected.pullRequests !== undefined
                  ? [
                      {
                        label: `${MOBILE_COPY.threadPullRequest}: ${threadPullRequestStatus(selected.pullRequests)}`,
                        icon: "git-pull-request-outline" as const,
                        onPress: () => setDetailsOpen(true),
                        testID: "mobile-thread-pull-request-open",
                      },
                    ]
                  : []),
                ...(selected.mode === "code"
                  ? [
                      {
                        label: MOBILE_COPY.threadChanges,
                        icon: "git-branch-outline" as const,
                        onPress: () => openPanes("review"),
                        testID: "mobile-thread-changes-open",
                      },
                    ]
                  : []),
                {
                  label: MOBILE_COPY.threadDetails,
                  icon: "ellipsis-horizontal",
                  onPress: () => setDetailsOpen(true),
                  testID: "mobile-thread-details-open",
                },
              ]
        }
        subtitle={[
          project,
          hostLabel,
          selected.pullRequests === undefined
            ? undefined
            : threadPullRequestStatus(selected.pullRequests),
        ]
          .filter((part) => part !== undefined)
          .join(" · ")}
        title={title}
      />

      {/* A view replaces the transcript, so while one is open a single chip
          leads back; the views themselves are chosen in the views and panes
          sheet rather than from a tab row every thread would pay for. */}
      {!fullView ? null : (
        <View style={styles.viewBar} testID="mobile-thread-view-bar">
          <Pressable
            accessibilityLabel="Back to the conversation"
            accessibilityRole="button"
            onPress={() => openSurface("chat")}
            style={({ pressed }) => [styles.viewReturn, pressed ? { opacity: 0.6 } : null]}
            testID="mobile-thread-view-return"
          >
            <Icon color={colors.accent} name="chevron-back" size={15} />
            <Text style={styles.viewReturnLabel}>{MOBILE_COPY.threadViewReturn}</Text>
          </Pressable>
          <Text numberOfLines={1} style={styles.viewName}>
            {surfaces.find((entry) => entry.id === activeSurface)?.label ?? ""}
          </Text>
          <Pressable
            accessibilityLabel="Keep it small over the conversation"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setViewFloating(true)}
            style={({ pressed }) => [styles.viewFloat, pressed ? { opacity: 0.6 } : null]}
            testID="mobile-thread-view-float"
          >
            <Icon color={colors.accent} name="contract-outline" size={17} />
          </Pressable>
        </View>
      )}

      <View style={styles.stage}>
        <LegendList
          ref={listRef}
          contentContainerStyle={styles.content}
          data={fullView ? [] : transcriptRows}
          estimatedItemSize={160}
          // A thread opens on its newest turn and stays there as it grows,
          // until the person scrolls up to read or a search names a turn.
          initialScrollAtEnd={props.focusTurnId === undefined}
          keyExtractor={(row) => row.key}
          ListFooterComponent={
            fullView ? null : (
              <View style={styles.listEnds}>
                <WaitingMessages
                  unsaved={outbox.unsaved}
                  messages={waiting}
                  onDelete={(message) =>
                    message.attempted === true
                      ? Alert.alert(MOBILE_COPY.outboxDeleteTitle, MOBILE_COPY.outboxDeleteSent, [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: MOBILE_COPY.outboxDelete,
                            style: "destructive",
                            onPress: whileHere(() => outbox.remove(message.id)),
                          },
                        ])
                      : outbox.remove(message.id)
                  }
                  onEdit={(message) => {
                    outbox.remove(message.id);
                    setPrompt((draft) =>
                      draft.trim().length === 0 ? message.text : `${message.text}\n\n${draft}`,
                    );
                  }}
                  onTryAgain={outbox.tryAgain}
                />
                {!offlineDemo &&
                Platform.OS !== "web" &&
                selectedHost !== undefined &&
                hostHealth !== "unauthorized" ? (
                  <ThreadVideoClips
                    key={`${selected.hostId}:${selectedHost.credentialGeneration}:${selected.mode}:${selected.threadId}`}
                    hostId={selected.hostId}
                    threadId={selected.threadId}
                    threadKind={`${selected.mode}-thread`}
                    transport={hostHealth === "ready" ? transport : undefined}
                  />
                ) : null}
                {/* What waits on the person comes last, beside the composer. */}
                {offlineDemo || transport === undefined ? null : (
                  <BrowserApprovalCard
                    actsAsHostPerson={standing.actsAsHostPerson}
                    threadId={selected.threadId}
                    threadTitle={title}
                    transport={transport}
                    watchingOnly={watchingOnly}
                  />
                )}
                {offlineDemo || transport === undefined ? null : (
                  <ExtensionToolApprovalCard
                    actsAsHostPerson={standing.actsAsHostPerson}
                    threadId={selected.threadId}
                    transport={transport}
                    watchingOnly={watchingOnly}
                  />
                )}
                {offlineDemo ||
                transport === undefined ||
                !standing.actsAsHostPerson ||
                selected.mode === "chat" ? null : (
                  <ThreadSecretCards
                    key={`secrets:${selected.hostId}:${selected.threadId}`}
                    threadId={selected.threadId}
                    transport={transport}
                  />
                )}
                {offlineDemo || transport === undefined ? null : (
                  <>
                    <MemoryProposalCard
                      key={`memory:${selected.hostId}:${selected.threadId}`}
                      actsAsHostPerson={standing.actsAsHostPerson}
                      threadId={selected.threadId}
                      transport={transport}
                    />
                    <RoutineProposalCard
                      key={`routine:${selected.hostId}:${selected.threadId}`}
                      actsAsHostPerson={standing.actsAsHostPerson}
                      threadId={selected.threadId}
                      transport={transport}
                    />
                  </>
                )}
                {offlineDemo || transport === undefined ? null : (
                  <NativeHarnessSessionPanel
                    threadId={selected.threadId}
                    transport={transport}
                    watchingOnly={watchingOnly}
                  />
                )}
                {offlineDemo || transport === undefined || !standing.actsAsHostPerson ? null : (
                  <ServiceOfferCard
                    key={`${selected.hostId}:${selected.mode}:${selected.threadId}`}
                    inProject={selected.projectId !== undefined}
                    threadId={selected.threadId}
                    threadKind={`${selected.mode}-thread`}
                    transport={transport}
                  />
                )}
                {offlineDemo ||
                transport === undefined ||
                selected.mode !== "work" ||
                work.thread === undefined ? null : (
                  <WorkRequestCards
                    projectId={String(work.thread.projectId)}
                    threadId={String(work.thread.id)}
                    transport={transport}
                    watchingOnly={watchingOnly}
                  />
                )}
                {!offlineDemo &&
                selected.mode === "code" &&
                transport !== undefined &&
                code.thread !== undefined ? (
                  <CoordinatorProposalsPanel
                    actsAsHostPerson={standing.actsAsHostPerson}
                    thread={code.thread}
                    transport={transport}
                  />
                ) : null}
                {busy && chat.activeAttempt === undefined ? (
                  <ActivityIndicator color={colors.accent} />
                ) : null}
                {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
                {turnActions.notice !== undefined ? (
                  <Text style={styles.connectionStatus} testID="mobile-thread-notice">
                    {turnActions.notice}
                  </Text>
                ) : null}
              </View>
            )
          }
          ListHeaderComponent={
            <View style={styles.listEnds}>
              {connectionStatus.kind === "waiting-to-retry" || chat.reconnecting ? (
                <Text style={styles.connectionStatus}>{RECONNECTING_COPY}</Text>
              ) : connectionStatus.kind === "offline" ? (
                <Text style={styles.connectionStatus}>Waiting for the network.</Text>
              ) : null}
              {/* Above the full Browser view too: handing a page back there
                  answers no prompt, so its Continue has to be in reach. */}
              {!offlineDemo &&
              fullView &&
              activeSurface === "browser" &&
              transport !== undefined ? (
                <BrowserApprovalCard
                  actsAsHostPerson={standing.actsAsHostPerson}
                  threadId={selected.threadId}
                  threadTitle={title}
                  transport={transport}
                  watchingOnly={watchingOnly}
                />
              ) : null}
              {!offlineDemo &&
              fullView &&
              activeSurface === "browser" &&
              transport !== undefined ? (
                <BrowserSurfacePanel
                  actsAsHostPerson={standing.actsAsHostPerson}
                  mode={selected.mode}
                  reach={browserReach}
                  threadId={selected.threadId}
                  transport={transport}
                />
              ) : null}
            </View>
          }
          maintainScrollAtEnd={props.focusTurnId === undefined}
          recycleItems={false}
          renderItem={({ item }) => item.node}
          style={styles.scroll}
          {...(Platform.OS === "web"
            ? {}
            : { keyboardShouldPersistTaps: "handled", testID: "mobile-thread-transcript" })}
        />
        {viewFloating && activeSurface === "browser" && !offlineDemo && transport !== undefined ? (
          <View style={styles.floatingView} testID="mobile-thread-view-floating">
            <View style={styles.floatingHeader}>
              <Text style={styles.floatingLabel}>
                {surfaces.find((entry) => entry.id === activeSurface)?.label ?? ""}
              </Text>
              <Pressable
                accessibilityLabel="Close the browser"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => openSurface("chat")}
                testID="mobile-thread-view-floating-close"
              >
                <Icon color={colors.textSecondary} name="close" size={15} />
              </Pressable>
            </View>
            <BrowserSurfacePanel
              actsAsHostPerson={standing.actsAsHostPerson}
              compact={{ onExpand: () => setViewFloating(false) }}
              mode={selected.mode}
              reach={browserReach}
              threadId={selected.threadId}
              transport={transport}
            />
          </View>
        ) : null}
      </View>

      {pendingAttachments.length > 0 ? (
        <View style={styles.pendingWrap} testID="mobile-thread-pending-attachments">
          {pendingAttachments.map((attachment) => (
            <Text key={attachment.id} style={styles.pendingChip}>
              {MOBILE_COPY.attachPending}: {attachment.displayName}
            </Text>
          ))}
        </View>
      ) : null}
      {selected.mode === "code" && code.conversation?.hasLater === true ? (
        <ResumeBar
          busy={false}
          offer={{
            label: MOBILE_COPY.threadEarlierPage,
            actionLabel: MOBILE_COPY.threadJumpToLatest,
            onPress: () => void code.jumpToLatest(),
          }}
        />
      ) : null}
      {turnControl.queue === undefined ? null : (
        <QueuedMessages
          actions={
            mayAct
              ? {
                  onEdit: turnControl.editQueued,
                  onRemove: (messageId) => void turnControl.removeQueued(messageId),
                  onSendNow: (messageId) => void turnControl.sendQueuedNow(messageId),
                }
              : undefined
          }
          changing={turnControl.pending}
          queue={turnControl.queue}
        />
      )}
      {resumeOffer === undefined ? null : <ResumeBar busy={resumeBusy} offer={resumeOffer} />}
      <SubagentsPill
        liveTasks={threadAgents.liveTasks}
        onPress={() => setAgentsOpen(true)}
        subagents={threadAgents.subagents}
      />
      <SubagentsSheet
        liveTasks={threadAgents.liveTasks}
        onClose={() => setAgentsOpen(false)}
        providerDirectory={models.providerDirectory}
        subagents={threadAgents.subagents}
        visible={agentsOpen}
        {...(mayAct && transport !== undefined
          ? {
              onStop: async (subagent) => {
                const stop = await stopMobileSubagent({
                  transport,
                  threadId: selected.threadId,
                  subagent,
                });
                threadAgents.refresh();
                return stop.status === "refused" ? stop.message : undefined;
              },
              ...(selected.mode === "chat"
                ? {}
                : {
                    onStopLiveTasks: async () => {
                      const stop = await stopMobileLiveTasks({
                        transport,
                        mode: selected.mode === "code" ? "code" : "work",
                        threadId: selected.threadId,
                      });
                      threadAgents.refresh();
                      return stop.status === "refused" ? stop.message : undefined;
                    },
                  }),
            }
          : {})}
      />
      {selected.mode === "chat" ? (
        <>
          <FloatingComposer
            busy={!unreached && liveBusy}
            busyLabel={
              chat.activeAttempt !== undefined
                ? chatAttemptStatusLabel(chat.activeAttempt.outcome)
                : MOBILE_COPY.working
            }
            busySince={chat.activeAttempt === undefined ? undefined : runningChatTurn?.createdAt}
            editable={composerEditable}
            footerHint={unreached ? undefined : composerAccess.reason}
            modelDriverKind={selectedModel?.driverKind}
            modelLabel={modelLabel}
            onChangeText={setPrompt}
            onPressModel={() => setModelOpen(true)}
            slashCommands={attachmentModel?.commands}
            slashProviderLabel={attachmentModel?.detail}
            onSubmit={() =>
              unreached ? sendLater() : void (mayQueue ? queueNow() : sendNow(chat.send))
            }
            queues={queues}
            sending={turnControl.pending}
            {...(chat.activeAttempt === undefined ? attachProps : {})}
            {...(chat.activeAttempt !== undefined && staleGate.allowProductMutations
              ? { onStop: () => void chat.stop() }
              : {})}
            placeholder={unreached ? MOBILE_COPY.outboxComposer : MOBILE_COPY.composerFollowUp}
            testID="mobile-thread-composer"
            typedScope={typedScope}
            value={prompt}
            voice={voice}
          />
        </>
      ) : (
        <FloatingComposer
          busy={!unreached && (busy || workTurnLive || codeTurnLive)}
          busyLabel={
            !busy && latestTurnAtUsageLimit
              ? MOBILE_COPY.turnWaitingOnUsageLimit
              : subagentsWorking > 0
                ? MOBILE_COPY.waitingOnSubagents(subagentsWorking)
                : MOBILE_COPY.working
          }
          busySince={runningWorkTurn?.acceptedAt ?? runningCodeTurn?.startedAt}
          editable={composerEditable}
          footerHint={unreached ? undefined : composerAccess.reason}
          {...(levelLabel === undefined
            ? {}
            : { modelLabel: levelLabel, onPressModel: () => setDetailsOpen(true) })}
          onChangeText={setPrompt}
          slashCommands={attachmentModel?.commands}
          slashProviderLabel={attachmentModel?.detail}
          onSubmit={unreached ? sendLater : mayQueue ? queueNow : sendFollowUp}
          queues={queues}
          sending={turnControl.pending}
          {...(turnControl.stop === undefined ? {} : { onStop: () => void turnControl.stop?.() })}
          {...(workTurnLive || codeTurnLive ? {} : attachProps)}
          placeholder={unreached ? MOBILE_COPY.outboxComposer : MOBILE_COPY.composerFollowUp}
          testID="mobile-thread-composer"
          typedScope={typedScope}
          value={prompt}
          voice={voice}
        />
      )}
      <BottomSheet
        onClose={() => setDetailsOpen(false)}
        testID="mobile-thread-details"
        title={MOBILE_COPY.threadDetails}
        visible={detailsOpen}
      >
        <ScrollView contentContainerStyle={styles.details}>
          {offlineDemo || transport === undefined ? null : (
            <ListSection>
              <ListRow
                accessory="chevron"
                icon="grid-outline"
                label={MOBILE_COPY.threadViewsAndPanes}
                last
                onPress={() => {
                  setDetailsOpen(false);
                  openPanes(undefined);
                }}
                testID="mobile-thread-panes-open"
              />
            </ListSection>
          )}
          {threadHint === undefined ? null : (
            <Text style={styles.connectionStatus}>{threadHint}</Text>
          )}
          {offlineDemo || transport === undefined ? null : selected.mode === "code" &&
            code.thread !== undefined ? (
            <ThreadLevelPanel
              actsAsHostPerson={standing.actsAsHostPerson}
              warnings={fullAccessWarnings}
              onChanged={() => void code.refresh({ quiet: true })}
              subject={{ mode: "code", thread: code.thread }}
              transport={transport}
            />
          ) : selected.mode === "work" && work.thread !== undefined ? (
            <ThreadLevelPanel
              actsAsHostPerson={standing.actsAsHostPerson}
              warnings={fullAccessWarnings}
              onChanged={() => void work.refresh({ quiet: true })}
              subject={{ mode: "work", thread: work.thread }}
              transport={transport}
            />
          ) : null}
          {!offlineDemo &&
          transport !== undefined &&
          (selected.mode === "work" || selected.mode === "code") &&
          routinesProjectId !== undefined ? (
            <DefaultLevelsPanel
              actsAsHostPerson={standing.actsAsHostPerson}
              warnings={fullAccessWarnings}
              mode={selected.mode}
              projectId={routinesProjectId}
              transport={transport}
            />
          ) : null}
          {!offlineDemo &&
          selected.mode === "code" &&
          (codePolicy === "approval-gated" || codePolicy === "auto-accept-edits") ? (
            <ApprovalDeferralSheet
              executionPolicy={codePolicy}
              mode="code"
              operationSummary="Approval-gated Code operations"
              threadTitle={title}
              {...(hostLabel === undefined ? {} : { hostLabel })}
            />
          ) : null}
          {!offlineDemo && selected.mode === "code" && transport !== undefined ? (
            <PullRequestReviewPanel threadId={selected.threadId} transport={transport} />
          ) : null}
          {!offlineDemo &&
          transport !== undefined &&
          (selected.mode === "work" || selected.mode === "code") &&
          routinesProjectId !== undefined ? (
            <ThreadRoutinesPanel
              mode={selected.mode}
              projectId={routinesProjectId}
              threadId={selected.threadId}
              transport={transport}
            />
          ) : null}
        </ScrollView>
      </BottomSheet>
      {offlineDemo || transport === undefined ? null : (
        <ThreadPanesSheet
          codeThread={selected.mode === "code" ? code.thread : undefined}
          initialPane={initialPane}
          mode={selected.mode}
          onClose={() => setPanesOpen(false)}
          onOpenView={(view) => {
            openSurface(view);
            setPanesOpen(false);
          }}
          onOpenTool={(tool) => {
            setPanesOpen(false);
            setOpenTool(tool);
          }}
          tools={threadTools}
          views={surfaces.filter((entry) => entry.id !== "chat")}
          threadId={selected.threadId}
          transport={transport}
          visible={panesOpen}
        />
      )}
      {offlineDemo || transport === undefined ? null : selected.mode === "chat" ? (
        <CanvasHtmlImportSheet
          onClose={() => setOpenTool(undefined)}
          projectId={
            chat.view?.thread.projectId === undefined
              ? undefined
              : String(chat.view.thread.projectId)
          }
          threadId={selected.threadId}
          transport={transport}
          visible={openTool === "import-html"}
        />
      ) : routinesProjectId === undefined ? null : (
        <>
          <ProjectTerminalSheet
            onClose={() => setOpenTool(undefined)}
            projectId={routinesProjectId}
            transport={transport}
            visible={openTool === "terminal"}
          />
          <ProjectPageSheet
            onClose={() => setOpenTool(undefined)}
            projectId={routinesProjectId}
            transport={transport}
            visible={openTool === "page"}
          />
        </>
      )}
      <RewindSheet {...turnActions.sheet} />
      <AttachSourceSheet
        onClose={() => setAttachOpen(false)}
        onSelect={attachFrom}
        sources={attachmentOffer.sources}
        visible={attachOpen}
      />
      <ModelPickerSheet
        onClose={() => setModelOpen(false)}
        onChangeValue={chat.setModelOptionValue}
        onSelect={(id) => {
          chat.setModelOptionId(id);
          // A model with settings keeps the sheet open so they can be set.
          if (
            selectableModelSettings(models.options.find((option) => option.id === id)?.settings)
              .length === 0
          ) {
            setModelOpen(false);
          }
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={chat.modelOptionId}
        settings={models.options.find((option) => option.id === chat.modelOptionId)?.settings}
        values={chat.modelOptionValues}
        visible={modelOpen}
      />
    </KeyboardRoom>
  );
}
