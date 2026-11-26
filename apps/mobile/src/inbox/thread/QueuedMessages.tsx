import { noteTypedComposerText, typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import type { ThreadMessageQueueItem } from "@octant/contracts";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { radii, space, typography, useTheme } from "../../../design-system";
import { queuedMessageRows } from "./queuedMessageRows";

function editScope(messageId: string): string {
  return `queue-edit:${messageId}`;
}

/**
 * The messages waiting for this thread's next turn, just above the composer.
 * Each one the host still holds unsent can be edited or removed here, when
 * this phone may change the queue.
 */
export function QueuedMessages(props: {
  readonly items: ReadonlyArray<ThreadMessageQueueItem>;
  readonly error: string | undefined;
  readonly changing: boolean;
  readonly allowChanges: boolean;
  readonly onEdit: (messageId: string, prompt: string, typedByPerson: boolean) => Promise<boolean>;
  readonly onRemove: (messageId: string) => Promise<boolean>;
  readonly onSendNow: (messageId: string) => Promise<boolean>;
}) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState<{ readonly messageId: string; readonly text: string }>();
  const { height } = useWindowDimensions();
  const rows = queuedMessageRows(props.items, props.allowChanges);
  if (rows.length === 0 && props.error === undefined) return null;
  const styles = StyleSheet.create({
    list: {
      gap: space.xs,
      marginHorizontal: space.md,
      marginBottom: space.xs,
      padding: space.sm,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.glassStroke,
      backgroundColor: colors.glassFillThin,
    },
    heading: { color: colors.textSecondary, fontSize: typography.meta.fontSize },
    // The host holds up to 32 messages; past a quarter of the screen the rows
    // scroll, so the composer below them stays on screen.
    rows: { maxHeight: Math.round(height / 4) },
    rowsContent: { gap: space.xs },
    row: { flexDirection: "row", alignItems: "center", gap: space.sm },
    text: { flex: 1, color: colors.textPrimary, fontSize: typography.detail.fontSize },
    input: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: typography.detail.fontSize,
      paddingVertical: 4,
    },
    action: { minHeight: 30, justifyContent: "center", paddingHorizontal: 8 },
    actionLabel: { color: colors.accent, fontSize: typography.detail.fontSize },
    error: { color: colors.danger, fontSize: typography.meta.fontSize },
  });
  const action = (label: string, onPress: () => void, disabled: boolean, testID: string) => (
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
    <View style={styles.list} testID="mobile-thread-queue">
      {rows.length === 0 ? null : <Text style={styles.heading}>Waiting for the next turn</Text>}
      <ScrollView
        contentContainerStyle={styles.rowsContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={styles.rows}
        testID="mobile-thread-queue-rows"
      >
        {rows.map((row) =>
          editing?.messageId === row.messageId ? (
            <View key={row.messageId} style={styles.row}>
              <TextInput
                accessibilityLabel="Queued message"
                autoFocus
                multiline
                onChangeText={(text) => {
                  // The person's own typing in the edit field, as the desktop queue notes it.
                  noteTypedComposerText(editScope(row.messageId), text);
                  setEditing({ messageId: row.messageId, text });
                }}
                style={styles.input}
                value={editing.text}
              />
              {action(
                "Save",
                () =>
                  void props
                    .onEdit(
                      row.messageId,
                      editing.text,
                      typedClaimFor(editScope(row.messageId), editing.text).typedByPerson === true,
                    )
                    .then((saved) => {
                      if (saved) setEditing(undefined);
                    }),
                props.changing || editing.text.trim() === "",
                "mobile-thread-queue-save",
              )}
              {action("Cancel", () => setEditing(undefined), false, "mobile-thread-queue-cancel")}
            </View>
          ) : (
            <View key={row.messageId} style={styles.row}>
              <Text numberOfLines={2} style={styles.text}>
                {row.text}
              </Text>
              {/* A phone that may only read the queue is shown no actions on it. */}
              {props.allowChanges ? (
                <>
                  {action(
                    "Edit",
                    () => setEditing({ messageId: row.messageId, text: row.text }),
                    props.changing || !row.changeable,
                    "mobile-thread-queue-edit",
                  )}
                  {action(
                    "Send now",
                    () => void props.onSendNow(row.messageId),
                    props.changing || !row.changeable,
                    "mobile-thread-queue-send-now",
                  )}
                  {action(
                    "Remove",
                    () => void props.onRemove(row.messageId),
                    props.changing || !row.changeable,
                    "mobile-thread-queue-remove",
                  )}
                </>
              ) : null}
            </View>
          ),
        )}
      </ScrollView>
      {props.error === undefined ? null : <Text style={styles.error}>{props.error}</Text>}
    </View>
  );
}
