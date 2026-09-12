import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  cancelMobileChatWorkItem,
  chatAttemptStatusLabel,
  completeMobileChatFollowUp,
  completeMobileChatWorkItem,
  decodeMobileModelOptionId,
  interruptMobileChatTurn,
  latestActiveChatAttempt,
  latestRetryableChatAttempt,
  loadMobileChatThread,
  loadMobileCodeConversation,
  loadMobileCodeThread,
  loadMobileWorkThread,
  loadMobileWorkTranscript,
  MobileInboxFailure,
  retryMobileChatTurn,
  sendMobileChatTurn,
  sendMobileCodeTurn,
  sendMobileWorkTurn,
  subscribeMobileChatEvents,
  uploadMobileChatAttachment,
  type MobileCodeConversationTurn,
  type MobileInboxRow,
} from "@octant/client-runtime";
import { useConnectionStatus } from "@octant/client-runtime/use-connection-status";
import type {
  ChatThreadView,
  ThreadFollowUp,
  ThreadWorkItem,
  WorkThread,
  WorkTurnState,
} from "@octant/contracts";
import { presentStaleHostSecurity } from "@octant/domain";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { ApprovalDeferralSheet } from "../approvals/ApprovalDeferralSheet";
import { BrowserSurfacePanel } from "../surfaces/BrowserSurfacePanel";
import { ThreadSurfaceSwitcher } from "../surfaces/ThreadSurfaceSwitcher";
import { NativeHarnessSessionPanel } from "../surfaces/NativeHarnessSessionPanel";
import { listMobileThreadSurfaces } from "../surfaces/threadSurfacePresentation";
import { MOBILE_COPY, mobileThreadComposerCopy } from "../copy";
import { PullRequestReviewPanel } from "../review/PullRequestReviewPanel";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { AttemptStatus } from "../ui/AttemptStatus";
import { FloatingComposer } from "../ui/FloatingComposer";
import { IconButton } from "../ui/IconButton";
import { MessageBubble } from "../ui/MessageBubble";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";
import { ThreadWorkShelf } from "../ui/ThreadWorkShelf";
import {
  MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
  enteredMobileForeground,
  nextMobileChatIdleRefreshDelay,
} from "./threadRefreshPolicy";

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

interface PendingAttachment {
  readonly id: string;
  readonly displayName: string;
}

async function readUriBytes(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function guessImageMediaType(uri: string, reported?: string | null): string {
  if (reported !== undefined && reported !== null && IMAGE_MEDIA_TYPES.has(reported)) {
    return reported;
  }
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function waitForMobileChatForeground(signal: AbortSignal): Promise<boolean> {
  if (AppState.currentState === "active") return true;
  return new Promise((resolve) => {
    let settled = false;
    let subscription: { remove: () => void } | undefined;
    const abort = () => finish(false);
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      signal.removeEventListener("abort", abort);
      resolve(active);
    };
    subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") finish(true);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (AppState.currentState === "active") finish(true);
  });
}

async function waitForMobileChatRefresh(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface ThreadScreenProps {
  readonly selected: MobileInboxRow | undefined;
  readonly onBack: () => void;
}

export function ThreadScreen(props: ThreadScreenProps) {
  const { colors } = useTheme();
  const { transportForHost, hosts, health, hub } = useMobileSession();
  const authenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const transport = useMemo(
    () => (props.selected === undefined ? undefined : transportForHost(props.selected.hostId)),
    [props.selected, transportForHost],
  );
  const hostHealth = useMemo(() => {
    if (props.selected === undefined) return "idle" as const;
    return health.find((entry) => entry.hostId === props.selected!.hostId)?.kind ?? "idle";
  }, [health, props.selected]);
  const selectedOrigin = useMemo(
    () =>
      props.selected === undefined
        ? undefined
        : hosts.find((host) => host.hostId === props.selected?.hostId)?.origin,
    [hosts, props.selected],
  );
  const supervisor = useMemo(
    () => (selectedOrigin === undefined ? undefined : hub.supervisorForOrigin(selectedOrigin)),
    [hub, selectedOrigin],
  );
  const connectionStatus = useConnectionStatus(supervisor);
  const staleGate = useMemo(() => presentStaleHostSecurity(hostHealth), [hostHealth]);
  const models = usePlacementHostModels(transport);
  const [view, setView] = useState<ChatThreadView | undefined>();
  const [codePolicy, setCodePolicy] = useState<string | undefined>();
  const [workThread, setWorkThread] = useState<WorkThread | undefined>();
  const [workTurns, setWorkTurns] = useState<ReadonlyArray<WorkTurnState> | undefined>();
  const [codeTurns, setCodeTurns] = useState<
    ReadonlyArray<MobileCodeConversationTurn> | undefined
  >();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOptionId, setModelOptionId] = useState<string | undefined>();
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>(
    [],
  );
  const viewRef = useRef<ChatThreadView | undefined>(undefined);
  viewRef.current = view;
  const [surface, setSurface] = useState<RemoteThreadSurfaceKind>("chat");
  // The surfaces on offer come from the shared remote matrix, so a host that
  // would refuse one never has it shown here.
  const surfaces = useMemo(
    () => listMobileThreadSurfaces({ mode: props.selected?.mode ?? "chat" }),
    [props.selected?.mode],
  );
  const activeSurface = surfaces.some((entry) => entry.id === surface) ? surface : "chat";
  const browserReach = surfaces.find((entry) => entry.id === "browser")?.reach ?? "unavailable";

  const hostLabel = useMemo(() => {
    if (props.selected === undefined) return undefined;
    return hosts.find((host) => host.hostId === props.selected!.hostId)?.label;
  }, [hosts, props.selected]);

  const activeAttempt = view === undefined ? undefined : latestActiveChatAttempt(view);
  const retryableAttempt = view === undefined ? undefined : latestRetryableChatAttempt(view);
  const liveBusy = busy || activeAttempt !== undefined;
  const selectedIdentity =
    props.selected === undefined
      ? undefined
      : `${props.selected.hostId}:${props.selected.threadId}`;
  const selectedIdentityRef = useRef(selectedIdentity);
  selectedIdentityRef.current = selectedIdentity;

  const refresh = useCallback(
    async (options?: { readonly quiet?: boolean }) => {
      if (transport === undefined || props.selected === undefined) {
        setView(undefined);
        setCodePolicy(undefined);
        setWorkThread(undefined);
        setWorkTurns(undefined);
        setCodeTurns(undefined);
        return;
      }
      // Quiet polling and a later inbox selection can overlap. An older
      // Code/Work load that commits after the selection changes would paint
      // the previous transcript, or leave that thread's workThread mounted
      // so a follow-up sends under the previous Project and binding.
      const identity = `${props.selected.hostId}:${props.selected.threadId}`;
      const stillSelected = () => selectedIdentityRef.current === identity;
      if (props.selected.mode === "code") {
        setView(undefined);
        setWorkThread(undefined);
        setWorkTurns(undefined);
        if (options?.quiet !== true) {
          setBusy(true);
          setError(undefined);
        }
        try {
          const [thread, turns] = await Promise.all([
            loadMobileCodeThread(transport, props.selected.threadId),
            loadMobileCodeConversation(transport, props.selected.threadId),
          ]);
          if (!stillSelected()) return;
          setCodePolicy(thread.executionPolicy);
          setCodeTurns(turns);
        } catch (cause) {
          if (!stillSelected() || options?.quiet === true) return;
          setCodePolicy(undefined);
          setCodeTurns(undefined);
          setError(
            cause instanceof MobileInboxFailure ? cause.message : "Could not load the Code thread.",
          );
        } finally {
          if (options?.quiet !== true && stillSelected()) setBusy(false);
        }
        return;
      }
      if (props.selected.mode === "work") {
        setView(undefined);
        setCodePolicy(undefined);
        setCodeTurns(undefined);
        if (options?.quiet !== true) {
          setBusy(true);
          setError(undefined);
        }
        try {
          const [thread, transcript] = await Promise.all([
            loadMobileWorkThread(transport, props.selected.threadId),
            loadMobileWorkTranscript(transport, props.selected.threadId),
          ]);
          if (!stillSelected()) return;
          setWorkThread(thread);
          setWorkTurns(transcript.turns);
        } catch (cause) {
          if (!stillSelected() || options?.quiet === true) return;
          setWorkThread(undefined);
          setWorkTurns(undefined);
          setError(
            cause instanceof MobileInboxFailure ? cause.message : "Could not load the Work thread.",
          );
        } finally {
          if (options?.quiet !== true && stillSelected()) setBusy(false);
        }
        return;
      }
      if (options?.quiet !== true) setBusy(true);
      setError(undefined);
      setCodePolicy(undefined);
      setWorkThread(undefined);
      setWorkTurns(undefined);
      setCodeTurns(undefined);
      try {
        const next = await loadMobileChatThread(transport, props.selected.threadId);
        setView(next);
        const match = models.options.find(
          (option) =>
            option.providerInstanceId === String(next.thread.providerInstanceId) &&
            option.modelId === String(next.thread.modelId),
        );
        if (match !== undefined) setModelOptionId(match.id);
      } catch (cause) {
        setError(
          cause instanceof MobileInboxFailure ? cause.message : "Could not load the thread.",
        );
      } finally {
        if (options?.quiet !== true) setBusy(false);
      }
    },
    [models.options, props.selected, transport],
  );

  useEffect(() => {
    setWorkThread(undefined);
    setWorkTurns(undefined);
    setCodeTurns(undefined);
    setCodePolicy(undefined);
  }, [selectedIdentity]);

  useEffect(() => {
    void refresh();
    setPendingAttachments([]);
  }, [refresh]);

  useEffect(() => {
    if (props.selected === undefined) return;
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
  }, [props.selected, refresh, supervisor]);

  // A Work or Code turn streams nowhere on the phone yet; while one is live the
  // durable transcript is re-read on a short cadence so the reply grows in
  // place, and the polling stops the moment the turn settles.
  const workTurnLive = (workTurns ?? []).some(
    (turn) => turn.status === "accepted" || turn.status === "running" || turn.status === "waiting",
  );
  const codeTurnLive = (codeTurns ?? []).some((turn) => turn.status === "waiting");
  useEffect(() => {
    if (props.selected?.mode === "chat" || (!workTurnLive && !codeTurnLive)) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh({ quiet: true });
    }, MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS);
    return () => clearInterval(timer);
  }, [codeTurnLive, props.selected?.mode, refresh, workTurnLive]);

  useEffect(() => {
    if (transport === undefined || props.selected?.mode !== "chat") {
      return;
    }
    const threadId = props.selected.threadId;
    const controller = new AbortController();
    let stopped = false;

    const run = async () => {
      let idleDelayMs = MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS;
      while (!stopped && !controller.signal.aborted && viewRef.current === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (stopped || controller.signal.aborted || viewRef.current === undefined) return;
      let cursor = viewRef.current.lastSequence;
      while (!stopped && !controller.signal.aborted) {
        if (!(await waitForMobileChatForeground(controller.signal))) return;
        let receivedFrame = false;
        try {
          for await (const _frame of subscribeMobileChatEvents({
            transport,
            threadId,
            afterSequence: cursor,
            signal: controller.signal,
          })) {
            if (stopped || controller.signal.aborted) return;
            receivedFrame = true;
            cursor = _frame.sequence;
          }
          if (stopped || controller.signal.aborted) return;
          if (receivedFrame) {
            const next = await loadMobileChatThread(transport, threadId);
            if (stopped || controller.signal.aborted) return;
            setView(next);
            cursor = next.lastSequence;
          }
          const delayMs = receivedFrame ? MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS : idleDelayMs;
          if (!(await waitForMobileChatRefresh(controller.signal, delayMs))) return;
          idleDelayMs = nextMobileChatIdleRefreshDelay({
            currentDelayMs: idleDelayMs,
            receivedFrame,
          });
        } catch {
          if (stopped || controller.signal.aborted) return;
          try {
            const next = await loadMobileChatThread(transport, threadId);
            if (!stopped && !controller.signal.aborted) {
              setView(next);
              cursor = next.lastSequence;
            }
          } catch {
            // Keep reconnecting while the thread is open.
          }
          if (!(await waitForMobileChatRefresh(controller.signal, idleDelayMs))) return;
          idleDelayMs = nextMobileChatIdleRefreshDelay({
            currentDelayMs: idleDelayMs,
            receivedFrame: false,
          });
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [props.selected?.mode, props.selected?.threadId, transport]);

  const selectedModel = useMemo(
    () => models.options.find((option) => option.id === modelOptionId),
    [modelOptionId, models.options],
  );
  const followUpComposerCopy =
    props.selected?.mode === "code" || props.selected?.mode === "work"
      ? mobileThreadComposerCopy(props.selected.mode)
      : undefined;

  const sendFollowUp = async () => {
    if (transport === undefined || props.selected === undefined) return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    const identity = `${props.selected.hostId}:${props.selected.threadId}`;
    const stillSelected = () => selectedIdentityRef.current === identity;
    setBusy(true);
    setError(undefined);
    try {
      if (props.selected.mode === "work") {
        if (workThread === undefined || String(workThread.id) !== props.selected.threadId) {
          return;
        }
        const turn = await sendMobileWorkTurn({ transport, thread: workThread, prompt });
        if (!stillSelected()) return;
        setWorkTurns((current) => [...(current ?? []), turn]);
      } else if (props.selected.mode === "code") {
        const threadId = props.selected.threadId;
        await sendMobileCodeTurn({ transport, threadId, prompt });
        const turns = await loadMobileCodeConversation(transport, threadId);
        if (!stillSelected()) return;
        setCodeTurns(turns);
      } else {
        return;
      }
      if (!stillSelected()) return;
      setPrompt("");
    } catch (cause) {
      if (!stillSelected()) return;
      setError(cause instanceof MobileInboxFailure ? cause.message : "Follow-up failed.");
    } finally {
      if (stillSelected()) setBusy(false);
    }
  };

  const attach = async () => {
    if (transport === undefined || view === undefined || props.selected?.mode !== "chat") return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(MOBILE_COPY.attachPermissionDenied);
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (picked.canceled || picked.assets[0] === undefined) return;
    const asset = picked.assets[0];
    const mediaType = guessImageMediaType(asset.uri, asset.mimeType);
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      setError(MOBILE_COPY.attachFailed);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const bytes = await readUriBytes(asset.uri);
      const attachmentId = globalThis.crypto.randomUUID();
      const displayName = asset.fileName?.trim() || `image-${attachmentId.slice(0, 8)}.jpg`;
      const uploaded = await uploadMobileChatAttachment({
        transport,
        threadId: String(view.thread.id),
        attachmentId,
        displayName,
        mediaType,
        bytes,
      });
      setPendingAttachments((current) => [
        ...current,
        { id: String(uploaded.id), displayName: uploaded.displayName },
      ]);
    } catch (cause) {
      setError(cause instanceof MobileInboxFailure ? cause.message : MOBILE_COPY.attachFailed);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (transport === undefined || view === undefined || props.selected?.mode !== "chat") return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const decoded =
        modelOptionId === undefined ? undefined : decodeMobileModelOptionId(modelOptionId);
      const needsChange =
        decoded !== undefined &&
        (decoded.providerInstanceId !== String(view.thread.providerInstanceId) ||
          decoded.modelId !== String(view.thread.modelId));
      await sendMobileChatTurn({
        transport,
        threadId: view.thread.id,
        expectedVersion: view.thread.version,
        prompt,
        ...(pendingAttachments.length > 0
          ? { attachmentIds: pendingAttachments.map((item) => item.id) }
          : {}),
        ...(needsChange && decoded !== undefined
          ? {
              providerInstanceId: decoded.providerInstanceId,
              modelId: decoded.modelId,
            }
          : {}),
      });
      setPrompt("");
      setPendingAttachments([]);
      setView(await loadMobileChatThread(transport, view.thread.id));
    } catch (cause) {
      setError(cause instanceof MobileInboxFailure ? cause.message : "Follow-up failed.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (transport === undefined || view === undefined || activeAttempt === undefined) return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await interruptMobileChatTurn({
        transport,
        threadId: view.thread.id,
        expectedVersion: view.thread.version,
        turnId: String(activeAttempt.turnId),
        attemptId: String(activeAttempt.id),
      });
      setView(await loadMobileChatThread(transport, view.thread.id));
    } catch (cause) {
      setError(cause instanceof MobileInboxFailure ? cause.message : "Stop failed.");
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (transport === undefined || view === undefined || retryableAttempt === undefined) return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await retryMobileChatTurn({
        transport,
        threadId: view.thread.id,
        expectedVersion: view.thread.version,
        turnId: String(retryableAttempt.turnId),
        attemptId: String(retryableAttempt.id),
      });
      setView(await loadMobileChatThread(transport, view.thread.id));
    } catch (cause) {
      setError(cause instanceof MobileInboxFailure ? cause.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  };

  const mutateWork = async (run: () => Promise<void>, failureMessage: string): Promise<void> => {
    if (transport === undefined || view === undefined) return;
    if (!staleGate.allowProductMutations) {
      setError(staleGate.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await run();
      setView(await loadMobileChatThread(transport, view.thread.id));
    } catch (cause) {
      setError(cause instanceof MobileInboxFailure ? cause.message : failureMessage);
    } finally {
      setBusy(false);
    }
  };

  const completeWorkItem = (item: ThreadWorkItem) => {
    if (transport === undefined || view === undefined) return;
    void mutateWork(
      () =>
        completeMobileChatWorkItem({
          transport,
          threadId: String(view.thread.id),
          expectedVersion: view.workListVersion,
          itemId: String(item.id),
        }),
      "Could not complete the work item.",
    );
  };

  const cancelWorkItem = (item: ThreadWorkItem) => {
    if (transport === undefined || view === undefined) return;
    void mutateWork(
      () =>
        cancelMobileChatWorkItem({
          transport,
          threadId: String(view.thread.id),
          expectedVersion: view.workListVersion,
          itemId: String(item.id),
        }),
      "Could not cancel the work item.",
    );
  };

  const completeFollowUp = (followUp: ThreadFollowUp) => {
    if (transport === undefined || view === undefined) return;
    void mutateWork(
      () =>
        completeMobileChatFollowUp({
          transport,
          threadId: String(view.thread.id),
          expectedVersion: view.followUpVersion,
          acknowledgedThroughSequence: followUp.triggerSequence,
        }),
      "Could not complete the follow-up.",
    );
  };

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
          lineHeight: 22,
        },
        error: { color: colors.danger },
        connectionStatus: {
          color: colors.textSecondary,
          fontSize: 12,
          lineHeight: 16,
        },
        transcript: { gap: mobileSpacing.sm, paddingTop: mobileSpacing.sm },
        emptyChat: {
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingVertical: mobileSpacing.xxl,
          paddingHorizontal: mobileSpacing.lg,
          gap: mobileSpacing.sm,
        },
        emptyTitle: {
          color: colors.textPrimary,
          fontSize: 22,
          fontWeight: "400",
          letterSpacing: -0.4,
          textAlign: "center",
        },
        emptyBody: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 22,
          textAlign: "center",
          maxWidth: 280,
        },
        metaBlock: {
          gap: mobileSpacing.xs,
          marginBottom: mobileSpacing.sm,
        },
        metaText: {
          color: colors.textSecondary,
          fontSize: 12,
          lineHeight: 16,
        },
        warningText: {
          color: colors.danger,
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

  if (props.selected === undefined) {
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

  const title = formatScreenshotSafeLabel(props.selected.title);
  const modelLabel =
    selectedModel?.label ??
    (view !== undefined ? String(view.thread.modelId) : MOBILE_COPY.modelHostOnly);

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
        {connectionStatus.kind === "waiting-to-retry" ? (
          <Text style={styles.connectionStatus}>Reconnecting to the host…</Text>
        ) : connectionStatus.kind === "offline" ? (
          <Text style={styles.connectionStatus}>Waiting for the network.</Text>
        ) : null}
        {activeSurface === "browser" && transport !== undefined ? (
          <BrowserSurfacePanel
            mode={props.selected.mode}
            reach={browserReach}
            threadId={props.selected.threadId}
            transport={transport}
          />
        ) : null}
        {activeSurface === "browser" ? null : (
          <>
            {transport === undefined ? null : (
              <NativeHarnessSessionPanel threadId={props.selected.threadId} transport={transport} />
            )}
            {busy && activeAttempt === undefined ? (
              <ActivityIndicator color={colors.accent} />
            ) : null}
            {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
            {props.selected.mode === "code" &&
            (codePolicy === "approval-gated" || codePolicy === "auto-accept-edits") ? (
              <ApprovalDeferralSheet
                executionPolicy={codePolicy}
                mode="code"
                operationSummary="Approval-gated Code operations"
                threadTitle={title}
                {...(hostLabel === undefined ? {} : { hostLabel })}
              />
            ) : null}
            {props.selected.mode === "code" && transport !== undefined ? (
              <PullRequestReviewPanel threadId={props.selected.threadId} transport={transport} />
            ) : null}
            {workTurns !== undefined ? (
              <View style={styles.transcript} testID="mobile-work-transcript">
                {workTurns.length === 0 ? (
                  <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>
                ) : (
                  workTurns.map((turn) => (
                    <View key={String(turn.turnId)} style={styles.transcript}>
                      <MessageBubble
                        body={turn.prompt}
                        role="user"
                        showActions={false}
                        testID={`mobile-work-prompt-${String(turn.turnId)}`}
                      />
                      {turn.response !== undefined && turn.response.length > 0 ? (
                        <MessageBubble
                          body={turn.response}
                          role="assistant"
                          testID={`mobile-work-reply-${String(turn.turnId)}`}
                        />
                      ) : turn.failure !== undefined ? (
                        <Text style={styles.warningText}>{turn.failure.message}</Text>
                      ) : turn.status === "accepted" ||
                        turn.status === "running" ||
                        turn.status === "waiting" ? (
                        <Text style={styles.metaText}>{MOBILE_COPY.turnRunning}</Text>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            ) : null}
            {codeTurns !== undefined ? (
              <View style={styles.transcript} testID="mobile-code-transcript">
                {codeTurns.length === 0 ? (
                  <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>
                ) : (
                  codeTurns.map((turn) => (
                    <View key={turn.operationId} style={styles.transcript}>
                      {turn.prompt.length === 0 ? null : (
                        <MessageBubble
                          body={turn.prompt}
                          role="user"
                          showActions={false}
                          testID={`mobile-code-prompt-${turn.operationId}`}
                        />
                      )}
                      {turn.assistant.map((part, index) => (
                        <MessageBubble
                          body={part}
                          key={`${turn.operationId}-${index}`}
                          role="assistant"
                          testID={`mobile-code-reply-${turn.operationId}-${index}`}
                        />
                      ))}
                      {turn.status === "waiting" ? (
                        <Text style={styles.metaText}>{MOBILE_COPY.turnRunning}</Text>
                      ) : turn.status === "failed" || turn.status === "interrupted" ? (
                        <Text style={styles.warningText}>
                          {chatAttemptStatusLabel(turn.status)}
                        </Text>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            ) : null}
            {view !== undefined ? (
              <View style={styles.transcript} testID="mobile-thread-transcript">
                {activeAttempt !== undefined ? (
                  <AttemptStatus
                    outcome={activeAttempt.outcome}
                    testID="mobile-thread-attempt-status"
                  />
                ) : retryableAttempt !== undefined ? (
                  <AttemptStatus
                    outcome={retryableAttempt.outcome}
                    testID="mobile-thread-attempt-status"
                  />
                ) : null}
                {view.thread.handoffWarning !== undefined ? (
                  <Text style={styles.warningText} testID="mobile-thread-handoff-warning">
                    {MOBILE_COPY.handoffWarning}
                  </Text>
                ) : null}
                <ThreadWorkShelf
                  items={view.workItems}
                  {...(view.followUp === undefined ? {} : { followUp: view.followUp })}
                  {...(staleGate.allowProductMutations
                    ? {
                        onCompleteItem: completeWorkItem,
                        onCancelItem: cancelWorkItem,
                        onCompleteFollowUp: completeFollowUp,
                      }
                    : {})}
                />
                {view.attachments.length > 0 || view.citations.length > 0 ? (
                  <View style={styles.metaBlock} testID="mobile-thread-meta">
                    {view.attachments.map((attachment) => (
                      <Text key={String(attachment.id)} style={styles.metaText}>
                        {MOBILE_COPY.attachmentLabel}: {attachment.displayName}
                      </Text>
                    ))}
                    {view.citations.map((citation) => (
                      <Text key={String(citation.citationId)} style={styles.metaText}>
                        {MOBILE_COPY.citationLabel}: {citation.sourceTitle}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {view.contents.length === 0 ? (
                  <View style={styles.emptyChat} testID="mobile-thread-empty">
                    <Text style={styles.emptyTitle}>{MOBILE_COPY.threadStart}</Text>
                    <Text style={styles.emptyBody}>{MOBILE_COPY.threadStartHelp}</Text>
                  </View>
                ) : (
                  view.contents.map((content, index) => {
                    const isLastAssistant =
                      index ===
                      view.contents.reduce(
                        (last, entry, i) =>
                          entry.role.toLowerCase() !== "user" &&
                          entry.role.toLowerCase() !== "human"
                            ? i
                            : last,
                        -1,
                      );
                    const showRetry =
                      isLastAssistant &&
                      retryableAttempt !== undefined &&
                      activeAttempt === undefined &&
                      staleGate.allowProductMutations;
                    return (
                      <MessageBubble
                        body={content.body}
                        key={content.contentId}
                        role={content.role}
                        showActions={isLastAssistant}
                        testID={`mobile-message-${content.contentId}`}
                        {...(content.parts === undefined ? {} : { parts: content.parts })}
                        {...(showRetry
                          ? {
                              extraActions: [
                                {
                                  id: "retry",
                                  label: `Retry ${chatAttemptStatusLabel(retryableAttempt.outcome).toLowerCase()}`,
                                  icon: "refresh-outline" as const,
                                  onPress: () => void retry(),
                                },
                              ],
                            }
                          : {})}
                      />
                    );
                  })
                )}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {props.selected.mode === "chat" ? (
        <>
          {pendingAttachments.length > 0 ? (
            <View style={styles.pendingWrap} testID="mobile-thread-pending-attachments">
              {pendingAttachments.map((attachment) => (
                <Text key={attachment.id} style={styles.pendingChip}>
                  {MOBILE_COPY.attachPending}: {attachment.displayName}
                </Text>
              ))}
            </View>
          ) : null}
          <FloatingComposer
            busy={liveBusy}
            busyLabel={
              activeAttempt !== undefined
                ? chatAttemptStatusLabel(activeAttempt.outcome)
                : MOBILE_COPY.working
            }
            editable={staleGate.allowProductMutations && activeAttempt === undefined}
            footerHint={MOBILE_COPY.hostOwnedThread}
            modelLabel={modelLabel}
            onChangeText={setPrompt}
            onPressModel={() => setModelOpen(true)}
            onSubmit={() => void send()}
            {...(staleGate.allowProductMutations && activeAttempt === undefined
              ? { onPressAttach: () => void attach() }
              : {})}
            {...(activeAttempt !== undefined && staleGate.allowProductMutations
              ? { onStop: () => void stop() }
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
            (props.selected.mode === "code" || workThread !== undefined)
          }
          footerHint={followUpComposerCopy?.footerHint ?? MOBILE_COPY.hostOwnedThread}
          modelLabel={
            props.selected.mode === "work" && workThread !== undefined
              ? String(workThread.modelId)
              : MOBILE_COPY.modelHostOnly
          }
          onChangeText={setPrompt}
          onSubmit={() => void sendFollowUp()}
          placeholder={followUpComposerCopy?.placeholder ?? MOBILE_COPY.composerFollowUp}
          testID="mobile-thread-composer"
          value={prompt}
        />
      )}
      <ModelPickerSheet
        onClose={() => setModelOpen(false)}
        onSelect={(id) => {
          setModelOptionId(id);
          setModelOpen(false);
        }}
        options={models.options.map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.detail,
        }))}
        selectedId={modelOptionId}
        visible={modelOpen}
      />
    </View>
  );
}
