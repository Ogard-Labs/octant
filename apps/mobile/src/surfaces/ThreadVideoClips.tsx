import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, Platform } from "react-native";
import { useEvent } from "expo";
import type { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { RemoteConnectionError, type MobileRemoteTransport } from "@octant/client-runtime";
import {
  createMobileThreadVideos,
  VideoGenerationClientFailure,
  type MobileThreadVideos,
} from "@octant/client-runtime/video-generation-client";
import {
  decodeImageGenerationScopeId,
  type VideoJobId,
  type VideoJobThreadKind,
} from "@octant/contracts";
import { useTheme } from "../../design-system";
import { usePolledResource } from "../runtime/usePolledResource";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { cacheVideoClip } from "./videoClipCache";
import { saveVideoClip } from "./videoClipSave";

export function ThreadVideoClips(props: {
  readonly hostId: string;
  readonly transport: MobileRemoteTransport | undefined;
  readonly threadId: string;
  readonly threadKind: VideoJobThreadKind;
}) {
  const { colors } = useTheme();
  const { hostId, transport, threadId, threadKind } = props;
  const activeTransport = useRef(transport);
  useLayoutEffect(() => {
    activeTransport.current = transport;
  }, [transport]);
  // The connection may disappear or be replaced while a local clip is playing.
  // Keep that player and its file while new requests use the current session.
  const client = useMemo(
    () =>
      createMobileThreadVideos({
        hostId,
        async authenticatedFetch(request) {
          const current = activeTransport.current;
          if (current === undefined) {
            throw new RemoteConnectionError("unavailable", "The host is reconnecting.");
          }
          return current.authenticatedFetch(request);
        },
      }),
    [hostId],
  );
  const load = useCallback(async () => {
    try {
      return await client.list({ threadKind, scopeId: decodeImageGenerationScopeId(threadId) });
    } catch (error) {
      // A refusal replaces the last authorized list. Transport errors leave
      // it in place so an already downloaded clip keeps playing offline.
      if (
        (error instanceof VideoGenerationClientFailure && [401, 403, 404].includes(error.status)) ||
        (error instanceof RemoteConnectionError &&
          (error.category === "unauthorized" || error.category === "host-changed"))
      ) {
        return { jobs: [] };
      }
      throw error;
    }
  }, [client, threadKind, threadId]);
  const resource = usePolledResource(load, { intervalMs: 5_000 });
  const [openClip, setOpenClip] = useState<VideoJobId>();
  const jobs = resource.value?.jobs ?? [];
  const clips = jobs.flatMap((job) =>
    job.status === "completed" && job.clip !== undefined ? [{ id: job.id, clip: job.clip }] : [],
  );
  useEffect(() => {
    if (openClip !== undefined && !resource.value?.jobs.some((job) => job.id === openClip)) {
      setOpenClip(undefined);
    }
  }, [openClip, resource.value]);
  if (clips.length === 0) return null;

  return (
    <View style={styles.clips}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>
        Video clips
      </Text>
      {clips.map(({ id, clip }, index) => {
        const open = openClip === id;
        const label = clips.length === 1 ? "video" : `video ${index + 1}`;
        return (
          <View key={String(clip.clipId)} style={styles.clip}>
            <Pressable
              accessibilityLabel={`${open ? "Close" : "Open"} ${label}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpenClip(open ? undefined : id)}
              style={styles.action}
            >
              <Text style={{ color: colors.accent }}>
                {open ? "Close" : "Watch"} {label}
              </Text>
              <Text style={{ color: colors.textPrimary }}>
                {clip.durationSeconds} s · {clip.resolution}
              </Text>
            </Pressable>
            {open ? <CachedClip client={client} jobId={id} size={clip.size} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function CachedClip(props: {
  readonly client: MobileThreadVideos;
  readonly jobId: VideoJobId;
  readonly size: number;
}) {
  const { colors } = useTheme();
  const { client, jobId, size } = props;
  const [state, setState] = useState<
    { readonly file: File; readonly signal: AbortSignal } | { readonly failed: true }
  >();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cached: File | undefined;
    void cacheVideoClip(client, { jobId, size, signal: controller.signal }).then(
      (file) => {
        if (controller.signal.aborted) {
          if (file.exists) file.delete();
          return;
        }
        cached = file;
        setState({ file, signal: controller.signal });
      },
      () => {
        if (!controller.signal.aborted) setState({ failed: true });
      },
    );
    return () => {
      controller.abort();
      if (cached?.exists === true) cached.delete();
    };
  }, [attempt, client, jobId, size]);

  if (state === undefined)
    return (
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>
        Preparing video…
      </Text>
    );
  if ("file" in state) return <ClipPlayer file={state.file} signal={state.signal} />;

  return (
    <View style={styles.clip}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>
        Could not open the video.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setState(undefined);
          setAttempt((current) => current + 1);
        }}
        style={styles.action}
      >
        <Text style={{ color: colors.accent }}>Try again</Text>
      </Pressable>
    </View>
  );
}

function ClipPlayer({ file, signal }: { readonly file: File; readonly signal: AbortSignal }) {
  const { colors } = useTheme();
  const player = useVideoPlayer(file.uri, (opened) => {
    // SDK 58 lets a clip mix with other apps' audio on iOS; it has always
    // taken over from them here.
    if (Platform.OS === "ios") opened.audioMixingMode = "doNotMix";
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | "failed">();
  const saving = useRef(false);

  const saveVideo = async () => {
    if (saving.current || signal.aborted) return;
    saving.current = true;
    setSaveStatus("saving");
    try {
      const saved = await saveVideoClip(file, signal);
      if (!signal.aborted) setSaveStatus(saved ? "saved" : undefined);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const cancelled = code === "ERR_PICKER_CANCELLED" || code === "ERR_FILE_PICKING_CANCELLED";
      if (!signal.aborted) setSaveStatus(cancelled ? undefined : "failed");
    } finally {
      saving.current = false;
    }
  };

  return (
    <View style={styles.clip}>
      {status === "error" ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>
          This video could not be played.
        </Text>
      ) : (
        <VideoView nativeControls player={player} style={styles.player} />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save video"
        accessibilityState={{ disabled: saveStatus === "saving", busy: saveStatus === "saving" }}
        disabled={saveStatus === "saving"}
        onPress={() => void saveVideo()}
        style={styles.action}
      >
        <Text style={{ color: colors.accent }}>
          {saveStatus === "saving" ? "Saving video…" : "Save video"}
        </Text>
      </Pressable>
      {saveStatus === "saved" || saveStatus === "failed" ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>
          {saveStatus === "saved" ? "Video saved." : "Could not save the video."}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clips: { gap: mobileSpacing.sm },
  clip: { gap: mobileSpacing.xs },
  title: { ...mobileTypography.body, fontWeight: "600" },
  action: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: mobileSpacing.sm,
    paddingVertical: mobileSpacing.sm,
  },
  player: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "black" },
});
