import { StyleSheet, Text, View } from "react-native";
import { CODE_PATTERN_LINES } from "./codePattern";
import { fonts } from "./tokens";
import { useTheme } from "./theme";

export interface CodePatternOverlayProps {
  readonly opacity?: number;
  readonly testID?: string;
}

/** Subtle Nerd Font code lattice behind glass surfaces. */
export function CodePatternOverlay(props: CodePatternOverlayProps) {
  const { colors, scheme } = useTheme();
  const opacity = props.opacity ?? (scheme === "dark" ? 0.18 : 0.14);
  return (
    <View
      pointerEvents="none"
      style={[styles.root, { opacity }]}
      testID={props.testID ?? "mobile-code-pattern"}
    >
      {CODE_PATTERN_LINES.map((line, index) => (
        <Text
          key={`${index}:${line.slice(0, 12)}`}
          numberOfLines={1}
          style={[
            styles.line,
            {
              color: colors.ink,
              top: 28 + index * 42,
              left: index % 2 === 0 ? 12 : 36,
              transform: [{ rotate: index % 3 === 0 ? "-8deg" : "-6deg" }],
            },
          ]}
        >
          {line}
        </Text>
      ))}
      {Array.from({ length: 14 }, (_, i) => (
        <View
          key={`hatch-${i}`}
          style={[
            styles.hatch,
            {
              left: -40 + i * 48,
              opacity: 0.4,
              backgroundColor:
                scheme === "dark" ? "rgba(245, 78, 0, 0.28)" : "rgba(245, 78, 0, 0.18)",
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
  },
  line: {
    position: "absolute",
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.2,
    width: "120%",
  },
  hatch: {
    position: "absolute",
    top: -20,
    bottom: -20,
    width: StyleSheet.hairlineWidth,
    transform: [{ rotate: "18deg" }],
  },
});
