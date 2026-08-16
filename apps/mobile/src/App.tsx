import { useMemo, useState } from "react";
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { MobileInboxRow } from "@octant/client-runtime";
import { ScreenCanvas, lightColors, useTheme } from "../design-system";
import { AppearanceProvider, useAppearance } from "./appearance/AppearanceContext";
import type { MobileRouteId } from "./copy";
import {
  createMobileMockScenario,
  resolveMobileMockScenario,
  type MobileMockScenario,
} from "./dev/mobileMockScenario";
import { MobileDeepLinkCapture } from "./navigation/mobileDeepLinkCapture";
import { RootNavigator } from "./navigation/RootNavigator";
import { createInitialNavigationState, selectMobileRoute } from "./navigation/navigationState";
import { AppVaultGate } from "./security/AppVaultGate";
import { createExpoBiometricAuthenticator } from "./security/expoBiometricAuthenticator";
import { MobileSessionProvider } from "./session/MobileSessionContext";
import { useDistilledFonts } from "./theme/useDistilledFonts";

function AppShell(props: {
  readonly mockScenario?: MobileMockScenario | undefined;
  readonly onDeepLinkConsumed: () => void;
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
}) {
  const appearance = useAppearance();
  const { colors, scheme } = useTheme();
  const [navigation, setNavigation] = useState(createInitialNavigationState);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safeArea: {
          flex: 1,
          backgroundColor: colors.canvas,
        },
        mockBanner: {
          alignSelf: "center",
          marginTop: 6,
          marginBottom: 2,
          borderRadius: 999,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.warning,
          backgroundColor: colors.surfaceElevated,
          paddingHorizontal: 12,
          paddingVertical: 5,
        },
        mockBannerText: {
          color: colors.warning,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        },
      }),
    [colors],
  );

  const onSelectRoute = (route: MobileRouteId) => {
    setNavigation((current) => selectMobileRoute(current, route));
  };

  return (
    <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.safeArea}>
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <ScreenCanvas
        backgroundMode={appearance.preferences.backgroundMode}
        customImageUri={appearance.preferences.customImageUri}
      >
        {props.mockScenario !== undefined ? (
          <View accessibilityRole="text" style={styles.mockBanner} testID="mobile-mock-banner">
            <Text style={styles.mockBannerText}>Mock data · {props.mockScenario.label}</Text>
          </View>
        ) : null}
        <RootNavigator
          activeRoute={navigation.activeRoute}
          onDeepLinkConsumed={props.onDeepLinkConsumed}
          onSelectRoute={onSelectRoute}
          {...(props.pendingDeepLinkRow === undefined
            ? {}
            : { pendingDeepLinkRow: props.pendingDeepLinkRow })}
        />
      </ScreenCanvas>
    </SafeAreaView>
  );
}

export default function App() {
  const fonts = useDistilledFonts();
  const mockScenario = useMemo(() => {
    const configured = Constants.expoConfig?.extra?.mobileMockScenario;
    const isDevelopment = typeof __DEV__ !== "undefined" && __DEV__;
    const id = resolveMobileMockScenario(configured, isDevelopment);
    return id === undefined ? undefined : createMobileMockScenario(id);
  }, []);
  const authenticator = useMemo(() => createExpoBiometricAuthenticator(), []);

  if (!fonts.ready) {
    return (
      <View style={bootStyles.boot}>
        <ActivityIndicator color={lightColors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <MobileDeepLinkCapture>
          {(pendingDeepLinkRow, onDeepLinkConsumed) => {
            const shell = (
              <MobileSessionProvider {...(mockScenario === undefined ? {} : { mockScenario })}>
                <AppShell
                  {...(mockScenario === undefined ? {} : { mockScenario })}
                  onDeepLinkConsumed={onDeepLinkConsumed}
                  {...(pendingDeepLinkRow === undefined ? {} : { pendingDeepLinkRow })}
                />
              </MobileSessionProvider>
            );
            return mockScenario === undefined ? (
              <AppVaultGate authenticator={authenticator}>{shell}</AppVaultGate>
            ) : (
              shell
            );
          }}
        </MobileDeepLinkCapture>
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

const bootStyles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: lightColors.canvas,
  },
});
