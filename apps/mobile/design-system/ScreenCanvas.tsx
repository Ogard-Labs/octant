import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { DEFAULT_EFFECT, type GroundEffect, type GroundPicture } from "./groundPrint";
import { pictureSource } from "./groundPictures";
import { PrintedGround } from "./PrintedGround";
import { themeAtmosphereOpacity } from "./themeAtmospheres";
import { useTheme } from "./theme";

export interface ScreenCanvasProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly picture?: GroundPicture;
  readonly effect?: GroundEffect;
  readonly customImageUri?: string | undefined;
}

/**
 * The Octant canvas mirrors the desktop ground: a flat workspace colour under
 * one of the first-party pictures, a person's photo, or the plain page, printed
 * as it is, pixelated or dithered. It is drawn once and never moves. A custom
 * photo stays dimmed for readability; the plain page keeps a whisper of wash.
 */
export function ScreenCanvas(props: ScreenCanvasProps) {
  const { colors, scheme } = useTheme();
  const picture = props.picture ?? "plain";
  const effect = props.effect ?? DEFAULT_EFFECT;
  const customSource =
    picture === "custom" && props.customImageUri !== undefined
      ? { uri: props.customImageUri }
      : undefined;
  const bundledSource = pictureSource(picture, scheme);
  const atmosphereOpacity = themeAtmosphereOpacity[scheme];

  return (
    <View
      style={[styles.root, { backgroundColor: colors.canvas }, props.style]}
      testID={props.testID ?? "mobile-screen-canvas"}
    >
      {customSource !== undefined ? (
        <>
          <View style={styles.customPicture}>
            <PrintedGround
              effect={effect}
              source={customSource}
              testID="mobile-canvas-custom-image"
            />
          </View>
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
      ) : bundledSource !== undefined ? (
        <>
          <View
            style={[
              StyleSheet.absoluteFill,
              picture === "atmosphere" ? { opacity: atmosphereOpacity } : null,
            ]}
          >
            <PrintedGround
              effect={effect}
              source={bundledSource}
              testID={`mobile-canvas-picture-${picture}`}
            />
          </View>
          {picture === "atmosphere" ? (
            <LinearGradient
              colors={[colors.atmosphereScrimStart, "transparent", colors.atmosphereScrimEnd]}
              end={{ x: 0.5, y: 1 }}
              start={{ x: 0.2, y: 0 }}
              style={StyleSheet.absoluteFill}
              testID="mobile-canvas-gradient"
            />
          ) : null}
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
  customPicture: {
    ...StyleSheet.absoluteFill,
    opacity: 0.88,
  },
  customDim: {
    ...StyleSheet.absoluteFill,
  },
});
