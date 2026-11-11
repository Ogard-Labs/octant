import { describe, expect, it } from "vitest";
import { encodeLastShownVersion, loadBundledWhatsNew } from "./bundledWhatsNew";
import {
  MAX_ANNOUNCEMENT_PICTURE_BYTES,
  loadBundledAnnouncement,
  parseAnnouncementFile,
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
    readBytes: async (path: string) => {
      const contents = read(path);
      return typeof contents === "string" ? Buffer.from(contents) : contents;
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
        announcement: { path: "/app/whats-new-announcement.json", readBytes: io.readBytes },
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
      announcement: { path: "/app/whats-new-announcement.json", readBytes: io.readBytes },
    });

    expect(answer).toEqual({
      kind: "notes",
      version: "0.2.0",
      text: "Octant 0.2.0",
      showAfterApply: true,
    });
  });
});
