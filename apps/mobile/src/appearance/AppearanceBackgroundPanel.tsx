import { useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  GlassChip,
  GlassSurface,
  radii,
  space,
  typography,
  useTheme,
  type ColorSchemePreference,
  type SurfaceStylePreference,
} from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { useAppearance } from "./AppearanceContext";

/** Soft cap for web data-URI wallpapers in localStorage. */
const MAX_DATA_URI_CHARS = 900_000;

const THEME_OPTIONS: ReadonlyArray<{
  readonly id: ColorSchemePreference;
  readonly label: string;
}> = [
  { id: "system", label: MOBILE_COPY.themeSystem },
  { id: "light", label: MOBILE_COPY.themeLight },
  { id: "dark", label: MOBILE_COPY.themeDark },
];

const SURFACE_OPTIONS: ReadonlyArray<{
  readonly id: SurfaceStylePreference;
  readonly label: string;
}> = [
  { id: "glass", label: MOBILE_COPY.surfaceGlass },
  { id: "flat", label: MOBILE_COPY.surfaceFlat },
];

async function readAsDataUri(uri: string): Promise<string> {
  if (uri.startsWith("data:")) return uri;
  const response = await fetch(uri);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read image."));
    };
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(blob);
  });
}

export function AppearanceBackgroundPanel() {
  const appearance = useAppearance();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const custom = appearance.preferences.backgroundMode === "custom";
  const themePreference = appearance.preferences.colorSchemePreference;
  const surfaceStyle = appearance.preferences.surfaceStyle;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: {
          marginTop: space.lg,
          gap: space.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.glassStroke,
          paddingTop: space.md,
        },
        title: {
          fontSize: typography.title.fontSize,
          fontWeight: typography.title.fontWeight,
          color: colors.textPrimary,
        },
        help: {
          fontSize: typography.body.fontSize,
          color: colors.textSecondary,
          lineHeight: 22,
        },
        section: {
          marginTop: space.sm,
          fontSize: typography.section.fontSize,
          fontWeight: typography.section.fontWeight,
          letterSpacing: typography.section.letterSpacing,
          textTransform: "uppercase",
          color: colors.textTertiary,
        },
        themeRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.sm,
        },
        previewPad: {
          padding: space.md,
        },
        previewLabel: {
          color: colors.textPrimary,
          fontWeight: "600",
        },
        button: {
          backgroundColor: colors.accent,
          paddingVertical: space.md,
          borderRadius: radii.pill,
          alignItems: "center",
        },
        buttonDisabled: { opacity: 0.45 },
        buttonLabel: {
          color: colors.sendLabel,
          fontWeight: "700",
          fontSize: typography.body.fontSize,
        },
        secondary: { alignItems: "center", paddingVertical: space.sm },
        secondaryLabel: { color: colors.accent, fontWeight: "600" },
        message: { color: colors.textSecondary, fontSize: typography.caption.fontSize },
      }),
    [colors],
  );

  const pickImage = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setMessage(MOBILE_COPY.backgroundPermissionDenied);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.55,
        allowsEditing: true,
        aspect: [9, 16],
      });
      if (result.canceled || result.assets[0] === undefined) return;
      const asset = result.assets[0];
      // Native: persist file URI (SecureStore-sized). Web: data URI for reload survival.
      const stored = Platform.OS === "web" ? await readAsDataUri(asset.uri) : asset.uri;
      if (Platform.OS === "web" && stored.length > MAX_DATA_URI_CHARS) {
        setMessage(MOBILE_COPY.backgroundImageTooLarge);
        return;
      }
      await appearance.setCustomBackground(stored);
      setMessage(MOBILE_COPY.backgroundImageSet);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : MOBILE_COPY.backgroundImageFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel} testID="mobile-appearance-panel">
      <Text style={styles.title}>{MOBILE_COPY.appearanceTitle}</Text>
      <Text style={styles.help}>{MOBILE_COPY.appearanceHelp}</Text>

      <Text style={styles.section}>{MOBILE_COPY.themeSectionTitle}</Text>
      <View style={styles.themeRow} testID="mobile-appearance-theme-row">
        {THEME_OPTIONS.map((option) => (
          <GlassChip
            key={option.id}
            active={themePreference === option.id}
            label={option.label}
            onPress={() => {
              void appearance.setColorSchemePreference(option.id);
            }}
            testID={`mobile-appearance-theme-${option.id}`}
          />
        ))}
      </View>
      <Text style={styles.help}>{MOBILE_COPY.themeSystemHelp}</Text>

      <Text style={styles.section}>{MOBILE_COPY.surfaceSectionTitle}</Text>
      <View style={styles.themeRow} testID="mobile-appearance-surface-row">
        {SURFACE_OPTIONS.map((option) => (
          <GlassChip
            key={option.id}
            active={surfaceStyle === option.id}
            label={option.label}
            onPress={() => {
              void appearance.setSurfaceStyle(option.id);
            }}
            testID={`mobile-appearance-surface-${option.id}`}
          />
        ))}
      </View>
      <Text style={styles.help}>{MOBILE_COPY.surfaceHelp}</Text>

      <Text style={styles.section}>{MOBILE_COPY.backgroundSectionTitle}</Text>
      <GlassSurface contentStyle={styles.previewPad} material="thin" radius={radii.md}>
        <Text style={styles.previewLabel}>
          {custom ? MOBILE_COPY.backgroundModeCustom : MOBILE_COPY.backgroundModeCodeGradient}
        </Text>
      </GlassSurface>

      <Pressable
        disabled={busy}
        onPress={() => void pickImage()}
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        testID="mobile-appearance-pick-image"
      >
        {busy ? (
          <ActivityIndicator color={colors.sendLabel} />
        ) : (
          <Text style={styles.buttonLabel}>{MOBILE_COPY.backgroundPickImage}</Text>
        )}
      </Pressable>

      <Pressable
        disabled={busy}
        onPress={() => {
          void appearance.useCodeGradient().then(() => {
            setMessage(MOBILE_COPY.backgroundModeCodeGradient);
          });
        }}
        style={styles.secondary}
        testID="mobile-appearance-use-code-gradient"
      >
        <Text style={styles.secondaryLabel}>{MOBILE_COPY.backgroundUseCodeGradient}</Text>
      </Pressable>

      {custom ? (
        <Pressable
          disabled={busy}
          onPress={() => {
            void appearance.clearCustomBackground().then(() => {
              setMessage(MOBILE_COPY.backgroundImageCleared);
            });
          }}
          style={styles.secondary}
          testID="mobile-appearance-clear-image"
        >
          <Text style={styles.secondaryLabel}>{MOBILE_COPY.backgroundClearImage}</Text>
        </Pressable>
      ) : null}

      {message !== undefined ? (
        <Text style={styles.message} testID="mobile-appearance-message">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
