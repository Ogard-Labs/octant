import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  chatAttemptStatusLabel,
  mobileAttachmentOffer,
  readRemoteSessionStanding,
  setMobileUsageResume,
  RESTRICTED_REMOTE_SESSION,
  type MobileAttachmentSource,
  type MobileInboxRow,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { useConnectionStatus } from "@octant/client-runtime/use-connection-status";
import { presentStaleHostSecurity } from "@octant/domain";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { ApprovalDeferralSheet } from "../approvals/ApprovalDeferralSheet";
import { BrowserSurfacePanel } from "../surfaces/BrowserSurfacePanel";
import { NativeHarnessSessionPanel } from "../surfaces/NativeHarnessSessionPanel";
import { ExtensionToolApprovalCard } from "../surfaces/ExtensionToolApprovalCard";
import { listMobileThreadSurfaces } from "../surfaces/threadSurfacePresentation";
import {
  MOBILE_COPY,
  MOBILE_TAB_LABELS,
  mobileModelLabel,
  mobileThreadComposerCopy,
} from "../copy";
import { PullRequestReviewPanel } from "../review/PullRequestReviewPanel";
import { CoordinatorProposalsPanel } from "../review/CoordinatorProposalsPanel";
import { ThreadRoutinesPanel } from "../review/ThreadRoutinesPanel";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { mobileSpacing } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { AttachSourceSheet } from "../ui/AttachSourceSheet";
import { FloatingComposer } from "../ui/FloatingComposer";
import { IconButton } from "../ui/IconButton";
import { NavBar } from "../ui/NativeChrome";
import { ThreadPanesSheet } from "../panes/ThreadPanesSheet";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { RewindSheet } from "../ui/RewindSheet";
import { modelOptionForThread } from "./thread/pendingAttachments";
import { useVoiceDictation } from "../voice/useVoiceDictation";
import { appendTranscript } from "../voice/voiceDictation";
import { DefaultLevelsPanel } from "./thread/DefaultLevelsPanel";
import { createSelectedThreadGuard } from "./thread/selectedThreadGuard";
import { ThreadLevelPanel } from "./thread/ThreadLevelPanel";
import { ThreadTranscript } from "./thread/ThreadTranscript";
import { ResumeBar, type ResumeOffer } from "./thread/ResumeBar";
import { useThreadReplyDetail } from "./thread/useThreadReplyDetail";
import type { ThreadHookInput, ThreadTarget, ThreadUi } from "./thread/threadTypes";
import { useChatThread } from "./thread/useChatThread";
import { useCodeThread } from "./thread/useCodeThread";
import { useThreadTurnActions } from "./thread/useThreadTurnActions";
import { useWorkThread } from "./thread/useWorkThread";
import {
  MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
  enteredMobileForeground,
} from "./threadRefreshPolicy";

// Shown while the host is unreachable, whether the app's connection or the
// chat event stream noticed first.
const RECONNECTING_COPY = "Reconnecting to the host…";

export interface ThreadScreenProps {
  readonly selected: MobileInboxRow | undefined;
  readonly onBack: () => void;
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
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [panesOpen, setPanesOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const [surface, setSurface] = useState<RemoteThreadSurfaceKind>("chat");
  // The surfaces on offer come from the shared remote matrix, so a host that
  // would refuse one never has it shown here.
  // What the host says this phone's session is, asked per host. Until it
  // answers, and whenever it does not, the session is shown as restricted.
  const [standing, setStanding] = useState<RemoteSessionStanding>(RESTRICTED_REMOTE_SESSION);
  useEffect(() => {
    setStanding(RESTRICTED_REMOTE_SESSION);
    if (transport === undefined || offlineDemo) return;
    let current = true;
    void readRemoteSessionStanding(transport).then((answer) => {
      if (current) setStanding(answer);
    });
    return () => {
      current = false;
    };
  }, [transport, offlineDemo]);
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
  const shared = (target: ThreadTarget | undefined): ThreadHookInput => ({
    transport,
    target,
    guard,
    ui,
    gate: staleGate,
    prompt,
    setPrompt,
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

  useEffect(() => {
    setError(undefined);
    setBusy(false);
    setPanesOpen(false);
  }, [identity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (identity === undefined) return;
    let previous = AppState.currentState;
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
  useEffect(() => {
    if (mode === "chat" || (!workTurnLive && !codeTurnLive)) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh({ quiet: true });
    }, MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS);
    return () => clearInterval(timer);
  }, [codeTurnLive, mode, refresh, workTurnLive]);

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
    if (offlineDemo) return;
    setAttachOpen(false);
    void threadAttachments.attach(source, attachmentOffer);
  };
  const attachProps =
    !offlineDemo && staleGate.allowProductMutations && attachmentOffer.sources.length > 0
      ? { onPressAttach: () => setAttachOpen(true) }
      : {};
  const followUpComposerCopy =
    mode === "code" || mode === "work" ? mobileThreadComposerCopy(mode) : undefined;
  const sendFollowUp = () => void (mode === "work" ? work : code).sendFollowUp();
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
    mode === "chat"
      ? staleGate.allowProductMutations && chat.activeAttempt === undefined
      : staleGate.allowProductMutations &&
        !workTurnLive &&
        !codeTurnLive &&
        (mode === "code" || work.thread !== undefined);
  const appendToDraft = useCallback(
    (text: string) => setPrompt((draft) => appendTranscript(draft, text)),
    [],
  );
  const voice = useVoiceDictation({
    transport: offlineDemo ? undefined : transport,
    editable: composerEditable,
    appendToDraft,
  });
  const replyDetail = useThreadReplyDetail({ transport, mode, threadId });

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        scroll: { flex: 1 },
        content: {
          paddingHorizontal: mobileSpacing.md,
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
        <NavBar
          backTestID="mobile-thread-back"
          onBack={props.onBack}
          title={MOBILE_TAB_LABELS.thread}
        />
        <Text style={styles.help}>{MOBILE_COPY.threadEmpty}</Text>
      </View>
    );
  }

  const title = formatScreenshotSafeLabel(selected.title);
  const modelLabel =
    selectedModel?.label ??
    (chat.view !== undefined
      ? mobileModelLabel(models.options, String(chat.view.thread.modelId))
      : MOBILE_COPY.modelHostOnly);
  const codePolicy = code.policy;

  return (
    <View style={styles.shell} testID="mobile-thread-screen">
      <NavBar
        backTestID="mobile-thread-back"
        onBack={props.onBack}
        subtitle={hostLabel}
        title={title}
        trailing={
          offlineDemo || transport === undefined ? undefined : (
            <IconButton
              accessibilityLabel="Views and panes"
              iconSize={19}
              name="grid-outline"
              onPress={() => setPanesOpen(true)}
              size={34}
              testID="mobile-thread-panes-open"
              variant="ghost"
            />
          )
        }
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
            <Ionicons color={colors.accent} name="chevron-back" size={15} />
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
            <Ionicons color={colors.accent} name="contract-outline" size={17} />
          </Pressable>
        </View>
      )}

      <View style={styles.stage}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          style={styles.scroll}
          testID="mobile-thread-transcript"
        >
          {connectionStatus.kind === "waiting-to-retry" || chat.reconnecting ? (
            <Text style={styles.connectionStatus}>{RECONNECTING_COPY}</Text>
          ) : connectionStatus.kind === "offline" ? (
            <Text style={styles.connectionStatus}>Waiting for the network.</Text>
          ) : null}
          {!offlineDemo && fullView && activeSurface === "browser" && transport !== undefined ? (
            <BrowserSurfacePanel
              mode={selected.mode}
              reach={browserReach}
              threadId={selected.threadId}
              transport={transport}
            />
          ) : null}
          {fullView ? null : (
            <>
              {offlineDemo || transport === undefined ? null : (
                <ExtensionToolApprovalCard
                  actsAsHostPerson={standing.actsAsHostPerson}
                  threadId={selected.threadId}
                  transport={transport}
                />
              )}
              {offlineDemo || transport === undefined ? null : (
                <NativeHarnessSessionPanel threadId={selected.threadId} transport={transport} />
              )}
              {busy && chat.activeAttempt === undefined ? (
                <ActivityIndicator color={colors.accent} />
              ) : null}
              {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
              {turnActions.notice !== undefined ? (
                <Text style={styles.connectionStatus} testID="mobile-thread-notice">
                  {turnActions.notice}
                </Text>
              ) : null}
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
              selected.mode === "code" &&
              transport !== undefined &&
              code.thread !== undefined ? (
                <CoordinatorProposalsPanel thread={code.thread} transport={transport} />
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
              <ThreadTranscript
                {...(props.focusTurnId === undefined
                  ? {}
                  : {
                      focus: {
                        turnId: props.focusTurnId,
                        onFound: (y: number) =>
                          scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true }),
                      },
                    })}
                allowProductMutations={staleGate.allowProductMutations}
                chat={chat}
                codeConversation={code.conversation}
                replyDetail={replyDetail}
                turnActionsFor={turnActions.actionsFor}
                workTurns={work.turns}
              />
            </>
          )}
        </ScrollView>
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
                <Ionicons color={colors.textSecondary} name="close" size={15} />
              </Pressable>
            </View>
            <BrowserSurfacePanel
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
      {resumeOffer === undefined ? null : <ResumeBar busy={resumeBusy} offer={resumeOffer} />}
      {selected.mode === "chat" ? (
        <>
          <FloatingComposer
            busy={liveBusy}
            busyLabel={
              chat.activeAttempt !== undefined
                ? chatAttemptStatusLabel(chat.activeAttempt.outcome)
                : MOBILE_COPY.working
            }
            editable={composerEditable}
            modelLabel={modelLabel}
            onChangeText={setPrompt}
            onPressModel={() => setModelOpen(true)}
            onSubmit={() => void chat.send()}
            {...(chat.activeAttempt === undefined ? attachProps : {})}
            {...(chat.activeAttempt !== undefined && staleGate.allowProductMutations
              ? { onStop: () => void chat.stop() }
              : {})}
            placeholder={MOBILE_COPY.composerFollowUp}
            testID="mobile-thread-composer"
            value={prompt}
            voice={voice}
          />
        </>
      ) : (
        <FloatingComposer
          busy={busy || workTurnLive || codeTurnLive}
          busyLabel={MOBILE_COPY.turnRunning}
          editable={composerEditable}
          footerHint={followUpComposerCopy?.footerHint}
          modelLabel={
            selected.mode === "work" && work.thread !== undefined
              ? mobileModelLabel(models.options, String(work.thread.modelId))
              : MOBILE_COPY.modelHostOnly
          }
          onChangeText={setPrompt}
          onSubmit={sendFollowUp}
          {...(workTurnLive || codeTurnLive ? {} : attachProps)}
          placeholder={followUpComposerCopy?.placeholder ?? MOBILE_COPY.composerFollowUp}
          testID="mobile-thread-composer"
          value={prompt}
          voice={voice}
        />
      )}
      {offlineDemo || transport === undefined ? null : (
        <ThreadPanesSheet
          codeThread={selected.mode === "code" ? code.thread : undefined}
          mode={selected.mode}
          onClose={() => setPanesOpen(false)}
          onOpenView={(view) => {
            openSurface(view);
            setPanesOpen(false);
          }}
          views={surfaces.filter((entry) => entry.id !== "chat")}
          threadId={selected.threadId}
          transport={transport}
          visible={panesOpen}
        />
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
        onSelect={(id) => {
          chat.setModelOptionId(id);
          setModelOpen(false);
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={chat.modelOptionId}
        visible={modelOpen}
      />
    </View>
  );
}
