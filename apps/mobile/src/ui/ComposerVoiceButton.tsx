import { useMemo } from "react";
import { StyleSheet, Text } from "react-native";
import { useTheme } from "../../design-system";
import type { ComposerVoice } from "../voice/useVoiceDictation";
import { IconButton } from "./IconButton";

/**
 * The composer's microphone. It is drawn only while the host can transcribe;
 * while a clip records it turns into a red stop control beside a "Recording"
 * label, so recording is never invisible.
 */
export function ComposerVoiceButton(props: {
  readonly voice: ComposerVoice;
  readonly size: number;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        state: { fontSize: 12, fontWeight: "600", marginRight: 4 },
      }),
    [],
  );
  const { state, onPress } = props.voice;
  return (
    <>
      {state === "idle" ? null : (
        <Text
          style={[styles.state, { color: state === "recording" ? colors.danger : colors.accent }]}
          testID="mobile-composer-voice-state"
        >
          {state === "recording" ? "Recording" : "Transcribing"}
        </Text>
      )}
      <IconButton
        accessibilityLabel={
          state === "recording"
            ? "Stop recording and transcribe"
            : state === "transcribing"
              ? "Transcribing"
              : "Dictate"
        }
        {...(state === "recording" ? { color: colors.danger } : {})}
        disabled={state === "transcribing"}
        name={state === "recording" ? "stop-circle" : "mic-outline"}
        onPress={onPress}
        size={props.size}
        testID="mobile-composer-voice"
        variant="ghost"
      />
    </>
  );
}
