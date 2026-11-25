import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { MobileInboxRow } from "@octant/client-runtime";
import { space, typography, useTheme } from "../../design-system";
import { ThreadRow } from "./ThreadRow";

/**
 * Threads on the page itself, under a heading with a hairline to the edge. A
 * group that folds shows its count while it is closed.
 */
export function ThreadGroup(props: {
  /** Absent where the rows need no heading: the list's first group. */
  readonly label?: string | undefined;
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly onOpen: (row: MobileInboxRow) => void;
  readonly folded?: boolean;
  readonly onToggle?: (() => void) | undefined;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        heading: {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: space.md,
          marginTop: space.sm,
        },
        label: { color: colors.textSecondary, fontSize: typography.detail.fontSize },
        line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
      }),
    [colors],
  );
  const { label, onToggle, rows } = props;
  const folded = props.folded === true;
  const shown = folded && label !== undefined ? `${label} (${rows.length})` : label;
  const heading =
    shown === undefined ? null : (
      <>
        <Text style={styles.label}>{shown}</Text>
        <View style={styles.line} />
        {onToggle === undefined ? null : (
          <Ionicons
            color={colors.textTertiary}
            name={folded ? "chevron-down" : "chevron-up"}
            size={15}
          />
        )}
      </>
    );
  return (
    <View testID={props.testID}>
      {heading === null ? null : onToggle === undefined ? (
        <View accessibilityRole="header" accessible style={styles.heading}>
          {heading}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !folded }}
          onPress={onToggle}
          style={styles.heading}
          testID={props.testID === undefined ? undefined : `${props.testID}-toggle`}
        >
          {heading}
        </Pressable>
      )}
      {folded
        ? null
        : rows.map((row, index) => (
            <ThreadRow
              key={`${row.hostId}:${row.mode}:${row.threadId}`}
              last={index === rows.length - 1}
              onOpen={props.onOpen}
              row={row}
            />
          ))}
    </View>
  );
}
