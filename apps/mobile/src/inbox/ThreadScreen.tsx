import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { chatAttemptStatusLabel, type MobileInboxRow } from "@octant/client-runtime";
import { useConnectionStatus } from "@octant/client-runtime/use-connection-status";
import { presentStaleHostSecurity } from "@octant/domain";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { ApprovalDeferralSheet } from "../approvals/ApprovalDeferralSheet";
import { BrowserSurfacePanel } from "../surfaces/BrowserSurfacePanel";
import { ThreadSurfaceSwitcher } from "../surfaces/ThreadSurfaceSwitcher";
import { NativeHarnessSessionPanel } from "../surfaces/NativeHarnessSessionPanel";
import { ExtensionToolApprovalCard } from "../surfaces/ExtensionToolApprovalCard";
import { listMobileThreadSurfaces } from "../surfaces/threadSurfacePresentation";
import { MOBILE_COPY, mobileModelLabel, mobileThreadComposerCopy } from "../copy";
import { PullRequestReviewPanel } from "../review/PullRequestReviewPanel";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { FloatingComposer } from "../ui/FloatingComposer";
import { IconButton } from "../ui/IconButton";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { createSelectedThreadGuard } from "./thread/selectedThreadGuard";
import { ThreadTranscript } from "./thread/ThreadTranscript";
import type { ThreadHookInput, ThreadTarget, ThreadUi } from "./thread/threadTypes";
import { useChatThread } from "./thread/useChatThread";
import { useCodeThread } from "./thread/useCodeThread";
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
}

export function ThreadScreen(props: ThreadScreenProps) {
  const { colors } = useTheme();
  const { transportForHost, hosts, health, hub } = useMobileSession();
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
  const [surface, setSurface] = useState<RemoteThreadSurfaceKind>("chat");
  // The surfaces on offer come from the shared remote matrix, so a host that
  // would refuse one never has it shown here.
  const surfaces = useMemo(
    () => listMobileThreadSurfaces({ mode: selected?.mode ?? "chat" }),
    [selected?.mode],
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

  const selectedModel = useMemo(
    () => models.options.find((option) => option.id === chat.modelOptionId),
    [chat.modelOptionId, models.options],
  );
  const followUpComposerCopy =
    mode === "code" || mode === "work" ? mobileThreadComposerCopy(mode) : undefined;
  const sendFollowUp = () => void (mode === "work" ? work : code).sendFollowUp();
  const liveBusy = busy || chat.activeAttempt !== undefined;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        topBar: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: mobileSpacing.sm,
          paddingTop: mobileSpacing.sm,
          paddingBottom: mobileSpacing.sm,
        },
        titleBlock: { flex: 1, alignItems: "center", paddingHorizontal: mobileSpacing.sm },
        topSpacer: { width: 36 },
        navTitle: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
          textAlign: "center",
        },
        navSubtitle: {
          color: colors.textTertiary,
          fontSize: 12,
          marginTop: 2,
        },
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
        <View style={styles.topBar}>
          <IconButton
            accessibilityLabel="Back"
            name="chevron-back"
            onPress={props.onBack}
            testID="mobile-thread-back"
            variant="ghost"
          />
        </View>
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
      <View style={styles.topBar}>
        <IconButton
          accessibilityLabel="Back"
          name="chevron-back"
          onPress={props.onBack}
          testID="mobile-thread-back"
          variant="ghost"
        />
        <View style={styles.titleBlock}>
          <Text style={styles.navTitle} numberOfLines={1}>
            {title}
          </Text>
          {hostLabel !== undefined ? (
            <Text style={styles.navSubtitle} numberOfLines={1}>
              {hostLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.topSpacer} />
      </View>

      <ThreadSurfaceSwitcher active={activeSurface} onSelect={setSurface} surfaces={surfaces} />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
      >
        {connectionStatus.kind === "waiting-to-retry" || chat.reconnecting ? (
          <Text style={styles.connectionStatus}>{RECONNECTING_COPY}</Text>
        ) : connectionStatus.kind === "offline" ? (
          <Text style={styles.connectionStatus}>Waiting for the network.</Text>
        ) : null}
        {activeSurface === "browser" && transport !== undefined ? (
          <BrowserSurfacePanel
            mode={selected.mode}
            reach={browserReach}
            threadId={selected.threadId}
            transport={transport}
          />
        ) : null}
        {activeSurface === "browser" ? null : (
          <>
            {transport === undefined ? null : (
              <ExtensionToolApprovalCard threadId={selected.threadId} transport={transport} />
            )}
            {transport === undefined ? null : (
              <NativeHarnessSessionPanel threadId={selected.threadId} transport={transport} />
            )}
            {busy && chat.activeAttempt === undefined ? (
              <ActivityIndicator color={colors.accent} />
            ) : null}
            {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
            {selected.mode === "code" &&
            (codePolicy === "approval-gated" || codePolicy === "auto-accept-edits") ? (
              <ApprovalDeferralSheet
                executionPolicy={codePolicy}
                mode="code"
                operationSummary="Approval-gated Code operations"
                threadTitle={title}
                {...(hostLabel === undefined ? {} : { hostLabel })}
              />
            ) : null}
            {selected.mode === "code" && transport !== undefined ? (
              <PullRequestReviewPanel threadId={selected.threadId} transport={transport} />
            ) : null}
            <ThreadTranscript
              allowProductMutations={staleGate.allowProductMutations}
              chat={chat}
              codeConversation={code.conversation}
              workTurns={work.turns}
            />
          </>
        )}
      </ScrollView>

      {selected.mode === "chat" ? (
        <>
          {chat.pendingAttachments.length > 0 ? (
            <View style={styles.pendingWrap} testID="mobile-thread-pending-attachments">
              {chat.pendingAttachments.map((attachment) => (
                <Text key={attachment.id} style={styles.pendingChip}>
                  {MOBILE_COPY.attachPending}: {attachment.displayName}
                </Text>
              ))}
            </View>
          ) : null}
          <FloatingComposer
            busy={liveBusy}
            busyLabel={
              chat.activeAttempt !== undefined
                ? chatAttemptStatusLabel(chat.activeAttempt.outcome)
                : MOBILE_COPY.working
            }
            editable={staleGate.allowProductMutations && chat.activeAttempt === undefined}
            footerHint={MOBILE_COPY.hostOwnedThread}
            modelLabel={modelLabel}
            onChangeText={setPrompt}
            onPressModel={() => setModelOpen(true)}
            onSubmit={() => void chat.send()}
            {...(staleGate.allowProductMutations && chat.activeAttempt === undefined
              ? { onPressAttach: () => void chat.attach() }
              : {})}
            {...(chat.activeAttempt !== undefined && staleGate.allowProductMutations
              ? { onStop: () => void chat.stop() }
              : {})}
            placeholder={MOBILE_COPY.composerFollowUp}
            testID="mobile-thread-composer"
            value={prompt}
          />
        </>
      ) : (
        <FloatingComposer
          busy={busy || workTurnLive || codeTurnLive}
          busyLabel={MOBILE_COPY.turnRunning}
          editable={
            staleGate.allowProductMutations &&
            !workTurnLive &&
            !codeTurnLive &&
            (selected.mode === "code" || work.thread !== undefined)
          }
          footerHint={followUpComposerCopy?.footerHint ?? MOBILE_COPY.hostOwnedThread}
          modelLabel={
            selected.mode === "work" && work.thread !== undefined
              ? mobileModelLabel(models.options, String(work.thread.modelId))
              : MOBILE_COPY.modelHostOnly
          }
          onChangeText={setPrompt}
          onSubmit={sendFollowUp}
          placeholder={followUpComposerCopy?.placeholder ?? MOBILE_COPY.composerFollowUp}
          testID="mobile-thread-composer"
          value={prompt}
        />
      )}
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
