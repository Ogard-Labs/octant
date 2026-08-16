import type { ExpoConfig } from "expo/config";

const configuredMockScenario = process.env.OCTANT_MOBILE_MOCK_SCENARIO?.trim();
const allowMockScenario =
  process.env.NODE_ENV !== "production" && process.env.EAS_BUILD_PROFILE !== "production";

const config: ExpoConfig = {
  name: "Octant",
  slug: "octant-mobile",
  scheme: "octant",
  icon: "./assets/icon.png",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  experiments: {
    autolinkingModuleResolution: true,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "app.octant.mobile",
    infoPlist: {
      NSFaceIDUsageDescription:
        "Octant uses Face ID or your device passcode to unlock the app and confirm high-risk actions.",
    },
  },
  android: {
    package: "app.octant.mobile",
  },
  plugins: [
    "expo-secure-store",
    "expo-local-authentication",
    "expo-font",
    "expo-system-ui",
    [
      "expo-image-picker",
      {
        photosPermission: "Octant uses your photo library only to set a local app background.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  extra: {
    eas: {
      projectId: "replace-before-eas-configure",
    },
    ...(allowMockScenario && configuredMockScenario
      ? { mobileMockScenario: configuredMockScenario }
      : {}),
  },
};

export default config;
