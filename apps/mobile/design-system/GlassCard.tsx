import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { GlassSurface } from "./GlassSurface";
import { glassPressedOverlayFor } from "./materials";
import { radii, type GlassMaterial } from "./tokens";
import { useTheme } from "./theme";

export interface GlassCardProps {
  readonly children: ReactNode;
  readonly onPress?: (() => void) | undefined;
  readonly material?: GlassMaterial;
  readonly radius?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly testID?: string | undefined;
  readonly accessibilityLabel?: string | undefined;
}

export function GlassCard(props: GlassCardProps) {
  const { scheme } = useTheme();
  const material = props.material ?? "regular";
  const radius = props.radius ?? radii.md;
  const pressedOverlay = glassPressedOverlayFor(scheme);

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole={props.onPress !== undefined ? "button" : undefined}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.pressable,
        props.style,
        pressed && props.onPress !== undefined
          ? { opacity: 0.92, backgroundColor: pressedOverlay }
          : null,
      ]}
      testID={props.testID}
    >
      <GlassSurface
        contentStyle={[styles.content, props.contentStyle]}
        material={material}
        radius={radius}
      >
        {props.children}
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    flex: 1,
  },
  content: {
    padding: 16,
    justifyContent: "space-between",
    minHeight: 104,
  },
});
