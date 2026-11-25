import { useMemo } from "react";
import { Platform, Pressable, StyleSheet } from "react-native";
import { Icon } from "../ui/Icon";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

// The system bar's own height above the safe area.
const BAR_HEIGHT = Platform.OS === "android" ? 64 : 49;

/** New over the bar's trailing end, where the platform has no place for it in the bar. */
export function NewButton(props: { readonly disabled: boolean; readonly onPress: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        button: {
          position: "absolute",
          right: 16 + insets.right,
          bottom: insets.bottom + BAR_HEIGHT + 16,
          width: 56,
          height: 56,
          borderRadius: Platform.OS === "android" ? 16 : 28,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.accent,
          elevation: 6,
          shadowColor: "#000000",
          shadowOpacity: 0.22,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        },
        disabled: { opacity: 0.45 },
      }),
    [colors, insets.bottom, insets.right],
  );
  return (
    <Pressable
      accessibilityLabel={MOBILE_COPY.newThread}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.disabled ? styles.disabled : null]}
      testID="mobile-new-thread"
    >
      <Icon color={colors.sendLabel} name="create-outline" size={24} />
    </Pressable>
  );
}
