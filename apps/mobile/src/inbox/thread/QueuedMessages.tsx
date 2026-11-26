import { noteTypedComposerText, typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import type { ThreadMessageQueueItem } from "@octant/contracts";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { radii, space, typography, useTheme } from "../../../design-system";
import { queuedMessageRows } from "./queuedMessageRows";

function editScope(messageId: string): string {
  return `queue-edit:${messageId}`;
}

/**
 * The messages waiting for this thread's next turn, just above the composer.
 * Each one the host still holds unsent can be edited or removed here.
 */
export function QueuedMessages(props: {
  readonly items: ReadonlyArray<ThreadMessageQueueItem>;
  readonly error: string | undefined;
  readonly changing: boolean;
  readonly onEdit: (messageId: string, prompt: string, typedByPerson: boolean) => Promise<boolean>;
  readonly onRemove: (messageId: string) => Promise<boolean>;
}) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState<{ readonly messageId: string; readonly text: string }>();
  const rows = queuedMessageRows(props.items);
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
            {action(
              "Edit",
              () => setEditing({ messageId: row.messageId, text: row.text }),
              props.changing || !row.changeable,
              "mobile-thread-queue-edit",
            )}
            {action(
              "Remove",
              () => void props.onRemove(row.messageId),
              props.changing || !row.changeable,
              "mobile-thread-queue-remove",
            )}
          </View>
        ),
      )}
      {props.error === undefined ? null : <Text style={styles.error}>{props.error}</Text>}
    </View>
  );
}
