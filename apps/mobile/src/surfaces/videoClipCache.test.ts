import { decodeVideoJobId } from "@octant/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileThreadVideos } from "@octant/client-runtime/video-generation-client";
import { cacheVideoClip } from "./videoClipCache";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("expo-file-system", () => ({
  Paths: { cache: "app-cache" },
  File: class {
    readonly uri: string;
    exists = false;

    constructor(directory: string, name: string) {
      this.uri = `${directory}/${name}`;
    }
    create() {
      calls.push("create");
      this.exists = true;
    }
    open() {
      return {
        writeBytesSync: (bytes: Uint8Array) => calls.push(`write ${bytes.length}`),
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
});
