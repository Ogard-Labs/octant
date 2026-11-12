import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  chatAttemptStatusLabel,
  mobileAttachmentOffer,
  readRemoteSessionStanding,
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
import { ThreadSurfaceSwitcher } from "../surfaces/ThreadSurfaceSwitcher";
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
import { NavBar } from "../ui/NativeChrome";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { RewindSheet } from "../ui/RewindSheet";
import { modelOptionForThread } from "./thread/pendingAttachments";
import { useVoiceDictation } from "../voice/useVoiceDictation";
import { appendTranscript } from "../voice/voiceDictation";
import { DefaultLevelsPanel } from "./thread/DefaultLevelsPanel";
import { createSelectedThreadGuard } from "./thread/selectedThreadGuard";
import { ThreadLevelPanel } from "./thread/ThreadLevelPanel";
import { ThreadTranscript } from "./thread/ThreadTranscript";
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
  const code = useCodeThread(shared(targetFor("code")));
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
      />

      {offlineDemo ? null : (
        <ThreadSurfaceSwitcher active={activeSurface} onSelect={setSurface} surfaces={surfaces} />
      )}

      <ScrollView
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
        {!offlineDemo && activeSurface === "browser" && transport !== undefined ? (
          <BrowserSurfacePanel
            mode={selected.mode}
            reach={browserReach}
            threadId={selected.threadId}
            transport={transport}
          />
        ) : null}
        {activeSurface === "browser" ? null : (
          <>
            {offlineDemo || transport === undefined ? null : (
              <ExtensionToolApprovalCard threadId={selected.threadId} transport={transport} />
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

      {pendingAttachments.length > 0 ? (
        <View style={styles.pendingWrap} testID="mobile-thread-pending-attachments">
          {pendingAttachments.map((attachment) => (
            <Text key={attachment.id} style={styles.pendingChip}>
              {MOBILE_COPY.attachPending}: {attachment.displayName}
            </Text>
          ))}
        </View>
      ) : null}
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
