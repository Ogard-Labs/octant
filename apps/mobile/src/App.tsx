import { createInMemoryExpoSecureStringStorage } from "@octant/client-runtime";
import { createAppearanceStore } from "./appearance/AppearanceStore";
import { MobileEntryGate } from "./demo/MobileEntryGate";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Appearance,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Constants from "expo-constants";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { MobileInboxRow } from "@octant/client-runtime";
import { ScreenCanvas, colorsForScheme, resolveThemeScheme, useTheme } from "../design-system";
import { AppearanceProvider, useAppearance } from "./appearance/AppearanceContext";
import type { MobileRouteId } from "./copy";
import { resolveMobileMockScenario, type MobileMockScenario } from "./dev/mobileMockScenarioId";
import { MobileDeepLinkCapture } from "./navigation/mobileDeepLinkCapture";
import { RootNavigator } from "./navigation/RootNavigator";
import { createInitialNavigationState, selectMobileRoute } from "./navigation/navigationState";
import { AppVaultGate } from "./security/AppVaultGate";
import { mobileScreenshotPrivacy } from "./security/deviceProtection";
import { createExpoBiometricAuthenticator } from "./security/expoBiometricAuthenticator";
import { MobileSessionProvider } from "./session/MobileSessionContext";
import { useDistilledFonts } from "./theme/useDistilledFonts";

function AppShell(props: {
  readonly mockScenario?: MobileMockScenario | undefined;
  readonly onLeaveDemo?: () => void;
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
          borderColor: colors.hairlineStrong,
          backgroundColor: colors.surfaceElevated,
          paddingHorizontal: 12,
          paddingVertical: 5,
        },
        demoExit: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
        mockBannerText: {
          color: colors.textSecondary,
          fontSize: 12,
          fontWeight: "500",
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
        effect={appearance.preferences.effect}
        picture={appearance.preferences.picture}
        customImageUri={appearance.preferences.customImageUri}
      >
        {props.mockScenario !== undefined ? (
          <View accessibilityRole="text" style={styles.mockBanner} testID="mobile-mock-banner">
            <Text style={styles.mockBannerText}>
              {props.onLeaveDemo === undefined
                ? `Mock data · ${props.mockScenario.label}`
                : "Offline demo · sample data"}
            </Text>
            {props.onLeaveDemo === undefined ? null : (
              <Pressable
                accessibilityRole="button"
                style={styles.demoExit}
                onPress={props.onLeaveDemo}
                testID="mobile-demo-leave"
              >
                <Text style={styles.mockBannerText}>Leave demo</Text>
              </Pressable>
            )}
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
    if (id === undefined || !isDevelopment) return undefined;
    // Development configuration never enables a production scenario. The public
    // offline demo loads the same fixtures only after an explicit entry choice.
    const dev: typeof import("./dev/mobileMockScenario") = require("./dev/mobileMockScenario");
    return dev.createMobileMockScenario(id);
  }, []);
  // Fonts load before the theme provider mounts, so follow the system setting
  // to avoid a light flash on dark phones.
  const bootColors = colorsForScheme(resolveThemeScheme("system", Appearance.getColorScheme()));
  const demoAppearance = useMemo(
    () => createAppearanceStore(createInMemoryExpoSecureStringStorage()),
    [],
  );
  const [offlineScenario, setOfflineScenario] = useState<MobileMockScenario | undefined>();
  const authenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  // The Android module starts with the secure window set; this applies the
  // session's choice again at launch, so a module that loaded after its
  // first foreground signal still protects the window before any thread
  // renders behind the vault.
  useEffect(() => {
    void mobileScreenshotPrivacy.getMode().then((mode) => mobileScreenshotPrivacy.apply(mode));
  }, []);

  if (!fonts.ready) {
    return (
      <View style={[bootStyles.boot, { backgroundColor: bootColors.canvas }]}>
        <ActivityIndicator color={bootColors.primary} />
      </View>
    );
  }

  const live = (
    <AppearanceProvider>
      <MobileDeepLinkCapture>
        {(pendingDeepLinkRow, onDeepLinkConsumed) => (
          <AppVaultGate authenticator={authenticator}>
            <MobileSessionProvider>
              <AppShell
                onDeepLinkConsumed={onDeepLinkConsumed}
                {...(pendingDeepLinkRow === undefined ? {} : { pendingDeepLinkRow })}
              />
            </MobileSessionProvider>
          </AppVaultGate>
        )}
      </MobileDeepLinkCapture>
    </AppearanceProvider>
  );
  if (mockScenario !== undefined)
    return (
      <SafeAreaProvider>
        <AppearanceProvider>
          <MobileSessionProvider mockScenario={mockScenario}>
            <AppShell mockScenario={mockScenario} onDeepLinkConsumed={() => undefined} />
          </MobileSessionProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    );
  return (
    <SafeAreaProvider>
      <AppearanceProvider store={demoAppearance}>
        <MobileEntryGate
          live={live}
          demo={(leave) => (
            <OfflineDemo
              scenario={offlineScenario}
              onLeave={() => {
                setOfflineScenario(undefined);
                leave();
              }}
              onReady={setOfflineScenario}
            />
          )}
        />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

const bootStyles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

function OfflineDemo(props: {
  readonly scenario: MobileMockScenario | undefined;
  readonly onReady: (scenario: MobileMockScenario) => void;
  readonly onLeave: () => void;
}) {
  useEffect(() => {
    if (props.scenario !== undefined) return;
    const fixtures: typeof import("./demo/offlineMobileDemo") = require("./demo/offlineMobileDemo");
    props.onReady(fixtures.createOfflineMobileDemo());
  }, [props.scenario, props.onReady]);
  if (props.scenario === undefined) return null;
  return (
    <MobileSessionProvider mockScenario={props.scenario}>
      <AppShell
        mockScenario={props.scenario}
        onLeaveDemo={props.onLeave}
        onDeepLinkConsumed={() => undefined}
      />
    </MobileSessionProvider>
  );
}
