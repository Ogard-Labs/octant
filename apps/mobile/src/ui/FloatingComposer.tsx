import { useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import type { ComposerVoice } from "../voice/useVoiceDictation";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
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
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly testID?: string;
  readonly footerHint?: string | undefined;
  readonly busyLabel?: string;
  /** Dictation through the host; absent while the host is not ready for it. */
  readonly voice?: ComposerVoice | undefined;
}

export function FloatingComposer(props: FloatingComposerProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          paddingTop: space.xs,
          backgroundColor: "transparent",
        },
        card: {
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          paddingHorizontal: 6,
          paddingVertical: 5,
        },
        placeholder: {
          color: colors.textTertiary,
          flex: 1,
          fontSize: typography.body.fontSize,
          paddingHorizontal: 6,
          paddingVertical: 8,
        },
        input: {
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          flex: 1,
          minHeight: 24,
          maxHeight: 140,
          marginVertical: 6,
          paddingHorizontal: 6,
          paddingVertical: 0,
          textAlignVertical: "top",
          lineHeight: 21,
        },
        modelChip: {
          maxWidth: 128,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: 30,
          marginVertical: 2,
          paddingHorizontal: 10,
          borderRadius: radii.pill,
          backgroundColor: colors.glassFillThin,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        modelLabel: {
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
          flexShrink: 1,
        },
        footerHint: {
          marginTop: space.sm,
          textAlign: "center",
          color: colors.textTertiary,
          fontSize: 12,
          lineHeight: 16,
        },
        busyHint: {
          color: colors.accent,
          fontSize: 12,
          fontWeight: "500",
          alignSelf: "center",
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
      <GlassSurface contentStyle={styles.card} material="thick" radius={24}>
        {props.onPressAttach !== undefined ? (
          <IconButton
            accessibilityLabel="Add attachment"
            name="add"
            onPress={props.onPressAttach}
            size={34}
            testID="mobile-composer-attach"
            variant="ghost"
          />
        ) : null}
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
        {props.modelLabel !== undefined && props.onPressModel !== undefined ? (
          <Pressable
            accessibilityRole="button"
            onPress={props.onPressModel}
            style={styles.modelChip}
            testID="mobile-composer-model"
          >
            <Text style={styles.modelLabel} numberOfLines={1}>
              {props.modelLabel}
            </Text>
            <Ionicons color={colors.textSecondary} name="chevron-down" size={13} />
          </Pressable>
        ) : props.modelLabel !== undefined ? (
          <Text style={styles.modelLabel} numberOfLines={1}>
            {props.modelLabel}
          </Text>
        ) : null}
        {props.busy === true ? (
          <Text style={styles.busyHint} testID="mobile-composer-busy">
            {props.busyLabel ?? "Working"}
          </Text>
        ) : props.voice !== undefined ? (
          <ComposerVoiceButton size={34} voice={props.voice} />
        ) : null}
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
      </GlassSurface>
      {props.voice?.notice !== undefined ? (
        <Text style={styles.footerHint} testID="mobile-composer-voice-notice">
          {props.voice.notice}
        </Text>
      ) : null}
      {props.footerHint !== undefined ? (
        <Text style={styles.footerHint}>{props.footerHint}</Text>
      ) : null}
    </View>
  );
}
