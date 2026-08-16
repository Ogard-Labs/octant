import { useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { IconButton } from "./IconButton";

export interface FloatingComposerProps {
  readonly placeholder: string;
  readonly value?: string;
  readonly onChangeText?: (value: string) => void;
  readonly onSubmit?: () => void;
  /** When set with busy, show Stop instead of Send (interrupt in-flight turn). */
  readonly onStop?: () => void;
  readonly modelLabel?: string;
  readonly onPressModel?: () => void;
  readonly onPressAttach?: () => void;
  readonly voiceEnabled?: boolean;
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly testID?: string;
  readonly footerHint?: string;
  readonly busyLabel?: string;
}

export function FloatingComposer(props: FloatingComposerProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          paddingHorizontal: space.md,
          paddingBottom: space.md,
          paddingTop: space.xs,
          backgroundColor: "transparent",
        },
        card: {
          paddingHorizontal: space.md,
          paddingTop: space.md,
          paddingBottom: space.sm,
          gap: space.sm,
          minHeight: 96,
        },
        placeholder: {
          color: colors.textTertiary,
          fontSize: typography.body.fontSize,
          paddingVertical: space.xs,
        },
        input: {
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          minHeight: 48,
          maxHeight: 140,
          textAlignVertical: "top",
          lineHeight: 24,
          letterSpacing: typography.body.letterSpacing,
        },
        toolbar: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingTop: 2,
        },
        spacer: { flex: 1 },
        modelChip: {
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          paddingVertical: 7,
          paddingHorizontal: space.sm,
          borderRadius: radii.pill,
          backgroundColor: colors.glassFillThin,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        modelLabel: {
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
          maxWidth: "85%",
        },
        footerHint: {
          marginTop: space.sm,
          textAlign: "center",
          color: colors.textTertiary,
          fontSize: 11,
          lineHeight: 14,
        },
        busyHint: {
          color: colors.accent,
          fontSize: 11,
          fontWeight: "600",
          marginRight: space.xs,
        },
      }),
    [colors],
  );

  const multiline = props.value !== undefined;
  const editable = props.editable !== false && !props.busy;
  const canSend = editable && (props.value ?? "").trim().length > 0 && props.onSubmit !== undefined;

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-floating-composer"}>
      <GlassSurface contentStyle={styles.card} material="thick" radius={radii.composer}>
        {multiline ? (
          <TextInput
            editable={editable}
            multiline
            onChangeText={props.onChangeText}
            placeholder={props.placeholder}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="mobile-composer-input"
            value={props.value}
          />
        ) : (
          <Text style={styles.placeholder}>{props.placeholder}</Text>
        )}
        <View style={styles.toolbar}>
          <IconButton
            accessibilityLabel="Add attachment"
            name="add"
            onPress={props.onPressAttach}
            size={34}
            testID="mobile-composer-attach"
            variant="ghost"
          />
          {props.modelLabel !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onPressModel}
              style={styles.modelChip}
              testID="mobile-composer-model"
            >
              <Text style={styles.modelLabel} numberOfLines={1}>
                {props.modelLabel}
              </Text>
              <Ionicons color={colors.textSecondary} name="chevron-down" size={14} />
            </Pressable>
          ) : (
            <View style={styles.spacer} />
          )}
          {props.busy === true ? (
            <Text style={styles.busyHint} testID="mobile-composer-busy">
              {props.busyLabel ?? "Working"}
            </Text>
          ) : (
            <IconButton
              accessibilityLabel={
                props.voiceEnabled === true ? "Voice input" : "Voice input unavailable"
              }
              name="mic-outline"
              size={34}
              testID={
                props.voiceEnabled === true
                  ? "mobile-composer-voice"
                  : "mobile-composer-voice-disabled"
              }
              variant="ghost"
            />
          )}
          {props.busy === true && props.onStop !== undefined ? (
            <IconButton
              accessibilityLabel="Stop"
              name="stop"
              onPress={props.onStop}
              size={34}
              testID="mobile-composer-stop"
              variant="send"
            />
          ) : props.onSubmit !== undefined ? (
            <IconButton
              accessibilityLabel="Send"
              disabled={!canSend}
              name="arrow-up"
              onPress={props.onSubmit}
              size={34}
              testID="mobile-composer-send"
              variant="send"
            />
          ) : null}
        </View>
      </GlassSurface>
      {props.footerHint !== undefined ? (
        <Text style={styles.footerHint}>{props.footerHint}</Text>
      ) : null}
    </View>
  );
}
