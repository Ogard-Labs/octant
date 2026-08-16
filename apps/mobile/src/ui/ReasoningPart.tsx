import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

export interface ReasoningPartProps {
  readonly text: string;
  /** Default collapsed. */
  readonly defaultExpanded?: boolean;
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
          flex: 1,
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
          letterSpacing: 0.3,
          textTransform: "uppercase",
        },
        body: {
          paddingHorizontal: space.md,
          paddingBottom: space.md,
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 22,
        },
        wrap: { marginBottom: space.sm },
      }),
    [colors],
  );

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-reasoning-part"}>
      <GlassSurface material="ultraThin" radius={radii.sm}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.header}
          testID="mobile-reasoning-toggle"
        >
          <Ionicons color={colors.textTertiary} name="sparkles-outline" size={16} />
          <Text style={styles.title}>{MOBILE_COPY.reasoningTitle}</Text>
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
