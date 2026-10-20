import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  GlassChip,
  EFFECT_MAX,
  EFFECT_MIN,
  radii,
  space,
  typography,
  useTheme,
  type ColorSchemePreference,
  type GroundEffect,
  type GroundPicture,
  type SurfaceStylePreference,
} from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { useAppearance } from "./AppearanceContext";
import { persistWallpaperFile } from "./wallpaperFile";

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

const PICTURE_OPTIONS: ReadonlyArray<{
  readonly id: GroundPicture;
  readonly label: string;
}> = [
  { id: "soft-glow", label: MOBILE_COPY.backgroundPictureSoftGlow },
  { id: "soft-graphite", label: MOBILE_COPY.backgroundPictureSoftGraphite },
  { id: "soft-sunset", label: MOBILE_COPY.backgroundPictureSoftSunset },
  { id: "atmosphere", label: MOBILE_COPY.backgroundPictureAtmosphere },
  { id: "custom", label: MOBILE_COPY.backgroundPictureCustom },
  { id: "plain", label: MOBILE_COPY.backgroundPicturePlain },
];

const EFFECT_OPTIONS: ReadonlyArray<{
  readonly id: GroundEffect["kind"];
  readonly label: string;
}> = [
  { id: "none", label: MOBILE_COPY.backgroundEffectNone },
  { id: "pixelate", label: MOBILE_COPY.backgroundEffectPixelate },
  { id: "dither", label: MOBILE_COPY.backgroundEffectDither },
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

interface DialProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly testID: string;
}

/** A whole-number dial on the desktop's 2..16 range, with 44pt steppers. */
function Dial(props: DialProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        dialRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        },
        dialLabel: { color: colors.textPrimary, fontSize: typography.body.fontSize },
        dialControls: { flexDirection: "row", alignItems: "center", gap: space.sm },
        dialButton: {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        dialButtonLabel: { color: colors.textPrimary, fontSize: 20, fontWeight: "500" },
        dialValue: {
          minWidth: 32,
          textAlign: "center",
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
        },
      }),
    [colors],
  );
  return (
    <View style={styles.dialRow} testID={props.testID}>
      <Text style={styles.dialLabel}>{props.label}</Text>
      <View style={styles.dialControls}>
        <Pressable
          accessibilityLabel={`${MOBILE_COPY.backgroundDialLess} ${props.label.toLowerCase()}`}
          accessibilityRole="button"
          disabled={props.value <= EFFECT_MIN}
          onPress={() => props.onChange(props.value - 1)}
          style={styles.dialButton}
          testID={`${props.testID}-less`}
        >
          <Text style={styles.dialButtonLabel}>−</Text>
        </Pressable>
        <Text
          accessibilityLabel={props.label}
          accessibilityRole="adjustable"
          accessibilityValue={{ min: EFFECT_MIN, max: EFFECT_MAX, now: props.value }}
          style={styles.dialValue}
          testID={`${props.testID}-value`}
        >
          {props.value}
        </Text>
        <Pressable
          accessibilityLabel={`${MOBILE_COPY.backgroundDialMore} ${props.label.toLowerCase()}`}
          accessibilityRole="button"
          disabled={props.value >= EFFECT_MAX}
          onPress={() => props.onChange(props.value + 1)}
          style={styles.dialButton}
          testID={`${props.testID}-more`}
        >
          <Text style={styles.dialButtonLabel}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function AppearanceBackgroundPanel() {
  const appearance = useAppearance();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const writeTail = useRef(Promise.resolve());
  const inflightWrites = useRef(0);
  const picture = appearance.preferences.picture;
  const effect = appearance.preferences.effect;
  const custom = picture === "custom";
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
          lineHeight: 20,
        },
        section: {
          marginTop: space.sm,
          fontSize: typography.section.fontSize,
          fontWeight: typography.section.fontWeight,
          letterSpacing: typography.section.letterSpacing,
          color: colors.textTertiary,
        },
        themeRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.sm,
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
          fontWeight: "500",
          fontSize: typography.body.fontSize,
        },
        secondary: { alignItems: "center", paddingVertical: space.sm },
        secondaryLabel: { color: colors.accent, fontWeight: "500" },
        message: { color: colors.textSecondary, fontSize: typography.caption.fontSize },
      }),
    [colors],
  );

  const runBackgroundAction = (action: () => Promise<void>, successMessage: string) => {
    inflightWrites.current += 1;
    setBusy(true);
    setMessage(undefined);
    const run = writeTail.current.then(action, action).then(
      () => {
        setMessage(successMessage);
      },
      (cause: unknown) => {
        setMessage(cause instanceof Error ? cause.message : MOBILE_COPY.backgroundImageFailed);
      },
    );
    writeTail.current = run.then(
      () => undefined,
      () => undefined,
    );
    void run.finally(() => {
      inflightWrites.current -= 1;
      if (inflightWrites.current === 0) {
        setBusy(false);
      }
    });
  };

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
      // Native: keep a copy in the documents folder, because the picker's cache
      // file can be purged. Web: data URI for reload survival.
      const stored =
        Platform.OS === "web" ? await readAsDataUri(asset.uri) : persistWallpaperFile(asset.uri);
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
      <Text style={styles.help}>{MOBILE_COPY.backgroundPictureTitle}</Text>
      <View style={styles.themeRow} testID="mobile-appearance-picture-row">
        {PICTURE_OPTIONS.map((option) => (
          <GlassChip
            key={option.id}
            active={picture === option.id}
            label={option.label}
            onPress={() => {
              const id = option.id;
              if (id === "custom") {
                void pickImage();
              } else {
                runBackgroundAction(() => appearance.setPicture(id), option.label);
              }
            }}
            testID={`mobile-appearance-picture-${option.id}`}
          />
        ))}
      </View>

      {custom ? (
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
      ) : null}

      <Text style={styles.help}>{MOBILE_COPY.backgroundEffectTitle}</Text>
      <View style={styles.themeRow} testID="mobile-appearance-effect-row">
        {EFFECT_OPTIONS.map((option) => (
          <GlassChip
            key={option.id}
            active={effect.kind === option.id}
            label={option.label}
            onPress={() => {
              void appearance.setEffect({ ...effect, kind: option.id });
            }}
            testID={`mobile-appearance-effect-${option.id}`}
          />
        ))}
      </View>
      {effect.kind !== "none" ? (
        <>
          <Dial
            label={MOBILE_COPY.backgroundPixelSize}
            onChange={(cell) => void appearance.setEffect({ ...effect, cell })}
            testID="mobile-appearance-dial-cell"
            value={effect.cell}
          />
          {effect.kind === "dither" ? (
            <Dial
              label={MOBILE_COPY.backgroundColours}
              onChange={(levels) => void appearance.setEffect({ ...effect, levels })}
              testID="mobile-appearance-dial-levels"
              value={effect.levels}
            />
          ) : null}
        </>
      ) : null}
      <Text style={styles.help}>{MOBILE_COPY.backgroundEffectHelp}</Text>

      {custom ? (
        <Pressable
          disabled={busy}
          onPress={() => {
            runBackgroundAction(
              appearance.clearCustomBackground,
              MOBILE_COPY.backgroundImageCleared,
            );
          }}
          style={[styles.secondary, busy ? styles.buttonDisabled : null]}
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
