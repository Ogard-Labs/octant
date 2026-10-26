import type { ExpoConfig } from "expo/config";

const configuredMockScenario = process.env.OCTANT_MOBILE_MOCK_SCENARIO?.trim();
const allowMockScenario =
  process.env.NODE_ENV !== "production" && process.env.EAS_BUILD_PROFILE !== "production";

// Both camera uses are named, because the image picker and the pairing scanner
// each write this one reason. The app asks for no location access at all.
const CAMERA_PERMISSION =
  "Octant uses the camera to scan the pairing QR code another computer shows, and to take a photo you attach to a thread.";
const PHOTO_LIBRARY_PERMISSION =
  "Octant uses your photo library to attach a photo you choose to a thread, and to set a local app background.";

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
      // A paired computer on a private LAN address is a local-network
      // destination: iOS asks before the app may reach it and shows this
      // reason. No Bonjour service is declared, since Octant browses none.
      NSLocalNetworkUsageDescription:
        "Octant connects to computers you pair with on your local network.",
    },
  },
  android: {
    package: "app.octant.mobile",
  },
  plugins: [
    ["expo-build-properties", { ios: { enableSceneSupport: true } }],
    "expo-secure-store",
    "expo-local-authentication",
    "expo-font",
    "expo-system-ui",
    [
      "expo-image-picker",
      {
        photosPermission: PHOTO_LIBRARY_PERMISSION,
        cameraPermission: CAMERA_PERMISSION,
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: CAMERA_PERMISSION,
        microphonePermission: false,
        recordAudioAndroid: false,
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
