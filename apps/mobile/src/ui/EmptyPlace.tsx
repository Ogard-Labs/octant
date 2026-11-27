import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import type { MobileIconName } from "./symbols";
import { space, typography, useTheme } from "../../design-system";

/** What a place says when its list has nothing in it, in the middle of the page. */
export function EmptyPlace(props: { readonly icon: MobileIconName; readonly text: string }) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        place: {
          flex: 1,
          minHeight: 240,
          alignItems: "center",
          justifyContent: "center",
          gap: space.md,
          paddingHorizontal: 40,
        },
        text: {
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: 21,
          textAlign: "center",
        },
      }),
    [colors],
  );
  return (
    <View style={styles.place}>
      <Icon color={colors.textTertiary} name={props.icon} size={40} />
      <Text style={styles.text}>{props.text}</Text>
    </View>
  );
}
