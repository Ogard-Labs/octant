import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";

export function InboxComposerDock(props: { readonly onOpen: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: {
          paddingHorizontal: space.md,
          paddingBottom: process.env.EXPO_OS === "web" ? 62 : space.md,
        },
        dock: {
          minHeight: 72,
          paddingHorizontal: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
        },
        roundAction: {
          width: 46,
          height: 46,
          borderRadius: 23,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.glassFillRegular,
        },
        prompt: {
          flex: 1,
          color: colors.textTertiary,
          fontSize: typography.body.fontSize,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.shell} testID="mobile-inbox-composer-dock">
      <Pressable
        accessibilityHint="Open Chat, Work, or Code composer"
        accessibilityLabel="Plan, ask, build"
        accessibilityRole="button"
        onPress={props.onOpen}
      >
        <GlassSurface contentStyle={styles.dock} material="chrome" radius={radii.pill}>
          <View style={styles.roundAction}>
            <Ionicons color={colors.textSecondary} name="add" size={24} />
          </View>
          <Text numberOfLines={1} style={styles.prompt}>
            Plan, ask, build…
          </Text>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.roundAction}
          >
            <Ionicons color={colors.textSecondary} name="mic" size={21} />
          </View>
        </GlassSurface>
      </Pressable>
    </View>
  );
}
