import type { ExpoConfig } from "expo/config";

const configuredMockScenario = process.env.OCTANT_MOBILE_MOCK_SCENARIO?.trim();
// Only a local run or a development-side EAS profile may carry a mock
// scenario. A release profile (`production`, `android-internal`) or one added
// later without a decision gets none, whatever the environment holds.
const easBuildProfile = process.env.EAS_BUILD_PROFILE;
const allowMockScenario =
  process.env.NODE_ENV !== "production" &&
  (easBuildProfile === undefined ||
    easBuildProfile === "development" ||
    easBuildProfile === "preview");

// Both camera uses are named, because the image picker and the pairing scanner
// each write this one reason. The app asks for no location access at all.
const CAMERA_PERMISSION =
  "Octant uses the camera to scan the pairing QR code another computer shows, and to take a photo you attach to a thread.";
const PHOTO_LIBRARY_PERMISSION =
  "Octant uses your photo library to attach a photo you choose to a thread, and to set a local app background.";

// Every plugin that can declare the microphone names the same single use:
// one of them left at `false` would remove the iOS string, or block the
// Android permission, that dictation needs.
const DICTATION_MICROPHONE_PERMISSION =
  "Octant uses the microphone only while you record a message to dictate. Your paired computer turns it into text, and the recording is not kept.";

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
    // Android backup would copy the app's data off the phone; the keystore
    // key that encrypts secure storage never leaves it, so a restored copy
    // is unreadable at best. Nothing is backed up.
    allowBackup: false,
    // Push on Android needs the Firebase project's file. It is a build input
    // (an EAS file variable), never a file in the repository, and a build
    // made without it reports push unavailable instead of failing.
    ...(process.env.GOOGLE_SERVICES_JSON
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
      : {}),
    // Expo adds the overlay permission by default and no library here needs
    // it. Location is never asked for, and without the media-location
    // permission Android removes a picked photo's location before Octant
    // reads it.
    blockedPermissions: [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.ACCESS_MEDIA_LOCATION",
    ],
  },
  plugins: [
    ["expo-build-properties", { ios: { enableSceneSupport: true } }],
    // The push entitlement, the Keychain group shared with the notification
    // service extension, and the extension target itself. Off until the build
    // is made with the push capability on its App ID (`OCTANT_MOBILE_PUSH=1`,
    // an EAS variable set once the push accounts exist), so a build made
    // before then signs as it does today.
    ["./plugins/withOctantPush", { enabled: process.env.OCTANT_MOBILE_PUSH === "1" }],
    "expo-secure-store",
    "expo-local-authentication",
    "expo-font",
    "expo-system-ui",
    [
      "expo-image-picker",
      {
        photosPermission: PHOTO_LIBRARY_PERMISSION,
        cameraPermission: CAMERA_PERMISSION,
        microphonePermission: DICTATION_MICROPHONE_PERMISSION,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: CAMERA_PERMISSION,
        microphonePermission: DICTATION_MICROPHONE_PERMISSION,
        recordAudioAndroid: false,
      },
    ],
    // Dictation records in the foreground only: no background audio mode on
    // iOS and no foreground service on Android.
    [
      "expo-audio",
      {
        microphonePermission: DICTATION_MICROPHONE_PERMISSION,
        recordAudioAndroid: true,
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
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
