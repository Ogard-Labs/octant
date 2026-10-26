import { useMemo } from "react";
import { Platform } from "react-native";
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";
import {
  REMOTE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  REMOTE_TRANSCRIPTION_MAX_CLIP_MS,
} from "@octant/domain";
import {
  createUnavailableVoiceRecorderPort,
  type MobileVoiceRecorderPort,
} from "./voiceRecorderPort";

/**
 * Mono AAC at 64 kbit/s: a full minute is about 480 kB, inside the bound the
 * host holds a phone clip to, and plenty for speech. The file goes to the
 * cache directory and is deleted after every clip.
 */
const VOICE_CLIP: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 22_050,
  numberOfChannels: 1,
  bitRate: 64_000,
  directory: "cache",
  android: {
    outputFormat: "mpeg4",
    audioEncoder: "aac",
    maxFileSize: REMOTE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: { mimeType: "audio/webm", bitsPerSecond: 64_000 },
};

/** The device microphone through expo-audio; unavailable outside iOS and Android. */
export function useExpoVoiceRecorder(): MobileVoiceRecorderPort {
  const recorder = useAudioRecorder(VOICE_CLIP);
  return useMemo<MobileVoiceRecorderPort>(() => {
    // The web build (the mock scenario) has no file to read back or delete.
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return createUnavailableVoiceRecorderPort();
    }
    const deleteRecording = () => {
      const uri = recorder.uri;
      if (uri === null) return;
      const file = new File(uri);
      if (file.exists) file.delete();
    };
    return {
      available: true,
      async start() {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) return { status: "denied" };
        try {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorder.prepareToRecordAsync();
          // The controller stops the clip at the same bound; this keeps the
          // cap if the JavaScript timer is late.
          recorder.record({ forDuration: REMOTE_TRANSCRIPTION_MAX_CLIP_MS / 1_000 });
          return { status: "recording" };
        } catch {
          return { status: "failed" };
        }
      },
      async stop() {
        try {
          if (recorder.isRecording) await recorder.stop();
          const uri = recorder.uri;
          if (uri === null) return { status: "failed" };
          const audio = await new File(uri).bytes();
          return { status: "recorded", clip: { audio, mediaType: "audio/mp4" } };
        } catch {
          return { status: "failed" };
        }
      },
      async discard() {
        try {
          if (recorder.isRecording) await recorder.stop();
        } finally {
          deleteRecording();
          await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        }
      },
    };
  }, [recorder]);
}
