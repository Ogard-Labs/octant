import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

export interface ToolPartCardProps {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
  readonly summary: string;
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
  const [open, setOpen] = useState(false);
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
        wrap: { marginBottom: space.sm },
        pad: {
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          gap: 6,
        },
        top: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
        },
        name: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
          fontFamily: typography.mono.fontFamily,
        },
        badge: {
          color: tone,
          fontSize: 12,
          fontWeight: "500",
        },
        summary: {
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 20,
        },
      }),
    [colors, tone],
  );

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-tool-part"}>
      <GlassSurface contentStyle={styles.pad} material="thin" radius={radii.sm}>
        <Pressable
          accessibilityRole={collapsible ? "button" : "text"}
          accessibilityState={collapsible ? { expanded: open } : {}}
          disabled={!collapsible}
          onPress={() => setOpen((value) => !value)}
          style={styles.top}
          testID="mobile-tool-part-toggle"
        >
          <Ionicons color={tone} name={statusIcon(props.status)} size={16} />
          <Text style={styles.name} numberOfLines={1}>
            {props.name}
          </Text>
          <Text style={styles.badge}>{statusLabel(props.status)}</Text>
          {collapsible ? (
            <Ionicons
              color={colors.textTertiary}
              name={open ? "chevron-up" : "chevron-down"}
              size={16}
            />
          ) : null}
        </Pressable>
        {showSummary ? <Text style={styles.summary}>{props.summary}</Text> : null}
      </GlassSurface>
    </View>
  );
}
