import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

export interface ToolPartCardProps {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
  readonly summary: string;
  /** Whether a finished call starts with its summary showing (Reply detail High). */
  readonly defaultOpen?: boolean;
  readonly testID?: string;
}

function statusLabel(status: ToolPartCardProps["status"]): string {
  switch (status) {
    case "running":
      return MOBILE_COPY.toolStatusRunning;
    case "failed":
      return MOBILE_COPY.toolStatusFailed;
    case "done":
      return MOBILE_COPY.toolStatusDone;
  }
}

function statusIcon(status: ToolPartCardProps["status"]): keyof typeof Ionicons.glyphMap {
  switch (status) {
    case "running":
      return "sync-outline";
    case "failed":
      return "alert-circle-outline";
    case "done":
      return "checkmark-circle-outline";
  }
}

/** Tool-call step card on Distilled glass or flat surfaces. */
export function ToolPartCard(props: ToolPartCardProps) {
  const { colors } = useTheme();
  // A finished call collapses to one line so a long run stays scannable; a
  // running or failed call keeps its detail in view.
  const collapsible = props.status === "done" && props.summary.length > 0;
  const [open, setOpen] = useState(props.defaultOpen === true);
  const showSummary = props.summary.length > 0 && (!collapsible || open);
  const tone =
    props.status === "failed"
      ? colors.danger
      : props.status === "running"
        ? colors.attention
        : colors.success;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { marginBottom: space.xs },
        pad: { gap: 2 },
        top: {
          minHeight: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
        },
        name: {
          flexShrink: 1,
          color: colors.textPrimary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
          fontFamily: typography.mono.fontFamily,
        },
        badge: {
          marginLeft: "auto",
          color: tone,
          fontSize: typography.meta.fontSize,
          fontWeight: "500",
        },
        summary: {
          marginLeft: 7,
          paddingLeft: space.md,
          paddingVertical: space.xs,
          borderLeftWidth: 2,
          borderLeftColor: colors.hairline,
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          lineHeight: 19,
        },
      }),
    [colors, tone],
  );

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-tool-part"}>
      <View style={styles.pad}>
        <Pressable
          accessibilityRole={collapsible ? "button" : "text"}
          accessibilityState={collapsible ? { expanded: open } : {}}
          disabled={!collapsible}
          onPress={() => setOpen((value) => !value)}
          style={styles.top}
          testID="mobile-tool-part-toggle"
        >
          <Ionicons color={tone} name={statusIcon(props.status)} size={15} />
          <Text style={styles.name} numberOfLines={1}>
            {props.name}
          </Text>
          <Text style={styles.badge}>{statusLabel(props.status)}</Text>
          {collapsible ? (
            <Ionicons
              color={colors.textTertiary}
              name={open ? "chevron-down" : "chevron-forward"}
              size={14}
            />
          ) : null}
        </Pressable>
        {showSummary ? <Text style={styles.summary}>{props.summary}</Text> : null}
      </View>
    </View>
  );
}
