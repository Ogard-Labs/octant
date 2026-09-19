import type { ExpoConfig } from "expo/config";

const configuredMockScenario = process.env.OCTANT_MOBILE_MOCK_SCENARIO?.trim();
const allowMockScenario =
  process.env.NODE_ENV !== "production" && process.env.EAS_BUILD_PROFILE !== "production";

const config: ExpoConfig = {
  name: "Octant",
  slug: "octant-mobile",
  owner: "henrikogard",
  githubUrl: "https://github.com/Ogard-Labs/octant",
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
    appleTeamId: "45AD7E7G5G",
    icon: "./assets/icon-ios.png",
    config: {
      usesNonExemptEncryption: false,
    },
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
      projectId: "348816ec-d222-4e6a-bc5c-1c2c89e4bff6",
    },
    ...(allowMockScenario && configuredMockScenario
      ? { mobileMockScenario: configuredMockScenario }
      : {}),
  },
};

export default config;
