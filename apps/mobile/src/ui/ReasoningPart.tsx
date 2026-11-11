import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

export interface ReasoningPartProps {
  readonly text: string;
  /** Default collapsed. */
  readonly defaultExpanded?: boolean;
  /**
   * The first line beside the title while the panel is shut (Reply detail
   * Medium). Hidden from assistive technology: the button's name stays the
   * title, and the same words are read from the body once it opens.
   */
  readonly preview?: string;
  readonly testID?: string;
}

/** Collapsible reasoning / thinking panel on Distilled glass or flat surfaces. */
export function ReasoningPart(props: ReasoningPartProps) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(props.defaultExpanded === true);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        header: {
          minHeight: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
        },
        title: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
        },
        preview: {
          flexShrink: 1,
          color: colors.textTertiary,
          fontSize: typography.caption.fontSize,
        },
        // Open thinking hangs off a hairline under its row, quieter than the reply.
        body: {
          marginLeft: 7,
          paddingLeft: space.md,
          paddingVertical: space.xs,
          borderLeftWidth: 2,
          borderLeftColor: colors.hairline,
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize + 1,
          lineHeight: 20,
        },
        wrap: { marginBottom: space.xs },
      }),
    [colors, props.preview],
  );
  const preview = expanded ? "" : (props.preview ?? "");

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-reasoning-part"}>
      <View>
        <Pressable
          accessibilityLabel={MOBILE_COPY.reasoningTitle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.header}
          testID="mobile-reasoning-toggle"
        >
          <Ionicons color={colors.textTertiary} name="sparkles-outline" size={15} />
          <Text style={styles.title}>{MOBILE_COPY.reasoningTitle}</Text>
          {preview === "" ? null : (
            <Text
              aria-hidden
              numberOfLines={1}
              style={styles.preview}
              testID="mobile-reasoning-preview"
            >
              {preview}
            </Text>
          )}
          <Ionicons
            color={colors.textTertiary}
            name={expanded ? "chevron-down" : "chevron-forward"}
            size={14}
          />
        </Pressable>
        {expanded ? (
          <Text style={styles.body} testID="mobile-reasoning-body">
            {props.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
