import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassCard, radii, space, typography, useTheme } from "../../design-system";
import type { MobileIconName } from "./IconButton";

export interface StatusCardProps {
  readonly title: string;
  readonly count?: number;
  readonly icon: MobileIconName;
  readonly iconColor?: string;
  readonly onPress?: () => void;
  readonly testID?: string;
}

export function StatusCard(props: StatusCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: { minHeight: 144, padding: space.md },
        icon: { marginTop: 2 },
        labelRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
        title: {
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          fontWeight: "500",
        },
        count: {
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          fontWeight: "400",
          fontVariant: ["tabular-nums"],
        },
      }),
    [colors],
  );

  return (
    <GlassCard
      accessibilityLabel={
        props.count === undefined ? props.title : `${props.title}, ${props.count}`
      }
      contentStyle={styles.card}
      material="thin"
      onPress={props.onPress}
      radius={radii.lg}
      testID={props.testID}
    >
      <Ionicons
        color={props.iconColor ?? colors.textPrimary}
        name={props.icon}
        size={22}
        style={styles.icon}
      />
      <View style={styles.labelRow}>
        <Text style={styles.title}>{props.title}</Text>
        {props.count === undefined ? null : <Text style={styles.count}>{props.count}</Text>}
      </View>
    </GlassCard>
  );
}
