import {
  composerValueShown,
  noteTypedComposerText,
} from "@octant/client-runtime/typed-composer-text";
import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Icon } from "./Icon";
import { radii, space, typography, useTheme } from "../../design-system";
import type { ComposerVoice } from "../voice/useVoiceDictation";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { MOBILE_COPY } from "../copy";
import { hapticSend } from "./haptics";
import { IconButton } from "./IconButton";
import { hasProviderMark, ProviderMark } from "./ProviderMark";
import { SlashCommandSuggestions } from "./SlashCommandSuggestions";
import { WorkingPill } from "./WorkingPill";
import type { ProviderSlashCommand } from "@octant/contracts";

// The chip shares one line with the message, so its name stops growing before
// it takes the message's room. The message itself follows the system size.
const CONTROL_TEXT_SCALE = 1.3;

export interface FloatingComposerProps {
  readonly placeholder: string;
  readonly value?: string;
  /** The draft this composer holds, which says whose typing a send may claim. */
  readonly typedScope: string;
  readonly onChangeText?: (value: string) => void;
  readonly onSubmit?: () => void;
  /** When set with busy, show Stop instead of Send (interrupt in-flight turn). */
  readonly onStop?: () => void;
  readonly modelLabel?: string;
  /** The model's provider, whose mark stands for the model where it has one. */
  readonly modelDriverKind?: string | undefined;
  readonly onPressModel?: () => void;
  readonly onPressAttach?: () => void;
  readonly busy?: boolean;
  /** While a turn runs, a message may still be written and waits behind it. */
  readonly queues?: boolean;
  /** A message is on its way, so it cannot be sent again. */
  readonly sending?: boolean;
  readonly editable?: boolean;
  readonly testID?: string;
  readonly footerHint?: string | undefined;
  readonly busyLabel?: string;
  /** When the running turn started, where the thread says. */
  readonly busySince?: string | undefined;
  /** Dictation through the host; absent while the host is not ready for it. */
  readonly voice?: ComposerVoice | undefined;
  /** The provider's own slash commands for the model, offered while a message begins with `/`. */
  readonly slashCommands?: ReadonlyArray<ProviderSlashCommand> | undefined;
  /** The provider account's name, shown on each command. */
  readonly slashProviderLabel?: string | undefined;
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
          minHeight: 30,
          marginVertical: 2,
          paddingHorizontal: 10,
          borderRadius: radii.pill,
          backgroundColor: colors.glassFillThin,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        // A mark names the model by itself, so it needs no box around it.
        modelMark: { backgroundColor: "transparent", borderWidth: 0, paddingHorizontal: 6 },
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
      }),
    [colors],
  );

  // What the person types is theirs; a value a screen writes is not, and
  // replaces the draft's note unless it is text the person left there.
  useEffect(() => {
    if (props.value !== undefined) composerValueShown(props.typedScope, props.value);
  }, [props.value, props.typedScope]);
  const marked = props.modelDriverKind !== undefined && hasProviderMark(props.modelDriverKind);
  const multiline = props.value !== undefined;
  const queues = props.busy === true && props.queues === true;
  const editable = props.editable !== false && (props.busy !== true || queues);
  const canSend =
    props.sending !== true &&
    editable &&
    (props.value ?? "").trim().length > 0 &&
    props.onSubmit !== undefined;

  return (
    <View style={styles.wrap} testID={props.testID ?? "mobile-floating-composer"}>
      {props.busy === true ? (
        <WorkingPill label={props.busyLabel ?? "Working"} since={props.busySince} />
      ) : null}
      {/* A composer that cannot send has no draft to write a command into. */}
      {!editable || props.value === undefined || props.onChangeText === undefined ? null : (
        <SlashCommandSuggestions
          commands={props.slashCommands}
          draft={props.value}
          onChoose={props.onChangeText}
          providerLabel={props.slashProviderLabel ?? ""}
        />
      )}
      <ComposerSurface contentStyle={styles.card}>
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
            onChangeText={(value) => {
              noteTypedComposerText(props.typedScope, value);
              props.onChangeText?.(value);
            }}
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
            accessibilityLabel={props.modelLabel}
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onPressModel}
            style={[styles.modelChip, marked ? styles.modelMark : null]}
            testID="mobile-composer-model"
          >
            {props.modelDriverKind !== undefined && marked ? (
              <ProviderMark driverKind={props.modelDriverKind} size={18} />
            ) : (
              <Text
                maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
                numberOfLines={1}
                style={styles.modelLabel}
              >
                {props.modelLabel}
              </Text>
            )}
            <Icon color={colors.textSecondary} name="chevron-down" size={13} />
          </Pressable>
        ) : props.modelLabel !== undefined ? (
          <Text
            maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
            numberOfLines={1}
            style={styles.modelLabel}
          >
            {props.modelLabel}
          </Text>
        ) : null}
        {props.busy === true && !queues ? null : props.voice !== undefined ? (
          <ComposerVoiceButton size={34} voice={props.voice} />
        ) : null}
        {props.busy === true && props.onStop !== undefined && !(queues && canSend) ? (
          <IconButton
            accessibilityLabel="Stop"
            name="stop"
            onPress={props.onStop}
            size={34}
            testID="mobile-composer-stop"
            variant="stop"
          />
        ) : props.onSubmit !== undefined ? (
          <IconButton
            accessibilityLabel={queues ? MOBILE_COPY.queueSend : "Send"}
            disabled={!canSend}
            name="arrow-up"
            onPress={() => {
              hapticSend();
              props.onSubmit?.();
            }}
            size={34}
            testID="mobile-composer-send"
            variant="send"
          />
        ) : null}
      </ComposerSurface>
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
