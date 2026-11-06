import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
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
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: 10,
        },
        title: {
          flex: props.preview === undefined || props.preview === "" ? 1 : 0,
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
        },
        preview: {
          flex: 1,
          color: colors.textTertiary,
          fontSize: typography.caption.fontSize,
        },
        body: {
          paddingHorizontal: space.md,
          paddingBottom: space.md,
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 20,
        },
        wrap: { marginBottom: space.sm },
      }),
    [colors, props.preview],
  );
  const preview = expanded ? "" : (props.preview ?? "");

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-reasoning-part"}>
      <GlassSurface material="ultraThin" radius={radii.sm}>
        <Pressable
          accessibilityLabel={MOBILE_COPY.reasoningTitle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.header}
          testID="mobile-reasoning-toggle"
        >
          <Ionicons color={colors.textTertiary} name="sparkles-outline" size={16} />
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
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
          />
        </Pressable>
        {expanded ? (
          <Text style={styles.body} testID="mobile-reasoning-body">
            {props.text}
          </Text>
        ) : null}
      </GlassSurface>
    </View>
  );
}
