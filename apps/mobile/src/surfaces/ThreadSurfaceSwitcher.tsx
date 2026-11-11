import { StyleSheet, View } from "react-native";
import type { RemoteThreadSurfaceKind } from "@octant/client-runtime";
import { space } from "../../design-system";
import { SegmentedControl } from "../ui/NativeChrome";
import type { MobileThreadSurfaceOption } from "./threadSurfacePresentation";

export interface ThreadSurfaceSwitcherProps {
  readonly surfaces: ReadonlyArray<MobileThreadSurfaceOption>;
  readonly active: RemoteThreadSurfaceKind;
  readonly onSelect: (surface: RemoteThreadSurfaceKind) => void;
}

/**
 * The control that flips one thread between the conversation and the product it is
 * building. It offers only the surfaces the host would answer for, so choosing
 * one never lands on a refusal — and with nothing to switch between it shows
 * nothing at all.
 */
export function ThreadSurfaceSwitcher(props: ThreadSurfaceSwitcherProps) {
  if (props.surfaces.length < 2) return null;

  return (
    <View style={styles.wrap}>
      <SegmentedControl
        onSelect={props.onSelect}
        optionTestID={(id) => `mobile-thread-surface-${id}`}
        options={props.surfaces}
        selected={props.active}
        testID="mobile-thread-surface-switcher"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.md, paddingBottom: space.sm },
});
