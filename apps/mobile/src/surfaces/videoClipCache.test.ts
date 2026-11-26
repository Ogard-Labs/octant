import { decodeVideoJobId } from "@octant/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileThreadVideos } from "@octant/client-runtime/video-generation-client";
import { File } from "expo-file-system";
import { cacheVideoClip, reclaimVideoClipCache } from "./videoClipCache";

const calls = vi.hoisted(() => [] as string[]);
const cached = vi.hoisted(() => ({ list: (): ReadonlyArray<unknown> => [] }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: { toString: () => "app-cache", list: () => cached.list() } },
  File: class {
    readonly uri: string;
    readonly name: string;
    exists = false;

    constructor(directory: string, name: string) {
      this.uri = `${directory}/${name}`;
      this.name = name;
    }
    create() {
      calls.push("create");
      this.exists = true;
    }
    open() {
      return {
        writeBytes: (bytes: Uint8Array) => calls.push(`write ${bytes.length}`),
        close: () => calls.push("close"),
      };
    }
    delete() {
      calls.push("delete");
      this.exists = false;
    }
  },
}));

const jobId = decodeVideoJobId("b4000000-0000-4000-8000-000000000001");

beforeEach(() => calls.splice(0));

describe("the disposable video file", () => {
  it("closes the file handle before making the finished file available to the native player", async () => {
    const client: MobileThreadVideos = {
      list: async () => ({ jobs: [] }),
      readClip: async ({ write }) => write(new Uint8Array(3)),
    };
    const file = await cacheVideoClip(client, {
      jobId,
      size: 3,
      signal: new AbortController().signal,
    });

    expect(file.uri).toMatch(/^app-cache\/octant-video-.*\.mp4$/);
    expect(calls).toEqual(["create", "write 3", "close"]);
  });

  it("closes and deletes a partial file when the clip closes before downloading finishes", async () => {
    const controller = new AbortController();
    const client: MobileThreadVideos = {
      list: async () => ({ jobs: [] }),
      readClip: async ({ write }) => {
        write(new Uint8Array(1));
        controller.abort();
      },
    };
    await expect(
      cacheVideoClip(client, { jobId, size: 3, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toEqual(["create", "write 1", "close", "delete"]);
  });

  it("is deleted at the next launch when the system ended the app during playback", () => {
    const file = (name: string, remove = () => void calls.push(`reclaim ${name}`)) =>
      Object.assign(new File("app-cache", name), { delete: remove });
    cached.list = () => [
      file("octant-video-1.mp4", () => {
        throw new Error("The file is locked.");
      }),
      file("octant-video-2.mp4"),
      file("picked-photo.mp4"),
      { name: "octant-video-folder.mp4", delete: () => calls.push("reclaim a folder") },
    ];
    reclaimVideoClipCache();
    expect(calls).toEqual(["reclaim octant-video-2.mp4"]);
  });

  it("does not stop the app from opening when its cache cannot be read", () => {
    cached.list = () => {
      throw new Error("The cache folder is unavailable.");
    };
    expect(() => reclaimVideoClipCache()).not.toThrow();
  });
});
