import { Fragment, useMemo, type ReactElement } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Icon } from "../../ui/Icon";
import {
  chatAttemptStatusLabel,
  mobileChatMessages,
  mobileCodeTurnTargets,
  mobileWorkTurnTargets,
  threadRoutineReceipts,
  type MobileCodeConversation,
  type MobileModelOption,
  type MobileProviderDirectoryEntry,
  type MobileTurnTargets,
} from "@octant/client-runtime";
import type { ChatAttachment, ReplyDetailLevel, WorkTurnState } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { mobileSpacing, mobileTypography } from "../../theme/tokens";
import { useTheme } from "../../../design-system";
import { AttemptStatus } from "../../ui/AttemptStatus";
import { MessageBubble } from "../../ui/MessageBubble";
import { RoutineReceiptCard } from "../../ui/RoutineReceiptCard";
import { TranscriptHandoffDivider } from "../../ui/TranscriptHandoffDivider";
import {
  mobileChatTranscriptAnnotations,
  resolveMobileTranscriptHandoff,
  type MobileChatTranscriptAnnotations,
  type MobileTranscriptHandoffEntry,
} from "../../ui/transcriptHandoffPresentation";
import type { MessageActionItem } from "../../ui/MessageActions";
import {
  codeTurnActivity,
  isLiveWorkTurn,
  workTurnActivity,
  type TurnActivity,
} from "./turnActivity";
import { TurnActivityView, TurnFilesView } from "./TurnActivityView";
import { ThreadWorkShelf } from "../../ui/ThreadWorkShelf";
import { placeAttachments } from "./attachmentPlacement";
import type { useChatThread } from "./useChatThread";

type ChatThread = ReturnType<typeof useChatThread>;

export interface ThreadTranscriptProps {
  readonly workTurns: ReadonlyArray<WorkTurnState> | undefined;
  readonly codeConversation: MobileCodeConversation | undefined;
  readonly chat: ChatThread;
  /** Opens a Code thread's changes; absent where they cannot be read. */
  readonly onOpenReview?: (() => void) | undefined;
  readonly allowProductMutations: boolean;
  /** Fork from here and Rewind to here for one message; empty where none can run. */
  readonly turnActionsFor: (
    targets: MobileTurnTargets | undefined,
  ) => ReadonlyArray<MessageActionItem>;
  /** The thread's Reply detail level, the host's per-thread choice or its default. */
  readonly replyDetail: ReplyDetailLevel;
  /** Host-advertised models, for resolving provider and model names on handoff dividers. */
  readonly modelOptions?: ReadonlyArray<MobileModelOption>;
  /** Full provider directory (including disabled/unready accounts) for historical handoff labels. */
  readonly providerDirectory?: ReadonlyArray<MobileProviderDirectoryEntry>;
  /**
   * A turn to bring into view, from a message search hit: its row is marked
   * so the screen can scroll to it. The id is the
   * one each mode keys its turns by: a Chat or Work turn id, or the operation
   * of a Code provider turn.
   */
  readonly focus?: { readonly turnId: string };
}

export interface TranscriptRow {
  readonly key: string;
  /** The turn a message search named. */
  readonly focused: boolean;
  readonly node: ReactElement;
}

/**
 * The person's messages the runtime took into a turn while it ran. The agent
 * read them mid-turn rather than in a turn of their own, so they sit inside
 * that turn, after its reply, and say so, as on the desktop.
 */
function SteeredMessages(props: {
  readonly steered: WorkTurnState["steeredMessages"];
  readonly replyDetail: ReplyDetailLevel;
  readonly testID: string;
}) {
  const { colors } = useTheme();
  if (props.steered === undefined || props.steered.length === 0) return null;
  return props.steered.map((entry) => (
    // No accessibilityLabel: on a View it would replace the message's own text
    // for a screen reader, and the visible heading already says how it was sent.
    <View key={entry.messageId} testID={`${props.testID}-${entry.messageId}`}>
      <Text style={{ color: colors.textSecondary, fontSize: 12, textAlign: "right" }}>
        {MOBILE_COPY.steeredMessage}
      </Text>
      <MessageBubble
        body={entry.body}
        replyDetail={props.replyDetail}
        role="user"
        showActions={false}
      />
    </View>
  ));
}

function TurnFiles(props: {
  readonly activity: TurnActivity;
  readonly onReview?: (() => void) | undefined;
  readonly testID: string;
}) {
  return props.activity.files === undefined ? null : (
    <TurnFilesView files={props.activity.files} onReview={props.onReview} testID={props.testID} />
  );
}

/**
 * The transcript as rows, one per turn or message, so a list can draw only
 * those in view.
 */
export function useThreadTranscriptRows(
  props: ThreadTranscriptProps,
): ReadonlyArray<TranscriptRow> {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        transcript: { gap: mobileSpacing.sm, paddingTop: mobileSpacing.sm },
        chatHead: { gap: mobileSpacing.sm },
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
          fontSize: 20,
          fontWeight: "600",
          letterSpacing: -0.4,
          textAlign: "center",
        },
        emptyBody: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 20,
          textAlign: "center",
          maxWidth: 280,
        },
        metaBlock: { gap: mobileSpacing.xs, marginBottom: mobileSpacing.sm },
        chipRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: mobileSpacing.xs,
        },
        chipRowUser: { justifyContent: "flex-end", marginTop: -2 },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          maxWidth: "84%",
          minHeight: 26,
          paddingHorizontal: 9,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        messageWithAttachments: { gap: mobileSpacing.xs },
        chipLabel: { flexShrink: 1, color: colors.textSecondary, fontSize: 12 },
        metaText: { color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
        warningText: { color: colors.danger, fontSize: 12, lineHeight: 16 },
      }),
    [colors],
  );
  const { chat, workTurns, codeConversation } = props;
  const modelOptions = props.modelOptions ?? [];
  const providerDirectory = props.providerDirectory ?? [];
  const codeTurns = codeConversation?.turns;
  const view = chat.view;
  const messages = useMemo(() => (view === undefined ? [] : mobileChatMessages(view)), [view]);
  // A Chat's message holds no time; the turn it opened does.
  const sentAt = useMemo(
    () =>
      new Map(
        (view?.turns ?? []).map((turn) => [String(turn.userMessageRef.contentId), turn.createdAt]),
      ),
    [view],
  );
  const chatAnnotations = useMemo<MobileChatTranscriptAnnotations>(() => {
    if (view === undefined) {
      return { beforeContentId: new Map(), afterContentId: new Map(), trailing: [] };
    }
    const shownIds = new Set(messages.map((entry) => String(entry.content.contentId)));
    return mobileChatTranscriptAnnotations(view, modelOptions, providerDirectory, shownIds);
  }, [messages, modelOptions, providerDirectory, view]);
  const workHandoffs = useMemo(() => {
    const map = new Map<string, MobileTranscriptHandoffEntry>();
    if (workTurns === undefined) return map;
    for (let index = 0; index < workTurns.length; index += 1) {
      const turn = workTurns[index];
      if (turn === undefined) continue;
      const previous = index > 0 ? workTurns[index - 1] : undefined;
      const entry = resolveMobileTranscriptHandoff({
        previous: previous?.authority,
        current: turn.authority,
        handoff: turn.handoff,
        modelOptions,
        providerDirectory,
      });
      if (entry !== undefined) map.set(String(turn.turnId), entry);
    }
    return map;
  }, [modelOptions, providerDirectory, workTurns]);
  const codeHandoffs = useMemo(() => {
    const map = new Map<string, MobileTranscriptHandoffEntry>();
    if (codeTurns === undefined) return map;
    let previous: { readonly providerInstanceId: string; readonly modelId: string } | undefined;
    for (const turn of codeTurns) {
      const current =
        turn.providerInstanceId !== undefined && turn.modelId !== undefined
          ? { providerInstanceId: turn.providerInstanceId, modelId: turn.modelId }
          : undefined;
      const entry = resolveMobileTranscriptHandoff({
        previous,
        current,
        handoff: turn.handoff,
        modelOptions,
        providerDirectory,
      });
      if (entry !== undefined) map.set(turn.operationId, entry);
      if (current !== undefined) previous = current;
    }
    return map;
  }, [codeTurns, modelOptions, providerDirectory]);
  const attachmentsByMessage = useMemo(
    () =>
      view === undefined
        ? new Map<string, ReadonlyArray<ChatAttachment>>()
        : placeAttachments({
            attachments: view.attachments,
            turns: view.turns,
            shownMessageIds: messages.map((entry) => String(entry.content.contentId)),
          }),
    [messages, view],
  );
  const attachmentChips = (attachments: ReadonlyArray<ChatAttachment>, user: boolean) => (
    <View style={[styles.chipRow, user ? styles.chipRowUser : null]}>
      {attachments.map((attachment) => (
        <View
          accessibilityLabel={`${MOBILE_COPY.attachmentLabel}: ${attachment.displayName}`}
          key={String(attachment.id)}
          style={styles.chip}
          testID={`mobile-attachment-${String(attachment.id)}`}
        >
          <Icon
            color={colors.textTertiary}
            name={attachment.mediaType.startsWith("image/") ? "image-outline" : "document-outline"}
            size={13}
          />
          <Text numberOfLines={1} style={styles.chipLabel}>
            {attachment.displayName}
          </Text>
        </View>
      ))}
    </View>
  );
  const looseAttachments = attachmentsByMessage.get("") ?? [];
  const focusContentId =
    props.focus === undefined || view === undefined
      ? undefined
      : view.turns
          .find((turn) => String(turn.id) === props.focus?.turnId)
          ?.userMessageRef.contentId.toString();
  // A search hit names a turn; its row is marked so the list can bring it into view.
  const focusMark = (focused: boolean, testID: string) => (focused ? { testID } : {});
  const rows: TranscriptRow[] = [];
  const row = (key: string, node: ReactElement, focused = false) =>
    rows.push({ key, focused, node });

  if (workTurns !== undefined) {
    if (workTurns.length === 0)
      row("work-empty", <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>);
    workTurns.forEach((turn, index) => {
      const handoff = workHandoffs.get(String(turn.turnId));
      row(
        `work:${String(turn.turnId)}`,
        <View
          style={styles.transcript}
          {...focusMark(String(turn.turnId) === props.focus?.turnId, "mobile-thread-focused-turn")}
        >
          {handoff === undefined ? null : (
            <TranscriptHandoffDivider
              entry={handoff}
              testID={`mobile-work-handoff-${String(turn.turnId)}`}
            />
          )}
          <MessageBubble
            at={turn.acceptedAt}
            replyDetail={props.replyDetail}
            body={turn.prompt}
            role="user"
            showActions={false}
            testID={`mobile-work-prompt-${String(turn.turnId)}`}
            turnActions={props.turnActionsFor(mobileWorkTurnTargets(workTurns, index, "user"))}
          />
          <TurnActivityView
            activity={workTurnActivity(turn)}
            live={isLiveWorkTurn(turn)}
            replyDetail={props.replyDetail}
            testID={`mobile-work-activity-${String(turn.turnId)}`}
          />
          {turn.response !== undefined && turn.response.length > 0 ? (
            <MessageBubble
              {...(turn.status === "completed" ? { at: turn.updatedAt } : {})}
              replyDetail={props.replyDetail}
              body={turn.response}
              role="assistant"
              testID={`mobile-work-reply-${String(turn.turnId)}`}
              turnActions={props.turnActionsFor(
                turn.status === "completed"
                  ? mobileWorkTurnTargets(workTurns, index, "assistant")
                  : undefined,
              )}
            />
          ) : turn.failure !== undefined ? (
            <Text style={styles.warningText}>{turn.failure.message}</Text>
          ) : null}
          <SteeredMessages
            replyDetail={props.replyDetail}
            steered={turn.steeredMessages}
            testID={`mobile-work-steered-${String(turn.turnId)}`}
          />
          <TurnFiles
            activity={workTurnActivity(turn)}
            testID={`mobile-work-files-${String(turn.turnId)}`}
          />
          {threadRoutineReceipts(turn.toolSteps).map((routine) => (
            <RoutineReceiptCard
              key={routine.routineId}
              routine={routine}
              testID={`mobile-work-routine-${routine.routineId}`}
            />
          ))}
        </View>,
        String(turn.turnId) === props.focus?.turnId,
      );
    });
  }
  if (codeTurns !== undefined) {
    if (codeConversation?.hasEarlier === true)
      row("code-earlier", <Text style={styles.metaText}>{MOBILE_COPY.codeEarlierTurns}</Text>);
    if (codeTurns.length === 0)
      row("code-empty", <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>);
    codeTurns.forEach((turn, turnIndex) => {
      const handoff = codeHandoffs.get(turn.operationId);
      row(
        `code:${turn.operationId}`,
        <View
          style={styles.transcript}
          {...focusMark(
            String(turn.operationId) === props.focus?.turnId,
            "mobile-thread-focused-turn",
          )}
        >
          {handoff === undefined ? null : (
            <TranscriptHandoffDivider
              entry={handoff}
              testID={`mobile-code-handoff-${turn.operationId}`}
            />
          )}
          {turn.prompt.length === 0 ? null : (
            <MessageBubble
              at={turn.startedAt}
              replyDetail={props.replyDetail}
              body={turn.prompt}
              role="user"
              showActions={false}
              testID={`mobile-code-prompt-${turn.operationId}`}
              turnActions={props.turnActionsFor(
                mobileCodeTurnTargets(codeTurns, turnIndex, "user"),
              )}
            />
          )}
          <TurnActivityView
            activity={codeTurnActivity(turn)}
            live={turn.status === "waiting"}
            replyDetail={props.replyDetail}
            testID={`mobile-code-activity-${turn.operationId}`}
          />
          {turn.assistant.map((part, index) => (
            <MessageBubble
              replyDetail={props.replyDetail}
              body={part}
              key={`${turn.operationId}-${index}`}
              role="assistant"
              testID={`mobile-code-reply-${turn.operationId}-${index}`}
              {...(index === turn.assistant.length - 1
                ? {
                    ...(turn.status === "completed" ? { at: turn.updatedAt } : {}),
                    turnActions: props.turnActionsFor(
                      mobileCodeTurnTargets(codeTurns, turnIndex, "assistant"),
                    ),
                  }
                : {})}
            />
          ))}
          <SteeredMessages
            replyDetail={props.replyDetail}
            steered={turn.steeredMessages}
            testID={`mobile-code-steered-${turn.operationId}`}
          />
          {turn.status === "waiting" && turn.usageLimit !== undefined ? (
            <Text style={styles.metaText}>{MOBILE_COPY.turnWaitingOnUsageLimit}</Text>
          ) : turn.status === "failed" || turn.status === "interrupted" ? (
            <Text style={styles.warningText}>{chatAttemptStatusLabel(turn.status)}</Text>
          ) : null}
          <TurnFiles
            activity={codeTurnActivity(turn)}
            onReview={props.onOpenReview}
            testID={`mobile-code-files-${turn.operationId}`}
          />
          {turn.routines.map((routine) => (
            <RoutineReceiptCard
              key={routine.routineId}
              routine={routine}
              testID={`mobile-code-routine-${routine.routineId}`}
            />
          ))}
        </View>,
        String(turn.operationId) === props.focus?.turnId,
      );
    });
  }
  if (view !== undefined) {
    row(
      "chat-head",
      <View style={styles.chatHead}>
        {chat.pendingPrompt !== undefined ? (
          <Text style={styles.metaText} testID="mobile-chat-pending">
            Sending… {chat.pendingPrompt}
          </Text>
        ) : null}
        {chat.pendingFailure !== undefined ? (
          <Text style={styles.warningText} testID="mobile-chat-failure">
            {chat.pendingFailure}
          </Text>
        ) : null}
        {chat.activeAttempt !== undefined ? (
          <AttemptStatus
            outcome={chat.activeAttempt.outcome}
            testID="mobile-thread-attempt-status"
          />
        ) : chat.retryableAttempt !== undefined ? (
          <AttemptStatus
            outcome={chat.retryableAttempt.outcome}
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
          {...(props.allowProductMutations
            ? {
                onCompleteItem: chat.completeWorkItem,
                onCancelItem: chat.cancelWorkItem,
                onCompleteFollowUp: chat.completeFollowUp,
              }
            : {})}
        />
        {looseAttachments.length > 0 || view.citations.length > 0 ? (
          <View style={styles.metaBlock} testID="mobile-thread-meta">
            {looseAttachments.length > 0 ? attachmentChips(looseAttachments, false) : null}
            {view.citations.map((citation) => (
              <Text key={String(citation.citationId)} style={styles.metaText}>
                {MOBILE_COPY.citationLabel}: {citation.sourceTitle}
              </Text>
            ))}
          </View>
        ) : null}
      </View>,
    );
    if (messages.length === 0)
      row(
        "chat-empty",
        <View style={styles.emptyChat} testID="mobile-thread-empty">
          <Text style={styles.emptyTitle}>{MOBILE_COPY.threadStart}</Text>
          <Text style={styles.emptyBody}>{MOBILE_COPY.threadStartHelp}</Text>
        </View>,
      );
    messages.forEach(({ content, targets }, index) => {
      const isLastAssistant =
        index ===
        messages.reduce(
          (last, entry, i) =>
            entry.content.role.toLowerCase() !== "user" &&
            entry.content.role.toLowerCase() !== "human"
              ? i
              : last,
          -1,
        );
      const retryable = chat.retryableAttempt;
      const showRetry =
        isLastAssistant &&
        retryable !== undefined &&
        chat.activeAttempt === undefined &&
        props.allowProductMutations;
      const sentWith = attachmentsByMessage.get(String(content.contentId)) ?? [];
      const annotationsBefore =
        chatAnnotations.beforeContentId.get(String(content.contentId)) ?? [];
      const annotationsAfter = chatAnnotations.afterContentId.get(String(content.contentId)) ?? [];
      row(
        `chat:${String(content.contentId)}`,
        <View
          {...focusMark(
            String(content.contentId) === focusContentId,
            "mobile-thread-focused-message",
          )}
          style={styles.messageWithAttachments}
        >
          {annotationsBefore.map((annotation, itemIndex) =>
            annotation.kind === "handoff" ? (
              <TranscriptHandoffDivider
                entry={annotation.entry}
                key={`before-${String(content.contentId)}-${String(itemIndex)}`}
                testID={`mobile-chat-handoff-${String(content.contentId)}`}
              />
            ) : (
              <Text
                key={`described-before-${String(content.contentId)}-${String(itemIndex)}`}
                style={styles.metaText}
                testID={`mobile-chat-described-images-${String(content.contentId)}-${String(itemIndex)}`}
              >
                {annotation.text}
              </Text>
            ),
          )}
          <MessageBubble
            at={sentAt.get(String(content.contentId))}
            replyDetail={props.replyDetail}
            body={content.body}
            role={content.role}
            showActions={isLastAssistant}
            testID={`mobile-message-${content.contentId}`}
            turnActions={props.turnActionsFor(targets)}
            {...(content.parts === undefined ? {} : { parts: content.parts })}
            {...(showRetry
              ? {
                  extraActions: [
                    {
                      id: "retry",
                      label: `Retry ${chatAttemptStatusLabel(retryable.outcome).toLowerCase()}`,
                      icon: "refresh-outline" as const,
                      onPress: () => void chat.retry(),
                    },
                  ],
                }
              : {})}
          />
          {sentWith.length > 0 ? attachmentChips(sentWith, true) : null}
          {annotationsAfter.map((annotation, itemIndex) =>
            annotation.kind === "handoff" ? (
              <TranscriptHandoffDivider
                entry={annotation.entry}
                key={`after-${String(content.contentId)}-${String(itemIndex)}`}
                testID={`mobile-chat-handoff-after-${String(content.contentId)}-${String(itemIndex)}`}
              />
            ) : (
              <Text
                key={`described-after-${String(content.contentId)}-${String(itemIndex)}`}
                style={styles.metaText}
                testID={`mobile-chat-described-images-after-${String(content.contentId)}-${String(itemIndex)}`}
              >
                {annotation.text}
              </Text>
            ),
          )}
        </View>,
        String(content.contentId) === focusContentId,
      );
    });
    if (chatAnnotations.trailing.length > 0)
      row(
        "chat-trailing",
        <View style={styles.transcript}>
          {chatAnnotations.trailing.map((annotation, itemIndex) =>
            annotation.kind === "handoff" ? (
              <TranscriptHandoffDivider
                entry={annotation.entry}
                key={`trailing-${String(itemIndex)}`}
                testID={`mobile-chat-handoff-trailing-${String(itemIndex)}`}
              />
            ) : (
              <Text
                key={`described-trailing-${String(itemIndex)}`}
                style={styles.metaText}
                testID={`mobile-chat-described-images-trailing-${String(itemIndex)}`}
              >
                {annotation.text}
              </Text>
            ),
          )}
        </View>,
      );
  }
  return rows;
}

/** The transcript drawn whole, where it is short or no list holds it. */
export function ThreadTranscript(props: ThreadTranscriptProps) {
  return (
    <>
      {useThreadTranscriptRows(props).map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
    </>
  );
}
