import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { radii, space, typography, useTheme } from "../../design-system";
import type { MobileThreadSurfaceOption } from "./threadSurfacePresentation";

export interface ThreadSurfaceSwitcherProps {
  readonly surfaces: ReadonlyArray<MobileThreadSurfaceOption>;
  readonly active: RemoteThreadSurfaceKind;
  readonly onSelect: (surface: RemoteThreadSurfaceKind) => void;
}

// Each segment is 28pt tall inside the track; the slop reaches the 44pt
// minimum without spreading the control.
const SEGMENT_HIT_SLOP = { top: 8, bottom: 8, left: 0, right: 0 } as const;

/**
 * The control that flips one thread between the conversation and the product it is
 * building. It offers only the surfaces the host would answer for, so choosing
 * one never lands on a refusal — and with nothing to switch between it shows
 * nothing at all.
 */
export function ThreadSurfaceSwitcher(props: ThreadSurfaceSwitcherProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { alignItems: "center", paddingBottom: space.xs },
        track: {
          flexDirection: "row",
          padding: 2,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        segment: {
          height: 28,
          minWidth: 76,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 14,
          borderRadius: radii.pill,
        },
        segmentActive: {
          backgroundColor: colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStrokeStrong,
        },
        label: { fontSize: typography.caption.fontSize, fontWeight: "500" },
      }),
    [colors],
  );

  if (props.surfaces.length < 2) return null;

  return (
    <View style={styles.wrap} testID="mobile-thread-surface-switcher">
      <View accessibilityRole="tablist" style={styles.track}>
        {props.surfaces.map((surface) => {
          const active = surface.id === props.active;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              hitSlop={SEGMENT_HIT_SLOP}
              key={surface.id}
              onPress={() => props.onSelect(surface.id)}
              style={[styles.segment, active ? styles.segmentActive : null]}
              testID={`mobile-thread-surface-${surface.id}`}
            >
              <Text
                style={[
                  styles.label,
                  { color: active ? colors.textPrimary : colors.textSecondary },
                ]}
              >
                {surface.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
