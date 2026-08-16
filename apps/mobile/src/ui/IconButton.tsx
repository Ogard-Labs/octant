import { useMemo } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, useTheme } from "../../design-system";

export type MobileIconName = keyof typeof Ionicons.glyphMap;

export interface IconButtonProps {
  readonly name: MobileIconName;
  readonly accessibilityLabel: string;
  readonly onPress?: (() => void) | undefined;
  readonly testID?: string;
  readonly size?: number;
  readonly iconSize?: number;
  readonly color?: string;
  readonly variant?: "solid" | "ghost" | "send";
  readonly disabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function IconButton(props: IconButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        base: {
          alignItems: "center",
          justifyContent: "center",
        },
        chromeFill: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        ghost: {
          backgroundColor: "transparent",
        },
        send: {
          backgroundColor: colors.send,
        },
        sendDisabled: {
          backgroundColor: colors.glassFillThin,
        },
        disabled: {
          opacity: 0.4,
        },
      }),
    [colors],
  );

  const size = props.size ?? 36;
  const iconSize = props.iconSize ?? Math.round(size * 0.5);
  const variant = props.variant ?? "solid";
  const disabled = props.disabled === true || props.onPress === undefined;
  const color =
    props.color ??
    (variant === "send"
      ? colors.sendLabel
      : variant === "ghost"
        ? colors.textSecondary
        : colors.textPrimary);

  const body = (
    <Ionicons
      color={disabled && variant === "send" ? colors.textTertiary : color}
      name={props.name}
      size={iconSize}
    />
  );

  if (variant === "solid") {
    return (
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        disabled={disabled}
        onPress={props.onPress}
        style={[
          { width: size, height: size, borderRadius: size / 2 },
          disabled ? styles.disabled : null,
          props.style,
        ]}
        testID={props.testID}
      >
        <GlassSurface
          contentStyle={styles.chromeFill}
          material="chrome"
          radius={size / 2}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        >
          {body}
        </GlassSurface>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      onPress={props.onPress}
      style={[
        styles.base,
        variant === "ghost" ? styles.ghost : null,
        variant === "send" ? styles.send : null,
        disabled && variant === "send" ? styles.sendDisabled : null,
        disabled && variant !== "send" ? styles.disabled : null,
        { width: size, height: size, borderRadius: size / 2 },
        props.style,
      ]}
      testID={props.testID}
    >
      {body}
    </Pressable>
  );
}
