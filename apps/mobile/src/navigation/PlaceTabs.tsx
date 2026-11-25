import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../ui/Icon";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import type { PlaceTabsProps } from "./PlaceTabs.types";
import { shippedMobilePlaces } from "./places";

/** The development mock's stand-in for the system bar: a layout check, not a fidelity one. */
export function PlaceTabs(props: PlaceTabsProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1 },
        place: { flex: 1 },
        away: { display: "none" },
        dock: {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 16,
          backgroundColor: colors.canvas,
        },
        bar: {
          flex: 1,
          height: 56,
          flexDirection: "row",
          paddingHorizontal: 6,
          borderRadius: 28,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairlineStrong,
          backgroundColor: colors.control,
        },
        selected: {
          position: "absolute",
          inset: 5,
          borderRadius: 24,
          backgroundColor: colors.controlPressed,
        },
        create: {
          width: 56,
          height: 56,
          borderRadius: 28,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairlineStrong,
          backgroundColor: colors.control,
        },
        disabled: { opacity: 0.45 },
        tab: { flex: 1, alignItems: "center", justifyContent: "center" },
      }),
    [colors],
  );
  return (
    <View style={styles.shell}>
      {shippedMobilePlaces().map((place) => (
        <View
          key={place.id}
          style={place.id === props.active ? styles.place : styles.away}
          testID={`mobile-place-${place.id}`}
        >
          {props.screens[place.id]}
        </View>
      ))}
      <View style={styles.dock}>
        <View accessibilityRole="tablist" style={styles.bar} testID="mobile-tab-bar">
          {shippedMobilePlaces().map((place) => {
            const active = place.id === props.active;
            return (
              <Pressable
                accessibilityLabel={place.label}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                key={place.id}
                onPress={() => props.onSelect(place.id)}
                style={styles.tab}
                testID={`mobile-tab-${place.id}`}
              >
                {active ? <View style={styles.selected} /> : null}
                <Icon
                  color={active ? colors.accent : colors.textPrimary}
                  name={active ? place.selectedIcon : place.icon}
                  size={24}
                />
              </Pressable>
            );
          })}
        </View>
        <Pressable
          accessibilityLabel={MOBILE_COPY.newThread}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.newDisabled }}
          disabled={props.newDisabled}
          onPress={props.onNew}
          style={[styles.create, props.newDisabled ? styles.disabled : null]}
          testID="mobile-new-thread"
        >
          <Icon color={colors.textPrimary} name="create-outline" size={23} />
        </Pressable>
      </View>
    </View>
  );
}
