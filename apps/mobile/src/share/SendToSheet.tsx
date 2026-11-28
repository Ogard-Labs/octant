import {
  composerValueShown,
  noteTypedComposerText,
  typedClaimFor,
} from "@octant/client-runtime/typed-composer-text";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileInboxRow, RemoteSessionStanding } from "@octant/client-runtime";
import { radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { usePlacementHostModels } from "../session/usePlacementHostModels";
import { BottomSheet } from "../ui/BottomSheet";
import { ComposerSurface } from "../ui/ComposerSurface";
import { Icon } from "../ui/Icon";
import { IconButton } from "../ui/IconButton";
import { ListNote, ListRow, ListSection } from "../ui/NativeChrome";
import {
  evaluateShareHosts,
  listShareDestinations,
  mapShareForDestination,
  reconcileSelectedShareHost,
  type ShareBotRow,
  type ShareDestination,
} from "./shareDestinations";
import { prepareShareForThread, sendSharedNewChat } from "./sendSharedNewChat";
import type { PendingAttachment } from "../inbox/thread/pendingAttachments";
import type { ValidatedStagedShare } from "./shareValidation";

const SHARE_NEW_CHAT_SCOPE = "mobile-share-new-chat";

export interface SendToSheetProps {
  readonly share: ValidatedStagedShare | undefined;
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly bots?: ReadonlyArray<ShareBotRow> | undefined;
  readonly projectName: (row: MobileInboxRow) => string | undefined;
  readonly standingForHost: (hostId: string) => RemoteSessionStanding | undefined;
  readonly onDiscard: (shareId: string) => void;
  readonly onNewChatSent: (shareId: string, row: MobileInboxRow) => void;
  readonly onPopulateThread: (handoff: {
    readonly shareId: string;
    readonly row: MobileInboxRow;
    readonly text: string;
    readonly attachments: ReadonlyArray<PendingAttachment>;
  }) => void;
}

function summarizeShare(share: ValidatedStagedShare): string {
  const parts: string[] = [];
  if (share.textParts.length > 0) {
    const first = share.textParts[0]?.trim() ?? "";
    const snippet = first.length <= 64 ? first : `${first.slice(0, 63).trimEnd()}…`;
    if (snippet.length > 0) parts.push(snippet);
  }
  const count = share.attachments.length;
  if (count > 0) {
    parts.push(count === 1 ? (share.attachments[0]?.displayName ?? "1 file") : `${count} files`);
  }
  return parts.join(" · ") || "Shared item";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The "Send to…" sheet shown behind AppVaultGate over MobileSessionContext
 * whenever staged items wait from the iOS share extension or Android SEND
 * intent. Never sends automatically; always names the chosen computer.
 */
export function SendToSheet(props: SendToSheetProps) {
  const { colors } = useTheme();
  const { hosts, health, transportForHost, placementHostId } = useMobileSession();
  const hostOptions = useMemo(
    () =>
      evaluateShareHosts({
        hosts,
        health,
        transportForHost,
        standingForHost: props.standingForHost,
      }),
    [health, hosts, props.standingForHost, transportForHost],
  );
  const defaultHostId = useMemo(() => {
    const placement = hostOptions.find((host) => host.hostId === placementHostId && host.enabled);
    if (placement !== undefined) return placement.hostId;
    return hostOptions.find((host) => host.enabled)?.hostId ?? hostOptions[0]?.hostId;
  }, [hostOptions, placementHostId]);

  const [selectedHostId, setSelectedHostId] = useState<string | undefined>(defaultHostId);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<"pick" | "new-chat">("pick");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const shareId = props.share?.id;
  // Reset share-specific state only when a different staged share arrives.
  // Host availability changes reconcile separately so a momentary reconnect
  // never wipes an edited New chat draft or clears an in-flight send.
  useEffect(() => {
    setStep("pick");
    setQuery("");
    setDraft("");
    setBusy(false);
    setError(undefined);
    setSelectedHostId(undefined);
  }, [shareId]);

  useEffect(() => {
    setSelectedHostId((currentHostId) =>
      reconcileSelectedShareHost({
        currentHostId,
        defaultHostId,
        hostOptions,
        step,
        busy,
      }),
    );
  }, [busy, defaultHostId, hostOptions, shareId, step]);

  useEffect(() => {
    if (step === "new-chat") {
      composerValueShown(SHARE_NEW_CHAT_SCOPE, draft);
    }
  }, [draft, step]);

  const activeHost = hostOptions.find((host) => host.hostId === selectedHostId) ?? hostOptions[0];
  const activeHostId = activeHost?.hostId;
  const activeTransport = activeHostId === undefined ? undefined : transportForHost(activeHostId);
  const models = usePlacementHostModels(activeTransport);
  const defaultChatModel = models.options[0];

  const destinations = useMemo<ReadonlyArray<ShareDestination>>(
    () =>
      activeHostId === undefined
        ? []
        : listShareDestinations({
            hostId: activeHostId,
            rows: props.rows,
            bots: props.bots,
            projectName: props.projectName,
            query,
          }),
    [activeHostId, props.bots, props.projectName, props.rows, query],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { flex: 1, gap: space.sm, paddingBottom: space.md },
        summaryBox: {
          marginHorizontal: space.md,
          padding: space.sm,
          borderRadius: radii.md,
          backgroundColor: colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
          gap: 4,
        },
        summaryText: { color: colors.textPrimary, fontSize: typography.detail.fontSize },
        hintText: { color: colors.textSecondary, fontSize: typography.caption.fontSize },
        errorText: {
          marginHorizontal: space.md,
          color: colors.danger,
          fontSize: typography.caption.fontSize,
          lineHeight: 18,
        },
        searchWrap: {
          marginHorizontal: space.md,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          minHeight: 38,
          borderRadius: radii.pill,
          backgroundColor: colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
        },
        searchInput: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          paddingVertical: 6,
        },
        scroll: { flex: 1 },
        footerBar: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space.md,
          paddingTop: space.xs,
        },
        discardText: {
          color: colors.danger,
          fontSize: typography.detail.fontSize,
          fontWeight: "600",
        },
        backText: {
          color: colors.accent,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        composerWrap: { paddingHorizontal: space.md, gap: space.sm, flex: 1 },
        composerCard: {
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 6,
          paddingLeft: 12,
          paddingRight: 6,
          paddingVertical: 6,
        },
        composerInput: {
          flex: 1,
          minHeight: 72,
          maxHeight: 200,
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          lineHeight: 22,
          textAlignVertical: "top",
        },
        attachmentChip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: radii.sm,
          backgroundColor: colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
        },
        attachmentName: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
        },
        attachmentSize: { color: colors.textTertiary, fontSize: typography.caption.fontSize },
        sendButton: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          minHeight: 44,
          borderRadius: radii.pill,
          backgroundColor: colors.accent,
          paddingHorizontal: space.md,
        },
        sendButtonDisabled: { opacity: 0.45 },
        sendButtonText: {
          color: colors.primaryForeground,
          fontSize: typography.rowLabel.fontSize,
          fontWeight: "600",
        },
      }),
    [colors],
  );

  const share = props.share;
  if (share === undefined) return null;

  const handleChooseDestination = async (destination: ShareDestination) => {
    if (busy || activeHost === undefined) return;
    setError(undefined);
    if (!activeHost.enabled) {
      setError(activeHost.disabledReason ?? MOBILE_COPY.shareComputerUnreachable);
      return;
    }
    if (destination.kind === "bot") {
      setError("Sending to bots will be enabled once bots are available.");
      return;
    }
    if (destination.kind === "new-chat") {
      const mapped = mapShareForDestination({
        share,
        mode: "chat",
        model: defaultChatModel,
      });
      if (mapped.status === "refused") {
        setError(mapped.reason);
        return;
      }
      setDraft(mapped.text);
      setStep("new-chat");
      return;
    }

    const providerModels =
      destination.row.providerInstanceId === undefined
        ? []
        : models.options.filter(
            (option) => option.providerInstanceId === destination.row.providerInstanceId,
          );
    // Only apply model-level modality checks from the list when every ready
    // model on that provider agrees (or only one exists); the thread's exact
    // model is checked again once the thread is opened.
    const threadModel = providerModels.length === 1 ? providerModels[0] : undefined;
    const mapped = mapShareForDestination({
      share,
      mode: destination.mode,
      model: threadModel,
    });
    if (mapped.status === "refused") {
      setError(mapped.reason);
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepareShareForThread({
        hostLabel: activeHost.label,
        health: health.find((entry) => entry.hostId === activeHost.hostId),
        transport: activeTransport,
        standing: props.standingForHost(activeHost.hostId),
        row: destination.row,
        attachments: mapped.attachments,
      });
      if (prepared.status === "refused") {
        setError(prepared.message);
        return;
      }
      props.onPopulateThread({
        shareId: share.id,
        row: destination.row,
        text: mapped.text,
        attachments: prepared.uploaded,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSendNewChat = async () => {
    if (busy || activeHost === undefined) return;
    setError(undefined);
    const mapped = mapShareForDestination({
      share,
      mode: "chat",
      model: defaultChatModel,
    });
    if (mapped.status === "refused") {
      setError(mapped.reason);
      return;
    }
    const typedClaim = typedClaimFor(SHARE_NEW_CHAT_SCOPE, draft);
    setBusy(true);
    try {
      const outcome = await sendSharedNewChat({
        hostId: activeHost.hostId,
        hostLabel: activeHost.label,
        health: health.find((entry) => entry.hostId === activeHost.hostId),
        transport: activeTransport,
        standing: props.standingForHost(activeHost.hostId),
        prompt: draft,
        ...(typedClaim.typedByPerson === true ? { typedByPerson: true as const } : {}),
        attachments: mapped.attachments,
        onCleanupStaged: async () => undefined,
      });
      if (outcome.status === "refused") {
        setError(outcome.message);
        return;
      }
      props.onNewChatSent(share.id, outcome.row);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      contentStyle={styles.content}
      dismissible={!busy}
      onClose={() => props.onDiscard(share.id)}
      size="full"
      testID="mobile-share-send-to-sheet"
      title={MOBILE_COPY.shareTitle}
      visible={true}
    >
      <View style={styles.summaryBox} testID="mobile-share-summary">
        <Text numberOfLines={2} style={styles.summaryText}>
          {summarizeShare(share)}
        </Text>
        <Text style={styles.hintText}>{MOBILE_COPY.shareReviewHint}</Text>
      </View>

      {share.refusal !== undefined ? (
        <Text style={styles.errorText} testID="mobile-share-refusal">
          {share.refusal.message}
        </Text>
      ) : null}
      {error !== undefined ? (
        <Text style={styles.errorText} testID="mobile-share-error">
          {error}
        </Text>
      ) : null}

      {step === "pick" ? (
        <>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
            <ListSection title={MOBILE_COPY.workspaces}>
              {hostOptions.length === 0 ? (
                <ListNote last text={MOBILE_COPY.shareNoComputers} />
              ) : (
                hostOptions.map((host, index) => (
                  <ListRow
                    accessory={host.enabled && host.hostId === activeHostId ? "check" : "none"}
                    detail={host.disabledReason}
                    detailTone={host.enabled ? undefined : colors.textTertiary}
                    icon="desktop-outline"
                    key={host.hostId}
                    label={formatScreenshotSafeLabel(host.label)}
                    labelTone={host.enabled ? undefined : colors.textTertiary}
                    last={index === hostOptions.length - 1}
                    onPress={
                      host.enabled
                        ? () => {
                            setSelectedHostId(host.hostId);
                            setError(undefined);
                          }
                        : undefined
                    }
                    testID={`mobile-share-host-${host.hostId}`}
                  />
                ))
              )}
            </ListSection>

            {activeHost !== undefined && activeHost.enabled ? (
              <>
                <View style={styles.searchWrap}>
                  <Icon color={colors.textTertiary} name="search" size={16} />
                  <TextInput
                    onChangeText={setQuery}
                    placeholder={MOBILE_COPY.shareSearchPlaceholder}
                    placeholderTextColor={colors.textTertiary}
                    style={styles.searchInput}
                    testID="mobile-share-search"
                    value={query}
                  />
                  {query.length > 0 ? (
                    <IconButton
                      accessibilityLabel="Clear search"
                      iconSize={15}
                      name="close-circle"
                      onPress={() => setQuery("")}
                      size={26}
                      variant="ghost"
                    />
                  ) : null}
                </View>

                <ListSection title="Destination">
                  {destinations.length === 0 ? (
                    <ListNote last text={MOBILE_COPY.shareNoDestinations} />
                  ) : (
                    destinations.map((destination, index) => {
                      const last = index === destinations.length - 1;
                      if (destination.kind === "new-chat") {
                        return (
                          <ListRow
                            accessory="chevron"
                            icon="create-outline"
                            key="new-chat"
                            label={destination.title}
                            last={last}
                            onPress={() => void handleChooseDestination(destination)}
                            testID="mobile-share-dest-new-chat"
                          />
                        );
                      }
                      if (destination.kind === "bot") {
                        return (
                          <ListRow
                            accessory="chevron"
                            detail={destination.subtitle}
                            icon="sparkles-outline"
                            key={`bot:${destination.botId}`}
                            label={formatScreenshotSafeLabel(destination.title)}
                            last={last}
                            onPress={() => void handleChooseDestination(destination)}
                            testID={`mobile-share-dest-bot-${destination.botId}`}
                          />
                        );
                      }
                      const detailParts = [
                        destination.mode === "chat"
                          ? "Chat"
                          : destination.mode === "work"
                            ? "Work"
                            : "Code",
                        ...(destination.projectName === undefined
                          ? []
                          : [formatScreenshotSafeLabel(destination.projectName)]),
                      ];
                      return (
                        <ListRow
                          accessory="chevron"
                          detail={detailParts.join(" · ")}
                          icon={
                            destination.mode === "code"
                              ? "code-slash"
                              : destination.mode === "work"
                                ? "folder-outline"
                                : "chatbubble-outline"
                          }
                          key={`thread:${destination.mode}:${destination.threadId}`}
                          label={formatScreenshotSafeLabel(destination.title)}
                          last={last}
                          onPress={() => void handleChooseDestination(destination)}
                          testID={`mobile-share-dest-thread-${destination.threadId}`}
                        />
                      );
                    })
                  )}
                </ListSection>
              </>
            ) : null}
          </ScrollView>

          <View style={styles.footerBar}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => props.onDiscard(share.id)}
              testID="mobile-share-discard"
            >
              <Text style={styles.discardText}>{MOBILE_COPY.shareDiscard}</Text>
            </Pressable>
            {busy ? <ActivityIndicator color={colors.accent} /> : null}
          </View>
        </>
      ) : (
        <View style={styles.composerWrap} testID="mobile-share-new-chat-composer">
          <View style={styles.footerBar}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                setStep("pick");
                setError(undefined);
              }}
              testID="mobile-share-back"
            >
              <Text style={styles.backText}>{MOBILE_COPY.shareBack}</Text>
            </Pressable>
            <Text style={styles.hintText}>
              {activeHost === undefined
                ? ""
                : MOBILE_COPY.shareNewChatTarget(formatScreenshotSafeLabel(activeHost.label))}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => props.onDiscard(share.id)}
              testID="mobile-share-discard"
            >
              <Text style={styles.discardText}>{MOBILE_COPY.shareDiscard}</Text>
            </Pressable>
          </View>

          <ComposerSurface contentStyle={styles.composerCard}>
            <TextInput
              editable={!busy}
              multiline
              onChangeText={(next) => {
                noteTypedComposerText(SHARE_NEW_CHAT_SCOPE, next);
                setDraft(next);
              }}
              placeholder={MOBILE_COPY.shareNewChatPlaceholder}
              placeholderTextColor={colors.textTertiary}
              style={styles.composerInput}
              testID="mobile-share-new-chat-input"
              value={draft}
            />
          </ComposerSurface>

          {share.attachments.map((attachment, index) => (
            <View
              key={`${attachment.displayName}-${index}`}
              style={styles.attachmentChip}
              testID={`mobile-share-attachment-${index}`}
            >
              <Icon
                color={colors.textSecondary}
                name={attachment.kind === "image" ? "image-outline" : "document-outline"}
                size={16}
              />
              <Text numberOfLines={1} style={styles.attachmentName}>
                {attachment.displayName}
              </Text>
              <Text style={styles.attachmentSize}>{formatBytes(attachment.bytes.byteLength)}</Text>
            </View>
          ))}

          <Pressable
            accessibilityRole="button"
            disabled={
              busy || draft.trim().length === 0 || activeHost === undefined || !activeHost.enabled
            }
            onPress={() => void handleSendNewChat()}
            style={[
              styles.sendButton,
              busy || draft.trim().length === 0 || activeHost === undefined || !activeHost.enabled
                ? styles.sendButtonDisabled
                : null,
            ]}
            testID="mobile-share-new-chat-send"
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.sendButtonText}>
                {activeHost === undefined
                  ? "Send"
                  : MOBILE_COPY.shareNewChatSendTo(formatScreenshotSafeLabel(activeHost.label))}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </BottomSheet>
  );
}
