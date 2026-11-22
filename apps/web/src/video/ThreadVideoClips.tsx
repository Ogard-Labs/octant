import type { VideoGenerationClient } from "@octant/client-runtime/video-generation-client";
import type { ImageGenerationScopeId, VideoJob, VideoJobThreadKind } from "@octant/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ContextType,
} from "react";
import { useThreadActivityRevision } from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantButton } from "../ui/base/OctantButton";
import { Video as VideoIcon } from "../ui/icons";
import "./thread-video-clips.css";

/**
 * The window's video client, set where the thread pane receives its clients,
 * so each mode's thread view can show its clips without threading another
 * prop through every workspace. Absent on a client that cannot reach the host.
 */
export const VideoClientContext = createContext<
  | (Pick<VideoGenerationClient, "list" | "clipUrl"> & Partial<Pick<VideoGenerationClient, "stop">>)
  | undefined
>(undefined);

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/**
 * A thread's clips: one `<video>` per finished clip, with controls,
 * `preload="metadata"` and no autoplay, a download link, and Stop for a job
 * still running. Clips are served on short-lived tickets with byte ranges, so
 * seeking does not download the whole clip.
 */
export function ThreadVideoClips(props: {
  readonly threadKind: VideoJobThreadKind;
  readonly scopeId: ImageGenerationScopeId | undefined;
  readonly className?: string;
}) {
  const client = useContext(VideoClientContext);
  const { threadKind, scopeId } = props;
  const [jobs, setJobs] = useState<ReadonlyArray<VideoJob>>([]);
  const revision = useThreadActivityRevision("toolApprovals");

  useEffect(() => setJobs([]), [client, scopeId, threadKind]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || scopeId === undefined) return;
      try {
        const listed = await client.list({ threadKind, scopeId });
        if (signal.aborted) return;
        setJobs((current) => (samePollingData(current, listed.jobs) ? current : listed.jobs));
      } catch {
        // A refused or unreachable list leaves the clips already shown.
      }
    },
    [client, scopeId, threadKind],
  );
  const running = jobs.some((job) => job.status === "queued" || job.status === "running");
  useVisibleRefresh(refresh, revision, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);

  if (client === undefined || jobs.length === 0) return null;
  return (
    <section aria-label="Video clips" className={`thread-video-clips ${props.className ?? ""}`}>
      {jobs.map((job) => (
        <VideoClipCard key={String(job.id)} job={job} client={client} />
      ))}
    </section>
  );
}

function VideoClipCard(props: {
  readonly job: VideoJob;
  readonly client: NonNullable<ContextType<typeof VideoClientContext>>;
}) {
  const { job, client } = props;
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ready = job.status === "completed" && job.clip !== undefined;

  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const ticket = await client.clipUrl(job.id);
        if (!live) return;
        setSrc(ticket.url);
        setFailed(false);
        // A fresh ticket before this one runs out, so a long watch keeps seeking.
        const renewIn = Math.max(30_000, Date.parse(ticket.expiresAt) - Date.now() - 60_000);
        timer = setTimeout(() => void load(), renewIn);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      setSrc((current) => {
        if (current?.startsWith("blob:") === true) URL.revokeObjectURL(current);
        return undefined;
      });
    };
  }, [client, job.id, ready]);

  const label = `${String(job.options.durationSeconds)} s · ${job.options.resolution} · ${job.options.aspectRatio}`;
  return (
    <article className="thread-video-clips__card" aria-label={`Video clip, ${label}`}>
      <div className="thread-video-clips__head">
        <span className="thread-video-clips__kind">
          <VideoIcon aria-hidden="true" size={12} /> Video · {label}
        </span>
        {job.status === "queued" || job.status === "running" ? (
          <span className="thread-video-clips__actions">
            <span role="status">
              {job.status === "queued" ? "Waiting to start…" : "Making the clip…"}
            </span>
            {client.stop === undefined ? null : (
              <OctantButton
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  void client.stop?.(job.id).finally(() => setStopping(false));
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Stop
              </OctantButton>
            )}
          </span>
        ) : ready && src !== undefined ? (
          <a className="thread-video-clips__download" download="clip.mp4" href={src}>
            Download
          </a>
        ) : null}
      </div>
      {ready ? (
        src === undefined ? (
          <p className="thread-video-clips__note">
            {failed ? "The clip could not be loaded." : "Loading the clip…"}
          </p>
        ) : (
          // Providers return no text track, so there is no caption to offer.
          <video
            className="thread-video-clips__player"
            controls
            playsInline
            preload="metadata"
            src={src}
            onError={() => setFailed(true)}
          />
        )
      ) : job.status === "failed" ? (
        <p className="thread-video-clips__note">
          {job.safetyRefusal ?? job.failure?.message ?? "The clip could not be made."}
        </p>
      ) : job.status === "cancelled" ? (
        <p className="thread-video-clips__note">Stopped.</p>
      ) : null}
    </article>
  );
}
