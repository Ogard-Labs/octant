import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { chatAttemptStatusLabel, type MobileCodeConversation } from "@octant/client-runtime";
import type { WorkTurnState } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { mobileSpacing, mobileTypography } from "../../theme/tokens";
import { useTheme } from "../../../design-system";
import { AttemptStatus } from "../../ui/AttemptStatus";
import { MessageBubble } from "../../ui/MessageBubble";
import { ThreadWorkShelf } from "../../ui/ThreadWorkShelf";
import type { useChatThread } from "./useChatThread";

type ChatThread = ReturnType<typeof useChatThread>;

export interface ThreadTranscriptProps {
  readonly workTurns: ReadonlyArray<WorkTurnState> | undefined;
  readonly codeConversation: MobileCodeConversation | undefined;
  readonly chat: ChatThread;
  readonly allowProductMutations: boolean;
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
          fontSize: 22,
          fontWeight: "400",
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
        metaText: { color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
        warningText: { color: colors.danger, fontSize: 12, lineHeight: 16 },
      }),
    [colors],
  );
  const { chat, workTurns, codeConversation } = props;
  const codeTurns = codeConversation?.turns;
  const view = chat.view;

  return (
    <>
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
          {codeConversation?.hasEarlier === true ? (
            <Text style={styles.metaText}>{MOBILE_COPY.codeEarlierTurns}</Text>
          ) : null}
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
                  <Text style={styles.warningText}>{chatAttemptStatusLabel(turn.status)}</Text>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}
      {view !== undefined ? (
        <View style={styles.transcript} testID="mobile-thread-transcript">
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
                    entry.role.toLowerCase() !== "user" && entry.role.toLowerCase() !== "human"
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
                            label: `Retry ${chatAttemptStatusLabel(retryable.outcome).toLowerCase()}`,
                            icon: "refresh-outline" as const,
                            onPress: () => void chat.retry(),
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
  );
}
