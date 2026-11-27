import { noteTypedComposerText, typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { radii, space, typography, useTheme } from "../../../design-system";
import { IconButton } from "../../ui/IconButton";
import { queuedMessageRows } from "./queuedMessageRows";

function editScope(messageId: string): string {
  return `queue-edit:${messageId}`;
}

/**
 * What waits on the computer behind the running turn, above the composer.
 * A message still waiting can be edited, sent now or removed, when this phone
 * may change the queue; one on its way cannot.
 */
export function QueuedMessages(props: {
  readonly queue: ThreadMessageQueueSnapshot;
  /** A change is on its way, so no second one starts. */
  readonly changing: boolean;
  /** Undefined where this phone may only read the queue. */
  readonly actions:
    | {
        readonly onEdit: (
          messageId: string,
          prompt: string,
          typedByPerson: boolean,
        ) => Promise<boolean>;
        readonly onSendNow: (messageId: string) => void;
        readonly onRemove: (messageId: string) => void;
      }
    | undefined;
}) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const [editing, setEditing] = useState<{ readonly messageId: string; readonly text: string }>();
  const { items, holdReason, paused } = props.queue;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          marginHorizontal: space.md,
          marginBottom: space.xs,
          borderRadius: radii.md,
          backgroundColor: colors.control,
          paddingVertical: 4,
        },
        // The computer holds up to 32 messages; past a quarter of the screen
        // the rows scroll, so the composer below them stays on screen.
        rows: { maxHeight: Math.round(height / 4) },
        row: {
          minHeight: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingLeft: 12,
          paddingRight: 4,
        },
        state: { color: colors.textTertiary, fontSize: typography.caption.fontSize },
        text: { flex: 1, color: colors.textPrimary, fontSize: typography.detail.fontSize },
        input: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          paddingVertical: 6,
        },
        action: { minHeight: 32, justifyContent: "center", paddingHorizontal: 8 },
        actionLabel: { color: colors.accent, fontSize: typography.detail.fontSize },
        hold: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          paddingHorizontal: 12,
          paddingVertical: 4,
        },
      }),
    [colors, height],
  );
  if (items.length === 0) return null;
  const rows = queuedMessageRows(items, props.actions !== undefined);
  const textAction = (label: string, onPress: () => void, disabled: boolean, testID: string) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed || disabled ? { opacity: 0.5 } : null]}
      testID={testID}
    >
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.card} testID="mobile-thread-queue">
      {paused || holdReason !== undefined ? (
        <Text style={styles.hold}>{MOBILE_COPY.queueHeld}</Text>
      ) : null}
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.rows}>
        {items.map((item, index) => {
          const row = rows[index];
          const messageId = String(item.messageId);
          const sending = item.steering === true || item.status !== "queued";
          const { actions } = props;
          if (editing?.messageId === messageId && actions !== undefined)
            return (
              <View key={messageId} style={styles.row}>
                <TextInput
                  accessibilityLabel={MOBILE_COPY.queueEditLabel}
                  autoFocus
                  multiline
                  onChangeText={(text) => {
                    // The person's own typing in the edit field, as the composer notes it.
                    noteTypedComposerText(editScope(messageId), text);
                    setEditing({ messageId, text });
                  }}
                  style={styles.input}
                  testID="mobile-thread-queue-input"
                  value={editing.text}
                />
                {textAction(
                  MOBILE_COPY.queueSave,
                  () =>
                    void actions
                      .onEdit(
                        messageId,
                        editing.text,
                        typedClaimFor(editScope(messageId), editing.text).typedByPerson === true,
                      )
                      .then((saved) => {
                        if (saved) setEditing(undefined);
                      }),
                  props.changing || editing.text.trim().length === 0,
                  "mobile-thread-queue-save",
                )}
                {textAction(
                  MOBILE_COPY.queueCancelEdit,
                  () => setEditing(undefined),
                  false,
                  "mobile-thread-queue-cancel",
                )}
              </View>
            );
          return (
            <View key={messageId} style={styles.row}>
              <Text style={styles.state}>
                {sending ? MOBILE_COPY.queueSending : MOBILE_COPY.queueWaiting}
              </Text>
              <Text numberOfLines={1} style={styles.text}>
                {item.payload?.prompt ?? MOBILE_COPY.queueUnreadable}
              </Text>
              {actions === undefined || row === undefined || row.actions.length === 0 ? null : (
                <>
                  {row.actions.includes("edit")
                    ? textAction(
                        MOBILE_COPY.queueEdit,
                        () => setEditing({ messageId, text: row.text }),
                        props.changing,
                        `mobile-thread-queue-edit-${messageId}`,
                      )
                    : null}
                  {row.actions.includes("send-now")
                    ? textAction(
                        MOBILE_COPY.queueSendNow,
                        () => actions.onSendNow(messageId),
                        props.changing,
                        `mobile-thread-queue-send-now-${messageId}`,
                      )
                    : null}
                  {row.actions.includes("remove") ? (
                    <IconButton
                      accessibilityLabel={MOBILE_COPY.queueRemove}
                      disabled={props.changing}
                      name="close"
                      onPress={() => actions.onRemove(messageId)}
                      size={32}
                      testID={`mobile-thread-queue-remove-${messageId}`}
                      variant="ghost"
                    />
                  ) : null}
                </>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
