import { useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { ParamListBase } from "@react-navigation/native";
import { ToolbarButton } from "../ui/NativeChrome";
import type { MobileIconName } from "../ui/IconButton";
import { hasLiquidGlass } from "../ui/systemVersion";
import { systemSymbol } from "../ui/symbols";
import { typography, useTheme } from "../../design-system";

// A system bar keeps its height at every text size, so two lines in it stop
// growing where they would no longer fit. The system's own bar titles do too.
const BAR_TEXT_SCALE = 1.15;

export interface ScreenHeaderAction {
  readonly label: string;
  readonly icon: MobileIconName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
}

/**
 * A screen's part of the system navigation bar: its title, a second line when
 * it has one, its actions and its search field. The bar, Back and the
 * collapsing large title are the platform's own. A place's name stands on the
 * bar's own line at the leading edge, so its list starts right under it.
 */
export function ScreenHeader(props: {
  readonly title: string;
  /** Set on the first screen of a place. */
  readonly place?: boolean;
  readonly subtitle?: string | undefined;
  readonly actions?: ReadonlyArray<ScreenHeaderAction>;
  readonly search?: {
    readonly placeholder: string;
    readonly onChangeText: (text: string) => void;
  };
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { colors } = useTheme();
  const { title, subtitle, actions, search } = props;
  const leading = props.place === true && hasLiquidGlass();
  // Beside Back, where a long title keeps its room as actions join the bar.
  const leadingTitles = hasLiquidGlass();
  const { width } = useWindowDimensions();
  // What Back and the actions leave on the bar's one line.
  const titleRoom = Math.max(110, width - 104 - (actions?.length ?? 0) * 50);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        title: {
          color: colors.textPrimary,
          fontSize: typography.pageTitle.fontSize,
          fontWeight: typography.pageTitle.fontWeight,
        },
        place: { color: colors.textPrimary, fontSize: 28, fontWeight: "700", letterSpacing: -0.4 },
        subtitle: { color: colors.textSecondary, fontSize: typography.meta.fontSize },
        titles: { maxWidth: titleRoom },
        actions: { flexDirection: "row", alignItems: "center" },
      }),
    [colors, titleRoom],
  );

  // The header keeps its options until what it shows changes. Handing the
  // native search field new ones on each keystroke is needless work, so the
  // handlers are read when they run.
  const handlers = useRef({ actions, search });
  handlers.current = { actions, search };
  const shown = JSON.stringify({
    title,
    subtitle,
    placeholder: search?.placeholder,
    actions: actions?.map(({ label, icon, disabled, testID }) => ({
      label,
      icon,
      disabled,
      testID,
    })),
  });
  useLayoutEffect(() => {
    const titles = (
      <View style={styles.titles}>
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={BAR_TEXT_SCALE}
          numberOfLines={1}
          style={styles.title}
        >
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text maxFontSizeMultiplier={BAR_TEXT_SCALE} numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        )}
      </View>
    );
    const run = (label: string) =>
      handlers.current.actions?.find((current) => current.label === label)?.onPress();
    const options: NativeStackNavigationOptions = {
      title,
      ...(leading
        ? {
            headerTitle: "",
            unstable_headerLeftItems: () => [
              {
                type: "custom" as const,
                // A name is not a control, so it stands on no glass of its own.
                hidesSharedBackground: true,
                element: (
                  <Text
                    accessibilityRole="header"
                    maxFontSizeMultiplier={BAR_TEXT_SCALE}
                    numberOfLines={1}
                    style={styles.place}
                  >
                    {title}
                  </Text>
                ),
              },
            ],
          }
        : {}),
      ...(Platform.OS === "ios"
        ? {
            unstable_headerRightItems: () =>
              (actions ?? []).map((action) => {
                const symbol = systemSymbol(action.icon);
                return {
                  type: "button" as const,
                  label: action.label,
                  accessibilityLabel: action.label,
                  ...(symbol === undefined
                    ? {}
                    : { icon: { type: "sfSymbol" as const, name: symbol } }),
                  ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
                  ...(action.testID === undefined ? {} : { identifier: action.testID }),
                  onPress: () => run(action.label),
                };
              }),
          }
        : {
            headerRight: () =>
              actions === undefined || actions.length === 0 ? null : (
                <View style={styles.actions}>
                  {actions.map((action) => (
                    <ToolbarButton
                      accessibilityLabel={action.label}
                      icon={action.icon}
                      key={action.label}
                      onPress={action.onPress}
                      {...(action.disabled === undefined ? {} : { disabled: action.disabled })}
                      {...(action.testID === undefined ? {} : { testID: action.testID })}
                    />
                  ))}
                </View>
              ),
          }),
      ...(subtitle === undefined
        ? {}
        : leadingTitles
          ? {
              headerTitle: "",
              headerBackVisible: true,
              unstable_headerLeftItems: () => [
                {
                  type: "custom" as const,
                  hidesSharedBackground: true,
                  element: titles,
                },
              ],
            }
          : {
              headerTitle: () => titles,
            }),
      ...(search === undefined
        ? {}
        : {
            headerSearchBarOptions: {
              placeholder: search.placeholder,
              // A round button in the bar that opens into the field. The system
              // would otherwise put it in a bottom bar, where the places are.
              ...(leading
                ? { placement: "integratedButton" as const, allowToolbarIntegration: false }
                : {}),
              onChangeText: (event) =>
                handlers.current.search?.onChangeText(event.nativeEvent.text),
              onCancelButtonPress: () => handlers.current.search?.onChangeText(""),
            },
          }),
    };
    navigation.setOptions(options);
    // `shown` stands for every value the options draw.
  }, [leading, leadingTitles, navigation, shown, styles]);
  return null;
}
