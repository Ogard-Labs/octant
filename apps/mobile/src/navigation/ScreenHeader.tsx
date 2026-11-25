import { useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { ParamListBase } from "@react-navigation/native";
import { ToolbarButton } from "../ui/NativeChrome";
import type { MobileIconName } from "../ui/IconButton";
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
 * collapsing large title are the platform's own.
 */
export function ScreenHeader(props: {
  readonly title: string;
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
  const styles = useMemo(
    () =>
      StyleSheet.create({
        title: {
          color: colors.textPrimary,
          fontSize: typography.pageTitle.fontSize,
          fontWeight: typography.pageTitle.fontWeight,
        },
        subtitle: { color: colors.textSecondary, fontSize: typography.meta.fontSize },
        titles: { maxWidth: 230 },
        actions: { flexDirection: "row", alignItems: "center" },
      }),
    [colors],
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
    const run = (label: string) =>
      handlers.current.actions?.find((current) => current.label === label)?.onPress();
    const options: NativeStackNavigationOptions = {
      title,
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
        : {
            headerTitle: () => (
              <View style={styles.titles}>
                <Text
                  accessibilityRole="header"
                  maxFontSizeMultiplier={BAR_TEXT_SCALE}
                  numberOfLines={1}
                  style={styles.title}
                >
                  {title}
                </Text>
                <Text
                  maxFontSizeMultiplier={BAR_TEXT_SCALE}
                  numberOfLines={1}
                  style={styles.subtitle}
                >
                  {subtitle}
                </Text>
              </View>
            ),
          }),
      ...(search === undefined
        ? {}
        : {
            headerSearchBarOptions: {
              placeholder: search.placeholder,
              onChangeText: (event) =>
                handlers.current.search?.onChangeText(event.nativeEvent.text),
              onCancelButtonPress: () => handlers.current.search?.onChangeText(""),
            },
          }),
    };
    navigation.setOptions(options);
    // `shown` stands for every value the options draw.
  }, [navigation, shown, styles]);
  return null;
}
