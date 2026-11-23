import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useEvent } from "expo";
import type { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import {
  createMobileThreadVideos,
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

export function ThreadVideoClips(props: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly threadKind: VideoJobThreadKind;
}) {
  const { colors } = useTheme();
  const { transport, threadId, threadKind } = props;
  const client = useMemo(() => createMobileThreadVideos(transport), [transport]);
  const load = useCallback(
    () => client.list({ threadKind, scopeId: decodeImageGenerationScopeId(threadId) }),
    [client, threadKind, threadId],
  );
  const resource = usePolledResource(load, { intervalMs: 5_000 });
  const [openClip, setOpenClip] = useState<VideoJobId>();
  const jobs = resource.value?.jobs ?? [];
  const clips = jobs.flatMap((job) =>
    job.status === "completed" && job.clip !== undefined ? [{ id: job.id, clip: job.clip }] : [],
  );
  if (resource.error !== undefined || clips.length === 0) return null;

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
  const [state, setState] = useState<{ readonly uri: string } | { readonly failed: true }>();
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
        setState({ uri: file.uri });
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
  if ("uri" in state) return <ClipPlayer uri={state.uri} />;

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

function ClipPlayer({ uri }: { readonly uri: string }) {
  const { colors } = useTheme();
  const player = useVideoPlayer(uri);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  return status === "error" ? (
    <Text accessibilityLiveRegion="polite" style={{ color: colors.textPrimary }}>
      This video could not be played.
    </Text>
  ) : (
    <VideoView nativeControls player={player} style={styles.player} />
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
