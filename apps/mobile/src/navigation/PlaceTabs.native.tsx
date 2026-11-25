import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View, type ImageSourcePropType } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Tabs, type TabsHostNavStateRequest } from "react-native-screens";
import { useTheme } from "../../design-system";
import { hapticSelect } from "../ui/haptics";
import { NewButton } from "./NewButton";
import type { PlaceTabsProps } from "./PlaceTabs.types";
import { placeFor, shippedMobilePlaces, type MobilePlaceId } from "./places";

const NEW_KEY = "new";
// iOS 26.1 sets a search tab apart at the bar's trailing end, and iOS 27 any one
// tab. New takes that place and only answers the press. Before that, New is a
// button of its own, as it is on Android.
const IOS = Platform.OS === "ios" ? Number.parseFloat(String(Platform.Version)) : 0;
const NEW_IS_A_TAB = IOS >= 26.1;
const NEW_IS_PROMINENT = IOS >= 27;

type AndroidIcons = Readonly<
  Partial<Record<MobilePlaceId, readonly [ImageSourcePropType, ImageSourcePropType]>>
>;

/** Material bars take an image; the glyphs come from the icon font the app ships. */
function useAndroidIcons(): AndroidIcons {
  const [icons, setIcons] = useState<AndroidIcons>({});
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let cancelled = false;
    void Promise.all(
      shippedMobilePlaces().map(async (place) => {
        const [plain, selected] = await Promise.all([
          Ionicons.getImageSource(place.icon, 24, "#000000"),
          Ionicons.getImageSource(place.selectedIcon, 24, "#000000"),
        ]);
        return plain === null || selected === null
          ? undefined
          : ([place.id, [plain, selected]] as const);
      }),
    ).then((entries) => {
      if (cancelled) return;
      setIcons(Object.fromEntries(entries.filter((entry) => entry !== undefined)));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return icons;
}

/** The system's own tab bar: icons only, each with a spoken label. */
export function PlaceTabs(props: PlaceTabsProps) {
  const { colors, scheme } = useTheme();
  const androidIcons = useAndroidIcons();
  // The native bar holds the selection; a request names the state it was
  // derived from, so a late one cannot undo a tap.
  const provenance = useRef(0);
  const [request, setRequest] = useState<TabsHostNavStateRequest>({
    selectedScreenKey: props.active,
    baseProvenance: 0,
  });
  useEffect(() => {
    setRequest({ selectedScreenKey: props.active, baseProvenance: provenance.current });
  }, [props.active]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <Tabs.Host
        colorScheme={scheme}
        ios={{
          tabBarTintColor: colors.accent,
          ...(NEW_IS_PROMINENT && !props.newDisabled ? { prominentScreenKey: NEW_KEY } : {}),
        }}
        navStateRequest={request}
        onTabSelected={(event) => {
          const { actionOrigin, hasTriggeredSpecialEffect, isRepeated, selectedScreenKey } =
            event.nativeEvent;
          provenance.current = event.nativeEvent.provenance;
          const place = placeFor(selectedScreenKey);
          // The bar also reports what it was told to select. Taken as a tap,
          // that returned the place to its root and closed the thread a link
          // had just opened there.
          if (actionOrigin === "programmatic-js") return;
          if (actionOrigin !== "user" && place === props.active) return;
          // The bar has already returned the place to its root.
          if (isRepeated && hasTriggeredSpecialEffect) return;
          if (actionOrigin === "user") hapticSelect();
          props.onSelect(place);
        }}
        onTabSelectionPrevented={(event) => {
          if (event.nativeEvent.preventedScreenKey === NEW_KEY) props.onNew();
        }}
      >
        {shippedMobilePlaces().map((place) => {
          const icons = androidIcons[place.id];
          return (
            <Tabs.Screen
              android={{
                ...(icons === undefined
                  ? {}
                  : {
                      icon: { type: "imageSource", imageSource: icons[0], tinting: "tinted" },
                      selectedIcon: {
                        type: "imageSource",
                        imageSource: icons[1],
                        tinting: "tinted",
                      },
                    }),
                standardAppearance: { tabBarItemLabelVisibilityMode: "unlabeled" },
              }}
              ios={{
                icon: { type: "sfSymbol", name: place.symbol },
                selectedIcon: { type: "sfSymbol", name: place.selectedSymbol },
              }}
              key={place.id}
              screenKey={place.id}
              tabBarItemAccessibilityLabel={place.label}
              tabBarItemTestID={`mobile-tab-${place.id}`}
            >
              {/* Its own provider, so a screen's bottom inset includes the bar over it. */}
              <SafeAreaProvider>{props.screens[place.id]}</SafeAreaProvider>
            </Tabs.Screen>
          );
        })}
        {NEW_IS_A_TAB && !props.newDisabled ? (
          <Tabs.Screen
            ios={{
              icon: { type: "sfSymbol", name: "square.and.pencil" },
              ...(NEW_IS_PROMINENT ? {} : { role: "search" as const }),
            }}
            key={NEW_KEY}
            preventNativeSelection
            screenKey={NEW_KEY}
            tabBarItemAccessibilityLabel="New thread"
            tabBarItemTestID="mobile-new-thread"
          />
        ) : null}
      </Tabs.Host>
      {NEW_IS_A_TAB || props.newHidden ? null : (
        <NewButton disabled={props.newDisabled} onPress={props.onNew} />
      )}
    </View>
  );
}
