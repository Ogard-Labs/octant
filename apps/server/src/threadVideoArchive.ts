import { createHash, randomBytes } from "node:crypto";
import { decodeImageGenerationScopeId, type WindowId } from "@octant/contracts";
import {
  decodeThreadVideoArchiveManifest,
  THREAD_VIDEO_ARCHIVE_FORMAT,
  THREAD_VIDEO_ARCHIVE_PATH,
  type ThreadExportRequest,
  type ThreadVideoArchiveOffer,
} from "@octant/contracts/thread-export";
import type { VideoJob } from "@octant/contracts/video-generation";
import type { ThreadExportService } from "./threadExportService";
import type { VideoJobService } from "./video/videoJobService";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const TAR_BLOCK = 512;
const END_OF_ARCHIVE = Buffer.alloc(2 * TAR_BLOCK);
const TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 32;

type VideoArchiveJobs = Pick<VideoJobService, "listByScope" | "getById" | "streamClip">;

interface ArchiveClip {
  readonly jobId: VideoJob["id"];
  readonly clip: NonNullable<VideoJob["clip"]>;
}

interface OfferedArchive {
  readonly windowId: WindowId;
  readonly request: ThreadExportRequest;
  readonly expiresAt: number;
  readonly size: number;
  readonly title: string;
  readonly manifest: Buffer;
  readonly clips: ReadonlyArray<ArchiveClip>;
}

export function createThreadVideoArchives(options: {
  readonly exportService: Pick<ThreadExportService, "exportThread">;
  readonly jobs: VideoArchiveJobs;
  readonly windows: Pick<WindowAuthorityStore, "listWindowIds">;
  readonly now: () => number;
}) {
  const tickets = new Map<string, OfferedArchive>();

  return {
    async offer(windowId: WindowId, input: unknown): Promise<ThreadVideoArchiveOffer> {
      const exported = await options.exportService.exportThread(windowId, "local-window", input);
      if (exported.kind !== "exported") return exported;
      const { mode, threadId, title } = exported.bundle.octant;
      const request = { mode, threadId };
      const scope = decodeImageGenerationScopeId(threadId);
      const clips = options.jobs
        .listByScope(scope)
        .flatMap((job) =>
          String(job.scopeId) === threadId &&
          job.threadKind === `${mode}-thread` &&
          job.status === "completed" &&
          job.clip !== undefined
            ? [{ jobId: job.id, clip: job.clip }]
            : [],
        );
      if (clips.length === 0) return exported;
      const manifest = Buffer.from(
        JSON.stringify(
          decodeThreadVideoArchiveManifest({
            format: THREAD_VIDEO_ARCHIVE_FORMAT,
            thread: exported.bundle,
            clips: clips.map(({ jobId, clip }) => ({
              jobId,
              clipId: clip.clipId,
              size: clip.size,
              hash: clip.hash,
            })),
          }),
        ),
        "utf8",
      );
      const size = clips.reduce(
        (total, { clip }) => total + tarEntrySize(clip.size),
        tarEntrySize(manifest.length) + END_OF_ARCHIVE.length,
      );
      const now = options.now();
      for (const [key, pending] of tickets) {
        if (pending.expiresAt <= now) tickets.delete(key);
      }
      const oldest = tickets.keys().next().value;
      if (tickets.size >= MAX_TICKETS && oldest !== undefined) tickets.delete(oldest);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, {
        windowId,
        request,
        expiresAt: now + TICKET_TTL_MS,
        clips,
        size,
        title,
        manifest,
      });
      return {
        kind: "archive-ready",
        url: `${THREAD_VIDEO_ARCHIVE_PATH}?ticket=${ticket}`,
        size,
        clipCount: clips.length,
      };
    },
    async take(ticket: string): Promise<Response | undefined> {
      const pending = tickets.get(ticket);
      tickets.delete(ticket);
      if (pending === undefined) return undefined;
      const hasAuthority = () => {
        const now = options.now();
        return (
          pending.expiresAt > now &&
          options.windows.listWindowIds(now).some((id) => String(id) === String(pending.windowId))
        );
      };
      if (!hasAuthority()) return undefined;
      const readable = await options.exportService.exportThread(
        pending.windowId,
        "local-window",
        pending.request,
      );
      if (readable.kind !== "exported" || !hasAuthority()) return undefined;
      const name =
        pending.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "octant-thread";
      const chunks = archiveChunks(pending, options.jobs);
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const next = await chunks.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          async cancel() {
            await chunks.return(undefined);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        headers: {
          "content-type": "application/x-tar",
          "content-length": String(pending.size),
          "content-disposition": `attachment; filename="${name}.octant-thread.tar"`,
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },
  };
}

async function* archiveChunks(
  archive: OfferedArchive,
  jobs: VideoArchiveJobs,
): AsyncGenerator<Uint8Array, void> {
  yield tarHeader("manifest.json", archive.manifest.length);
  yield archive.manifest;
  const manifestPadding = tarPadding(archive.manifest.length);
  if (manifestPadding > 0) yield Buffer.alloc(manifestPadding);
  for (const entry of archive.clips) {
    const job = jobs.getById(entry.jobId);
    if (
      job?.clip === undefined ||
      String(job.scopeId) !== archive.request.threadId ||
      job.threadKind !== `${archive.request.mode}-thread` ||
      String(job.clip.clipId) !== String(entry.clip.clipId) ||
      job.clip.hash !== entry.clip.hash ||
      job.clip.size !== entry.clip.size
    )
      throw Error("A clip changed after the export was prepared.");
    yield tarHeader(`video/${entry.clip.clipId}.mp4`, entry.clip.size);
    const opened = await jobs.streamClip(job);
    if (opened === undefined) throw Error("A clip could not be read for export.");
    const reader = opened.body.getReader();
    try {
      if (opened.size !== entry.clip.size)
        throw Error("A clip changed after the export was prepared.");
      let copied = 0;
      const hash = createHash("sha256");
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        copied += result.value.length;
        if (copied > opened.size) throw Error("A clip changed while it was being exported.");
        hash.update(result.value);
        yield result.value;
      }
      if (copied !== opened.size || hash.digest("hex") !== entry.clip.hash)
        throw Error("A clip changed while it was being exported.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const padding = tarPadding(entry.clip.size);
    if (padding > 0) yield Buffer.alloc(padding);
  }
  yield END_OF_ARCHIVE;
}

function tarPadding(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

function tarEntrySize(size: number): number {
  return TAR_BLOCK + size + tarPadding(size);
}

/** The only member names are the fixed manifest and a validated clip UUID. */
function tarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(path, 0, 100, "ascii");
  const octal = (value: number, offset: number, width: number) =>
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}
