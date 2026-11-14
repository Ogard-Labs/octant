import { useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  chatAttemptStatusLabel,
  mobileChatMessages,
  mobileCodeTurnTargets,
  mobileWorkTurnTargets,
  threadRoutineReceipts,
  type MobileCodeConversation,
  type MobileTurnTargets,
} from "@octant/client-runtime";
import type { ChatAttachment, ReplyDetailLevel, WorkTurnState } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { mobileSpacing, mobileTypography } from "../../theme/tokens";
import { useTheme } from "../../../design-system";
import { AttemptStatus } from "../../ui/AttemptStatus";
import { MessageBubble } from "../../ui/MessageBubble";
import { RoutineReceiptCard } from "../../ui/RoutineReceiptCard";
import type { MessageActionItem } from "../../ui/MessageActions";
import { ThreadWorkShelf } from "../../ui/ThreadWorkShelf";
import { placeAttachments } from "./attachmentPlacement";
import type { useChatThread } from "./useChatThread";

type ChatThread = ReturnType<typeof useChatThread>;

export interface ThreadTranscriptProps {
  readonly workTurns: ReadonlyArray<WorkTurnState> | undefined;
  readonly codeConversation: MobileCodeConversation | undefined;
  readonly chat: ChatThread;
  readonly allowProductMutations: boolean;
  /** Fork from here and Rewind to here for one message; empty where none can run. */
  readonly turnActionsFor: (
    targets: MobileTurnTargets | undefined,
  ) => ReadonlyArray<MessageActionItem>;
  /** The thread's Reply detail level, the host's per-thread choice or its default. */
  readonly replyDetail: ReplyDetailLevel;
  /**
   * A turn to bring into view, from a message search hit: the transcript
   * reports where that turn sits so the screen can scroll to it. The id is the
   * one each mode keys its turns by: a Chat or Work turn id, or the operation
   * of a Code provider turn.
   */
  readonly focus?: { readonly turnId: string; readonly onFound: (y: number) => void };
}

export function ThreadTranscript(props: ThreadTranscriptProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
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
  const codeTurns = codeConversation?.turns;
  const view = chat.view;
  const messages = useMemo(() => (view === undefined ? [] : mobileChatMessages(view)), [view]);
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
          <Ionicons
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
  const sectionY = useRef<number | undefined>(undefined);
  const messageY = useRef<number | undefined>(undefined);
  const reported = useRef(false);
  const reportFocus = () => {
    if (reported.current || sectionY.current === undefined || messageY.current === undefined)
      return;
    reported.current = true;
    props.focus?.onFound(sectionY.current + messageY.current);
  };
  const onSectionLayout = (event: { nativeEvent: { layout: { y: number } } }) => {
    sectionY.current = event.nativeEvent.layout.y;
    reportFocus();
  };
  // Work and Code render one View per turn, so the focused turn's View reports
  // where it sits, as the focused Chat message does.
  const focusTurnLayout = (turnId: string) =>
    turnId === props.focus?.turnId
      ? {
          onLayout: (event: { nativeEvent: { layout: { y: number } } }) => {
            messageY.current = event.nativeEvent.layout.y;
            reportFocus();
          },
          testID: "mobile-thread-focused-turn",
        }
      : {};

  return (
    <>
      {workTurns !== undefined ? (
        <View onLayout={onSectionLayout} style={styles.transcript} testID="mobile-work-transcript">
          {workTurns.length === 0 ? (
            <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>
          ) : (
            workTurns.map((turn, index) => (
              <View
                key={String(turn.turnId)}
                style={styles.transcript}
                {...focusTurnLayout(String(turn.turnId))}
              >
                <MessageBubble
                  replyDetail={props.replyDetail}
                  body={turn.prompt}
                  role="user"
                  showActions={false}
                  testID={`mobile-work-prompt-${String(turn.turnId)}`}
                  turnActions={props.turnActionsFor(
                    mobileWorkTurnTargets(workTurns, index, "user"),
                  )}
                />
                {turn.response !== undefined && turn.response.length > 0 ? (
                  <MessageBubble
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
                ) : turn.status === "accepted" ||
                  turn.status === "running" ||
                  turn.status === "waiting" ? (
                  <Text style={styles.metaText}>{MOBILE_COPY.turnRunning}</Text>
                ) : null}
                {threadRoutineReceipts(turn.toolSteps).map((routine) => (
                  <RoutineReceiptCard
                    key={routine.routineId}
                    routine={routine}
                    testID={`mobile-work-routine-${routine.routineId}`}
                  />
                ))}
              </View>
            ))
          )}
        </View>
      ) : null}
      {codeTurns !== undefined ? (
        <View onLayout={onSectionLayout} style={styles.transcript} testID="mobile-code-transcript">
          {codeConversation?.hasEarlier === true ? (
            <Text style={styles.metaText}>{MOBILE_COPY.codeEarlierTurns}</Text>
          ) : null}
          {codeTurns.length === 0 ? (
            <Text style={styles.metaText}>{MOBILE_COPY.transcriptEmpty}</Text>
          ) : (
            codeTurns.map((turn, turnIndex) => (
              <View
                key={turn.operationId}
                style={styles.transcript}
                {...focusTurnLayout(String(turn.operationId))}
              >
                {turn.prompt.length === 0 ? null : (
                  <MessageBubble
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
                {turn.assistant.map((part, index) => (
                  <MessageBubble
                    replyDetail={props.replyDetail}
                    body={part}
                    key={`${turn.operationId}-${index}`}
                    role="assistant"
                    testID={`mobile-code-reply-${turn.operationId}-${index}`}
                    {...(index === turn.assistant.length - 1
                      ? {
                          turnActions: props.turnActionsFor(
                            mobileCodeTurnTargets(codeTurns, turnIndex, "assistant"),
                          ),
                        }
                      : {})}
                  />
                ))}
                {turn.status === "waiting" ? (
                  <Text style={styles.metaText}>{MOBILE_COPY.turnRunning}</Text>
                ) : turn.status === "failed" || turn.status === "interrupted" ? (
                  <Text style={styles.warningText}>{chatAttemptStatusLabel(turn.status)}</Text>
                ) : null}
                {turn.routines.map((routine) => (
                  <RoutineReceiptCard
                    key={routine.routineId}
                    routine={routine}
                    testID={`mobile-code-routine-${routine.routineId}`}
                  />
                ))}
              </View>
            ))
          )}
        </View>
      ) : null}
      {view !== undefined ? (
        <View
          onLayout={onSectionLayout}
          style={styles.transcript}
          testID="mobile-thread-transcript"
        >
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
          {messages.length === 0 ? (
            <View style={styles.emptyChat} testID="mobile-thread-empty">
              <Text style={styles.emptyTitle}>{MOBILE_COPY.threadStart}</Text>
              <Text style={styles.emptyBody}>{MOBILE_COPY.threadStartHelp}</Text>
            </View>
          ) : (
            messages.map(({ content, targets }, index) => {
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
              return (
                <View
                  key={content.contentId}
                  {...(String(content.contentId) === focusContentId
                    ? {
                        onLayout: (event: { nativeEvent: { layout: { y: number } } }) => {
                          messageY.current = event.nativeEvent.layout.y;
                          reportFocus();
                        },
                        testID: "mobile-thread-focused-message",
                      }
                    : {})}
                  style={styles.messageWithAttachments}
                >
                  <MessageBubble
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
                </View>
              );
            })
          )}
        </View>
      ) : null}
    </>
  );
}
