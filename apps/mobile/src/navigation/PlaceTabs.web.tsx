import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../design-system";
import { NewButton } from "./NewButton";
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
        bar: {
          flexDirection: "row",
          height: 49,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.hairlineStrong,
          backgroundColor: colors.canvas,
        },
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
      {props.barHidden ? null : (
        <>
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
                  <Ionicons
                    color={active ? colors.accent : colors.textTertiary}
                    name={active ? place.selectedIcon : place.icon}
                    size={24}
                  />
                </Pressable>
              );
            })}
          </View>
          <NewButton disabled={props.newDisabled} onPress={props.onNew} />
        </>
      )}
    </View>
  );
}
