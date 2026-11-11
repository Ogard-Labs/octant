import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeLastShownVersion, loadBundledWhatsNew } from "./bundledWhatsNew";
import {
  MAX_ANNOUNCEMENT_FILE_CHARS,
  MAX_ANNOUNCEMENT_PICTURE_BYTES,
  loadBundledAnnouncement,
  parseAnnouncementFile,
  readAtMost,
} from "./bundledWhatsNewAnnouncement";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function announcementJson(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: "Canvas comments",
    body: "Point at it.",
    ...extra,
  });
}

function pngBytes(length = 16): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_HEAD);
  return bytes;
}

function memoryFiles(entries: Readonly<Record<string, string | Uint8Array>>) {
  const read = (path: string) => {
    const contents = entries[path];
    if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return contents;
  };
  return {
    readFile: async (path: string) => {
      const contents = read(path);
      return typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8");
    },
    // Like the real reader: never more than the cap plus one byte.
    readBounded: async (path: string, maxBytes: number) => {
      const contents = read(path);
      const bytes = typeof contents === "string" ? Buffer.from(contents) : contents;
      return bytes.subarray(0, maxBytes + 1);
    },
  };
}

describe("bundled What's new announcement", () => {
  it("reads a title, body, action label and picture name from a strict file", () => {
    expect(
      parseAnnouncementFile(
        announcementJson({
          actionLabel: "Take a look",
          picture: "canvas.png",
          pictureAlt: "A mark",
        }),
      ),
    ).toEqual({
      title: "Canvas comments",
      body: "Point at it.",
      actionLabel: "Take a look",
      pictureName: "canvas.png",
      pictureAlt: "A mark",
    });
  });

  it("treats bad JSON, unknown fields and oversized text as no announcement", () => {
    expect(parseAnnouncementFile("{not json")).toBeUndefined();
    expect(parseAnnouncementFile("[]")).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ url: "https://example.com" }))).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ title: "" }))).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ title: "t".repeat(81) }))).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ body: "b".repeat(601) }))).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ actionLabel: 7 }))).toBeUndefined();
    expect(parseAnnouncementFile(announcementJson({ body: "b".repeat(9_000) }))).toBeUndefined();
    expect(
      parseAnnouncementFile(JSON.stringify({ schemaVersion: 2, title: "t", body: "b" })),
    ).toBeUndefined();
  });

  it("refuses a picture name that tries to leave the resources folder", () => {
    for (const picture of [
      "../secret.png",
      "..\\secret.png",
      "/etc/passwd.png",
      "nested/art.png",
      ".hidden.png",
      "art.svg",
      "art.png.exe",
    ]) {
      expect(parseAnnouncementFile(announcementJson({ picture }))).toBeUndefined();
    }
  });

  it("hands the picture over as a data URL beside the text", async () => {
    const announcement = await loadBundledAnnouncement({
      announcementPath: "/app/resources/whats-new-announcement.json",
      ...memoryFiles({
        "/app/resources/whats-new-announcement.json": announcementJson({
          picture: "canvas.png",
          pictureAlt: "A mark on a block",
        }),
        "/app/resources/canvas.png": pngBytes(),
      }),
    });

    expect(announcement?.title).toBe("Canvas comments");
    expect(announcement?.picture?.alt).toBe("A mark on a block");
    expect(announcement?.picture?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from(pngBytes()).toString("base64")}`,
    );
  });

  it("drops the announcement when its picture is oversized, empty, missing or not what its name says", async () => {
    const load = (picture: Uint8Array | undefined) =>
      loadBundledAnnouncement({
        announcementPath: "/app/resources/whats-new-announcement.json",
        ...memoryFiles({
          "/app/resources/whats-new-announcement.json": announcementJson({ picture: "canvas.png" }),
          ...(picture === undefined ? {} : { "/app/resources/canvas.png": picture }),
        }),
      });

    expect(await load(pngBytes(MAX_ANNOUNCEMENT_PICTURE_BYTES + 1))).toBeUndefined();
    expect(await load(new Uint8Array(0))).toBeUndefined();
    expect(await load(undefined)).toBeUndefined();
    expect(await load(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeUndefined();
    expect(await load(pngBytes(MAX_ANNOUNCEMENT_PICTURE_BYTES))).toBeDefined();
  });

  it("includes the announcement only when the notes are due", async () => {
    const files = {
      "/app/whats-new.txt": "Octant 0.2.0\n\nThe dock keeps pins.",
      "/app/whats-new-announcement.json": announcementJson(),
    } as const;
    const io = memoryFiles(files);
    const load = (lastShown: string) =>
      loadBundledWhatsNew({
        currentVersion: "0.2.0",
        notesPath: "/app/whats-new.txt",
        statePath: "/data/state.json",
        readFile: async (path) =>
          path === "/data/state.json" ? encodeLastShownVersion(lastShown) : io.readFile(path),
        writeFile: async () => undefined,
        announcement: { path: "/app/whats-new-announcement.json", readBounded: io.readBounded },
      });

    const due = await load("0.1.0");
    expect(due.kind === "notes" ? due.announcement?.title : undefined).toBe("Canvas comments");
    const settled = await load("0.2.0");
    expect(settled.kind === "notes" ? settled.announcement : "empty").toBeUndefined();
  });

  it("still answers with notes when the announcement is invalid", async () => {
    const io = memoryFiles({
      "/app/whats-new.txt": "Octant 0.2.0",
      "/app/whats-new-announcement.json": "{broken",
    });
    const answer = await loadBundledWhatsNew({
      currentVersion: "0.2.0",
      notesPath: "/app/whats-new.txt",
      statePath: "/data/state.json",
      readFile: async (path) =>
        path === "/data/state.json" ? encodeLastShownVersion("0.1.0") : io.readFile(path),
      writeFile: async () => undefined,
      announcement: { path: "/app/whats-new-announcement.json", readBounded: io.readBounded },
    });

    expect(answer).toEqual({
      kind: "notes",
      version: "0.2.0",
      text: "Octant 0.2.0",
      showAfterApply: true,
    });
  });

  it("asks the reader for no more than the cap, so an oversized picture or file is never loaded whole", async () => {
    const readBounded = vi.fn(async (path: string, maxBytes: number) => {
      const big = path.endsWith(".json")
        ? Buffer.from(announcementJson({ picture: "canvas.png" }))
        : pngBytes(maxBytes + 1);
      return big.subarray(0, maxBytes + 1);
    });
    expect(
      await loadBundledAnnouncement({ announcementPath: "/app/a.json", readBounded }),
    ).toBeUndefined();
    expect(readBounded).toHaveBeenCalledWith("/app/a.json", MAX_ANNOUNCEMENT_FILE_CHARS);
    expect(readBounded).toHaveBeenCalledWith("/app/canvas.png", MAX_ANNOUNCEMENT_PICTURE_BYTES);

    const oversizedJson = vi.fn(async (_path: string, maxBytes: number) =>
      new Uint8Array(maxBytes + 1).fill(0x20),
    );
    expect(
      await loadBundledAnnouncement({
        announcementPath: "/app/a.json",
        readBounded: oversizedJson,
      }),
    ).toBeUndefined();
    expect(oversizedJson).toHaveBeenCalledOnce();
  });

  it("reads only the cap plus one byte of a file far larger than the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whats-new-"));
    try {
      const path = join(directory, "huge.png");
      await writeFile(path, Buffer.alloc(MAX_ANNOUNCEMENT_PICTURE_BYTES * 8, 1));
      const bytes = await readAtMost(path, MAX_ANNOUNCEMENT_PICTURE_BYTES);
      expect(bytes.byteLength).toBe(MAX_ANNOUNCEMENT_PICTURE_BYTES + 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
