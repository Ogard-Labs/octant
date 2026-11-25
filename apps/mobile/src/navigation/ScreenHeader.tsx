import { useLayoutEffect, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { ParamListBase } from "@react-navigation/native";
import { ToolbarButton } from "../ui/NativeChrome";
import type { MobileIconName } from "../ui/IconButton";
import { typography, useTheme } from "../../design-system";

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

  // No dependency list: actions close over the screen's current state, and
  // setOptions compares nothing itself.
  useLayoutEffect(() => {
    const options: NativeStackNavigationOptions = {
      title,
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
      ...(subtitle === undefined
        ? {}
        : {
            headerTitle: () => (
              <View style={styles.titles}>
                <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
                  {title}
                </Text>
                <Text numberOfLines={1} style={styles.subtitle}>
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
              onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
              onCancelButtonPress: () => search.onChangeText(""),
            },
          }),
    };
    navigation.setOptions(options);
  });
  return null;
}
