import { StyleSheet, View } from "react-native";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { GlassChip } from "../../design-system";
import { mobileSpacing } from "../theme/tokens";
import type { MobileThreadSurfaceOption } from "./threadSurfacePresentation";

export interface ThreadSurfaceSwitcherProps {
  readonly surfaces: ReadonlyArray<MobileThreadSurfaceOption>;
  readonly active: RemoteThreadSurfaceKind;
  readonly onSelect: (surface: RemoteThreadSurfaceKind) => void;
}

/**
 * The row that flips one thread between the conversation and the product it is
 * building. It offers only the surfaces the host would answer for, so choosing
 * one never lands on a refusal — and with nothing to switch between it shows
 * nothing at all.
 */
export function ThreadSurfaceSwitcher(props: ThreadSurfaceSwitcherProps) {
  if (props.surfaces.length < 2) return null;

  return (
    <View style={styles.row} testID="mobile-thread-surface-switcher">
      {props.surfaces.map((surface) => (
        <GlassChip
          active={surface.id === props.active}
          key={surface.id}
          label={surface.label}
          onPress={() => props.onSelect(surface.id)}
          testID={`mobile-thread-surface-${surface.id}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: mobileSpacing.xs,
    paddingHorizontal: mobileSpacing.md,
    paddingBottom: mobileSpacing.xs,
  },
});
