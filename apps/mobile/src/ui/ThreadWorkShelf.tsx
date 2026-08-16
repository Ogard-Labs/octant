import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThreadFollowUp, ThreadWorkItem } from "@octant/contracts";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

function isHistoryItem(item: ThreadWorkItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function ordered(items: ReadonlyArray<ThreadWorkItem>): ThreadWorkItem[] {
  return [...items].sort((a, b) => a.position - b.position);
}

/**
 * Distilled work and follow-up shelf beneath the conversation.
 * Complete / cancel / complete-follow-up mutate on the host when callbacks are provided.
 */
export function ThreadWorkShelf(props: {
  readonly items: ReadonlyArray<ThreadWorkItem>;
  readonly followUp?: ThreadFollowUp;
  readonly onCompleteItem?: (item: ThreadWorkItem) => void;
  readonly onCancelItem?: (item: ThreadWorkItem) => void;
  readonly onCompleteFollowUp?: (followUp: ThreadFollowUp) => void;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const currentItems = ordered(props.items.filter((item) => !isHistoryItem(item)));
  const blockedCount = currentItems.filter((item) => item.status === "blocked").length;
  const showFollowUp = props.followUp?.state === "open";
  const canMutate = props.onCompleteItem !== undefined || props.onCancelItem !== undefined;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { gap: space.sm, marginBottom: space.sm },
        summary: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
        },
        summaryText: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
        },
        chevron: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
        followUp: {
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
          gap: space.xs,
        },
        followUpText: {
          color: colors.accent,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
          lineHeight: 16,
        },
        list: { gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
        itemTitle: {
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          fontWeight: "600",
        },
        itemMeta: {
          color: colors.textSecondary,
          fontSize: 11,
          marginTop: 2,
        },
        itemPad: { paddingVertical: space.sm, paddingHorizontal: space.md, gap: space.xs },
        actions: { flexDirection: "row", gap: space.xs, marginTop: space.xs },
        actionChip: {
          paddingVertical: 4,
          paddingHorizontal: 8,
          borderRadius: radii.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        actionLabel: {
          color: colors.textSecondary,
          fontSize: 11,
          fontWeight: "600",
        },
      }),
    [colors],
  );

  if (currentItems.length === 0 && !showFollowUp) return null;

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-thread-work-shelf"}>
      <GlassSurface material="thin" radius={radii.md}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          style={styles.summary}
          testID="mobile-thread-work-toggle"
        >
          <Text style={styles.summaryText}>
            {MOBILE_COPY.workListLabel}: {currentItems.length} {MOBILE_COPY.workRemaining},{" "}
            {blockedCount} {MOBILE_COPY.workBlocked}
          </Text>
          <Text style={styles.chevron}>{expanded ? "−" : "+"}</Text>
        </Pressable>
        {showFollowUp ? (
          <View style={styles.followUp} testID="mobile-thread-follow-up">
            <Text style={styles.followUpText}>
              {MOBILE_COPY.followUpRequired}: {props.followUp!.reason}
            </Text>
            {props.onCompleteFollowUp !== undefined ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => props.onCompleteFollowUp?.(props.followUp!)}
                style={styles.actionChip}
                testID="mobile-thread-follow-up-complete"
              >
                <Text style={styles.actionLabel}>{MOBILE_COPY.followUpComplete}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {expanded ? (
          <View style={styles.list}>
            {currentItems.map((item) => (
              <GlassSurface
                contentStyle={styles.itemPad}
                key={String(item.id)}
                material="thin"
                radius={radii.sm}
              >
                <Text style={styles.itemTitle}>{item.title}</Text>
                <Text style={styles.itemMeta}>
                  {item.status}
                  {item.detail !== undefined ? ` · ${item.detail}` : ""}
                </Text>
                {canMutate ? (
                  <View style={styles.actions}>
                    {props.onCompleteItem !== undefined ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => props.onCompleteItem?.(item)}
                        style={styles.actionChip}
                        testID={`mobile-work-complete-${item.id}`}
                      >
                        <Text style={styles.actionLabel}>{MOBILE_COPY.workComplete}</Text>
                      </Pressable>
                    ) : null}
                    {props.onCancelItem !== undefined ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => props.onCancelItem?.(item)}
                        style={styles.actionChip}
                        testID={`mobile-work-cancel-${item.id}`}
                      >
                        <Text style={styles.actionLabel}>{MOBILE_COPY.workCancel}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </GlassSurface>
            ))}
          </View>
        ) : null}
      </GlassSurface>
    </View>
  );
}
