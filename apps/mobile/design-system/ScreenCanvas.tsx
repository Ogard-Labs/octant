import type { ReactNode } from "react";
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { themeAtmosphereOpacity, themeAtmosphereSources } from "./themeAtmospheres";
import { useTheme } from "./theme";

export type CanvasBackgroundMode = "code-gradient" | "atmosphere" | "custom";

export interface ScreenCanvasProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly backgroundMode?: CanvasBackgroundMode;
  readonly customImageUri?: string | undefined;
}

/**
 * The Octant canvas mirrors the desktop ground: a flat workspace colour with a
 * whisper of neutral wash — not a loud photo. The bundled atmosphere and custom
 * wallpapers remain opt-in through Appearance → Background; custom photos stay
 * dimmed for readability.
 */
export function ScreenCanvas(props: ScreenCanvasProps) {
  const { colors, scheme } = useTheme();
  const mode = props.backgroundMode ?? "code-gradient";
  const custom = mode === "custom" && props.customImageUri !== undefined;
  const atmosphereOpacity = themeAtmosphereOpacity[scheme];
  const atmosphereSource = themeAtmosphereSources[scheme];

  return (
    <View
      style={[styles.root, { backgroundColor: colors.canvas }, props.style]}
      testID={props.testID ?? "mobile-screen-canvas"}
    >
      {custom ? (
        <>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: props.customImageUri }}
            style={[StyleSheet.absoluteFill, { opacity: 0.88 }]}
            testID="mobile-canvas-custom-image"
          />
          <View
            style={[styles.customDim, { backgroundColor: colors.customDim }]}
            testID="mobile-canvas-custom-dim"
          />
          <LinearGradient
            colors={[colors.customScrimTop, colors.customScrimMid, colors.customScrimBottom]}
            end={{ x: 0.5, y: 1 }}
            start={{ x: 0.2, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : mode === "atmosphere" ? (
        <>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={atmosphereSource}
            style={[StyleSheet.absoluteFill, { opacity: atmosphereOpacity }]}
            testID={`mobile-canvas-atmosphere-${scheme}`}
          />
          <LinearGradient
            colors={[
              scheme === "dark" ? "rgba(26,26,26,0.55)" : "rgba(255,255,255,0.30)",
              "transparent",
              scheme === "dark" ? "rgba(26,26,26,0.70)" : "rgba(255,255,255,0.44)",
            ]}
            end={{ x: 0.5, y: 1 }}
            start={{ x: 0.2, y: 0 }}
            style={StyleSheet.absoluteFill}
            testID="mobile-canvas-gradient"
          />
        </>
      ) : (
        <LinearGradient
          colors={[colors.atmosphereGradientStart, "transparent", colors.atmosphereGradientEnd]}
          end={{ x: 1, y: 0.85 }}
          start={{ x: 0.05, y: 0 }}
          style={StyleSheet.absoluteFill}
          testID="mobile-canvas-ground-wash"
        />
      )}
      <View style={styles.content}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  customDim: {
    ...StyleSheet.absoluteFill,
  },
});
